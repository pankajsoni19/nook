import { createHash } from "node:crypto";
import { audit, db, now } from "../db";
import { blockKeys, REPORT_LIMITS, type ReportBlock, type ReportSpec } from "../../shared/reports";
import { INSTRUCTION_LIMITS, type ReportInstruction } from "../../shared/reportsEdit";
import { QUERY_EDIT_LIMITS, type PreviewBlockCheck, type QueryEditPreview } from "../../shared/reportsQueryEdit";
import { commentableReport, type ReportRow } from "./access";
import { usableDatasource } from "./datasources";
import { proposalResults, type InstructionRow, type StoredProposal } from "./edit";
import { ReportError } from "./errors";
import { getInstruction, kick } from "./instructions";
import { reportToday } from "./paramZone";
import { parameterErrors, resolveSet } from "./params";
import { applyPatch, changedBlockIds, changedQueryKeys, diffSpecs } from "./patch";
import { queryResults, takeRunLock } from "./refresh";
import { adHocQueryId, runGuarded } from "./runner";
import { parseSpec } from "./service";
import { forValidation, reattach, specHash } from "./specCheck";
import { checkColumns, checkSpecShape, validateSpec } from "./specValidate";

/**
 * Editing a saved query from Inspect → Query (lane EDIT, D525–D531).
 *
 * - **Preview** (the owner and the comment level): the new SQL runs once through the guard, SELECT
 *   only, with the report's parameter values the person has on screen, at most the console's rows,
 *   counted against their query slots and QUERY_EDIT_LIMITS.previewsPerMinute. It answers the result
 *   and the columns the blocks that read the query would miss. Nothing is saved.
 * - **Suggest** (the comment level; an owner may too): the patched spec is checked as a manual edit is
 *   (the guard, a run of every query with the default and one other parameter set, the blocks'
 *   columns, the design rules on the blocks it changes), under the report's run lock. It becomes an
 *   instruction (`suggested_query`) that already holds its proposal; the queue makes it `proposed`
 *   with no agent run when it reaches the head (`promoteSuggestion`), and the owner applies or rejects
 *   it in Changes as any proposal (applyProposal re-checks it first).
 *
 * The owner's own Save is a manual edit (`POST …/spec/edit` with `update_query`), unchanged.
 */

type Actor = { userId: string; role: string; keyId?: string | null };

/** The extra a suggestion's stored proposal carries, so it can move onto a spec that changed elsewhere. */
type SuggestionMeta = { queryKey: string; baseSql: string; parametersSha256: string };
type StoredSuggestion = StoredProposal & { suggestion?: SuggestionMeta };

const previews = new Map<string, number[]>();
const suggestions = new Map<string, number[]>();

function windowLimit(store: Map<string, number[]>, userId: string, limit: number, windowMs: number, message: string, nowMs = Date.now()) {
  const kept = (store.get(userId) ?? []).filter((at) => nowMs - at < windowMs);
  if (kept.length >= limit) {
    store.set(userId, kept);
    throw new ReportError(429, "BUSY", message);
  }
  kept.push(nowMs);
  store.set(userId, kept);
}

/** Test hook: forget the per-person preview and suggestion counts. */
export function resetQueryEditLimits() {
  previews.clear();
  suggestions.clear();
}

/** A report the person may suggest on (owner or comment level, never a Team viewer or guest), and the query. */
function editableQuery(actor: Actor, reportId: string, queryKey: string): { report: ReportRow; spec: ReportSpec; level: string; sql: string } {
  const { row: report, level } = commentableReport(reportId, actor.userId);
  if (actor.role === "viewer" || actor.role === "guest") throw new ReportError(403, "ROLE_READ_ONLY", "Your role cannot change reports");
  const spec = parseSpec(report.spec_json);
  const query = spec.queries.find((item) => item.key === queryKey);
  if (!query) throw new ReportError(404, "NOT_FOUND", "That query is not in the report");
  return { report, spec, level, sql: query.sql };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const readsKey = (block: ReportBlock, key: string) => blockKeys(block).includes(key);
const blockTitle = (block: ReportBlock) => block.title ?? (block.type === "kpi" ? block.label ?? block.column : block.type === "markdown" ? "Text" : block.queryKey);

/**
 * The checked spec with every block that does not read `key` exactly as it is now: the checks fill
 * defaults and record auto-fixes on the whole spec, and a suggestion changes one query (and what its
 * readers draw), never the rest of the page (so the review shows only those blocks as changed).
 */
function onlyReaders(checked: ReportSpec, current: ReportSpec, key: string): ReportSpec {
  const now = new Map(current.blocks.map((block) => [block.id, block]));
  return { ...checked, blocks: checked.blocks.map((block) => readsKey(block, key) ? block : now.get(block.id) ?? block) };
}

/** The parameters a suggestion's queries ran with (their SHA-256): its stored rows hold only while they stay. */
const parametersHash = (spec: ReportSpec) => sha(JSON.stringify(spec.parameters ?? []));

/**
 * Column problems for every block that reads `key` (its own query, a KPI's comparison, or a sparkline),
 * as Save's `checkColumns` reports them: the new result for `key`, the stored results for the other
 * queries those blocks read (lane EDIT follow-up: preview and Save agree).
 */
function blockChecks(reportId: string, spec: ReportSpec, key: string, outcome: QueryEditPreview["outcome"]): { blocks: PreviewBlockCheck[]; problems: string[] } {
  const readers = spec.blocks.filter((block) => readsKey(block, key));
  const others = new Set(readers.flatMap(blockKeys).filter((other) => other !== key));
  const results = new Map<string, Pick<QueryEditPreview["outcome"], "columns" | "rows">>();
  if (others.size) for (const item of queryResults(reportId, spec)) if (others.has(item.queryKey) && item.result) results.set(item.queryKey, item.result);
  results.set(key, outcome);
  const problems = checkColumns({ blocks: readers }, results);
  const blocks = readers.map((block) => {
    const missing = problems.filter((line) => line.startsWith(`block ${block.id}:`)).flatMap((line) => {
      const found = /^block \S+: .+? (\S+) is not a column of (\S+) /.exec(line);
      return found && found[2] === key ? [found[1]!] : [];
    });
    return { blockId: block.id, title: blockTitle(block), missing: [...new Set(missing)] };
  });
  return { blocks, problems };
}

/**
 * Run preview: the new SQL once, guarded and read-only, with the parameter values given (the report's
 * defaults for any not given), audited by SHA-256 like the console (never the text).
 */
export async function previewQueryEdit(actor: Actor, reportId: string, input: { queryKey: string; sql: string; values?: Record<string, unknown> | null }, signal?: AbortSignal): Promise<QueryEditPreview> {
  const { report, spec, level } = editableQuery(actor, reportId, input.queryKey);
  const sql = input.sql.trim();
  if (!sql) throw new ReportError(400, "INVALID", "Write the SQL first");
  const placeholderErrors = parameterErrors(spec.parameters ?? [], [{ key: input.queryKey, sql }]).filter((line) => line.startsWith(`query ${input.queryKey}:`));
  if (placeholderErrors.length) throw new ReportError(400, "INVALID", placeholderErrors[0]!, { details: placeholderErrors });
  const set = resolveSet(spec, input.values ?? null, reportToday(reportId));
  const datasource = usableDatasource(report.datasource_id);
  windowLimit(previews, actor.userId, QUERY_EDIT_LIMITS.previewsPerMinute, 60_000, "Too many previews in a minute; wait a moment and try again");
  const queryId = adHocQueryId("qedit");
  const meta = { reportId, queryKey: input.queryKey, level, queryId, sha256: sha(sql), ...(actor.keyId ? { via: "mcp", keyId: actor.keyId } : {}) };
  try {
    const outcome = await runGuarded(datasource, sql, { classes: ["select"], maxRows: Math.min(datasource.max_rows, REPORT_LIMITS.consoleRows), queryId, userId: actor.userId, signal, params: set.bound });
    const checks = blockChecks(reportId, spec, input.queryKey, outcome);
    audit(actor.userId, null, "reports.query.preview", { ...meta, rows: outcome.rows.length, problems: checks.problems.length });
    return { queryKey: input.queryKey, outcome, ...checks };
  } catch (error) {
    audit(actor.userId, null, "reports.query.preview_refused", { ...meta, error: error instanceof Error ? error.name : "Error" });
    throw error;
  }
}

/**
 * Suggest: the new SQL checked as the owner's Save would check it, then queued as an instruction that
 * holds its proposal (no AI, no budget). A refusal saves nothing and answers 400 INVALID with details.
 */
export async function suggestQueryEdit(actor: Actor, reportId: string, input: { queryKey: string; sql: string; note?: string | null; blockId?: string | null; expectedRevision?: number }, signal?: AbortSignal): Promise<{ instruction: ReportInstruction; warnings?: string[] }> {
  const { report, spec: current, level, sql: baseSql } = editableQuery(actor, reportId, input.queryKey);
  if (input.expectedRevision !== undefined && report.revision !== input.expectedRevision) throw new ReportError(409, "REVISION_CONFLICT", "This report changed since; reload it", { revision: report.revision });
  const sql = input.sql.trim();
  if (!sql || sql === baseSql.trim()) throw new ReportError(400, "INVALID", "That changes nothing");
  const blockId = input.blockId ?? null;
  if (blockId && !current.blocks.some((block) => block.id === blockId)) throw new ReportError(404, "NOT_FOUND", "That block is not in the report");
  const queued = (db.query("SELECT COUNT(*) AS count FROM report_instructions WHERE report_id = ? AND status = 'queued'").get(reportId) as { count: number }).count;
  if (queued >= INSTRUCTION_LIMITS.queued) throw new ReportError(429, "LIMIT_REACHED", `At most ${INSTRUCTION_LIMITS.queued} instructions can wait at once`);
  const applied = applyPatch(current, { ops: [{ op: "update_query", key: input.queryKey, sql }] }, "user");
  if (!applied.ok) throw new ReportError(400, "INVALID", applied.errors[0] ?? "The change is not valid", { details: applied.errors });
  const spec = applied.spec;
  const diff = diffSpecs(current, spec);
  const changed = changedQueryKeys(diff);
  const datasource = usableDatasource(report.datasource_id);
  windowLimit(suggestions, actor.userId, QUERY_EDIT_LIMITS.suggestionsPerHour, 3_600_000, `At most ${QUERY_EDIT_LIMITS.suggestionsPerHour} suggestions an hour; wait a while and try again`);
  const via = actor.keyId ? { via: "mcp", keyId: actor.keyId } : {};
  // The checks run queries: the report's one run (409 RUN_IN_PROGRESS while a refresh, generation, or edit holds it).
  const run = takeRunLock({ reportId, kind: "edit", trigger: actor.keyId ? "mcp" : "user", userId: actor.userId, queryKeys: [...changed] });
  const finish = (status: "succeeded" | "failed", error: string | null) =>
    db.query("UPDATE report_runs SET status = ?, error = ?, finished_at = ?, lease_until = NULL WHERE id = ? AND status = 'running'").run(status, error?.slice(0, 1000) ?? null, now(), run.id);
  let check: Awaited<ReturnType<typeof validateSpec>>;
  try {
    check = await validateSpec(datasource, forValidation(spec), { userId: actor.userId, runId: run.id, signal, changedBlockIds: changedBlockIds(diff), sanity: { changedQueryKeys: changed } });
  } catch (error) {
    finish("failed", error instanceof ReportError ? error.message : "The check failed");
    throw error;
  }
  if (!check.ok) {
    finish("failed", check.errors[0] ?? "The suggestion did not pass the checks");
    audit(actor.userId, null, "reports.query.suggest_refused", { reportId, queryKey: input.queryKey, level, runId: run.id, sha256: sha(sql), errors: check.errors.length, ...via });
    throw new ReportError(400, "INVALID", check.errors[0] ?? "The suggestion did not pass the checks", { details: check.errors });
  }
  const validated = onlyReaders(reattach(check.spec, spec), current, input.queryKey);
  const note = (input.note ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, QUERY_EDIT_LIMITS.note);
  const proposal: StoredSuggestion = {
    spec: validated, summary: note || null, results: proposalResults(check.results, changed), docSnapshotId: null,
    suggestion: { queryKey: input.queryKey, baseSql, parametersSha256: parametersHash(current) }
  };
  const id = crypto.randomUUID();
  const at = now();
  db.transaction(() => {
    const position = ((db.query("SELECT max(position) AS position FROM report_instructions WHERE report_id = ?").get(reportId) as { position: number | null }).position ?? 0) + 1;
    db.query(`INSERT INTO report_instructions (id, report_id, block_id, text, author_id, via, key_id, status, position, run_id, base_revision, base_spec_sha256, base_datasource_id,
      base_datasource_revision, proposal_json, summary, suggested_query, created_at, updated_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, reportId, blockId, `Suggested SQL for ${input.queryKey}`, actor.userId, actor.keyId ? "mcp" : "web", actor.keyId ?? null, position, run.id, report.revision,
        specHash(report.spec_json), datasource.id, datasource.revision, JSON.stringify(proposal), proposal.summary, input.queryKey, at, at, at, at);
    finish("succeeded", null);
  })();
  const warnings = check.sanity?.hints ?? [];
  // Never the SQL or the note (T402: literals may be sensitive; the stored proposal has them for the owner).
  audit(actor.userId, null, "reports.query.suggest", { reportId, instructionId: id, queryKey: input.queryKey, level, runId: run.id, sha256: sha(sql), noteChars: note.length, ...(warnings.length ? { sanityHints: warnings.length } : {}), ...via });
  kick(reportId);
  return { instruction: getInstruction(reportId, id, actor.userId), ...(warnings.length ? { warnings } : {}) };
}

type SuggestionRow = InstructionRow & { suggested_query?: string | null };

const fail = (row: SuggestionRow, reason: string) => {
  const at = now();
  const changed = db.query("UPDATE report_instructions SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(reason, at, at, row.id).changes;
  if (changed) audit(row.author_id, null, "reports.query.suggest_stale", { reportId: row.report_id, instructionId: row.id, queryKey: row.suggested_query });
};

/**
 * The queue reached a suggestion (kick, nothing running or proposed): it becomes `proposed` with no
 * agent run. When the report changed since it was made, it moves onto the current spec if the query's
 * SQL and the parameters are as they were, every block that now reads the query finds its columns in
 * the suggestion's stored result, and the new spec has the right shape; otherwise it fails with a
 * reason ("suggest it again"). Apply re-checks it against the guard and the allowlist as any proposal.
 */
export function promoteSuggestion(row: SuggestionRow) {
  const report = db.query("SELECT spec_json, revision FROM reports WHERE id = ? AND deleted_at IS NULL").get(row.report_id) as { spec_json: string; revision: number } | null;
  if (!report || !row.proposal_json) return fail(row, "The suggestion could not be read; suggest it again");
  const at = now();
  if (row.base_spec_sha256 === specHash(report.spec_json)) {
    db.query("UPDATE report_instructions SET status = 'proposed', updated_at = ? WHERE id = ? AND status = 'queued'").run(at, row.id);
    return;
  }
  const stored = JSON.parse(row.proposal_json) as StoredSuggestion;
  const meta = stored.suggestion;
  const current = parseSpec(report.spec_json);
  const stale = "The report changed since this was suggested; suggest it again";
  const query = meta ? current.queries.find((item) => item.key === meta.queryKey) : undefined;
  if (!meta || !query || query.sql !== meta.baseSql || parametersHash(current) !== meta.parametersSha256) return fail(row, stale);
  const sql = stored.spec.queries.find((item) => item.key === meta.queryKey)?.sql;
  const result = stored.results[meta.queryKey];
  const applied = sql && result ? applyPatch(current, { ops: [{ op: "update_query", key: meta.queryKey, sql }] }, "user") : null;
  if (!applied?.ok || !result) return fail(row, stale);
  if (checkColumns({ blocks: applied.spec.blocks.filter((block) => readsKey(block, meta.queryKey)) }, new Map([[meta.queryKey, result]])).length) return fail(row, stale);
  const shape = checkSpecShape(forValidation(applied.spec));
  if (!shape.ok) return fail(row, stale);
  const moved: StoredSuggestion = { ...stored, spec: onlyReaders(reattach(shape.spec, applied.spec), current, meta.queryKey) };
  db.query("UPDATE report_instructions SET status = 'proposed', proposal_json = ?, base_spec_sha256 = ?, base_revision = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
    .run(JSON.stringify(moved), specHash(report.spec_json), report.revision, at, row.id);
  audit(row.author_id, null, "reports.query.suggest_rebased", { reportId: row.report_id, instructionId: row.id, queryKey: meta.queryKey });
}
