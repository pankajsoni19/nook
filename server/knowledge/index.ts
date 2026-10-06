import { createHash } from "node:crypto";
import { audit, db, now } from "../db";
import { checksum, storage } from "../storage";
import { DocumentIntegrityError, openObjectForRead } from "../documentStorage";
import { CHUNKING, KNOWLEDGE_BOUNDS } from "../../shared/knowledge";
import { assertBudget, chargeUsage } from "../agents/runs";
import { connectionFor } from "../agents/providers";
import { ProviderError } from "../agents/loop";
import { AgentError, agentsStatus } from "../agents/status";
import { chunkText, type Chunk, type ChunkFormat } from "./chunk";
import { embedTexts, takesDimensions, vectorToBlob } from "./embed";
import { canReadDocument, canReadNote, documentFormat, isKnowledgeType, refreshKbCounts, refreshKbStatus, type KbRow, type SourceRow } from "./service";
import { onNotePublished } from "./hooks";

/**
 * The index pipeline (plan §9, D368, D369; Wave 44 "AC-E"): a background queue, one base at a time,
 * that never blocks a request. A source is `pending` until the worker takes it (`indexing`), then
 * `ready`, `error`, or `unavailable`; those states live in SQLite, so the queue resumes after a
 * restart (sources left `indexing` go back to `pending` at boot).
 *
 * - **Read as the owner** at index time: a note's current published version, a Files text document
 *   (checked against its stored SHA-256), or the pasted text. A note or file the owner can no longer
 *   read becomes `unavailable` and its chunks are removed (T320).
 * - **Content hash:** `sha256(chunker version | model | dimensions | format | the content's own
 *   checksum)`. A source whose hash is unchanged is not embedded again, so the hourly sweep and the
 *   publish hook can mark sources freely; only real changes cost tokens.
 * - **Budgets:** embedding tokens count toward the base owner's daily token budget (and the
 *   instance's), checked before every request; over budget, the source waits (`pending`, "paused")
 *   and nothing is sent. Usage is charged to `agent_usage_daily` under the agent id `kb:<id>`.
 * - **Failures:** a provider or egress error marks the source `error` (the message is the redacted
 *   one) and keeps any chunks it had; Re-index or the next change tries again.
 * - **Triggers:** adding a source; publishing a note that is a source (debounced 60 s); the hourly
 *   sweep (`sweepKnowledge`); Re-index all.
 */

/** Timers, on an object so tests can shorten them. */
export const knowledgeTimers = { publishDebounceMs: 60_000 };

const queue = new Set<string>();
let worker: Promise<void> | null = null;
let idleWaiters: Array<() => void> = [];

/** Queues a base for the worker (no-op while the module is off: its sources stay pending). */
export function scheduleKnowledge(kbId: string) {
  if (!agentsStatus().enabled) return;
  queue.add(kbId);
  worker ??= (async () => {
    try {
      while (queue.size > 0) {
        const next = queue.values().next().value as string;
        queue.delete(next);
        try {
          await indexBase(next);
        } catch (error) {
          console.error("Knowledge indexing failed", error instanceof Error ? error.name : "Unknown error");
        }
      }
    } finally {
      worker = null;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  })();
}

/** Resolves once the queue is empty (tests, and the smoke). */
export function whenKnowledgeIdle(): Promise<void> {
  if (!worker && queue.size === 0) return Promise.resolve();
  return new Promise((resolve) => { idleWaiters.push(resolve); });
}

const liveKb = (id: string) => db.query("SELECT * FROM knowledge_bases WHERE id = ? AND deleted_at IS NULL").get(id) as KbRow | null;

async function indexBase(kbId: string) {
  const skipped = new Set<string>();
  for (;;) {
    const kb = liveKb(kbId);
    if (!kb) return;
    const rows = (db.query("SELECT * FROM kb_sources WHERE kb_id = ? AND status = 'pending' ORDER BY COALESCE(created_at, ''), rowid LIMIT 50").all(kbId) as SourceRow[]).filter((row) => !skipped.has(row.id));
    const source = rows[0];
    if (!source) break;
    const outcome = await indexSource(kb, source);
    if (outcome === "paused") break;
    if (outcome === "requeued") skipped.add(source.id);
  }
  refreshKbStatus(kbId);
  // A source marked again while it was embedded (a new publish) runs in the next pass.
  if (skipped.size > 0) queue.add(kbId);
}

/** What a source's text is, as the owner reads it now; null when the owner cannot read it. */
type Content = { text: string; format: ChunkFormat; fingerprint: string; title: string; bytes: number };

class SourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SourceError";
  }
}

/** The cheap half: whether the owner can read it and the content's own checksum, from SQLite alone (the sweep uses this). */
export function sourceFingerprint(ownerId: string, source: Pick<SourceRow, "kind" | "ref_id" | "text">): { fingerprint: string; format: ChunkFormat; title: string | null } | null {
  if (source.kind === "text") return { fingerprint: checksum(source.text ?? ""), format: "markdown", title: null };
  if (!source.ref_id) return null;
  if (source.kind === "note") {
    if (!canReadNote(ownerId, source.ref_id)) return null;
    const row = db.query("SELECT v.checksum, v.title FROM notes n JOIN note_versions v ON v.note_id = n.id AND v.version_number = n.current_version WHERE n.id = ?").get(source.ref_id) as { checksum: string; title: string } | null;
    return row ? { fingerprint: row.checksum, format: "markdown", title: row.title || "Untitled" } : null;
  }
  if (!canReadDocument(ownerId, source.ref_id)) return null;
  const row = db.query("SELECT sha256, mime_type, name FROM documents WHERE id = ?").get(source.ref_id) as { sha256: string; mime_type: string; name: string } | null;
  if (!row) return null;
  return { fingerprint: row.sha256, format: documentFormat(row.mime_type, row.name), title: row.name };
}

export const contentHash = (kb: Pick<KbRow, "embedding_model" | "dims">, format: ChunkFormat, fingerprint: string) =>
  createHash("sha256").update(`v${CHUNKING.version}|${kb.embedding_model}|${kb.dims}|${format}|${fingerprint}`).digest("hex");

/** The whole content, read as the owner (null: the owner cannot read it now). */
async function readContent(kb: KbRow, source: SourceRow): Promise<Content | null> {
  const seen = sourceFingerprint(kb.owner_id, source);
  if (!seen) return null;
  if (source.kind === "text") {
    const text = source.text ?? "";
    return { text, format: "markdown", fingerprint: seen.fingerprint, title: source.title, bytes: Buffer.byteLength(text, "utf8") };
  }
  if (source.kind === "note") {
    const row = db.query("SELECT n.current_version, v.checksum, v.title FROM notes n JOIN note_versions v ON v.note_id = n.id AND v.version_number = n.current_version WHERE n.id = ?").get(source.ref_id!) as { current_version: number; checksum: string; title: string };
    const markdown = await storage.readVersion(source.ref_id!, row.current_version);
    if (checksum(markdown) !== row.checksum) throw new SourceError("INTEGRITY", "The note's stored text failed its integrity check");
    return { text: markdown, format: "markdown", fingerprint: row.checksum, title: row.title || "Untitled", bytes: Buffer.byteLength(markdown, "utf8") };
  }
  const document = db.query("SELECT id, name, mime_type, size_bytes, sha256 FROM documents WHERE id = ?").get(source.ref_id!) as { id: string; name: string; mime_type: string; size_bytes: number; sha256: string };
  if (!isKnowledgeType(document.mime_type)) throw new SourceError("UNSUPPORTED_TYPE", "Only text, Markdown, and CSV files can be knowledge sources");
  if (document.size_bytes > KNOWLEDGE_BOUNDS.documentBytes) throw new SourceError("TOO_LARGE", "The file is larger than 1 MiB");
  let bytes: Uint8Array;
  try {
    const { handle } = await openObjectForRead(document.id, document.size_bytes);
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof DocumentIntegrityError) throw new SourceError("INTEGRITY", "The file's stored content failed its integrity check");
    throw error;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== document.sha256) throw new SourceError("INTEGRITY", "The file's stored content failed its integrity check");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new SourceError("NOT_TEXT", "The file is not valid UTF-8 text"); }
  return { text, format: documentFormat(document.mime_type, document.name), fingerprint: document.sha256, title: document.name, bytes: document.size_bytes };
}

/** The input a chunk is embedded as: its heading path, then its text (the heading helps a short answer match its topic). */
export const embeddingInput = (chunk: Chunk) => chunk.heading ? `${chunk.heading}\n\n${chunk.text}` : chunk.text;

const setState = (sourceId: string, status: string, error: string | null, from: string = "indexing") =>
  db.query("UPDATE kb_sources SET status = ?, error = ? WHERE id = ? AND status = ?").run(status, error, sourceId, from).changes > 0;

/** One source: read, hash, chunk, embed, and swap its chunks in one transaction. */
async function indexSource(kb: KbRow, source: SourceRow): Promise<"done" | "paused" | "requeued"> {
  if (!db.query("UPDATE kb_sources SET status = 'indexing' WHERE id = ? AND status = 'pending'").run(source.id).changes) return "requeued";
  let content: Content | null;
  try {
    content = await readContent(kb, source);
  } catch (error) {
    const message = error instanceof SourceError ? error.message : "The source could not be read";
    if (!(error instanceof SourceError)) console.error("Knowledge source could not be read", error instanceof Error ? error.name : "Unknown error");
    setState(source.id, "error", message);
    return "done";
  }
  if (!content) {
    markUnavailable(kb.id, source.id);
    return "done";
  }
  const hash = contentHash(kb, content.format, content.fingerprint);
  if (hash === source.content_hash && source.indexed_at !== null) {
    // Unchanged: nothing is embedded again (the sweep and the publish hook mark sources freely).
    db.query("UPDATE kb_sources SET status = 'ready', error = NULL, title = ? WHERE id = ? AND status = 'indexing'").run(content.title.slice(0, 255), source.id);
    return "done";
  }
  const chunks = chunkText(content.text, content.format);
  const others = (db.query("SELECT COUNT(*) AS count FROM kb_chunks WHERE kb_id = ? AND source_id <> ?").get(kb.id, source.id) as { count: number }).count;
  if (others + chunks.length > KNOWLEDGE_BOUNDS.chunks) {
    setState(source.id, "error", `This source would take the knowledge base past ${KNOWLEDGE_BOUNDS.chunks.toLocaleString("en-US")} chunks`);
    return "done";
  }
  let vectors: Float32Array[] = [];
  let tokens = 0;
  let dims = kb.dims;
  if (chunks.length > 0) {
    try {
      const connection = connectionFor(kb.provider_id, null);
      // A model that takes no `dimensions` answers in its own size: a base with no chunks yet adopts it.
      const requested = takesDimensions(kb.embedding_model) || kb.chunk_count > 0 ? kb.dims : null;
      const result = await embedTexts(connection, kb.embedding_model, requested, chunks.map(embeddingInput), {
        // Before every request (T314): over the owner's or the instance's budget nothing is sent.
        beforeBatch: () => assertBudget(kb.owner_id),
        afterBatch: (used) => chargeUsage(kb.owner_id, `kb:${kb.id}`, { promptTokens: used, completionTokens: 0, estimated: false }, 0)
      });
      vectors = result.vectors;
      tokens = result.tokens;
      dims = vectors[0]?.length ?? dims;
      if (dims < 64 || dims > 3072) throw new ProviderError("PROVIDER_ERROR", `The model returned ${dims} dimensions; 64 to 3072 are supported`);
    } catch (error) {
      if (error instanceof AgentError && error.code === "BUDGET_EXCEEDED") {
        setState(source.id, "pending", "Paused: the daily token budget is used up; indexing resumes after midnight UTC");
        return "paused";
      }
      const message = error instanceof ProviderError || error instanceof AgentError ? error.message : "The embeddings could not be made";
      if (!(error instanceof ProviderError) && !(error instanceof AgentError)) console.error("Knowledge embedding failed", error instanceof Error ? error.name : "Unknown error");
      setState(source.id, "error", message.slice(0, 200));
      return "done";
    }
  }
  const stored = db.transaction(() => {
    // The base may have been binned, the source removed, or marked again (a new publish) while the
    // provider answered: then nothing is written and the queue takes it again.
    const live = liveKb(kb.id);
    if (!live || live.dims !== kb.dims) return false;
    const finished = db.query("UPDATE kb_sources SET status = 'ready', error = NULL, content_hash = ?, indexed_at = ?, chunk_count = ?, title = ?, bytes = ? WHERE id = ? AND status = 'indexing'")
      .run(hash, now(), chunks.length, content.title.slice(0, 255), content.bytes, source.id).changes;
    if (!finished) return false;
    if (dims !== kb.dims) db.query("UPDATE knowledge_bases SET dims = ? WHERE id = ?").run(dims, kb.id);
    db.query("DELETE FROM kb_chunks WHERE source_id = ?").run(source.id);
    const insert = db.query("INSERT INTO kb_chunks (kb_id, source_id, ord, heading, text, embedding) VALUES (?, ?, ?, ?, ?, ?)");
    chunks.forEach((chunk, ord) => insert.run(kb.id, source.id, ord, chunk.heading, chunk.text, vectorToBlob(vectors[ord]!)));
    refreshKbCounts(kb.id);
    return true;
  })();
  if (stored) audit(kb.owner_id, null, "knowledge.source.indexed", { kbId: kb.id, sourceId: source.id, chunks: chunks.length, tokens });
  return stored ? "done" : "requeued";
}

/** The owner can no longer read the source (T320): its chunks go, and it says so. */
function markUnavailable(kbId: string, sourceId: string) {
  db.transaction(() => {
    db.query("UPDATE kb_sources SET status = 'unavailable', error = NULL, content_hash = NULL, chunk_count = 0 WHERE id = ?").run(sourceId);
    const removed = db.query("DELETE FROM kb_chunks WHERE source_id = ?").run(sourceId).changes;
    if (removed) refreshKbCounts(kbId);
    else refreshKbStatus(kbId);
  })();
}

/** Re-index all (manage): every source is embedded again, whatever its hash. */
export function reindexAll(actor: { userId: string }, kb: KbRow) {
  const changed = db.query("UPDATE kb_sources SET status = 'pending', error = NULL, content_hash = NULL WHERE kb_id = ? AND status <> 'indexing'").run(kb.id).changes;
  // A source being embedded right now finishes, then runs again with the hash cleared.
  db.query("UPDATE kb_sources SET content_hash = NULL WHERE kb_id = ? AND status = 'indexing'").run(kb.id);
  refreshKbStatus(kb.id);
  audit(actor.userId, null, "knowledge.reindex", { kbId: kb.id, sources: changed, ...(kb.owner_id !== actor.userId ? { asManager: true } : {}) });
  scheduleKnowledge(kb.id);
  return { ok: true as const, sources: changed };
}

// ------------------------------------------------------------------------------ the publish hook

const publishTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** A note that is a source was published: after 60 s of quiet, its sources are checked again. */
export function notePublished(noteId: string) {
  if (!db.query("SELECT 1 FROM kb_sources WHERE kind = 'note' AND ref_id = ? LIMIT 1").get(noteId)) return;
  clearTimeout(publishTimers.get(noteId));
  const timer = setTimeout(() => {
    publishTimers.delete(noteId);
    try {
      markNoteSourcesPending(noteId);
    } catch (error) {
      console.error("Knowledge publish hook failed", error instanceof Error ? error.name : "Unknown error");
    }
  }, knowledgeTimers.publishDebounceMs);
  timer.unref?.();
  publishTimers.set(noteId, timer);
}
onNotePublished(notePublished);

function markNoteSourcesPending(noteId: string) {
  const rows = db.query(`SELECT s.id, s.kb_id, s.status FROM kb_sources s JOIN knowledge_bases k ON k.id = s.kb_id AND k.deleted_at IS NULL WHERE s.kind = 'note' AND s.ref_id = ?`).all(noteId) as Array<{ id: string; kb_id: string; status: string }>;
  for (const row of rows) {
    // A source being embedded right now is marked too: its result is then dropped and it runs again.
    db.query("UPDATE kb_sources SET status = 'pending', error = NULL WHERE id = ?").run(row.id);
    refreshKbStatus(row.kb_id);
    scheduleKnowledge(row.kb_id);
  }
}

// ------------------------------------------------------------------------------ boot and the sweep

/** Boot: sources a previous process left `indexing` go back to `pending`, and every base with work is queued. */
export function resumeKnowledgeIndexing(log: (line: string) => void = (line) => console.log(line)) {
  const reset = db.query("UPDATE kb_sources SET status = 'pending' WHERE status = 'indexing'").run().changes;
  const bases = db.query("SELECT DISTINCT s.kb_id FROM kb_sources s JOIN knowledge_bases k ON k.id = s.kb_id AND k.deleted_at IS NULL WHERE s.status = 'pending'").all() as Array<{ kb_id: string }>;
  for (const { kb_id } of bases) scheduleKnowledge(kb_id);
  if (reset || bases.length) log(`Knowledge: ${bases.length} ${bases.length === 1 ? "base has" : "bases have"} sources waiting to be indexed${reset ? ` (${reset} interrupted)` : ""}.`);
  return { reset, bases: bases.length };
}

/**
 * The hourly check (plan §9): every note and file source of a live base is compared, from SQLite
 * alone, against what the owner can read now. Unreadable → `unavailable` (chunks removed); a changed
 * checksum (or one that came back) → `pending`; then every base with pending work is queued. A
 * source in `error` is only checked for readability: it runs again on Re-index all, on a publish of
 * its note, or when it is removed and added again, never every hour on its own.
 */
export function sweepKnowledge() {
  const rows = db.query(`SELECT s.*, k.owner_id, k.embedding_model, k.dims FROM kb_sources s JOIN knowledge_bases k ON k.id = s.kb_id AND k.deleted_at IS NULL
    WHERE s.status IN ('ready','error','unavailable') AND s.kind IN ('note','document')`).all() as Array<SourceRow & { owner_id: string; embedding_model: string; dims: number }>;
  let unavailable = 0;
  let changed = 0;
  for (const row of rows) {
    const seen = sourceFingerprint(row.owner_id, row);
    if (!seen) {
      if (row.status !== "unavailable") {
        markUnavailable(row.kb_id, row.id);
        unavailable += 1;
      }
      continue;
    }
    if (contentHash(row, seen.format, seen.fingerprint) !== row.content_hash && row.status !== "error") {
      if (db.query("UPDATE kb_sources SET status = 'pending', error = NULL WHERE id = ? AND status = ?").run(row.id, row.status).changes) changed += 1;
    }
  }
  const bases = db.query("SELECT DISTINCT s.kb_id FROM kb_sources s JOIN knowledge_bases k ON k.id = s.kb_id AND k.deleted_at IS NULL WHERE s.status = 'pending'").all() as Array<{ kb_id: string }>;
  for (const { kb_id } of bases) {
    refreshKbStatus(kb_id);
    scheduleKnowledge(kb_id);
  }
  return { unavailable, changed, queued: bases.length };
}

/** Test hook: forget pending publish timers. */
export function resetKnowledgeTimersForTests() {
  for (const timer of publishTimers.values()) clearTimeout(timer);
  publishTimers.clear();
}
