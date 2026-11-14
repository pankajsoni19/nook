import { db, now } from "../db";
import { userRole } from "../team/userRole";
import { isValidTimeZone } from "../../shared/calendarRecurrence";
import { DATASET_ROW_LIMIT, measureName, type DatasetInfo } from "../../shared/datasets";
import { REPORT_LIMITS, type QueryOutcome, type ReportResult, type ReportSpec, type ResultColumn } from "../../shared/reports";
import type { QueryResultView } from "../../shared/reportsView";
import { todayIn, type BoundParam } from "../../shared/reportParams";
import { bindDatasetQuery, DatasetBindError, parseDatasetQuery, resultColumnType, WORKSPACE_SOURCE_ID, WORKSPACE_SOURCE_NAME, type ReportDatasetQuery } from "../../shared/reportsWorkspace";
import { DatasetError, datasetDef, listDatasets, runDatasetQuery } from "../datasets/registry";
import type { DatasourceRow } from "./datasources";
import { ReportError } from "./errors";
import { logger } from "../log";

/**
 * "This workspace" as a Reports data source (docs/plan/WORKSPACE_MODULES.md §D.8, W3-REPORTS,
 * D1060–D1069, T600–T605).
 *
 * The source is not a row of `report_datasources` (that table is ClickHouse endpoints an admin
 * configures; D1060): a report says `reports.source = 'workspace'` and reads as data source
 * `workspace` everywhere a report names its source. Code that runs a report's queries gets
 * WORKSPACE_ROW from `usableDatasource("workspace")`, and the runner (runner.ts `runGuarded`) sends a
 * statement for it here instead of to ClickHouse: the saved "SQL" is a structured dataset query (JSON),
 * run by the dataset registry with the access of the person the run is for (`userId`). No SQL is ever
 * accepted (T600): a text that is not a structured query is refused before anything runs.
 *
 * Every reader's numbers are their own (Q3, D1061): `liveResults` computes a report's results when a
 * reader opens it, with their access, and stored results of a workspace report keep no rows (113's
 * triggers, D1062), so nothing computed with one person's access is ever shown to another.
 */

const slog = logger("reports");

/** What the reports code sees as the workspace's data source row (never stored). */
export const WORKSPACE_ROW: DatasourceRow = {
  id: WORKSPACE_SOURCE_ID, name: WORKSPACE_SOURCE_NAME, kind: "workspace", url: "nook://workspace", username: "", password_ct: null, database: "workspace",
  allowlist_json: "[]", max_rows: DATASET_ROW_LIMIT, timeout_s: 20, enabled: 1, schema_synced_at: null, schema_table_count: 0, schema_truncated: 0,
  schema_error: null, revision: 1, created_by: null, created_at: "", updated_at: "", agent_use: "off"
};

export const isWorkspaceRow = (row: Pick<DatasourceRow, "kind">) => row.kind === "workspace";

/** SQL: a report row's data source id as the API shows it (`workspace` for a workspace report). */
export const reportSourceSql = (alias = "r") => `CASE WHEN ${alias}.source = 'workspace' THEN '${WORKSPACE_SOURCE_ID}' ELSE ${alias}.datasource_id END`;

/** A report row read with `SELECT *`: its data source id as the reports code uses it. */
export function withSource<T extends { datasource_id: string | null; source?: string | null }>(row: T): T {
  return row.source === "workspace" ? { ...row, datasource_id: WORKSPACE_SOURCE_ID } : row;
}

/** Whether a person may use the workspace source at all: any dataset their role can query. */
export const workspaceAvailable = (userId: string) => {
  const role = userRole(userId);
  return role !== null && role !== "guest" && listDatasets(role).length > 0;
};

/** The datasets a person can query (what the widget editor and the AI see). */
export const workspaceDatasets = (userId: string): DatasetInfo[] => {
  const role = userRole(userId);
  return role ? listDatasets(role) : [];
};

/** The output columns of a structured query, in the registry's order: dimensions, the bucket, then measures. */
function outputColumns(query: ReportDatasetQuery): ResultColumn[] {
  const def = datasetDef(query.dataset);
  const columns = new Map((def?.columns ?? []).map((column) => [column.name, column]));
  const out: ResultColumn[] = [];
  for (const name of query.dimensions ?? []) out.push({ name, type: resultColumnType(columns.get(name)?.type ?? "string") });
  if (query.timeBucket) out.push({ name: "bucket", type: resultColumnType("bucket", { bucket: query.timeBucket }) });
  for (const measure of query.measures) out.push({ name: measureName(measure), type: resultColumnType(measure.column ? columns.get(measure.column)?.type ?? "number" : "number", { measure: measure.fn }) });
  return out;
}

export type WorkspaceRunOptions = { userId: string; maxRows: number; params?: readonly BoundParam[]; timeZone?: string };

/**
 * Runs one saved workspace query for `userId` with their access (T600, T601). Throws ReportError
 * (400 INVALID) for a text that is not a structured query, a placeholder of no parameter, or what the
 * registry refuses (an unknown dataset or column, a measure the column does not allow).
 */
export function runWorkspaceQuery(text: string, options: WorkspaceRunOptions): QueryOutcome {
  const started = Date.now();
  const parsed = parseDatasetQuery(text);
  if (!parsed.ok) throw new ReportError(400, "INVALID", parsed.error);
  const role = userRole(options.userId);
  if (!role || role === "guest") throw new ReportError(403, "FORBIDDEN", "Reports on this workspace are for members");
  const zone = options.timeZone && isValidTimeZone(options.timeZone) ? options.timeZone : parsed.query.tz && isValidTimeZone(parsed.query.tz) ? parsed.query.tz : "UTC";
  let bound;
  try {
    bound = bindDatasetQuery(parsed.query, options.params ?? [], todayIn(zone));
  } catch (error) {
    if (error instanceof DatasetBindError) throw new ReportError(400, "INVALID", error.message);
    throw error;
  }
  const limit = Math.max(1, Math.min(options.maxRows, DATASET_ROW_LIMIT, bound.limit ?? DATASET_ROW_LIMIT));
  const query = { ...bound, tz: bound.tz ?? zone, limit };
  let result;
  try {
    result = runDatasetQuery(query, { userId: options.userId, role });
  } catch (error) {
    if (error instanceof DatasetError) throw new ReportError(400, "INVALID", error.message);
    throw error;
  }
  const columns = outputColumns(parsed.query);
  return {
    class: "select", columns, rows: result.rows, truncated: result.truncated, sentSql: JSON.stringify(query), chQueryId: "", rowsRead: null, bytesRead: null, ms: Date.now() - started,
    ...(options.params?.length ? { params: Object.fromEntries(options.params.map((param) => [param.name, param.value])) } : {})
  };
}

/**
 * A workspace report's results as `userId` sees them now (D1061): every saved query run with their
 * access and the bound parameters. Nothing is stored; a query that fails shows as failed.
 */
export function liveResults(spec: ReportSpec, userId: string, bound: readonly BoundParam[], timeZone: string): QueryResultView[] {
  return spec.queries.map((query) => {
    const createdAt = now();
    const base = { runId: "live", queryKey: query.key, sql: query.sql, rowsRead: null, bytesRead: null, chQueryId: null, createdAt } as const;
    try {
      const outcome = runWorkspaceQuery(query.sql, { userId, maxRows: REPORT_LIMITS.storedRows, params: bound, timeZone });
      const result: ReportResult = { ...base, sentSql: outcome.sentSql, columns: outcome.columns, rows: outcome.rows, rowCount: outcome.rows.length, truncated: outcome.truncated, ms: outcome.ms, error: null, errorCode: null, params: outcome.params ?? null };
      return { queryKey: query.key, result, failed: null, stale: false };
    } catch (error) {
      const known = error instanceof ReportError ? error : null;
      if (!known) slog.error("Workspace report query failed", error);
      const failed: ReportResult = { ...base, sentSql: null, columns: [], rows: [], rowCount: 0, truncated: false, ms: null, error: known?.message ?? "The query failed", errorCode: known?.code ?? "INTERNAL", params: null };
      return { queryKey: query.key, result: null, failed, stale: false };
    }
  });
}

/** Whether a report row is on the workspace source (a `SELECT *` row or a mapped one). */
export const isWorkspaceReport = (row: { datasource_id?: string | null; source?: string | null }) => row.source === "workspace" || row.datasource_id === WORKSPACE_SOURCE_ID;

/** The report's stored source, by id (for code that holds only the id). */
export const reportIsWorkspace = (reportId: string) => (db.query("SELECT source FROM reports WHERE id = ?").get(reportId) as { source?: string } | null)?.source === "workspace";

/** One line per dataset column for the AI prompt: name, type, groupable, measures. */
export function datasetCatalogText(datasets: readonly DatasetInfo[]): string {
  if (!datasets.length) return "No datasets are available to you.";
  return datasets.map((info) => [
    `### ${info.id} — ${info.label}`,
    info.description,
    `Time column: ${info.timeColumn ?? "none (no timeRange or timeBucket)"}`,
    ...info.columns.map((column) => `- ${column.name} (${column.type}${column.dimension ? ", groupable" : ""}${column.measures?.length ? `, measures: ${column.measures.join("/")}` : ""}): ${column.label}`)
  ].join("\n")).join("\n\n");
}

/** What the catalog tools answer on the workspace source (the datasets are in the prompt instead). */
export const notOnWorkspace = (what: string) => new ReportError(400, "INVALID", `${what} is not available on This workspace: the datasets and their columns are listed in the prompt; test a structured query with run_sql`);

/**
 * MCP (T603): an API key reads a workspace report's numbers only for datasets whose module read scope
 * it holds (as `query_dataset` requires), so `reports:read` never widens a key to Contacts or Time.
 * Null when the key may read the query's dataset; else the scope it lacks.
 */
export function missingDatasetScope(text: string, hasScope: (scope: string) => boolean): string | null {
  const parsed = parseDatasetQuery(text);
  if (!parsed.ok) return null;
  const def = datasetDef(parsed.query.dataset);
  return def && !hasScope(def.readScope) ? def.readScope : null;
}
