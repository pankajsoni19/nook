import { audit, db, now } from "../db";
import { logger } from "../log";
import { readableNote } from "../access";
import { listableDocument } from "../documentAccess";
import { REPORT_DOC_LIMITS, type DocInput, type DocState, type DocToolChoice, type ReportDocVia, type ReportDocView } from "../../shared/reportsGenerate";
import type { CatalogMetric } from "../../shared/reportsMetrics";
import { serverAvailableTo, serverRowOrNull, type ToolServerRow } from "../agents/toolServers";
import { ownedReport } from "./access";
import { ReportError } from "./errors";
import { catalogRow, changedMetrics, pageMetricsChanged, type LinkedPage } from "./metricCatalog";
import { currentSpecRunIds, pageInfos, recheckPages, storedBrowseTools } from "./docBrowse";
import { docServerFor, docToolOf, fetchDoc, fetchNookFetched, recordSnapshot, sha256Of, type FetchedDoc } from "./docSource";
import { NOOK_SOURCE_ID, nookRefOf, nookSourceName } from "./nookSource";

const slog = logger("reports");

/**
 * Several docs per report (lane DOCS, D515–D518; migration 064): a report is built from 1–8 docs in
 * order, Nook notes and files mixed with docs behind admins' tool servers. Each doc keeps its own
 * snapshots (`report_doc_snapshots.doc_id`) and the hash the report was last generated from
 * (`report_docs.hash`), so "Doc changed" names the doc that changed. `reports.doc_*` mirror the first
 * doc (the browse tools, MCP, and code that reads one doc keep working), and `reports.doc_hash` is the
 * hash of the doc set (`combinedHash`: the one doc's own hash when there is one).
 *
 * Every doc is read deterministically before any model call, at most three at a time, each through
 * its own source with the acting person's access (a Nook doc as them, a tool server they may use);
 * a scheduled refresh never reads a doc. A doc's text is untrusted data: generate.ts and edit.ts wrap
 * each as `<document id=… title=…>`, and nothing here follows anything in it.
 */

export type ReportDocRow = {
  id: string; report_id: string; position: number; source: "nook" | "server"; server_id: string | null; tool: string | null; arg: string | null;
  ref: string; title: string | null; hash: string | null; added_by: string | null; added_via: ReportDocVia; created_at: string;
};

/** A doc input checked before anything is read: its source (Nook, or a tool server the person may use) and the tool to call. */
export type ResolvedDoc = { ref: string; nook: boolean; server: ToolServerRow | null; choice: DocToolChoice | null; sourceId: string; tool: string | null; arg: string | null };
export type ReadDoc = FetchedDoc & { tool: string };

/** The label a doc has in a prompt and in a run's docs (`d1` is the first). */
export const docLabel = (index: number) => `d${index + 1}`;

/** The doc set's hash: the one doc's own hash, else the SHA-256 of their hashes in order. */
export const combinedHash = (hashes: readonly string[]) => hashes.length === 1 ? hashes[0]! : sha256Of(hashes.join("\n"));

/**
 * The docs as one text (the metric catalog, the doc's signals, doc-first table seeding): the one
 * doc's markdown as it is, or each under a `# <title>` heading.
 */
export const combinedMarkdown = (docs: ReadonlyArray<{ title: string | null; markdown: string }>) =>
  docs.length === 1 ? docs[0]!.markdown : docs.map((doc, index) => `# ${(doc.title ?? `Document ${index + 1}`).replace(/[\r\n]+/g, " ").slice(0, 200)}\n\n${doc.markdown}`).join("\n\n");

/** Two docs are the same when they are read from the same place with the same link. */
const sameDoc = (a: { source: string; server_id: string | null; ref: string }, b: { source: string; server_id: string | null; ref: string }) =>
  a.source === b.source && (a.source === "nook" || a.server_id === b.server_id) && a.ref.trim() === b.ref.trim();

/** Whether a report's stored docs are these resolved docs, in this order. */
export const sameDocList = (rows: readonly Pick<ReportDocRow, "source" | "server_id" | "ref" | "tool" | "arg">[], docs: readonly ResolvedDoc[]) =>
  rows.length === docs.length && rows.every((row, index) => {
    const doc = docs[index]!;
    return sameDoc(row, { source: doc.nook ? "nook" : "server", server_id: doc.server?.id ?? null, ref: doc.ref }) && (doc.nook || ((row.tool ?? null) === doc.tool && (row.arg ?? null) === doc.arg));
  });

/** The report's docs in order. */
export function reportDocs(reportId: string): ReportDocRow[] {
  return db.query("SELECT * FROM report_docs WHERE report_id = ? ORDER BY position, created_at, rowid").all(reportId) as ReportDocRow[];
}

type MirrorRow = { owner_id: string; doc_source: string; doc_server_id: string | null; doc_tool: string | null; doc_arg: string | null; doc_ref: string | null; doc_hash: string | null; created_at: string };

/**
 * The report's docs, made from its one-doc columns when it has none yet (a report written around the
 * app, or by a test): the doc row claims the report's snapshots that have no doc. Idempotent.
 */
export function ensureDocRows(reportId: string): ReportDocRow[] {
  const rows = reportDocs(reportId);
  if (rows.length) return rows;
  const report = db.query("SELECT owner_id, doc_source, doc_server_id, doc_tool, doc_arg, doc_ref, doc_hash, created_at FROM reports WHERE id = ?").get(reportId) as MirrorRow | null;
  if (!report?.doc_ref) return rows;
  db.transaction(() => {
    if (reportDocs(reportId).length) return;
    const id = crypto.randomUUID();
    const nook = report.doc_source === NOOK_SOURCE_ID;
    const title = (db.query("SELECT title FROM report_doc_snapshots WHERE report_id = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1").get(reportId) as { title: string | null } | null)?.title ?? null;
    db.query(`INSERT INTO report_docs (id, report_id, position, source, server_id, tool, arg, ref, title, hash, added_by, added_via, created_at)
      VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM users WHERE id = ?), 'create', ?)`)
      .run(id, reportId, nook ? "nook" : "server", nook ? null : report.doc_server_id, report.doc_tool, report.doc_arg, report.doc_ref!.slice(0, 2048), title, report.doc_hash, report.owner_id, report.created_at);
    db.query("UPDATE report_doc_snapshots SET doc_id = ? WHERE report_id = ? AND doc_id IS NULL").run(id, reportId);
  })();
  return reportDocs(reportId);
}

/** Writes the first doc into `reports.doc_*` (the browse ticks are cleared when its source changes). */
export function mirrorFirstDoc(reportId: string) {
  const first = reportDocs(reportId)[0];
  if (!first) return;
  const current = db.query("SELECT doc_source, doc_server_id FROM reports WHERE id = ?").get(reportId) as { doc_source: string; doc_server_id: string | null } | null;
  if (!current) return;
  const sameSource = current.doc_source === first.source && (first.source === "nook" || current.doc_server_id === first.server_id);
  db.query(`UPDATE reports SET doc_source = ?, doc_server_id = ?, doc_tool = ?, doc_arg = ?, doc_ref = ?, doc_browse_tools = CASE WHEN ? THEN doc_browse_tools ELSE '[]' END, updated_at = ? WHERE id = ?`)
    .run(first.source, first.server_id, first.tool, first.arg, first.ref, sameSource ? 1 : 0, now(), reportId);
}

/** The newest snapshot of one doc. */
export function newestSnapshot(reportId: string, docId: string | null): { id: string; sha256: string; title: string | null; markdown: string; bytes: number; fetched_at: string } | null {
  return db.query(`SELECT id, sha256, title, markdown, length(CAST(markdown AS BLOB)) AS bytes, fetched_at FROM report_doc_snapshots WHERE report_id = ? AND doc_id IS ?
    ORDER BY fetched_at DESC, rowid DESC LIMIT 1`).get(reportId, docId) as { id: string; sha256: string; title: string | null; markdown: string; bytes: number; fetched_at: string } | null;
}

// ------------------------------------------------------------------------------------ reading

/**
 * Checks doc inputs before anything is read (D515): at most 8, no doc twice, each a Nook link or a doc
 * behind a tool server the person may use (404 otherwise), with a read-only tool (D424's rules).
 */
export function resolveDocInputs(role: string, inputs: readonly DocInput[], limit: number = REPORT_DOC_LIMITS.docs): ResolvedDoc[] {
  if (!inputs.length) throw new ReportError(400, "INVALID", "Give at least one doc");
  if (inputs.length > limit) throw new ReportError(400, "INVALID", `At most ${limit} docs`);
  const resolved = inputs.map((input) => resolveDocInput(role, input));
  for (let index = 1; index < resolved.length; index += 1) {
    const doc = resolved[index]!;
    const twice = resolved.slice(0, index).some((other) => sameDoc({ source: other.nook ? "nook" : "server", server_id: other.server?.id ?? null, ref: other.ref }, { source: doc.nook ? "nook" : "server", server_id: doc.server?.id ?? null, ref: doc.ref }));
    if (twice) throw new ReportError(400, "INVALID", `Doc ${index + 1} is already in the list`);
  }
  return resolved;
}

export function resolveDocInput(role: string, input: DocInput): ResolvedDoc {
  const ref = input.docRef.trim();
  if (!ref) throw new ReportError(400, "INVALID", "A doc needs its link or id");
  if (input.serverId === NOOK_SOURCE_ID) {
    // A Nook doc must be a link into this Nook (checked again, with access, when it is read).
    nookRefOf(ref);
    return { ref, nook: true, server: null, choice: null, sourceId: NOOK_SOURCE_ID, tool: null, arg: null };
  }
  const server = docServerFor(input.serverId, role);
  const choice = docToolOf(server, { tool: input.tool ?? null, arg: input.arg ?? null });
  return { ref, nook: false, server, choice, sourceId: server.id, tool: choice.tool, arg: input.arg?.trim() ? choice.arg : null };
}

/** A stored doc as an input again (Regenerate, Check doc). */
export const storedDocInput = (row: Pick<ReportDocRow, "source" | "server_id" | "tool" | "arg" | "ref">): DocInput =>
  ({ docRef: row.ref, serverId: row.source === "nook" ? NOOK_SOURCE_ID : row.server_id ?? "", tool: row.source === "nook" ? null : row.tool, arg: row.source === "nook" ? null : row.arg });

/** Reads one resolved doc: a Nook doc as `userId` with their live access, a tool server's through its read-only tool. */
export async function readResolved(userId: string, doc: ResolvedDoc, signal?: AbortSignal): Promise<ReadDoc> {
  if (doc.nook) return fetchNookFetched(userId, doc.ref);
  const fetched = await fetchDoc(doc.server!, doc.choice!, doc.ref, { signal });
  return { ...fetched, tool: doc.choice!.tool };
}

/**
 * Reads every doc, at most three at a time (D515), in their order. The first failure stops the rest
 * and is answered with its own status and code, its message naming the doc when there are several.
 */
export async function readAllDocs(userId: string, docs: readonly ResolvedDoc[], signal?: AbortSignal): Promise<ReadDoc[]> {
  const out: ReadDoc[] = new Array(docs.length);
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (failed === null && next < docs.length) {
      const index = next++;
      try {
        out[index] = await readResolved(userId, docs[index]!, signal);
      } catch (error) {
        if (failed === null) failed = docs.length > 1 && error instanceof ReportError ? new ReportError(error.status, error.code, `Doc ${index + 1} (${shortRef(docs[index]!.ref)}): ${error.message}`, error.details) : error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REPORT_DOC_LIMITS.fetchConcurrency, docs.length) }, worker));
  if (failed !== null) throw failed;
  return out;
}

const shortRef = (ref: string) => ref.length > 80 ? `${ref.slice(0, 77)}…` : ref;

/**
 * Replaces the report's doc list with these docs (generation, in its transaction): a doc already on
 * the report keeps its row (and snapshots and hash); a new one is added (`via`, by `userId`); one no
 * longer listed is removed with its snapshots no run names. Records each doc's snapshot.
 */
export function replaceDocs(reportId: string, userId: string, docs: readonly ResolvedDoc[], read: readonly ReadDoc[], via: ReportDocVia): Array<{ row: ReportDocRow; snapshot: { id: string; sha256: string; changed: boolean } }> {
  const existing = ensureDocRows(reportId);
  const kept = new Set<string>();
  const at = now();
  const out: Array<{ row: ReportDocRow; snapshot: { id: string; sha256: string; changed: boolean } }> = [];
  docs.forEach((doc, index) => {
    const key = { source: doc.nook ? "nook" : "server", server_id: doc.server?.id ?? null, ref: doc.ref };
    const match = existing.find((row) => !kept.has(row.id) && sameDoc(row, key));
    const title = read[index]!.title?.slice(0, 500) ?? null;
    let id: string;
    if (match) {
      id = match.id;
      db.query("UPDATE report_docs SET position = ?, tool = ?, arg = ?, title = COALESCE(?, title) WHERE id = ?").run(index, doc.nook ? read[index]!.tool : doc.tool, doc.arg, title, id);
    } else {
      id = crypto.randomUUID();
      db.query(`INSERT INTO report_docs (id, report_id, position, source, server_id, tool, arg, ref, title, hash, added_by, added_via, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(id, reportId, index, key.source, key.server_id, doc.nook ? read[index]!.tool : doc.tool, doc.arg, doc.ref.slice(0, 2048), title, userId, via, at);
    }
    kept.add(id);
    const snapshot = recordSnapshot(reportId, read[index]!, id);
    out.push({ row: db.query("SELECT * FROM report_docs WHERE id = ?").get(id) as ReportDocRow, snapshot });
  });
  for (const row of existing) if (!kept.has(row.id)) dropDoc(reportId, row.id);
  return out;
}

/** Removes a doc row and its snapshots that no run names. */
function dropDoc(reportId: string, docId: string) {
  db.query("DELETE FROM report_docs WHERE id = ? AND report_id = ?").run(docId, reportId);
  db.query(`DELETE FROM report_doc_snapshots WHERE report_id = $reportId AND doc_id = $docId
    AND id NOT IN (SELECT doc_snapshot_id FROM report_runs WHERE report_id = $reportId AND doc_snapshot_id IS NOT NULL)
    AND id NOT IN (SELECT json_extract(j.value, '$.snapshotId') FROM report_runs r, json_each(r.docs_json) j WHERE r.report_id = $reportId AND r.docs_json IS NOT NULL AND json_extract(j.value, '$.snapshotId') IS NOT NULL)`).run({ reportId, docId });
}

const renumber = (reportId: string) => {
  reportDocs(reportId).forEach((row, index) => { if (row.position !== index) db.query("UPDATE report_docs SET position = ? WHERE id = ?").run(index, row.id); });
};

// --------------------------------------------------------------------------------------- state

const serverNameOf = (row: Pick<ReportDocRow, "source" | "server_id">) => row.source === "nook" ? nookSourceName() : row.server_id ? (db.query("SELECT name FROM agent_tool_servers WHERE id = ?").get(row.server_id) as { name: string } | null)?.name ?? null : null;

/** The docs as their owner sees them, with each doc's newest snapshot and whether it changed or was added since the report was generated. */
export function docViews(reportId: string): ReportDocView[] {
  const report = db.query("SELECT doc_hash FROM reports WHERE id = ?").get(reportId) as { doc_hash: string | null } | null;
  const generated = Boolean(report?.doc_hash);
  return ensureDocRows(reportId).map((row) => {
    const latest = newestSnapshot(reportId, row.id);
    const added = generated && row.hash === null && latest !== null;
    const changed = added || Boolean(latest && row.hash && latest.sha256 !== row.hash);
    const by = row.added_by ? (db.query("SELECT display_name FROM users WHERE id = ?").get(row.added_by) as { display_name: string } | null)?.display_name ?? null : null;
    return {
      id: row.id, position: row.position, serverId: row.source === "nook" ? NOOK_SOURCE_ID : row.server_id, serverName: serverNameOf(row), tool: row.tool, arg: row.arg, ref: row.ref,
      title: latest?.title ?? row.title, hash: row.hash,
      latest: latest ? { id: latest.id, sha256: latest.sha256, title: latest.title, bytes: latest.bytes, fetchedAt: latest.fetched_at } : null,
      changed, added, addedVia: row.added_via, addedByName: by, createdAt: row.created_at
    };
  });
}

type DocRow = { doc_server_id: string | null; doc_tool: string | null; doc_arg: string | null; doc_ref: string | null; doc_hash: string | null; doc_browse_tools: string; doc_source: string };
const DOC_COLUMNS = "doc_server_id, doc_tool, doc_arg, doc_ref, doc_hash, doc_browse_tools, doc_source";

/** The report's docs, the first doc's newest snapshot, and whether any doc changed since the report was generated. */
export function docState(reportId: string, userId: string): DocState {
  // The doc (its link, server, and snapshots) is the owner's; readers of a shared report never see it (wave 48, D456).
  ownedReport(reportId, userId);
  const docs = docViews(reportId);
  const row = db.query(`SELECT ${DOC_COLUMNS} FROM reports WHERE id = ?`).get(reportId) as DocRow;
  const firstLatest = docs.length ? docs[0]!.latest : null;
  // A report with snapshots but no doc link (a test, an old draft) still shows its newest snapshot.
  const loose = docs.length ? null : db.query("SELECT id, sha256, title, length(CAST(markdown AS BLOB)) AS bytes, fetched_at FROM report_doc_snapshots WHERE report_id = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1")
    .get(reportId) as { id: string; sha256: string; title: string | null; bytes: number; fetched_at: string } | null;
  const latest = firstLatest ?? (loose ? { id: loose.id, sha256: loose.sha256, title: loose.title, bytes: loose.bytes, fetchedAt: loose.fetched_at } : null);
  const nook = row.doc_source === NOOK_SOURCE_ID;
  const serverName = nook ? nookSourceName() : row.doc_server_id ? (db.query("SELECT name FROM agent_tool_servers WHERE id = ?").get(row.doc_server_id) as { name: string } | null)?.name ?? null : null;
  const mainChanged = docs.length ? docs.some((doc) => doc.changed) : Boolean(loose && row.doc_hash && loose.sha256 !== row.doc_hash);
  // B3: the linked pages of the current spec's runs; one that changed since its run read it is "Doc changed" too.
  const pages = pageInfos(reportId);
  // E4: which catalog metrics' definitions the new snapshots changed (their doc text, compared).
  let metricsChanged: string[] = [];
  if (mainChanged && row.doc_hash) {
    const catalog = catalogRow(reportId, row.doc_hash);
    if (catalog?.metrics.length) {
      const texts = docs.length ? docs.map((doc) => newestSnapshot(reportId, doc.id)).filter((item): item is NonNullable<typeof item> => item !== null) : loose ? [{ title: loose.title, markdown: (db.query("SELECT markdown FROM report_doc_snapshots WHERE id = ?").get(loose.id) as { markdown: string }).markdown }] : [];
      if (texts.length) metricsChanged = changedMetrics(catalog.metrics, combinedMarkdown(texts));
    }
  }
  // L2: the metrics Check doc re-read from a changed linked page, named like the main doc's.
  const changedTitles = pages.filter((page) => page.changed && page.kind !== "search" && page.title).map((page) => page.title!);
  if (changedTitles.length && row.doc_hash) {
    for (const name of linkedMetricsChanged(reportId, row.doc_hash, changedTitles)) if (!metricsChanged.includes(name)) metricsChanged.push(name);
  }
  return {
    doc: row.doc_ref || row.doc_server_id || nook ? { serverId: nook ? NOOK_SOURCE_ID : row.doc_server_id, serverName, tool: row.doc_tool, arg: row.doc_arg, ref: row.doc_ref, hash: row.doc_hash, browseTools: storedBrowseTools(row.doc_browse_tools) } : null,
    latest,
    changed: mainChanged || pages.some((page) => page.changed),
    mainChanged,
    pages,
    ...(metricsChanged.length ? { metricsChanged } : {}),
    docs
  };
}

/**
 * L2: the catalog metrics on these changed linked pages whose definition differs between the catalog the
 * current spec was generated with (its generation run's own version, else the newest saved before that
 * run finished) and the newest catalog for the doc's hash. None when the two are the same version.
 */
function linkedMetricsChanged(reportId: string, docHash: string, titles: readonly string[]): string[] {
  const newest = catalogRow(reportId, docHash);
  if (!newest) return [];
  const runs = currentSpecRunIds(reportId);
  const generation = runs.length ? db.query(`SELECT id, COALESCE(finished_at, started_at) AS at FROM report_runs WHERE kind = 'generate' AND id IN (${runs.map(() => "?").join(", ")}) ORDER BY started_at DESC LIMIT 1`).get(...runs) as { id: string; at: string } | null : null;
  if (!generation) return [];
  const base = (db.query("SELECT version, metrics_json FROM report_metric_catalogs WHERE report_id = ? AND run_id = ? ORDER BY version DESC LIMIT 1").get(reportId, generation.id)
    ?? db.query("SELECT version, metrics_json FROM report_metric_catalogs WHERE report_id = ? AND doc_sha256 = ? AND created_at <= ? ORDER BY version DESC LIMIT 1").get(reportId, docHash, generation.at)) as { version: number; metrics_json: string } | null;
  if (!base || base.version === newest.version) return [];
  let before: CatalogMetric[] = [];
  try { before = JSON.parse(base.metrics_json) as CatalogMetric[]; } catch { return []; }
  return pageMetricsChanged(before.map((metric) => ({ ...metric, filters: metric.filters ?? [], excerpt: metric.excerpt ?? null })), newest.metrics, titles);
}

/**
 * "Check doc": reads every doc again (at most three at a time) and stores a snapshot for each that
 * changed; then reads the linked pages again (B3) and hands the changed ones to `onPagesChanged` (L2)
 * before it answers the state.
 */
export async function checkDoc(actor: { userId: string; role: string }, reportId: string, signal?: AbortSignal, onPagesChanged?: (pages: LinkedPage[]) => Promise<unknown>): Promise<DocState> {
  // Review M3: Check doc writes snapshots, so it is the owner's (wave 48's viewers only read the state).
  ownedReport(reportId, actor.userId);
  const docs = ensureDocRows(reportId);
  if (!docs.length) throw new ReportError(400, "INVALID", "This report has no doc to check");
  const resolved = docs.map((row) => resolveDocInput(actor.role, storedDocInput(row)));
  const read = await readAllDocs(actor.userId, resolved, signal);
  const snapshots = db.transaction(() => read.map((doc, index) => {
    if (doc.title) db.query("UPDATE report_docs SET title = ? WHERE id = ?").run(doc.title.slice(0, 500), docs[index]!.id);
    return recordSnapshot(reportId, doc, docs[index]!.id);
  }))();
  const pages = await recheckPages(reportId, { id: actor.userId, role: actor.role }, signal);
  const first = read[0]!;
  audit(actor.userId, null, "reports.doc.check", {
    reportId, serverId: resolved[0]!.sourceId, tool: first.tool, sha256: first.sha256, bytes: read.reduce((sum, doc) => sum + doc.bytes, 0), changed: snapshots.some((item) => item.changed),
    ...(docs.length > 1 ? { docs: docs.length, docsChanged: snapshots.filter((item) => item.changed).length } : {}),
    pages: pages.checked, pagesFailed: pages.failed, pagesChanged: pages.changed
  });
  if (pages.changedPages.length && onPagesChanged) await onPagesChanged(pages.changedPages);
  return docState(reportId, actor.userId);
}

// ---------------------------------------------------------------------------- Doc settings

/** Doc settings → Add a doc (the owner; D515): read now (it must be readable), added last, not yet generated from. */
export async function addReportDoc(actor: { userId: string; role: string }, reportId: string, input: DocInput, signal?: AbortSignal): Promise<DocState> {
  ownedReport(reportId, actor.userId);
  const docs = ensureDocRows(reportId);
  if (docs.length >= REPORT_DOC_LIMITS.docs) throw new ReportError(409, "LIMIT_REACHED", `A report has at most ${REPORT_DOC_LIMITS.docs} docs`);
  const resolved = resolveDocInput(actor.role, input);
  const key = { source: resolved.nook ? "nook" : "server", server_id: resolved.server?.id ?? null, ref: resolved.ref };
  if (docs.some((row) => sameDoc(row, key))) throw new ReportError(409, "INVALID", "That doc is already one of the report's docs");
  const read = await readResolved(actor.userId, resolved, signal);
  const id = crypto.randomUUID();
  const changed = db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM report_docs WHERE report_id = ?").get(reportId) as { count: number }).count;
    if (count >= REPORT_DOC_LIMITS.docs) throw new ReportError(409, "LIMIT_REACHED", `A report has at most ${REPORT_DOC_LIMITS.docs} docs`);
    db.query(`INSERT INTO report_docs (id, report_id, position, source, server_id, tool, arg, ref, title, hash, added_by, added_via, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'settings', ?)`).run(id, reportId, count, key.source, key.server_id, resolved.nook ? read.tool : resolved.tool, resolved.arg, resolved.ref.slice(0, 2048), read.title?.slice(0, 500) ?? null, actor.userId, now());
    const snapshot = recordSnapshot(reportId, read, id);
    if (count === 0) mirrorFirstDoc(reportId);
    db.query("UPDATE reports SET updated_at = ? WHERE id = ?").run(now(), reportId);
    return snapshot.changed;
  })();
  audit(actor.userId, null, "reports.doc.add", { reportId, docId: id, serverId: resolved.sourceId, tool: read.tool, sha256: read.sha256, bytes: read.bytes, changed });
  return docState(reportId, actor.userId);
}

/** Doc settings → Remove (the owner, in the app only: D180 keeps removal off MCP). The last doc stays. */
export function removeReportDoc(actor: { userId: string }, reportId: string, docId: string): DocState {
  ownedReport(reportId, actor.userId);
  const docs = ensureDocRows(reportId);
  const doc = docs.find((row) => row.id === docId);
  if (!doc) throw new ReportError(404, "NOT_FOUND", "Doc not found");
  if (docs.length === 1) throw new ReportError(409, "INVALID", "A report keeps at least one doc; add another before removing this one");
  db.transaction(() => {
    dropDoc(reportId, docId);
    renumber(reportId);
    if (doc.position === 0 || docs[0]!.id === docId) mirrorFirstDoc(reportId);
    db.query("UPDATE reports SET updated_at = ? WHERE id = ?").run(now(), reportId);
  })();
  audit(actor.userId, null, "reports.doc.remove", { reportId, docId, serverId: doc.source === "nook" ? NOOK_SOURCE_ID : doc.server_id });
  return docState(reportId, actor.userId);
}

/** Doc settings → reorder (the owner): `ids` is every doc's id in the new order; the first doc is the one the browse tools follow. */
export function reorderReportDocs(actor: { userId: string }, reportId: string, ids: readonly string[]): DocState {
  ownedReport(reportId, actor.userId);
  const docs = ensureDocRows(reportId);
  const wanted = ids.map((id) => id.toLowerCase());
  if (wanted.length !== docs.length || new Set(wanted).size !== docs.length || !docs.every((row) => wanted.includes(row.id))) throw new ReportError(400, "INVALID", "List every doc of the report once");
  db.transaction(() => {
    wanted.forEach((id, index) => db.query("UPDATE report_docs SET position = ? WHERE id = ? AND report_id = ?").run(index, id, reportId));
    mirrorFirstDoc(reportId);
    db.query("UPDATE reports SET updated_at = ? WHERE id = ?").run(now(), reportId);
  })();
  audit(actor.userId, null, "reports.doc.reorder", { reportId, count: wanted.length });
  return docState(reportId, actor.userId);
}

// --------------------------------------------------------------------- docs on an instruction

/**
 * Whether the report's owner may read a doc an instruction carried (D517): a Nook note they can read
 * with a published version or a Files item they can list, or a tool server open to their role and on.
 */
export function ownerMayRead(owner: { id: string; role: string }, doc: { source: string; server_id: string | null; ref: string }): boolean {
  if (doc.source === "nook") {
    try {
      const ref = nookRefOf(doc.ref);
      if (ref.kind !== "file") {
        const note = readableNote(ref.id, owner.id);
        if (note && note.current_version >= 1) return true;
        if (ref.kind === "note") return false;
      }
      return Boolean(listableDocument(ref.id, owner.id));
    } catch {
      return false;
    }
  }
  const row = doc.server_id ? serverRowOrNull(doc.server_id) : null;
  return Boolean(row && row.enabled === 1 && serverAvailableTo(row, owner.role));
}

type InstructionDocRow = { id: string; instruction_id: string; position: number; source: "nook" | "server"; server_id: string | null; tool: string | null; arg: string | null; ref: string; title: string | null; sha256: string; bytes: number; markdown: string; joined_doc_id: string | null; join_note: string | null };

/**
 * D517: an instruction that was decided or ended keeps its docs' titles and hashes, never their text:
 * cleared at once after Apply, Reject, and Cancel, and by the instruction sweep for the rest (a failed
 * edit, a stale proposal, a restart). One instruction, or every one that ended.
 */
export function releaseInstructionDocs(instructionId?: string): number {
  const ended = "instruction_id IN (SELECT id FROM report_instructions WHERE status IN ('applied','rejected','failed','cancelled'))";
  return instructionId
    ? db.query(`UPDATE report_instruction_docs SET markdown = '' WHERE instruction_id = ? AND markdown <> '' AND ${ended}`).run(instructionId).changes
    : db.query(`UPDATE report_instruction_docs SET markdown = '' WHERE markdown <> '' AND ${ended}`).run().changes;
}

export const instructionDocRows = (instructionId: string) =>
  db.query("SELECT * FROM report_instruction_docs WHERE instruction_id = ? ORDER BY position").all(instructionId) as InstructionDocRow[];

/**
 * On Apply (inside its transaction, before the instruction is marked applied): the instruction's docs
 * join the report's docs (`added_via = 'change'`, added by its author, `hash` = the text the edit
 * read, so they are not "changed"), with a snapshot of that text. A doc the owner cannot read, one
 * already on the report, or one past the 8-doc cap is left out with a note. Returns how many joined.
 */
export function joinInstructionDocs(reportId: string, instructionId: string, authorId: string | null): { joined: number; skipped: number } {
  const rows = instructionDocRows(instructionId).filter((row) => row.joined_doc_id === null && row.join_note === null);
  if (!rows.length) return { joined: 0, skipped: 0 };
  const report = db.query("SELECT owner_id FROM reports WHERE id = ?").get(reportId) as { owner_id: string };
  const owner = { id: report.owner_id, role: (db.query("SELECT role FROM users WHERE id = ?").get(report.owner_id) as { role: string } | null)?.role ?? "member" };
  let joined = 0;
  let skipped = 0;
  for (const row of rows) {
    const docs = ensureDocRows(reportId);
    const note = (text: string) => { skipped += 1; db.query("UPDATE report_instruction_docs SET join_note = ? WHERE id = ?").run(text, row.id); };
    const same = docs.find((doc) => sameDoc(doc, row));
    if (same) { db.query("UPDATE report_instruction_docs SET joined_doc_id = ? WHERE id = ?").run(same.id, row.id); continue; }
    if (docs.length >= REPORT_DOC_LIMITS.docs) { note(`Not added: the report already has ${REPORT_DOC_LIMITS.docs} docs`); continue; }
    if (!ownerMayRead(owner, row)) { note("Not added: the report's owner cannot read it"); continue; }
    if (!row.markdown) { note("Not added: its text is no longer kept"); continue; }
    const id = crypto.randomUUID();
    db.query(`INSERT INTO report_docs (id, report_id, position, source, server_id, tool, arg, ref, title, hash, added_by, added_via, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM users WHERE id = ?), 'change', ?)`).run(id, reportId, docs.length, row.source, row.server_id, row.tool, row.arg, row.ref, row.title, row.sha256, authorId, now());
    recordSnapshot(reportId, { title: row.title, markdown: row.markdown, sha256: row.sha256 }, id);
    db.query("UPDATE report_instruction_docs SET joined_doc_id = ? WHERE id = ?").run(id, row.id);
    if (!docs.length) mirrorFirstDoc(reportId);
    joined += 1;
  }
  if (joined) slog.info("Instruction docs joined the report", { joined, skipped });
  return { joined, skipped };
}
