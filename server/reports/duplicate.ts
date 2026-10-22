import { audit, db, now } from "../db";
import { logger, shortId } from "../log";
import { REPORT_LIMITS, type ReportDuplicate, type ReportSpec } from "../../shared/reports";
import { duplicateNote } from "../../shared/reportVersions";
import { isReportOwner, readableReport, type ReportRow } from "./access";
import { usableDatasource } from "./datasources";
import { ReportError } from "./errors";
import { liveFolder } from "./folderAccess";
import { mayChoose, reportModelOverride, setReportModel } from "./model";
import { combinedHash, ensureDocRows, mirrorFirstDoc, newestSnapshot, ownerMayRead } from "./reportDocs";
import { parseSpec, reportDetail, REPORTS_PER_USER } from "./service";
import { maxProvenanceVersion } from "./versionNumbers";

const slog = logger("reports");

/**
 * Duplicate a report (D575, D576; lane SMALL, after lane EDIT's research D531): anyone who can read a
 * report makes a new report they own from it, in Unfiled or a folder they pick, titled "Copy of …".
 *
 * Copied: the spec (blocks, sections, parameters, click filters), its queries, the latest good result of
 * each query (so the copy renders at once; their times stay the source's), the cached options of its
 * selects, the data source, and the model choice when the copier's role may choose one (else the copy
 * uses the default, and the answer says so). Docs (`report_docs`) are copied only for one of the report's
 * owners, and only the docs that owner can read (with their hash and newest snapshot, so "Changed" keeps
 * working); the others are named in `docsLeftOut`. Anyone else never sees a report's docs (D456), so
 * their copy has none and `docsHidden` counts them.
 *
 * Not copied: sharing (the copy is private), owners (the copier alone), the schedule, favorites,
 * instructions and proposals, versions and runs (the copy starts at version 1, "Duplicated from “T” vN",
 * and every block's provenance is reset to it), the metric catalog, and parameter-set results. Nothing a
 * reader cannot see reaches their copy: the spec, SQL, rows, options, status, and model are what any
 * reader already sees (D456, D459), and version notes, proposals, and docs stay behind.
 */

type SourceDocRow = { id: string; position: number; source: "nook" | "server"; server_id: string | null; tool: string | null; arg: string | null; ref: string; title: string | null; hash: string | null };

/** The version the source's current spec is: its newest version row that holds it, else the number the backfill would give it. */
function currentVersion(reportId: string, specJson: string, spec: ReportSpec): number | null {
  if (!spec.blocks.length) return null;
  const held = db.query("SELECT version FROM report_versions WHERE report_id = ? AND spec_json = ? ORDER BY version DESC LIMIT 1").get(reportId, specJson) as { version: number } | null;
  if (held) return held.version;
  const latest = db.query("SELECT max(version) AS version FROM report_versions WHERE report_id = ?").get(reportId) as { version: number | null };
  return Math.max((latest.version ?? 0) + 1, maxProvenanceVersion(spec), 1);
}

export const copyTitle = (title: string) => {
  const text = `Copy of ${title}`;
  return text.length <= REPORT_LIMITS.title ? text : `${text.slice(0, REPORT_LIMITS.title - 1)}…`;
};

export function duplicateReport(actor: { id: string; role: string }, sourceId: string, input: { title?: string | null; folderId?: string | null }, via: { keyId?: string } = {}): ReportDuplicate {
  const source: ReportRow & { model_provider_id?: string | null; model?: string | null } = readableReport(sourceId, actor.id);
  const owner = isReportOwner(source.id, actor.id);
  // The copy runs its queries as its new owner: the data source must still be usable (as for a new report).
  usableDatasource(source.datasource_id);
  if (input.folderId) liveFolder(input.folderId);
  const live = (db.query("SELECT COUNT(*) AS count FROM reports WHERE owner_id = ? AND deleted_at IS NULL").get(actor.id) as { count: number }).count;
  if (live >= REPORTS_PER_USER) throw new ReportError(409, "LIMIT_REACHED", `You can have up to ${REPORTS_PER_USER} reports`);

  const spec = parseSpec(source.spec_json);
  const sourceVersion = currentVersion(source.id, source.spec_json, spec);
  const title = input.title?.trim() || copyTitle(source.title);
  // Every block starts at the copy's version 1: the source's runs, instructions, and snapshots stay behind.
  const copied: ReportSpec = { ...spec, version: 1, specVersion: 3, blocks: spec.blocks.map((block) => ({ ...block, provenance: { runId: null, version: 1 } })) };
  const specJson = JSON.stringify(copied);
  if (specJson.length > 524_288) throw new ReportError(413, "TOO_LARGE", "The spec is larger than 512 KiB");

  // Docs: an owner's copy keeps the docs they can read; anyone else's copy has none (D456).
  const sourceDocs: SourceDocRow[] = owner ? ensureDocRows(source.id) : (db.query("SELECT id, position, source, server_id, tool, arg, ref, title, hash FROM report_docs WHERE report_id = ? ORDER BY position, created_at, rowid").all(source.id) as SourceDocRow[]);
  const readable = owner ? sourceDocs.filter((doc) => ownerMayRead({ id: actor.id, role: actor.role }, doc)) : [];
  const docsLeftOut = owner ? sourceDocs.filter((doc) => !readable.includes(doc)).map((doc) => ({ title: newestSnapshot(source.id, doc.id)?.title ?? doc.title ?? "Untitled doc" })) : [];
  const docsHidden = owner ? 0 : sourceDocs.length;

  const id = crypto.randomUUID();
  const at = now();
  let results = 0;
  db.transaction(() => {
    db.query(`INSERT INTO reports (id, owner_id, title, title_source, datasource_id, spec_json, status, last_run_at, last_error, created_at, updated_at, folder_id)
      VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, actor.id, title, source.datasource_id, specJson, copied.blocks.length ? source.status : "draft", source.last_run_at, source.last_error, at, at, input.folderId ?? null);
    // The queries, with the columns their last results had.
    const columnsOf = new Map((db.query("SELECT key, columns_json FROM report_queries WHERE report_id = ?").all(source.id) as Array<{ key: string; columns_json: string }>).map((row) => [row.key, row.columns_json]));
    const insertQuery = db.query("INSERT INTO report_queries (id, report_id, key, sql, purpose, columns_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const query of copied.queries) insertQuery.run(crypto.randomUUID(), id, query.key, query.sql, query.purpose, columnsOf.get(query.key) ?? "[]", query.createdBy, at, at);
    // Each query's latest good result (what a reader of the source sees), under one finished run of the copy.
    const latest = copied.queries.flatMap((query) => {
      const row = db.query("SELECT id FROM report_results WHERE report_id = ? AND query_key = ? AND error IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get(source.id, query.key) as { id: string } | null;
      return row ? [{ key: query.key, resultId: row.id }] : [];
    });
    if (latest.length) {
      const runId = crypto.randomUUID();
      db.query(`INSERT INTO report_runs (id, report_id, kind, trigger, status, query_keys_json, created_by, started_at, finished_at) VALUES (?, ?, 'refresh', ?, 'succeeded', ?, ?, ?, ?)`)
        .run(runId, id, via.keyId ? "mcp" : "user", JSON.stringify(latest.map((item) => item.key)), actor.id, at, at);
      const copyResult = db.query(`INSERT INTO report_results (id, run_id, report_id, query_key, sql, sent_sql, columns_json, rows_json, row_count, truncated, rows_read, bytes_read, ch_query_id, ms, error, error_code, created_at, params_json)
        SELECT ?, ?, ?, query_key, sql, sent_sql, columns_json, rows_json, row_count, truncated, rows_read, bytes_read, ch_query_id, ms, NULL, NULL, created_at, params_json FROM report_results WHERE id = ?`);
      for (const item of latest) copyResult.run(crypto.randomUUID(), runId, id, item.resultId);
      results = latest.length;
    }
    // The selects' cached options, so the filters work before the first refresh.
    db.query(`INSERT INTO report_param_options (report_id, param_id, sql, values_json, truncated, error, created_at)
      SELECT ?, param_id, sql, values_json, truncated, error, created_at FROM report_param_options WHERE report_id = ?`).run(id, source.id);
    // Version 1, saying where it came from (a report with no blocks has no versions yet).
    if (copied.blocks.length) {
      db.query("INSERT INTO report_versions (report_id, version, spec_json, source, note, created_by, created_at) VALUES (?, 1, ?, 'initial', ?, ?, ?)")
        .run(id, specJson, sourceVersion ? duplicateNote(source.title, sourceVersion) : null, actor.id, at);
    }
    if (readable.length) {
      const insertDoc = db.query(`INSERT INTO report_docs (id, report_id, position, source, server_id, tool, arg, ref, title, hash, added_by, added_via, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create', ?)`);
      readable.forEach((doc, index) => {
        const docId = crypto.randomUUID();
        insertDoc.run(docId, id, index, doc.source, doc.server_id, doc.tool, doc.arg, doc.ref, doc.title, doc.hash, actor.id, at);
        const snapshot = newestSnapshot(source.id, doc.id);
        if (snapshot) db.query("INSERT INTO report_doc_snapshots (id, report_id, sha256, title, markdown, fetched_at, doc_id) SELECT ?, ?, sha256, title, markdown, fetched_at, ? FROM report_doc_snapshots WHERE id = ?").run(crypto.randomUUID(), id, docId, snapshot.id);
      });
      mirrorFirstDoc(id);
      // The doc set's hash: the source's when every doc came along; else the copied docs' own.
      const hashes = readable.map((doc) => doc.hash).filter((hash): hash is string => hash !== null);
      const docHash = readable.length === sourceDocs.length ? source.doc_hash : hashes.length ? combinedHash(hashes) : null;
      const firstKept = readable[0] === sourceDocs[0];
      db.query("UPDATE reports SET doc_hash = ?, doc_browse_tools = ? WHERE id = ?").run(docHash, firstKept ? source.doc_browse_tools ?? "[]" : "[]", id);
    }
  })();

  // The model choice, through the owner's own check (a role that may create agents and chat, a listed model).
  const override = reportModelOverride(source.id);
  let model: ReportDuplicate["duplicate"]["model"] = override ? "copied" : "none";
  if (override) {
    if (!mayChoose(actor.role)) model = "not_allowed";
    else {
      try { setReportModel(id, actor, override); } catch (error) {
        if (!(error instanceof ReportError)) throw error;
        model = "not_allowed";
      }
    }
  }

  audit(actor.id, null, "reports.report.duplicate", { id, sourceId: source.id, sourceVersion, owner, results, docs: readable.length, docsLeftOut: docsLeftOut.length, docsHidden, model, ...(input.folderId ? { folderId: input.folderId } : {}), ...(via.keyId ? { via: "mcp", keyId: via.keyId } : {}) });
  slog.info("Report duplicated", { report: shortId(id), source: shortId(source.id), results, docs: readable.length });
  return { report: reportDetail(id, actor.id), duplicate: { sourceId: source.id, sourceVersion, results, docs: readable.length, docsLeftOut, docsHidden, model } };
}
