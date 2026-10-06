import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { readableNotePredicate } from "../access";
import { readableDocumentPredicate } from "../documentAccess";
import { DEFAULT_EMBEDDING_DIMS, DEFAULT_EMBEDDING_MODEL } from "../../shared/agents";
import { KNOWLEDGE_BOUNDS, KNOWLEDGE_DOCUMENT_TYPES, type KnowledgeCandidate, type KnowledgeDetail, type KnowledgeLevel, type KnowledgeSource, type KnowledgeStatus, type KnowledgeSummary, type SourceKind, type SourceStatus } from "../../shared/knowledge";
import { defaultProvider } from "../agents/providers";
import { readAgentSettings, roleMayCreate } from "../agents/settings";
import { shareLevel, shareReadableSql, type ShareLevel } from "../agents/sharing";
import { AgentError } from "../agents/status";

/**
 * Knowledge bases (plan §9, D367; Wave 44 "AC-E"): the record, its sources, and who may do what.
 *
 * - **Levels** come from server/agents/sharing.ts (`knowledge_base` kind, `agent_access` rows):
 *   `view` = search it (Try it); `manage` = also add and remove sources, rename it, re-index it,
 *   attach it to agents (Wave 44 fixes, M4, operator 2026-10-06: attaching needs manage), and
 *   share it at view; the owner alone moves it to the Bin.
 *   Viewers (the team role) are capped at view; guests never reach it (AC-O2); admins are nobody
 *   special (D73): without a share they get the same 404.
 * - **Sources** are read as the base's **owner** at index time (server/knowledge/index.ts). A note
 *   or file can be added only when both the person adding it and the owner can read it now, so a
 *   manager can never pull an owner's private note into a base they search, nor a note of their
 *   own the owner could not read (T320). The pickers offer exactly that set.
 * - The embedding provider, model, and dimensions are fixed at creation (AC-O14): the instance's
 *   default provider and its embedding model (`text-embedding-3-small`, 512 dimensions, unless the
 *   admin set others).
 */

export type KbRow = {
  id: string; owner_id: string; name: string; description: string; provider_id: string | null; embedding_model: string; dims: number;
  visibility: string; status: string; chunk_count: number; revision: number; created_at: string; updated_at: string;
  deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null;
};
export type SourceRow = {
  id: string; kb_id: string; kind: SourceKind; ref_id: string | null; title: string; text: string | null; content_hash: string | null;
  status: SourceStatus; error: string | null; indexed_at: string | null; chunk_count: number; bytes: number | null; added_by: string | null; created_at: string | null;
};

const liveKb = (id: string) => db.query("SELECT * FROM knowledge_bases WHERE id = ? AND deleted_at IS NULL").get(id) as KbRow | null;
export const kbRow = (id: string) => db.query("SELECT * FROM knowledge_bases WHERE id = ?").get(id) as KbRow | null;
export const kbLevel = (kb: KbRow, userId: string): ShareLevel => shareLevel("knowledge_base", kb, userId);

/** A live base the person can open (view and up), or the 404. */
export function readableKb(id: string, userId: string): { kb: KbRow; level: Exclude<ShareLevel, "none"> } {
  const kb = liveKb(id);
  const level = kb ? kbLevel(kb, userId) : "none";
  if (!kb || level === "none") throw new AgentError(404, "NOT_FOUND", "Not found");
  return { kb, level };
}

/** A live base the person may change (owner or manager); a viewer gets 403, everyone else the 404. */
export function manageableKb(id: string, userId: string): { kb: KbRow; level: "owner" | "manage" } {
  const { kb, level } = readableKb(id, userId);
  if (level === "view") throw new AgentError(403, "READ_ONLY", "You can search this knowledge base; only its owner and managers change it");
  return { kb, level };
}

/** A live base the person owns (Bin); others who can open it get 403. */
export function ownedKb(id: string, userId: string): KbRow {
  const { kb, level } = readableKb(id, userId);
  if (level !== "owner") throw new AgentError(403, "OWNER_ONLY", "Only the knowledge base's owner can move it to the Bin");
  return kb;
}

// ------------------------------------------------------------------------------ readability

/** Whether `userId` can read note `noteId` now (published, not binned). */
export function canReadNote(userId: string, noteId: string) {
  return Boolean(db.query(`SELECT 1 FROM notes n WHERE n.id = $noteId AND n.deleted_at IS NULL AND n.current_version > 0 AND ${readableNotePredicate}`).get({ noteId, userId }));
}

/** Whether `userId` can read Files document `documentId` now (a Files item, not an attachment, not binned). */
export function canReadDocument(userId: string, documentId: string) {
  return Boolean(db.query(`SELECT 1 FROM documents d WHERE d.id = $documentId AND d.purpose = 'file' AND ${readableDocumentPredicate}`).get({ documentId, userId }));
}

export const canReadSource = (userId: string, kind: SourceKind, refId: string | null) =>
  kind === "text" ? true : refId !== null && (kind === "note" ? canReadNote(userId, refId) : canReadDocument(userId, refId));

/**
 * Whether a base's owner is an active account (Wave 44 fixes, M2). A blocked owner reads nothing:
 * their bases pause (no indexing, no sweep) and answer no search, as their agents stop; an unblock
 * resumes them.
 */
export const ownerIsActive = (ownerId: string) => Boolean(db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL").get(ownerId));

/** The error a source gets, and the note search adds, when the base's embedding provider was removed (M3: fail closed, never the default). */
export const PROVIDER_REMOVED = "The embedding provider was removed";
export const PROVIDER_REMOVED_NOTICE = "The embedding provider this knowledge base was made with was removed. Search uses keywords only, and nothing new is indexed; make a new knowledge base to use the current provider.";
export const OWNER_BLOCKED_NOTICE = "This knowledge base's owner is blocked. It is paused and answers no searches until they are unblocked.";

/** The base's own provider row (no fallback to the default: M3), or null when it was removed. */
export function kbProvider(kb: Pick<KbRow, "provider_id">): { id: string; base_url: string } | null {
  if (!kb.provider_id) return null;
  return db.query("SELECT id, base_url FROM agent_providers WHERE id = ?").get(kb.provider_id) as { id: string; base_url: string } | null;
}

/** The media type without parameters, lower case. */
export const bareType = (mime: string) => mime.split(";")[0]!.trim().toLowerCase();
export const isKnowledgeType = (mime: string) => (KNOWLEDGE_DOCUMENT_TYPES as readonly string[]).includes(bareType(mime));
/** The file names a document source may have (QA LOW-5): text, Markdown, or CSV by extension, so `.json` and the like are refused. */
export const KNOWLEDGE_FILE_NAME = /\.(txt|text|md|markdown|csv)$/i;
const KNOWLEDGE_EXTENSIONS_SQL = ["txt", "text", "md", "markdown", "csv"].map((extension) => `lower(d.name) LIKE '%.${extension}'`).join(" OR ");
export const isKnowledgeFile = (mime: string, name: string) => isKnowledgeType(mime) && KNOWLEDGE_FILE_NAME.test(name);

/**
 * How a Files document is chunked. Files stores every text upload as `text/plain` (it sniffs, never
 * trusting the client's type), so the name decides: `.csv` (or a `text/csv` type) by rows, `.md`
 * and everything else by the Markdown rules (plain text is Markdown without headings).
 */
export const documentFormat = (mime: string, name: string): "csv" | "markdown" => bareType(mime) === "text/csv" || /\.csv$/i.test(name) ? "csv" : "markdown";
const documentLabel = (mime: string, name: string) => documentFormat(mime, name) === "csv" ? "CSV" : bareType(mime) === "text/markdown" || /\.(md|markdown)$/i.test(name) ? "Markdown" : "Text";

// ------------------------------------------------------------------------------ summaries

type Counts = KnowledgeSummary["counts"];
const emptyCounts = (): Counts => ({ pending: 0, indexing: 0, ready: 0, error: 0, unavailable: 0 });

function countsOf(kbId: string): Counts {
  const counts = emptyCounts();
  for (const row of db.query("SELECT status, COUNT(*) AS count FROM kb_sources WHERE kb_id = ? GROUP BY status").all(kbId) as Array<{ status: SourceStatus; count: number }>) {
    if (row.status in counts) counts[row.status] = row.count;
  }
  return counts;
}

/** A base's state from its sources: indexing while any waits, else ready with any indexed, else error, else empty. */
export function statusOf(counts: Counts): KnowledgeStatus {
  const total = counts.pending + counts.indexing + counts.ready + counts.error + counts.unavailable;
  if (total === 0) return "empty";
  if (counts.pending + counts.indexing > 0) return "indexing";
  if (counts.ready > 0) return "ready";
  return counts.error > 0 ? "error" : "empty";
}

const ownerName = (id: string) => (db.query("SELECT display_name FROM users WHERE id = ?").get(id) as { display_name: string } | null)?.display_name ?? "Former member";

export function knowledgeSummary(kb: KbRow, userId: string, level: ShareLevel = kbLevel(kb, userId)): KnowledgeSummary {
  const counts = countsOf(kb.id);
  const yourLevel: KnowledgeLevel = level === "owner" ? "owner" : level === "manage" ? "manage" : "view";
  return {
    id: kb.id, name: kb.name, description: kb.description, ownerId: kb.owner_id, ownerName: ownerName(kb.owner_id), yourLevel,
    embeddingModel: kb.embedding_model, dims: kb.dims, status: statusOf(counts), chunkCount: kb.chunk_count,
    sourceCount: counts.pending + counts.indexing + counts.ready + counts.error + counts.unavailable, counts,
    audience: yourLevel === "owner" ? kb.visibility as KnowledgeSummary["audience"] : null, revision: kb.revision, createdAt: kb.created_at, updatedAt: kb.updated_at,
    notice: !ownerIsActive(kb.owner_id) ? OWNER_BLOCKED_NOTICE : kbProvider(kb) === null ? PROVIDER_REMOVED_NOTICE : null
  };
}

/** The bases the person can open: their own first, then those shared with them, by name. */
export function listKnowledge(userId: string): KnowledgeSummary[] {
  const rows = db.query(`SELECT k.* FROM knowledge_bases k WHERE ${shareReadableSql("knowledge_base", "k")} ORDER BY (k.owner_id = $userId) DESC, k.name COLLATE NOCASE, k.id LIMIT 500`).all({ userId }) as KbRow[];
  return rows.map((row) => knowledgeSummary(row, userId));
}

/** The base's page: its sources. A viewer is not told the title or id of a note or file they cannot read (T320). */
export function knowledgeDetail(kb: KbRow, userId: string, level: ShareLevel = kbLevel(kb, userId)): KnowledgeDetail {
  const rows = db.query("SELECT * FROM kb_sources WHERE kb_id = ? ORDER BY created_at, rowid").all(kb.id) as SourceRow[];
  const manager = level === "owner" || level === "manage";
  const sources = rows.map((row): KnowledgeSource => {
    const shown = manager || canReadSource(userId, row.kind, row.ref_id);
    return {
      id: row.id, kind: row.kind, title: shown ? row.title : null, titleHidden: !shown, refId: shown ? row.ref_id : null,
      status: row.status, error: row.error, chunkCount: row.chunk_count, indexedAt: row.indexed_at, createdAt: row.created_at, bytes: row.bytes
    };
  });
  return { ...knowledgeSummary(kb, userId, level), sources };
}

// ------------------------------------------------------------------------------ the record

export type KnowledgeInput = { name: string; description?: string };

export function createKnowledge(actor: { userId: string; role: string }, input: KnowledgeInput): KnowledgeDetail {
  const settings = readAgentSettings();
  if (!roleMayCreate(actor.role, settings)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot create knowledge bases");
  const provider = defaultProvider();
  if (!provider) throw new AgentError(409, "NO_PROVIDER", "No model provider is configured; an admin sets one in Settings → AI");
  return db.transaction(() => {
    const owned = (db.query("SELECT COUNT(*) AS count FROM knowledge_bases WHERE owner_id = ? AND deleted_at IS NULL").get(actor.userId) as { count: number }).count;
    if (owned >= settings.kbsPerUser) throw new AgentError(409, "LIMIT_REACHED", `You can have up to ${settings.kbsPerUser} knowledge bases`);
    const id = crypto.randomUUID();
    const timestamp = now();
    // AC-O14: the default provider's embedding model and size, fixed for the life of the base.
    const model = provider.embedding_model?.trim() || DEFAULT_EMBEDDING_MODEL;
    const dims = provider.embedding_dims && provider.embedding_dims >= 64 && provider.embedding_dims <= 3072 ? provider.embedding_dims : DEFAULT_EMBEDDING_DIMS;
    db.query(`INSERT INTO knowledge_bases (id, owner_id, name, description, provider_id, embedding_model, dims, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, actor.userId, input.name.trim(), input.description?.trim() ?? "", provider.id, model, dims, timestamp, timestamp);
    audit(actor.userId, null, "knowledge.create", { kbId: id });
    return knowledgeDetail(liveKb(id)!, actor.userId);
  })();
}

export function updateKnowledge(actor: { userId: string }, id: string, input: Partial<KnowledgeInput>): KnowledgeDetail {
  const { kb } = manageableKb(id, actor.userId);
  db.query("UPDATE knowledge_bases SET name = ?, description = ?, updated_at = ? WHERE id = ?")
    .run(input.name?.trim() ?? kb.name, input.description !== undefined ? input.description.trim() : kb.description, now(), id);
  audit(actor.userId, null, "knowledge.update", { kbId: id, ...(kb.owner_id !== actor.userId ? { asManager: true } : {}) });
  return knowledgeDetail(liveKb(id)!, actor.userId);
}

/** Moves the base to the Bin (D363 parity). Agents that use it stop finding it at their next step. */
export function deleteKnowledge(actor: { userId: string }, id: string) {
  ownedKb(id, actor.userId);
  const timestamp = now();
  db.query("UPDATE knowledge_bases SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(timestamp, actor.userId, purgeAfterFrom(new Date(timestamp)), timestamp, id);
  audit(actor.userId, null, "knowledge.delete", { kbId: id });
  return { ok: true as const, purgeAfter: purgeAfterFrom(new Date(timestamp)) };
}

// ------------------------------------------------------------------------------ sources

export type SourceInput =
  | { kind: "note"; noteId: string }
  | { kind: "document"; documentId: string }
  | { kind: "text"; title: string; text: string };

const noteTitle = (noteId: string) => (db.query("SELECT v.title FROM notes n JOIN note_versions v ON v.note_id = n.id AND v.version_number = n.current_version WHERE n.id = ?").get(noteId) as { title: string } | null)?.title || "Untitled";

/**
 * Adds a source (manage). A note or file must be readable by both the person adding it and the
 * base's owner now (T320); missing and unreadable look the same (404). A file must be text,
 * Markdown, or CSV and at most 1 MiB; pasted text at most 256 KiB. At most 500 sources.
 */
export function addSource(actor: { userId: string }, kbId: string, input: SourceInput): KnowledgeSource {
  const { kb } = manageableKb(kbId, actor.userId);
  return db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM kb_sources WHERE kb_id = ?").get(kbId) as { count: number }).count;
    if (count >= KNOWLEDGE_BOUNDS.sources) throw new AgentError(409, "LIMIT_REACHED", `A knowledge base can have up to ${KNOWLEDGE_BOUNDS.sources} sources`);
    const id = crypto.randomUUID();
    const timestamp = now();
    let refId: string | null = null;
    let title: string;
    let text: string | null = null;
    let bytes: number | null = null;
    if (input.kind === "note") {
      refId = input.noteId.toLowerCase();
      if (!canReadNote(actor.userId, refId) || !canReadNote(kb.owner_id, refId)) throw new AgentError(404, "NOT_FOUND", "That note was not found, or the knowledge base's owner cannot read it");
      title = noteTitle(refId);
    } else if (input.kind === "document") {
      refId = input.documentId.toLowerCase();
      if (!canReadDocument(actor.userId, refId) || !canReadDocument(kb.owner_id, refId)) throw new AgentError(404, "NOT_FOUND", "That file was not found, or the knowledge base's owner cannot read it");
      const document = db.query("SELECT name, mime_type, size_bytes FROM documents WHERE id = ?").get(refId) as { name: string; mime_type: string; size_bytes: number };
      if (!isKnowledgeFile(document.mime_type, document.name)) throw new AgentError(400, "UNSUPPORTED_TYPE", "Only text (.txt), Markdown (.md), and CSV (.csv) files can be knowledge sources", { field: "documentId" });
      if (document.size_bytes > KNOWLEDGE_BOUNDS.documentBytes) throw new AgentError(400, "TOO_LARGE", "A file source can be at most 1 MiB", { field: "documentId" });
      title = document.name;
      bytes = document.size_bytes;
    } else {
      title = input.title.trim();
      text = input.text;
      bytes = Buffer.byteLength(text, "utf8");
      if (bytes > KNOWLEDGE_BOUNDS.textBytes) throw new AgentError(400, "TOO_LARGE", "Pasted text can be at most 256 KiB", { field: "text" });
    }
    if (refId && db.query("SELECT 1 FROM kb_sources WHERE kb_id = ? AND kind = ? AND ref_id = ?").get(kbId, input.kind, refId)) throw new AgentError(409, "SOURCE_EXISTS", "That source is already in this knowledge base");
    db.query(`INSERT INTO kb_sources (id, kb_id, kind, ref_id, title, text, status, bytes, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(id, kbId, input.kind, refId, title.slice(0, 255), text, bytes, actor.userId, timestamp);
    db.query("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?").run(timestamp, kbId);
    audit(actor.userId, null, "knowledge.source.add", { kbId, sourceId: id, kind: input.kind, ...(kb.owner_id !== actor.userId ? { asManager: true } : {}) });
    const row = db.query("SELECT * FROM kb_sources WHERE id = ?").get(id) as SourceRow;
    return { id: row.id, kind: row.kind, title: row.title, titleHidden: false, refId: row.ref_id, status: row.status, error: null, chunkCount: 0, indexedAt: null, createdAt: row.created_at, bytes: row.bytes };
  })();
}

/** Removes a source and its chunks (manage); the base's revision moves, so cached vectors reload. */
export function removeSource(actor: { userId: string }, kbId: string, sourceId: string) {
  const { kb } = manageableKb(kbId, actor.userId);
  db.transaction(() => {
    const removed = db.query("DELETE FROM kb_sources WHERE id = ? AND kb_id = ?").run(sourceId, kbId).changes;
    if (!removed) throw new AgentError(404, "NOT_FOUND", "Not found");
    refreshKbCounts(kbId);
    audit(actor.userId, null, "knowledge.source.remove", { kbId, sourceId, ...(kb.owner_id !== actor.userId ? { asManager: true } : {}) });
  })();
  return { ok: true as const };
}

/** The base's chunk count and state from its rows, with a new revision (search reloads its vectors). */
export function refreshKbCounts(kbId: string) {
  const chunks = (db.query("SELECT COUNT(*) AS count FROM kb_chunks WHERE kb_id = ?").get(kbId) as { count: number }).count;
  db.query("UPDATE knowledge_bases SET chunk_count = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(chunks, statusOf(countsOf(kbId)), now(), kbId);
}

/** The base's stored state only (no new revision): after a source moved between queue states. */
export function refreshKbStatus(kbId: string) {
  db.query("UPDATE knowledge_bases SET status = ? WHERE id = ?").run(statusOf(countsOf(kbId)), kbId);
}

/**
 * Add source's pickers (plan §13.4): published notes, or Files text documents, that both the caller
 * and the base's owner can read now, matching `q` by title, at most 50. Those already in the base
 * are marked.
 */
export function sourceCandidates(actor: { userId: string }, kbId: string, kind: "note" | "document", q: string): KnowledgeCandidate[] {
  const { kb } = manageableKb(kbId, actor.userId);
  const like = `%${q.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const added = new Set((db.query("SELECT ref_id FROM kb_sources WHERE kb_id = ? AND kind = ? AND ref_id IS NOT NULL").all(kbId, kind) as Array<{ ref_id: string }>).map((row) => row.ref_id));
  // Both people must read it: the predicate once for the caller, once (renamed) for the owner.
  const ownerNote = readableNotePredicate.replaceAll("$userId", "$ownerId");
  const ownerDocument = readableDocumentPredicate.replaceAll("$userId", "$ownerId");
  if (kind === "note") {
    const rows = db.query(`SELECT n.id, v.title, n.updated_at, u.display_name AS owner_name FROM notes n
        JOIN note_versions v ON v.note_id = n.id AND v.version_number = n.current_version JOIN users u ON u.id = n.owner_id
      WHERE n.deleted_at IS NULL AND n.current_version > 0 AND ${readableNotePredicate} AND ${ownerNote} AND v.title LIKE $like ESCAPE '\\'
      ORDER BY n.updated_at DESC LIMIT 50`).all({ userId: actor.userId, ownerId: kb.owner_id, like }) as Array<{ id: string; title: string; updated_at: string; owner_name: string }>;
    return rows.map((row) => ({ id: row.id, title: row.title || "Untitled", detail: `Note · ${row.owner_name}`, added: added.has(row.id) }));
  }
  const types = KNOWLEDGE_DOCUMENT_TYPES.map((type) => `'${type}'`).join(",");
  const rows = db.query(`SELECT d.id, d.name, d.mime_type, d.size_bytes, u.display_name AS owner_name FROM documents d JOIN users u ON u.id = d.owner_id
    WHERE d.purpose = 'file' AND ${readableDocumentPredicate} AND ${ownerDocument} AND lower(trim(substr(d.mime_type, 1, instr(d.mime_type || ';', ';') - 1))) IN (${types})
      AND d.size_bytes <= $max AND (${KNOWLEDGE_EXTENSIONS_SQL}) AND d.name LIKE $like ESCAPE '\\' AND NOT EXISTS (SELECT 1 FROM whiteboards w WHERE w.document_id = d.id)
    ORDER BY d.updated_at DESC LIMIT 50`).all({ userId: actor.userId, ownerId: kb.owner_id, like, max: KNOWLEDGE_BOUNDS.documentBytes }) as Array<{ id: string; name: string; mime_type: string; size_bytes: number; owner_name: string }>;
  return rows.map((row) => ({ id: row.id, title: row.name, detail: `${documentLabel(row.mime_type, row.name)} · ${Math.max(1, Math.round(row.size_bytes / 1024))} KiB · ${row.owner_name}`, added: added.has(row.id) }));
}

/**
 * The knowledge bases `userId` owns or manages now, by id (Wave 44 fixes, M4, operator 2026-10-06):
 * attaching a base to an agent needs manage, and a base answers in an agent only while the agent's
 * owner still owns or manages it. View is search and Try it only.
 */
export function manageableKbIds(userId: string, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db.query("SELECT * FROM knowledge_bases WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL").all(JSON.stringify(ids)) as KbRow[];
  return new Set(rows.filter((kb) => { const level = kbLevel(kb, userId); return level === "owner" || level === "manage"; }).map((kb) => kb.id));
}

/** The knowledge bases `userId` can open now, by id (for the tool picker and run-time checks). */
export function viewableKbIds(userId: string, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db.query(`SELECT k.id FROM knowledge_bases k WHERE k.id IN (SELECT value FROM json_each($ids)) AND ${shareReadableSql("knowledge_base", "k")}`).all({ userId, ids: JSON.stringify(ids) }) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}
