import { createHash } from "node:crypto";
import { audit, db, now } from "../db";
import { logger } from "../log";
import { REPORT_LIMITS, type QueryOutcome, type ReportQuery, type ReportResult, type ReportSpec, type ResultColumn, type RunTrigger } from "../../shared/reports";
import {
  bindValues, boundRecord, canonicalValues, declaredPlaceholders, defaultValues, escapeParamString, isDefaultSet, LINKED_OPTIONS, optionParentsOf, PARAM_LIMITS, placeholdersIn, placeholdersOf, quotedElement, readsOf, resolveValues, todayUtc, valueLabel,
  type BoundParam, type ParamOptions, type ParamSetInfo, type ParamValues, type ReportParameter
} from "../../shared/reportParams";
import type { QueryResultView, ReportResultsView } from "../../shared/reportsView";
import { readableReport, type ReportRow } from "./access";
import { queryIdFor } from "./clickhouse";
import { usableDatasource, type DatasourceRow } from "./datasources";
import { asReportError, ReportError } from "./errors";
import {
  BUSY_WAIT_MS, capRows, HEARTBEAT_MS, LEASE_MS, paramsJson, parseParams, pool, REFRESH_CONCURRENCY, reportResults, runQueryId, takeRunLock
} from "./refresh";
import { killQuery, runGuarded } from "./runner";
import { parseSpec } from "./service";
import { classify, GuardError } from "./sqlGuard";
import { reportToday } from "./paramZone";

/**
 * Interactive report parameters (spec v3, D489, docs/plan/REPORT_THEME.md § Parameters).
 *
 * - **Binding.** Queries read parameters only as typed ClickHouse placeholders (`{period_from:Date}`);
 *   runner.ts checks each placeholder against the declared parameters and sends the values as
 *   `param_<name>` (shared/reportParams.ts encodes them), so a value is never SQL text.
 * - **The default set** is what Refresh all, schedules, generation, and version previews run; its
 *   results stay in `report_results`.
 * - **Other sets** (a reader changed the date range or a filter): the values are checked against their
 *   parameters (and a select's against its options), bound on today's date, and keyed by the sha256 of
 *   the canonical bound values. Their results live in `report_param_results`, one per query per set,
 *   shared by everyone who can read the report. D532: a query that reads only default values answers
 *   with the default results, and any other is found by its own key (`queryHashOf`: its SQL and the
 *   values it reads) in any set, so a filter change runs only the queries that read it. A result is
 *   fresh while its SQL is the saved SQL and it is newer than the report's last default run; a run
 *   fills the missing ones.
 * - **Runs.** Read access is enough (D489): a run takes the report's one-run lock (409 RUN_IN_PROGRESS
 *   while another runs; the client retries), runs under the caller's query slots and the data source's
 *   limits, and is rate-limited per person (PARAM_RUNS.perMinute). Its run row is removed when it ends
 *   (the Runs history stays the owner's refreshes); the audit log keeps `reports.params.run`.
 * - **Pruning.** The PARAM_RUNS.setsKept most recently used sets per report are kept, none unused for
 *   PARAM_RUNS.setDays days.
 */

const plog = logger("reports");

export const PARAM_RUNS = {
  /** Runs (cache misses) one person may start per minute, across reports. */
  perMinute: 20,
  setsKept: 20,
  setDays: 7,
  /** A select's options are re-read after this long (and after every default refresh). */
  optionsMaxAgeMs: 6 * 60 * 60_000
} as const;

// ------------------------------------------------------------------------------- spec checks

/**
 * Spec shape checks for parameters (checkSpecShape): unique ids, defaults of their type, min ≤ max,
 * every placeholder a query writes declared with its exact type, and every parameter used.
 */
export function parameterErrors(params: readonly ReportParameter[], queries: ReadonlyArray<Pick<ReportQuery, "key" | "sql">>): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const param of params) {
    if (ids.has(param.id)) errors.push(`parameters: the id ${param.id} is used twice`);
    ids.add(param.id);
    const resolved = resolveValues([param], { [param.id]: param.default });
    if (resolved.problems.length) errors.push(`parameter ${param.id}: default ${resolved.problems[0]!.slice(param.id.length + 2)}`);
    if (param.type === "number" && param.min !== undefined && param.max !== undefined && param.min > param.max) errors.push(`parameter ${param.id}: min is more than max`);
  }
  const names = new Map<string, string>();
  for (const param of params) {
    for (const item of placeholdersOf(param)) {
      const other = names.get(item.name);
      if (other !== undefined && other !== param.id) errors.push(`parameter ${param.id}: its placeholder {${item.name}} is also parameter ${other}'s; rename one`);
      names.set(item.name, param.id);
    }
  }
  const declared = declaredPlaceholders(params);
  const used = new Set<string>();
  for (const query of queries) {
    let placeholders: Array<{ name: string; type: string }>;
    try {
      placeholders = classify(query.sql, { params: true }).placeholders;
    } catch (error) {
      if (!(error instanceof GuardError)) throw error;
      // The guard says so when the query runs; only placeholder problems are reported here.
      if (/query parameter/i.test(error.message)) errors.push(`query ${query.key}: ${error.message}`);
      continue;
    }
    for (const placeholder of placeholders) {
      const known = declared.get(placeholder.name);
      if (!known) errors.push(`query ${query.key}: {${placeholder.name}:${placeholder.type}} is not a declared parameter (declare it in parameters; a date range ${"`id`"} gives {id_from:Date} and {id_to:Date})`);
      else if (known.type !== placeholder.type) errors.push(`query ${query.key}: {${placeholder.name}:${placeholder.type}} must be written {${placeholder.name}:${known.type}} (the type of parameter ${known.param})`);
      else used.add(known.param);
    }
  }
  // D560: an options query may read parameters declared before it (linked filters), each with its exact type.
  params.forEach((param, at) => {
    if (param.type !== "select" && param.type !== "multi_select") return;
    let placeholders: Array<{ name: string; type: string }>;
    try {
      placeholders = classify(param.optionsQuery, { params: true }).placeholders;
    } catch (error) {
      if (!(error instanceof GuardError)) throw error;
      if (/query parameter/i.test(error.message)) errors.push(`parameter ${param.id}: its optionsQuery: ${error.message}`);
      return;
    }
    const earlier = declaredPlaceholders(params.slice(0, at));
    for (const placeholder of placeholders) {
      const known = earlier.get(placeholder.name);
      if (!known) errors.push(`parameter ${param.id}: its optionsQuery reads {${placeholder.name}:${placeholder.type}}, which no parameter declared before it provides (an options query may read only earlier parameters; move ${param.id} after the one it reads)`);
      else if (known.type !== placeholder.type) errors.push(`parameter ${param.id}: its optionsQuery must write {${placeholder.name}:${known.type}} (the type of parameter ${known.param})`);
    }
  });
  for (const param of params) if (!used.has(param.id)) errors.push(`parameter ${param.id}: no query reads it; use ${param.type === "date_range" ? `{${param.id}_from:Date} and {${param.id}_to:Date}` : `{${param.id}:${param.chType}}`} in a query's WHERE, or remove it`);
  return errors;
}

/**
 * The sets validation runs every query with (D489): the defaults, and one other set (another date
 * preset; a select's first other option; a multi-select's first option, or All when it has a default),
 * when the parameters allow one.
 */
export function paramSetsToCheck(params: readonly ReportParameter[], options: ReadonlyMap<string, readonly string[]>, today = todayUtc()): { defaults: BoundParam[]; other: { bound: BoundParam[]; label: string } | null } {
  const defaults = defaultValues(params);
  const other: ParamValues = { ...defaults };
  for (const param of params) {
    if (param.type === "date_range") other[param.id] = { preset: param.default.preset === "7d" ? "30d" : "7d" };
    else if (param.type === "select") {
      const choice = options.get(param.id)?.find((option) => option !== param.default);
      if (choice !== undefined) other[param.id] = choice;
    } else if (param.type === "multi_select") {
      const first = options.get(param.id)?.[0];
      other[param.id] = param.default.length ? [] : first !== undefined ? [first] : [];
    }
  }
  const differs = !isDefaultSet(params, other);
  return {
    defaults: bindValues(params, defaults, today),
    other: differs ? { bound: bindValues(params, other, today), label: params.map((param) => `${param.id}=${valueLabel(param, other[param.id]!)}`).join(", ").slice(0, 200) } : null
  };
}

// ----------------------------------------------------------------------------------- options

/**
 * Runs a select's options query through the guard (a SELECT): its first column, at most 200 distinct
 * values. D560: a linked options query reads earlier parameters; `params` binds them (only the
 * placeholders it holds are sent, and every one it holds must be bound).
 */
export async function runOptionsQuery(row: DatasourceRow, sql: string, context: { userId: string; queryId: string; signal?: AbortSignal; params?: readonly BoundParam[] }): Promise<{ options: string[]; truncated: boolean }> {
  const linked = placeholdersIn(sql).length > 0;
  const outcome = await runGuarded(row, sql, { classes: ["select"], maxRows: PARAM_LIMITS.options, queryId: context.queryId, userId: context.userId, signal: context.signal, ...(linked ? { params: context.params ?? [] } : {}) });
  if (!outcome.columns.length) throw new ReportError(400, "INVALID", "An options query must select at least one column");
  rememberOptionColumn(sql, outcome.columns[0]!.name);
  const options = optionTexts(outcome.rows);
  // D491: a full list (200) may be the options query's own LIMIT 200 cutting it; it counts as cut, so search reaches the rest.
  return { options, truncated: outcome.truncated || options.length >= PARAM_LIMITS.options };
}

/** The first column of option rows as the select lists them: distinct, at most 200, each cut at 200 characters. */
function optionTexts(rows: readonly (readonly unknown[])[]): string[] {
  const seen = new Set<string>();
  for (const line of rows) {
    const value = line[0];
    if (value === null || value === undefined) continue;
    const text = (typeof value === "string" ? value : JSON.stringify(value) ?? "").slice(0, PARAM_LIMITS.optionChars);
    seen.add(typeof value === "number" || typeof value === "bigint" ? String(value) : text.replace(/^"(.*)"$/, "$1"));
  }
  return [...seen].slice(0, PARAM_LIMITS.options);
}

// ------------------------------------------------------------------------- option search (D491)

/**
 * Search-as-you-type for a select whose options query has more than 200 values (D491): the options
 * query, its trailing LIMIT taken off, is wrapped and filtered on its first column with a bound ILIKE
 * pattern (`toString(col) ILIKE {nook_search:String}`), through the same guard, at most 200 rows.
 * Read access is enough; searches are rate-limited per person (OPTION_SEARCH.perMinute) and run under
 * the person's query slots. The same wrap checks that a picked value past the first 200 is a real one.
 */
export const OPTION_SEARCH = { perMinute: 60, chars: 100 } as const;

/** An options query's first column name, learned from its last run (the wrap filters on it). */
const optionColumns = new Map<string, string>();
function rememberOptionColumn(sql: string, column: string) {
  optionColumns.delete(sql);
  optionColumns.set(sql, column);
  if (optionColumns.size > 1000) optionColumns.delete(optionColumns.keys().next().value!);
}

/**
 * The options query without its trailing top-level `LIMIT n [OFFSET m]` (or `LIMIT m, n`), so a search
 * reaches every value. Anything else after LIMIT (`BY`, `WITH TIES`) keeps the query as written.
 */
export function unlimitedOptionsSql(sql: string): string {
  const classified = classify(sql, { params: true });
  if (classified.class !== "select") throw new GuardError("NOT_SELECT", "An options query is one SELECT");
  const tokens = classified.tokens;
  let depth = 0;
  let limit = -1;
  tokens.forEach((token, at) => {
    if (token.kind === "punct" && token.text === "(") depth += 1;
    else if (token.kind === "punct" && token.text === ")") depth -= 1;
    else if (depth === 0 && token.kind === "word" && token.value === "limit") limit = at;
  });
  if (limit <= 0) return classified.sql;
  const tail = tokens.slice(limit + 1);
  const plain = tail.length > 0 && tail.every((token) => token.kind === "number" || (token.kind === "punct" && token.text === ",") || (token.kind === "word" && token.value === "offset"));
  if (!plain) return classified.sql;
  return classified.sql.slice(0, tokens[limit]!.start - tokens[0]!.start).trimEnd();
}

/** A column name as a quoted identifier; null for a name the wrap cannot quote safely. */
const quotedColumn = (name: string) => name && !/[`\\\u0000-\u001f\u007f]/.test(name) && name.length <= 200 ? `\`${name}\`` : null;

/** The options query wrapped and filtered on its first column (`filter` is a condition on `col`). */
export function optionsFilterSql(inner: string, column: string, filter: (col: string) => string): string {
  const quoted = quotedColumn(column);
  if (!quoted) throw new ReportError(400, "INVALID", "This filter's choices cannot be searched");
  return `SELECT * FROM (\n${inner}\n) AS nook_options WHERE ${filter(`toString(${quoted})`)}`;
}

/** A substring ILIKE pattern for a search term: `%term%` with `%`, `_`, and `\` escaped. */
export const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

const searches = new Map<string, number[]>();
function searchRateLimit(userId: string, nowMs = Date.now()) {
  const kept = (searches.get(userId) ?? []).filter((at) => nowMs - at < 60_000);
  if (kept.length >= OPTION_SEARCH.perMinute) {
    searches.set(userId, kept);
    throw new ReportError(429, "BUSY", "Too many searches in a minute; wait a moment and try again");
  }
  kept.push(nowMs);
  searches.set(userId, kept);
}

/** Test hook: forget the per-person search counts. */
export const resetOptionSearchLimit = () => searches.clear();

/** The options query's first column: remembered from its last run, else read with a one-row run. */
async function optionColumn(row: DatasourceRow, sql: string, inner: string, context: { userId: string; queryId: string; params?: readonly BoundParam[] }): Promise<string> {
  const known = optionColumns.get(sql);
  if (known) return known;
  const outcome = await runGuarded(row, inner, { classes: ["select"], maxRows: 1, queryId: `${context.queryId}-c`, userId: context.userId, ...(context.params ? { params: context.params } : {}) });
  const column = outcome.columns[0]?.name;
  if (!column) throw new ReportError(400, "INVALID", "An options query must select at least one column");
  rememberOptionColumn(sql, column);
  return column;
}

type SelectParam = Extract<ReportParameter, { type: "select" | "multi_select" }>;

function selectParam(spec: ReportSpec, paramId: string): SelectParam {
  const param = spec.parameters.find((item) => item.id === paramId);
  if (!param || (param.type !== "select" && param.type !== "multi_select")) throw new ReportError(404, "NOT_FOUND", "This report has no select parameter with that id");
  return param;
}

/** A linked filter's parents as bound for its options query (D560). */
export type ParentBinding = { ids: string[]; values: ParamValues; bound: BoundParam[]; hash: string };

/**
 * D560: the parents a select's options query reads, with the reader's values for them (each checked
 * against its parameter: 400 when one does not fit; a missing one is its default), bound on the
 * report's today. Null for a select whose options query reads no parameter.
 */
export function parentBinding(reportId: string, spec: Pick<ReportSpec, "parameters">, param: SelectParam, given: Record<string, unknown> | null | undefined): ParentBinding | null {
  const ids = optionParentsOf(param, spec.parameters);
  if (!ids.length) return null;
  const parents = spec.parameters.filter((item) => ids.includes(item.id));
  const picked = Object.fromEntries(Object.entries(given ?? {}).filter(([key]) => ids.includes(key)));
  const { values, problems } = resolveValues(parents, picked);
  if (problems.length) throw new ReportError(400, "INVALID", `Parameter values refused: ${problems.slice(0, 3).join("; ")}`, { problems: problems.slice(0, 10) });
  const bound = bindValues(parents, values, reportToday(reportId));
  return { ids, values, bound, hash: queryHashOf(param.optionsQuery, bound) };
}

/**
 * GET …/parameters/:paramId/options?q=… (D491): the values of a select's options query whose text holds
 * `q` (case-insensitive), at most 200. An empty `q` is the cached list (reportParamOptions). D560: a
 * linked select's search binds its parents' values (`given`), like its list.
 */
export async function searchParamOptions(reportId: string, userId: string, paramId: string, query: string, given?: Record<string, unknown> | null): Promise<ParamOptions> {
  const report = readableReport(reportId, userId);
  const term = query.trim().slice(0, OPTION_SEARCH.chars);
  if (!term) return reportParamOptions(reportId, userId, paramId, report, given);
  const spec = parseSpec(report.spec_json);
  const param = selectParam(spec, paramId);
  const parents = parentBinding(reportId, spec, param, given);
  const datasource = usableDatasource(report.datasource_id);
  searchRateLimit(userId);
  const queryId = queryIdFor("opts", reportId.replace(/-/g, "").slice(0, 12), paramId, crypto.randomUUID().slice(0, 8));
  try {
    const inner = unlimitedOptionsSql(param.optionsQuery);
    const column = await optionColumn(datasource, param.optionsQuery, inner, { userId, queryId, ...(parents ? { params: parents.bound } : {}) });
    const outcome = await runGuarded(datasource, optionsFilterSql(inner, column, (col) => `${col} ILIKE {nook_search:String}`), {
      classes: ["select"], maxRows: PARAM_LIMITS.options, queryId, userId, params: [...(parents?.bound ?? []), { name: "nook_search", type: "String", value: escapeParamString(likePattern(term)) }]
    });
    return { paramId, options: optionTexts(outcome.rows), truncated: outcome.truncated, error: null, at: now(), query: term, ...(parents ? { parents: parents.values } : {}) };
  } catch (failure) {
    throw asReportError(failure);
  }
}

/** The picked values that are real choices, read past the first 200 (D491): the wrap with `IN {nook_values:Array(String)}`. */
async function existingOptionValues(datasource: DatasourceRow, param: SelectParam, values: readonly string[], userId: string, parents: readonly BoundParam[] = []): Promise<Set<string>> {
  const queryId = queryIdFor("optx", param.id, crypto.randomUUID().slice(0, 8));
  const inner = unlimitedOptionsSql(param.optionsQuery);
  const column = await optionColumn(datasource, param.optionsQuery, inner, { userId, queryId, ...(parents.length ? { params: parents } : {}) });
  const outcome = await runGuarded(datasource, optionsFilterSql(inner, column, (col) => `${col} IN {nook_values:Array(String)}`), {
    classes: ["select"], maxRows: PARAM_LIMITS.selected, queryId, userId, params: [...parents, { name: "nook_values", type: "Array(String)", value: `[${values.map(quotedElement).join(",")}]` }]
  });
  return new Set(optionTexts(outcome.rows));
}

type OptionsRow = { sql: string; values_json: string; truncated: number; error: string | null; created_at: string };

const optionsView = (paramId: string, row: OptionsRow | null, parents?: ParamValues): ParamOptions => {
  let options: string[] = [];
  try { options = row ? (JSON.parse(row.values_json) as unknown[]).filter((item): item is string => typeof item === "string") : []; } catch { options = []; }
  return { paramId, options, truncated: row?.truncated === 1, error: row?.error ?? null, at: row?.created_at ?? null, ...(parents ? { parents } : {}) };
};

/** Runs an options query for the cache: its list, or its error as text (a busy person's refusal is thrown, never cached). */
async function readOptionsList(report: ReportRow, param: SelectParam, userId: string, bound?: readonly BoundParam[]): Promise<{ values: string[]; truncated: boolean; error: string | null }> {
  const datasource = usableDatasource(report.datasource_id);
  try {
    const read = await runOptionsQuery(datasource, param.optionsQuery, { userId, queryId: queryIdFor("opt", report.id.replace(/-/g, "").slice(0, 12), param.id), ...(bound ? { params: bound } : {}) });
    return { values: read.options, truncated: read.truncated, error: null };
  } catch (failure) {
    // A busy person keeps the last list rather than caching the refusal.
    if (failure instanceof ReportError && failure.code === "BUSY") throw failure;
    let error: string;
    try { error = asReportError(failure).message.slice(0, 1000); } catch { error = "The options query failed"; }
    return { values: [], truncated: false, error };
  }
}

/** Whether a cached list may answer: its SQL is the saved one, newer than the last default run, and younger than optionsMaxAgeMs. */
const freshList = (report: ReportRow, row: OptionsRow | null, sql: string) => Boolean(row && row.sql === sql && (!report.last_run_at || row.created_at >= report.last_run_at) && Date.now() - Date.parse(row.created_at) < PARAM_RUNS.optionsMaxAgeMs);

/**
 * A select's options for a reader (GET …/parameters/:paramId/options): the cached list while it is
 * fresh (freshList); else the options query runs again (the caller's query slots; a failure is cached
 * as its error). D560: a linked select's list is per its parents' values (`given`; a missing one is its
 * default), cached in report_param_linked_options by the options query and those bound values, the
 * LINKED_OPTIONS.listsPerReport most recently used kept. A list not cached yet counts against the
 * person's option searches (OPTION_SEARCH.perMinute).
 */
export async function reportParamOptions(reportId: string, userId: string, paramId: string, report = readableReport(reportId, userId), given?: Record<string, unknown> | null): Promise<ParamOptions> {
  const spec = parseSpec(report.spec_json);
  const param = selectParam(spec, paramId);
  const parents = parentBinding(reportId, spec, param, given);
  if (parents) return linkedOptions(report, param, parents, userId);
  const cached = db.query("SELECT sql, values_json, truncated, error, created_at FROM report_param_options WHERE report_id = ? AND param_id = ?").get(reportId, paramId) as OptionsRow | null;
  if (freshList(report, cached, param.optionsQuery)) return optionsView(paramId, cached);
  const read = await readOptionsList(report, param, userId);
  const at = now();
  db.query(`INSERT INTO report_param_options (report_id, param_id, sql, values_json, truncated, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (report_id, param_id) DO UPDATE SET sql = excluded.sql, values_json = excluded.values_json, truncated = excluded.truncated, error = excluded.error, created_at = excluded.created_at`)
    .run(reportId, paramId, param.optionsQuery, JSON.stringify(read.values), read.truncated ? 1 : 0, read.error, at);
  return optionsView(paramId, { sql: param.optionsQuery, values_json: JSON.stringify(read.values), truncated: read.truncated ? 1 : 0, error: read.error, created_at: at });
}

/** D560: a linked select's list for its parents' values (cached per report, parameter, and parents' hash). */
async function linkedOptions(report: ReportRow, param: SelectParam, parents: ParentBinding, userId: string): Promise<ParamOptions> {
  const cached = db.query("SELECT sql, values_json, truncated, error, created_at FROM report_param_linked_options WHERE report_id = ? AND param_id = ? AND parents_hash = ?")
    .get(report.id, param.id, parents.hash) as OptionsRow | null;
  const at = now();
  if (freshList(report, cached, param.optionsQuery)) {
    db.query("UPDATE report_param_linked_options SET last_used_at = ? WHERE report_id = ? AND param_id = ? AND parents_hash = ?").run(at, report.id, param.id, parents.hash);
    return optionsView(param.id, cached, parents.values);
  }
  searchRateLimit(userId);
  const read = await readOptionsList(report, param, userId, parents.bound);
  db.query(`INSERT INTO report_param_linked_options (report_id, param_id, parents_hash, sql, values_json, truncated, error, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (report_id, param_id, parents_hash) DO UPDATE SET sql = excluded.sql, values_json = excluded.values_json, truncated = excluded.truncated, error = excluded.error,
    created_at = excluded.created_at, last_used_at = excluded.last_used_at`)
    .run(report.id, param.id, parents.hash, param.optionsQuery, JSON.stringify(read.values), read.truncated ? 1 : 0, read.error, at, at);
  db.query(`DELETE FROM report_param_linked_options WHERE report_id = $reportId AND rowid NOT IN (
    SELECT rowid FROM report_param_linked_options WHERE report_id = $reportId ORDER BY last_used_at DESC, rowid DESC LIMIT $kept)`).run({ reportId: report.id, kept: LINKED_OPTIONS.listsPerReport });
  return optionsView(param.id, { sql: param.optionsQuery, values_json: JSON.stringify(read.values), truncated: read.truncated ? 1 : 0, error: read.error, created_at: at }, parents.values);
}

/**
 * Refuses a select value that is not one of its options (when they could be read): no set is cached
 * for values nobody can pick. D560: a linked select's values are checked against its list for the
 * set's own parent values.
 */
async function assertOptionValues(report: ReportRow, spec: ReportSpec, values: ParamValues, userId: string) {
  for (const param of spec.parameters) {
    if (param.type !== "select" && param.type !== "multi_select") continue;
    const value = values[param.id];
    const picked = param.type === "select" ? (value === param.default ? [] : [value as string]) : (value as string[]).filter((item) => !param.default.includes(item));
    if (!picked.length) continue;
    const options = await reportParamOptions(report.id, userId, param.id, report, values);
    if (options.error) continue;
    const known = new Set(options.options);
    // D491: a list cut at 200 may not hold a value found by search; ask ClickHouse whether it is a choice.
    const beyond = picked.filter((item) => !known.has(item));
    if (beyond.length && options.truncated) {
      try {
        const parents = parentBinding(report.id, spec, param, values);
        for (const item of await existingOptionValues(usableDatasource(report.datasource_id), param, beyond, userId, parents?.bound)) known.add(item);
      } catch (failure) {
        const error = asReportError(failure);
        if (error.code === "BUSY") throw error;
      }
    }
    const unknown = picked.find((item) => !known.has(item));
    if (unknown !== undefined) throw new ReportError(400, "INVALID", `${unknown.slice(0, 60)} is not one of the choices for ${param.label}`, { paramId: param.id });
  }
}


// ----------------------------------------------------------------------------------- sets

/** The cache key of a set: the sha256 of its canonical bound values. */
export const setHashOf = (bound: readonly BoundParam[]) => createHash("sha256").update(JSON.stringify([...bound].sort((a, b) => a.name.localeCompare(b.name)).map((item) => [item.name, item.type, item.value]))).digest("hex");

export type ResolvedSet = { values: ParamValues; bound: BoundParam[]; hash: string; isDefault: boolean };

/** Values given by a reader (the URL, MCP) for this spec: refused (400) when one does not fit its parameter. */
export function resolveSet(spec: ReportSpec, given: Record<string, unknown> | null | undefined, today = todayUtc()): ResolvedSet {
  const { values, problems } = resolveValues(spec.parameters, given);
  if (problems.length) throw new ReportError(400, "INVALID", `Parameter values refused: ${problems.slice(0, 3).join("; ")}`, { problems: problems.slice(0, 10) });
  const bound = bindValues(spec.parameters, values, today);
  return { values, bound, hash: setHashOf(bound), isDefault: isDefaultSet(spec.parameters, values) };
}

type ParamResultRow = {
  id: string; report_id: string; set_hash: string; query_key: string; sql: string; sent_sql: string | null; params_json: string | null; columns_json: string; rows_json: string;
  row_count: number; truncated: number; rows_read: number | null; bytes_read: number | null; ch_query_id: string | null; ms: number | null; error: string | null; error_code: string | null; created_at: string;
  /** 066 (D532): the query's own result key; NULL on rows from before it. */ query_hash: string | null;
};

function parseArray<T>(json: string): T[] {
  try { const value: unknown = JSON.parse(json); return Array.isArray(value) ? value as T[] : []; } catch { return []; }
}

const paramResultView = (row: ParamResultRow): ReportResult => ({
  runId: "", queryKey: row.query_key, sql: row.sql, sentSql: row.sent_sql, columns: parseArray<ResultColumn>(row.columns_json), rows: parseArray<unknown[]>(row.rows_json),
  rowCount: row.row_count, truncated: row.truncated === 1, rowsRead: row.rows_read, bytesRead: row.bytes_read, chQueryId: row.ch_query_id, ms: row.ms,
  error: row.error, errorCode: row.error_code, createdAt: row.created_at, params: parseParams(row.params_json)
});

/** The queries a set's results come from: those a block reads (an unused query never runs for a set). */
const setQueries = (spec: ReportSpec) => {
  const used = new Set(spec.blocks.flatMap((block) => block.type === "markdown" ? [] : [block.queryKey, ...(block.type === "kpi" ? [block.compareTo?.queryKey, block.sparkline?.queryKey] : [])]).filter((key): key is string => Boolean(key)));
  return spec.queries.filter((query) => used.has(query.key));
};

/**
 * D532: a query's result key: the sha256 of its SQL and the bound values of only the placeholders it
 * reads. Two sets that differ only in a filter a query does not read share its result.
 */
export function queryHashOf(sql: string, bound: readonly BoundParam[]): string {
  const names = new Set(placeholdersIn(sql).map((item) => item.name));
  const read = bound.filter((item) => names.has(item.name)).sort((a, b) => a.name.localeCompare(b.name)).map((item) => [item.name, item.type, item.value]);
  return createHash("sha256").update(JSON.stringify([sql, read])).digest("hex");
}

/** D532: whether every parameter a query reads holds its default in these values (its default result answers). */
export function readsOnlyDefaults(spec: Pick<ReportSpec, "parameters">, sql: string, values: ParamValues): boolean {
  const byId = new Map(spec.parameters.map((param) => [param.id, param]));
  return readsOf(sql, spec.parameters).every((id) => {
    const param = byId.get(id)!;
    return canonicalValues([param], { [id]: values[id] ?? param.default }) === canonicalValues([param], {});
  });
}

type SetResults = { results: QueryResultView[]; missing: string[]; /** Sets whose rows answered (their last use is touched). */ usedSets: Set<string> };

/**
 * A set's results (D532): a query that reads only default values answers with the default results
 * (`report_results`, as Refresh all left them); any other is found by its own key (`queryHashOf`) in
 * any cached set of the report. `missing` names the used queries with no fresh result under their key.
 */
function setResults(report: ReportRow, spec: ReportSpec, set: ResolvedSet, defaults: readonly QueryResultView[]): SetResults {
  const hashes = new Map(spec.queries.map((query) => [query.key, queryHashOf(query.sql, set.bound)]));
  const rows = new Map<string, ParamResultRow>();
  // Newest first: the first row per query and key is its latest run.
  for (const row of db.query("SELECT * FROM report_param_results WHERE report_id = ? AND query_hash IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC, rowid DESC")
    .all(report.id, JSON.stringify([...new Set(hashes.values())])) as ParamResultRow[]) {
    if (row.query_hash === hashes.get(row.query_key) && !rows.has(row.query_key)) rows.set(row.query_key, row);
  }
  const byKey = new Map(defaults.map((item) => [item.queryKey, item]));
  const used = new Set(setQueries(spec).map((query) => query.key));
  const missing: string[] = [];
  const usedSets = new Set<string>();
  const results = spec.queries.map((query): QueryResultView => {
    const fromDefault = byKey.get(query.key);
    if (readsOnlyDefaults(spec, query.sql, set.values) && fromDefault && (fromDefault.result || fromDefault.failed)) return fromDefault;
    const row = rows.get(query.key);
    const fresh = Boolean(row && row.sql === query.sql && (!report.last_run_at || row.created_at >= report.last_run_at));
    if (!fresh && used.has(query.key)) missing.push(query.key);
    if (!row || row.sql !== query.sql) return { queryKey: query.key, result: null, failed: null, stale: false };
    usedSets.add(row.set_hash);
    const view = paramResultView(row);
    return row.error === null ? { queryKey: query.key, result: view, failed: null, stale: !fresh } : { queryKey: query.key, result: null, failed: view, stale: false };
  });
  return { results, missing, usedSets };
}

/** Marks the sets whose rows answered as used now (pruning keeps the most recently used). */
function touchSets(reportId: string, hashes: Iterable<string>) {
  const list = [...hashes];
  if (list.length) db.query("UPDATE report_param_sets SET last_used_at = ? WHERE report_id = ? AND set_hash IN (SELECT value FROM json_each(?))").run(now(), reportId, JSON.stringify(list));
}

export type ParamResultsView = ReportResultsView & { set: ParamSetInfo };

/**
 * GET …/results with parameter values: the default set's stored results (as today), or a non-default
 * set's cached results with the keys a run would fill (`set.missing`). Nothing runs here.
 */
export function paramResults(reportId: string, userId: string, given: Record<string, unknown> | null | undefined): ParamResultsView {
  const report = readableReport(reportId, userId);
  const spec = parseSpec(report.spec_json);
  const set = resolveSet(spec, given, reportToday(reportId));
  const base = reportResults(reportId, userId);
  const info = (missing: string[]): ParamSetInfo => ({ isDefault: set.isDefault, values: set.values, bound: boundRecord(set.bound), missing });
  if (set.isDefault) return { ...base, set: info([]) };
  const cached = setResults(report, spec, set, base.results);
  touchSets(reportId, cached.usedSets);
  return { results: cached.results, running: base.running, ...(base.timeZone ? { timeZone: base.timeZone } : {}), ...(base.reach ? { reach: base.reach } : {}), set: info(cached.missing) };
}

// ----------------------------------------------------------------------------------- runs

const recent = new Map<string, number[]>();

/** Per person: PARAM_RUNS.perMinute runs a minute (429 BUSY past it). */
function rateLimit(userId: string, nowMs = Date.now()) {
  const kept = (recent.get(userId) ?? []).filter((at) => nowMs - at < 60_000);
  if (kept.length >= PARAM_RUNS.perMinute) {
    recent.set(userId, kept);
    throw new ReportError(429, "BUSY", "Too many filter changes in a minute; wait a moment and try again");
  }
  kept.push(nowMs);
  recent.set(userId, kept);
}

/** Test hook: forget the per-person run counts. */
export const resetParamRateLimit = () => recent.clear();

const UPSERT_RESULT = () => db.query(`INSERT INTO report_param_results (id, report_id, set_hash, query_key, sql, sent_sql, params_json, columns_json, rows_json, row_count, truncated,
  rows_read, bytes_read, ch_query_id, ms, error, error_code, created_at, query_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (report_id, set_hash, query_key) DO UPDATE SET id = excluded.id, sql = excluded.sql, sent_sql = excluded.sent_sql, params_json = excluded.params_json, query_hash = excluded.query_hash,
  columns_json = excluded.columns_json, rows_json = excluded.rows_json, row_count = excluded.row_count, truncated = excluded.truncated, rows_read = excluded.rows_read,
  bytes_read = excluded.bytes_read, ch_query_id = excluded.ch_query_id, ms = excluded.ms, error = excluded.error, error_code = excluded.error_code, created_at = excluded.created_at`);

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

async function runOne(datasource: DatasourceRow, report: ReportRow, query: ReportQuery, set: ResolvedSet, runId: string, userId: string, controller: AbortController, inFlight: Set<string>): Promise<boolean> {
  const queryId = runQueryId(runId, query.key);
  const started = Date.now();
  inFlight.add(queryId);
  try {
    let outcome: QueryOutcome;
    for (;;) {
      try {
        outcome = await runGuarded(datasource, query.sql, { classes: ["select"], maxRows: Math.min(datasource.max_rows, REPORT_LIMITS.storedRows), queryId, userId, signal: controller.signal, params: set.bound });
        break;
      } catch (error) {
        if (error instanceof ReportError && error.code === "BUSY" && !controller.signal.aborted && Date.now() - started < BUSY_WAIT_MS) { await sleep(250, controller.signal); continue; }
        throw error;
      }
    }
    const capped = capRows(outcome.rows);
    UPSERT_RESULT().run(crypto.randomUUID(), report.id, set.hash, query.key, query.sql, outcome.sentSql, paramsJson(outcome.params), JSON.stringify(outcome.columns).slice(0, 200_000), capped.json, capped.kept,
      outcome.truncated || capped.cut ? 1 : 0, outcome.rowsRead, outcome.bytesRead, outcome.chQueryId.slice(0, 128), outcome.ms, null, null, now(), queryHashOf(query.sql, set.bound));
    return true;
  } catch (error) {
    let code = "CLICKHOUSE";
    let message = "The query failed";
    if (controller.signal.aborted) { code = "CANCELLED"; message = "The run stopped before this query finished"; }
    else {
      try {
        const known = asReportError(error);
        code = known.code === "GUARD" && typeof known.details.guard === "string" ? `GUARD:${known.details.guard}` : known.code;
        message = known.message;
      } catch { message = error instanceof Error ? `The query failed (${error.name})` : message; }
    }
    try {
      UPSERT_RESULT().run(crypto.randomUUID(), report.id, set.hash, query.key, query.sql, null, paramsJson(boundRecord(set.bound)), "[]", "[]", 0, 0, null, null, queryId, Date.now() - started, message.slice(0, 2000), code.slice(0, 40), now(), queryHashOf(query.sql, set.bound));
    } catch { /* the set was pruned meanwhile */ }
    return false;
  } finally {
    inFlight.delete(queryId);
  }
}

/** Keeps the PARAM_RUNS.setsKept most recently used sets of a report and drops those unused for PARAM_RUNS.setDays (their results go too). */
export function pruneParamSets(reportId?: string, nowMs = Date.now()): number {
  const cutoff = new Date(nowMs - PARAM_RUNS.setDays * 86_400_000).toISOString();
  let removed = db.query("DELETE FROM report_param_sets WHERE last_used_at < $cutoff AND ($reportId IS NULL OR report_id = $reportId)").run({ cutoff, reportId: reportId ?? null }).changes;
  const reports = reportId ? [{ report_id: reportId }] : db.query("SELECT report_id FROM report_param_sets GROUP BY report_id HAVING count(*) > ?").all(PARAM_RUNS.setsKept) as Array<{ report_id: string }>;
  for (const { report_id } of reports) {
    removed += db.query(`DELETE FROM report_param_sets WHERE report_id = $reportId AND set_hash NOT IN (
      SELECT set_hash FROM report_param_sets WHERE report_id = $reportId ORDER BY last_used_at DESC, set_hash LIMIT $kept)`).run({ reportId: report_id, kept: PARAM_RUNS.setsKept }).changes;
  }
  return removed;
}

/**
 * Runs a report with a reader's parameter values (POST …/param-runs, MCP): the set's missing queries
 * (or every one with `force`), under the report's run lock, and answers with the set's results. The
 * default set never runs here (it is Refresh all's, the owner's).
 */
export async function runParamSet(userId: string, reportId: string, given: Record<string, unknown> | null | undefined, options: { trigger: RunTrigger; force?: boolean }): Promise<ParamResultsView> {
  const report = readableReport(reportId, userId);
  const spec = parseSpec(report.spec_json);
  const set = resolveSet(spec, given, reportToday(reportId));
  if (set.isDefault) return paramResults(reportId, userId, given);
  await assertOptionValues(report, spec, set.values, userId);
  const cached = setResults(report, spec, set, reportResults(reportId, userId).results);
  // D532: `force` re-runs the used queries this set reads non-default values in (the rest answer with the default results).
  const keys = options.force ? setQueries(spec).filter((query) => !readsOnlyDefaults(spec, query.sql, set.values)).map((query) => query.key) : cached.missing;
  if (!keys.length) return paramResults(reportId, userId, given);
  const datasource = usableDatasource(report.datasource_id);
  rateLimit(userId);
  const run = takeRunLock({ reportId, kind: "refresh", trigger: options.trigger, userId, queryKeys: [`~p:${set.hash.slice(0, 12)}`, ...keys] });
  const at = now();
  db.query(`INSERT INTO report_param_sets (report_id, set_hash, values_json, bound_json, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (report_id, set_hash) DO UPDATE SET last_used_at = excluded.last_used_at`).run(reportId, set.hash, canonicalValues(spec.parameters, set.values), JSON.stringify(boundRecord(set.bound)), at, at);
  const controller = new AbortController();
  const inFlight = new Set<string>();
  const heartbeat = setInterval(() => {
    const renewed = db.query("UPDATE report_runs SET lease_until = ? WHERE id = ? AND status = 'running'").run(new Date(Date.now() + LEASE_MS).toISOString(), run.id).changes;
    if (!renewed && !controller.signal.aborted) controller.abort();
  }, HEARTBEAT_MS);
  (heartbeat as { unref?: () => void }).unref?.();
  controller.signal.addEventListener("abort", () => { for (const queryId of inFlight) void killQuery(datasource, queryId); }, { once: true });
  const queries = spec.queries.filter((query) => keys.includes(query.key));
  let succeeded = 0;
  try {
    await pool(queries, REFRESH_CONCURRENCY, async (query) => {
      if (controller.signal.aborted) return;
      if (await runOne(datasource, report, query, set, run.id, userId, controller, inFlight)) succeeded += 1;
    });
  } finally {
    clearInterval(heartbeat);
    // The lock is released by removing the run: a reader's filter change is not a refresh in Runs.
    db.query("DELETE FROM report_runs WHERE id = ?").run(run.id);
  }
  audit(userId, null, "reports.params.run", { reportId, setHash: set.hash.slice(0, 16), trigger: options.trigger, queries: queries.length, failed: queries.length - succeeded });
  if (plog.enabled("debug")) plog.debug("Parameter set run", { report: reportId.slice(0, 8), set: set.hash.slice(0, 8), queries: queries.length, failed: queries.length - succeeded });
  try { pruneParamSets(reportId); } catch { /* retention is best effort */ }
  return paramResults(reportId, userId, given);
}
