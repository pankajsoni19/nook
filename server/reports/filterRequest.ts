import { audit } from "../db";
import type { ReportSpec } from "../../shared/reports";
import { bindValues, DATE_PRESET_LABELS, DATE_PRESETS, defaultValues, PARAM_ID, PARAM_LIMITS, placeholdersIn, placeholdersOf, type DatePreset } from "../../shared/reportParams";
import { FILTER_LIMITS, REMOVABLE_FILTER_TYPES, type AddFilterRequest, type FilterColumn, type FilterColumnsView, type FilterKind, type FilterNarrowSkipped, type FilterNumbers, type FilterPreview, type RemovableFilterType, type ReportInstruction } from "../../shared/reportsEdit";
import { ownedReport } from "./access";
import { tableAllowed } from "./allowlist";
import { queryIdFor } from "./clickhouse";
import { allowlistOf, usableDatasource, type DatasourceRow } from "./datasources";
import { asReportError, ReportError } from "./errors";
import { queryTables, usedQueries } from "./filterChecks";
import { addInstruction } from "./instructions";
import { runOptionsQuery } from "./params";
import { runGuarded } from "./runner";
import { describeTables } from "./schemaCatalog";
import { parseSpec } from "./service";
import { sqlIdentifier, sqlString } from "./sqlGuard";
import { reportTimeZone, reportToday } from "./paramZone";


/**
 * Add filter and Remove filter (lane FILTERS, D534, D535; docs/plan/REPORT_FILTERS.md F3).
 *
 * - **Columns.** The owner picks a column of a table the report's queries read (`classify(sql).tables`,
 *   on the data source's allowlist), from the schema catalog. v1 offers text, enum, and integer columns
 *   as a multi-select whose default is All (`[]`), so the default results must not change (later: text
 *   contains, date ranges, and, D671, number ranges on any numeric column, starting at Any). Columns named
 *   or commented like personal data are flagged (`sensitive`) and hidden by the sheet unless asked for.
 * - **Options.** Nook writes the options query from catalog identifiers only (quoted), never from text:
 *   `SELECT toString(col) AS value FROM db.table GROUP BY value ORDER BY count() DESC LIMIT 200`. It runs
 *   through the guard first and must return a row; a column over FILTER_LIMITS.distinct values is refused.
 * - **The request** is an instruction with `request_json` (migration 066) for the edit agent, which must
 *   add exactly that parameter and put the filter into the queries that read the table; edit.ts checks
 *   the patch here (`filterPatchErrors`) and, after the usual validation, the default results
 *   (`filterIdentityChecks`, D535) before a proposal is stored. It is never auto-applied.
 */

const SENSITIVE = /(e-?mail|phone|mobile|msisdn|token|secret|passw|api_?key|ssn|card_?num|iban|salary)/i;

/** The multi-select type a column binds as (null: not offered in v1, e.g. dates, floats, arrays). */
export function filterChType(type: string): string | null {
  let inner = type.trim();
  for (let match = /^(LowCardinality|Nullable)\((.*)\)$/.exec(inner); match; match = /^(LowCardinality|Nullable)\((.*)\)$/.exec(inner)) inner = match[2]!.trim();
  if (inner === "String" || /^FixedString\(\d+\)$/.test(inner) || /^Enum(8|16)?\(/.test(inner)) return "Array(String)";
  if (/^Int(8|16|32)$/.test(inner)) return "Array(Int32)";
  if (inner === "Int64") return "Array(Int64)";
  if (/^UInt(8|16|32)$/.test(inner)) return "Array(UInt32)";
  if (inner === "UInt64") return "Array(UInt64)";
  return null;
}

/** A column type without its LowCardinality and Nullable wrappers. */
function innerType(type: string): string {
  let inner = type.trim();
  for (let match = /^(LowCardinality|Nullable)\((.*)\)$/.exec(inner); match; match = /^(LowCardinality|Nullable)\((.*)\)$/.exec(inner)) inner = match[2]!.trim();
  return inner;
}

/** D570: whether a column is a day or a time (a date range filters it by day). */
export function isDateType(type: string): boolean {
  return /^(Date|Date32|DateTime|DateTime64)(\(.*\))?$/.test(innerType(type));
}

/** D671: whether a column holds numbers a range can filter (floats, decimals, and integers of any width). */
export function isNumberType(type: string): boolean {
  const inner = innerType(type);
  return /^(Float32|Float64|BFloat16)$/.test(inner) || /^Decimal(32|64|128|256)?\(/.test(inner) || /^U?Int(8|16|32|64|128|256)$/.test(inner);
}

/**
 * D672: the zone a DateTime column's day is read in: the zone its type names (`DateTime('UTC')`,
 * `DateTime64(3, 'Asia/Kolkata')`), null for a DateTime without one (the data source's own zone), and
 * undefined for a Date (a day has no zone).
 */
export function dateTimeZoneOf(type: string): string | null | undefined {
  const inner = innerType(type);
  const match = /^DateTime(?:64)?\((?:\s*\d+\s*,)?\s*'([^']+)'\s*\)$/.exec(inner);
  if (match) return match[1]!;
  return /^DateTime(64)?(\(\s*\d+\s*\))?$/.test(inner) ? null : undefined;
}

/** D569, D570, D671: what Add filter offers for a column type: text a list or "contains", whole numbers a list or a range, other numbers a range, dates a date range. */
export function filterKinds(type: string): FilterKind[] {
  if (isDateType(type)) return ["date_range"];
  const chType = filterChType(type);
  if (!chType) return isNumberType(type) ? ["number_range"] : [];
  if (chType === "Array(String)") return ["multi_select", "text"];
  return isNumberType(type) ? ["multi_select", "number_range"] : ["multi_select"];
}

/** A column as the agent's condition names it (a plain name as is, anything else quoted). */
const columnRef = (column: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(column) ? column : sqlIdentifier(column);

/**
 * D568–D570, D671, D672: the exact condition the edit agent puts in each query that reads the table,
 * built from identifiers: a multi-select `(empty(p) OR col IN p)` (with exclusion `(col IN p) != p_not`),
 * text contains `positionCaseInsensitive`, a date range by day (in `zone` when the report's differs from
 * the data source's), and a number range that keeps every row, NULL and NaN too, while both ends are open.
 */
export function filterCondition(kind: FilterKind, id: string, column: string, chType: string, exclude = false, zone: string | null = null): string {
  const col = columnRef(column);
  if (kind === "text") return `(empty({${id}:String}) OR positionCaseInsensitive(toString(${col}), {${id}:String}) > 0)`;
  if (kind === "date_range") return `${zone ? `toDate(${col}, ${sqlString(zone)})` : `toDate(${col})`} BETWEEN {${id}_from:Date} AND {${id}_to:Date}`;
  if (kind === "number_range") return `(({${id}_min:Float64} = -inf AND {${id}_max:Float64} = inf) OR ${col} BETWEEN {${id}_min:Float64} AND {${id}_max:Float64})`;
  const placeholder = `{${id}:${chType}}`;
  return exclude ? `(empty(${placeholder}) OR (${col} IN ${placeholder}) != {${id}_not:UInt8})` : `(empty(${placeholder}) OR ${col} IN ${placeholder})`;
}

/**
 * D562: an existing select or multi-select a new filter's choices may follow ("Narrow by Country").
 * D673: `operand` is what the narrowed options query compares with the parent's values: the quoted
 * column, or the parent's own expression of it (`toString(lower(country))`).
 */
export type NarrowParent = { paramId: string; label: string; column: string; type: "select" | "multi_select"; chType: string; operand: string; expression?: string };

/**
 * The options query for a column, from catalog identifiers only. D562: narrowed by existing filters on
 * the same table, it reads them (a linked filter, D560): a multi-select as `(empty(p) OR col IN p)` (All
 * keeps every value), a select as `col = p`.
 */
export function optionsQueryFor(table: string, column: string, narrow: readonly NarrowParent[] = []): string {
  const [db, name] = table.split(".") as [string, string];
  const where = narrow.map((parent) => {
    const placeholder = `{${parent.paramId}:${parent.chType}}`;
    // D568: a parent that leaves its picks out narrows to the values it keeps.
    return parent.type === "multi_select" ? `(empty(${placeholder}) OR (${parent.operand} IN ${placeholder}) != {${parent.paramId}_not:UInt8})` : `${parent.operand} = ${placeholder}`;
  });
  return `SELECT toString(${sqlIdentifier(column)}) AS value FROM ${sqlIdentifier(db)}.${sqlIdentifier(name)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} GROUP BY value ORDER BY count() DESC LIMIT ${PARAM_LIMITS.options}`;
}

/** The index just past a quoted string, identifier, or name that starts at `start` (backslash and doubled-quote escapes). */
function pastQuoted(sql: string, start: number): number {
  const quote = sql[start]!;
  for (let at = start + 1; at < sql.length; at += 1) {
    if (sql[at] === "\\") { at += 1; continue; }
    if (sql[at] === quote) {
      if (sql[at + 1] === quote) { at += 1; continue; }
      return at + 1;
    }
  }
  return sql.length;
}

/** D673: the first item an options query selects, without its alias (null when the text is not a plain `SELECT … FROM`). */
export function firstSelectItem(sql: string): string | null {
  const head = /^\s*SELECT\s+(?:DISTINCT\s+)?/i.exec(sql);
  if (!head) return null;
  const start = head[0].length;
  let depth = 0;
  let end = -1;
  for (let at = start; at < sql.length;) {
    const char = sql[at]!;
    if (char === "'" || char === "\"" || char === "`") { at = pastQuoted(sql, at); continue; }
    if (char === "(") depth += 1;
    else if (char === ")") { depth -= 1; if (depth < 0) return null; }
    else if (depth === 0 && char === ",") { end = at; break; }
    else if (depth === 0 && /[Ff]/.test(char) && !/[A-Za-z0-9_]/.test(sql[at - 1] ?? " ") && /^FROM\b/i.test(sql.slice(at, at + 5))) { end = at; break; }
    at += 1;
  }
  if (end < 0) return null;
  const item = sql.slice(start, end).trim().replace(/\s+AS\s+(?:`(?:[^`\\]|\\.)+`|"(?:[^"\\]|\\.)+"|[A-Za-z_][A-Za-z0-9_]*)$/i, "").trim();
  return item || null;
}

const EXPRESSION_WORDS = new Set(["case", "when", "then", "else", "end", "and", "or", "not", "in", "is", "null", "like", "ilike", "between", "interval", "true", "false", "as", "distinct",
  "second", "minute", "hour", "day", "week", "month", "quarter", "year", "inf", "nan", "asc", "desc", "both", "leading", "trailing", "from"]);
const unquoteName = (raw: string) => raw.startsWith("`") || raw.startsWith("\"") ? raw.slice(1, -1).replace(/\\(.)/g, "$1").replace(/``|""/g, (pair) => pair[0]!) : raw;

/** D673: what an options query lists: one column of its table, as is (`expression` null) or through an expression; else why not. */
export type OptionSource = { column: string; expression: string | null } | { reason: string };
export function optionSourceOf(sql: string): OptionSource {
  const item = firstSelectItem(sql);
  if (!item) return { reason: "its choices query is not a plain SELECT … FROM" };
  if (/--|\/\*/.test(item)) return { reason: "its choices column has a comment in it" };
  const names = new Set<string>();
  const tokens = [...item.matchAll(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`(?:[^`\\]|\\.|``)+`|\d[\w.]*|[A-Za-z_][A-Za-z0-9_]*|->|\S/g)].map((match) => match[0]);
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at]!;
    if (token === "{") return { reason: "its choices column reads other filters" };
    if (token.startsWith("'") || /^\d/.test(token)) continue;
    if (!/^[A-Za-z_`"]/.test(token)) continue;
    const bare = /^[A-Za-z_]/.test(token);
    if (bare && token.toLowerCase() === "select") return { reason: "its choices column holds a subquery" };
    const next = tokens[at + 1];
    // A function name, a table qualifier (`t.col` reads col), a lambda's parameter, or a type after AS (`CAST(x AS String)`).
    if (next === "(" || next === "." || next === "->" || (bare && EXPRESSION_WORDS.has(token.toLowerCase()))) continue;
    if (bare && tokens[at - 1]?.toLowerCase() === "as") continue;
    names.add(unquoteName(token));
  }
  if (names.size === 0) return { reason: "its choices are not read from a column" };
  if (names.size > 1) return { reason: `its choices read ${names.size} columns (${[...names].slice(0, 3).join(", ")})` };
  const column = [...names][0]!;
  const plain = new RegExp(String.raw`^(?:toString\(\s*)?(?:${column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|\`${column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`)\s*\)?$`);
  const balanced = !/^toString\(/.test(item) || /\)$/.test(item);
  return { column, expression: plain.test(item) && balanced ? null : item };
}

/** The column an options query lists, when it reads one column of its table (as is, or through an expression, D673). */
export function optionColumnOf(sql: string): string | null {
  const source = optionSourceOf(sql);
  return "column" in source ? source.column : null;
}

/**
 * D562, D673: the report's selects and multi-selects a new filter on `table` can follow, and why the
 * others cannot. A parent qualifies when its options query reads only `table` and lists one of its
 * columns: as is when the column binds as the parameter's type (the condition compares the column), or
 * through an expression or `toString` when the parameter is text (the condition compares
 * `toString(<its expression>)`, so a pick matches the rows the parent's own list was read from).
 * `catalog` is every column of `table` by name (with its type); `columns` the ones Add filter offers.
 */
export function narrowChoices(spec: Pick<ReportSpec, "parameters">, table: string, columns: readonly FilterColumn[], catalog: ReadonlyMap<string, string>, database: string, except?: string): { offered: NarrowParent[]; skipped: FilterNarrowSkipped[] } {
  const offered: NarrowParent[] = [];
  const skipped: FilterNarrowSkipped[] = [];
  for (const param of spec.parameters) {
    if (param.type !== "select" && param.type !== "multi_select") continue;
    const skip = (reason: string) => { skipped.push({ paramId: param.id, label: param.label, reason }); };
    const tables = queryTables(param.optionsQuery, database);
    if (!tables.length) { skip("its choices query could not be read"); continue; }
    if (tables.length > 1) { skip(`its choices come from ${tables.length} tables`); continue; }
    if (tables[0] !== table) { skip(`its choices come from ${tables[0]}, not ${table}`); continue; }
    const source = optionSourceOf(param.optionsQuery);
    if ("reason" in source) { skip(source.reason); continue; }
    if (source.column === except) { skip("it lists the same column"); continue; }
    if (!catalog.has(source.column)) { skip(`its choices read ${source.column}, which ${table} does not have`); continue; }
    const listType = param.type === "multi_select" ? param.chType : `Array(${param.chType})`;
    const found = columns.find((item) => item.table === table && item.column === source.column);
    const base = { paramId: param.id, label: param.label, column: source.column, type: param.type, chType: param.chType };
    if (source.expression === null && found?.chType === listType) offered.push({ ...base, operand: sqlIdentifier(source.column) });
    else if (listType === "Array(String)") {
      const expression = source.expression ?? sqlIdentifier(source.column);
      offered.push({ ...base, operand: /^toString\(/i.test(expression) && source.expression !== null ? expression : `toString(${expression})`, ...(source.expression !== null ? { expression: source.expression } : {}) });
    } else skip(source.expression === null ? `its choices are ${elementOf(listType)} and ${source.column} is ${catalog.get(source.column)}` : "its choices are numbers worked out by an expression, which only a text filter can follow");
  }
  return { offered, skipped };
}
const elementOf = (listType: string) => listType.replace(/^Array\((.*)\)$/, "$1");

/** D562: the parents a new filter on `table` can follow (narrowChoices' offered ones). */
export function narrowParents(spec: Pick<ReportSpec, "parameters">, table: string, columns: readonly FilterColumn[], database: string, except?: string, catalog?: ReadonlyMap<string, string>): NarrowParent[] {
  const known = catalog ?? new Map(columns.filter((item) => item.table === table).map((item) => [item.column, item.type]));
  return narrowChoices(spec, table, columns, known, database, except).offered;
}

/** A parameter id and label from a column name ("plan_tier" → plan_tier, "Plan tier"), unique among the report's. */
export function suggestedFilter(column: string, taken: readonly string[]): { id: string; label: string } {
  let base = column.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "").slice(0, 26) || "filter";
  if (!PARAM_ID.test(base)) base = "filter";
  let id = base;
  for (let n = 2; taken.includes(id) || taken.some((other) => ["_from", "_to", "_min", "_max", "_not"].some((suffix) => other === `${id}${suffix}`)); n += 1) id = `${base}_${n}`;
  const words = column.replace(/[_\-.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  const label = (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, PARAM_LIMITS.label) || "Filter";
  return { id, label };
}

/** GET …/filters/columns (the owner): the columns Add filter offers, most-read tables first. */
export async function filterColumns(reportId: string, userId: string): Promise<FilterColumnsView> {
  return (await readColumns(reportId, userId)).view;
}

/** The columns Add filter offers, and (D673) every column of the read tables by name with its type. */
async function readColumns(reportId: string, userId: string): Promise<{ view: FilterColumnsView; catalog: Map<string, Map<string, string>> }> {
  const report = ownedReport(reportId, userId);
  const spec = parseSpec(report.spec_json);
  const datasource = usableDatasource(report.datasource_id);
  const patterns = allowlistOf(datasource);
  const queries = usedQueries(spec);
  const readers = new Map<string, string[]>();
  for (const query of queries) {
    for (const table of queryTables(query.sql, datasource.database)) {
      const [db, name] = table.split(".") as [string, string];
      if (!tableAllowed(patterns, db, name)) continue;
      readers.set(table, [...(readers.get(table) ?? []), query.key]);
    }
  }
  const { tables } = await describeTables(datasource, [...readers.keys()]);
  const columns: FilterColumn[] = [];
  const catalog = new Map<string, Map<string, string>>();
  for (const table of tables) {
    const name = `${table.db}.${table.name}`;
    catalog.set(name, new Map(table.columns.map((column) => [column.name, column.type])));
    for (const column of table.columns) {
      // D570: dates too (a date range); D569: text also as "contains"; D671: numbers as a range.
      const kinds = filterKinds(column.type);
      if (!kinds.length) continue;
      const chType = kinds[0] === "date_range" ? "Date" : kinds[0] === "number_range" ? "Float64" : filterChType(column.type)!;
      columns.push({ table: name, column: column.name, type: column.type, chType, comment: column.comment ?? "", readBy: readers.get(name) ?? [], sensitive: SENSITIVE.test(column.name) || SENSITIVE.test(column.comment ?? ""), kinds });
    }
  }
  columns.sort((a, b) => b.readBy.length - a.readBy.length || a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
  return { view: { columns, queries: queries.length, slotsLeft: Math.max(0, PARAM_LIMITS.parameters - spec.parameters.length) }, catalog };
}

type Found = { found: FilterColumn; spec: ReportSpec; datasource: DatasourceRow; columns: FilterColumn[]; catalog: ReadonlyMap<string, string> };

async function findColumn(reportId: string, userId: string, table: string, column: string): Promise<Found> {
  const { view, catalog } = await readColumns(reportId, userId);
  const found = view.columns.find((item) => item.table === table && item.column === column);
  if (!found) throw new ReportError(400, "INVALID", "Pick a text, number, or date column of a table this report's queries read");
  const report = ownedReport(reportId, userId);
  return { found, spec: parseSpec(report.spec_json), datasource: usableDatasource(report.datasource_id), columns: view.columns, catalog: catalog.get(table) ?? new Map() };
}

/** D562, D673: the filters a new list on the column can follow, and why the others cannot. */
const choicesFor = (context: Found) => narrowChoices(context.spec, context.found.table, context.columns, context.catalog, context.datasource.database, context.found.column);

/** D562: the parents a request names (`narrowBy`, parameter ids), each one an offered Narrow by choice (400 otherwise). */
function pickedParents(context: Found, narrowBy: readonly string[] | undefined): NarrowParent[] {
  if (!narrowBy?.length) return [];
  const { offered, skipped } = choicesFor(context);
  return [...new Set(narrowBy)].map((paramId) => {
    const parent = offered.find((item) => item.paramId === paramId);
    if (!parent) {
      const why = skipped.find((item) => item.paramId === paramId)?.reason;
      throw new ReportError(400, "INVALID", `${paramId.slice(0, 30)} is not a filter on ${context.found.table} this one can follow${why ? `: ${why}` : ""}`);
    }
    return parent;
  });
}

const KIND_WORDS: Record<FilterKind, string> = { multi_select: "a list", text: "text contains", date_range: "a date range", number_range: "a number range" };

/** The kind asked for, one the column offers (its first by default). */
function pickedKind(found: FilterColumn, kind: FilterKind | undefined): FilterKind {
  if (kind === undefined) return found.kinds[0]!;
  if (!found.kinds.includes(kind)) throw new ReportError(400, "INVALID", `${found.column} cannot be filtered as ${KIND_WORDS[kind]}`);
  return kind;
}

/** The bind type a kind's parameter has (a list keeps the column's). */
const kindChType = (kind: FilterKind, found: FilterColumn) => kind === "date_range" ? "Date" : kind === "text" ? "String" : kind === "number_range" ? "Float64" : found.chType;

/**
 * Runs the options query and counts the distinct values (refused past FILTER_LIMITS.distinct or with no
 * rows). D562: a narrowed options query runs with its parents at their defaults (All for a multi-select).
 * D569: text contains reads the same sample (the owner's preview and the check's values) but readers
 * never get a list, so the distinct limit does not apply.
 */
async function readOptions(context: Found, userId: string, reportId: string, narrow: readonly NarrowParent[] = [], kind: FilterKind = "multi_select"): Promise<{ optionsQuery: string; options: string[]; truncated: boolean; distinct: number }> {
  const { datasource, found, spec } = context;
  const optionsQuery = optionsQueryFor(found.table, found.column, narrow);
  const short = reportId.replace(/-/g, "").slice(0, 12);
  try {
    let distinct = 0;
    if (kind === "multi_select") {
      const counted = await runGuarded(datasource, `SELECT uniq(${sqlIdentifier(found.column)}) AS distinct_values FROM ${found.table.split(".").map(sqlIdentifier).join(".")}`, { classes: ["select"], maxRows: 1, queryId: queryIdFor("fltn", short, crypto.randomUUID().slice(0, 8)), userId });
      distinct = Number(counted.rows[0]?.[0] ?? 0);
      if (distinct > FILTER_LIMITS.distinct) throw new ReportError(400, "INVALID", `${found.column} has about ${distinct.toLocaleString("en-US")} different values; a filter takes columns with at most ${FILTER_LIMITS.distinct.toLocaleString("en-US")}`);
    }
    const bound = bindValues(spec.parameters, defaultValues(spec.parameters), reportToday(reportId));
    const read = await runOptionsQuery(datasource, optionsQuery, { userId, queryId: queryIdFor("fltopt", short, crypto.randomUUID().slice(0, 8)), params: bound });
    if (!read.options.length) throw new ReportError(400, "INVALID", `${found.table} has no values in ${found.column} to filter by`);
    return { optionsQuery, options: read.options, truncated: read.truncated, distinct };
  } catch (error) {
    throw asReportError(error);
  }
}

const tableRef = (table: string) => table.split(".").map(sqlIdentifier).join(".");

/**
 * D672: the zone a DateTime column's days must be taken in when it is not the data source's own: the
 * report's zone (where the presets resolve), or null when the two agree (and for a Date, which has no
 * zone). A DateTime whose type names no zone is read in the data source's (`timezone()`, asked once).
 */
async function dayZoneFor(context: Found, userId: string, reportId: string): Promise<string | null> {
  const own = dateTimeZoneOf(context.found.type);
  if (own === undefined) return null;
  const report = reportTimeZone(reportId);
  let source = own;
  if (source === null) {
    try {
      // Read from the table: a SELECT without FROM reads system.one, which the guard refuses. An empty table has no days to shift.
      const outcome = await runGuarded(context.datasource, `SELECT timezone() AS zone FROM ${tableRef(context.found.table)} LIMIT 1`, { classes: ["select"], maxRows: 1, queryId: queryIdFor("fltz", reportId.replace(/-/g, "").slice(0, 12), crypto.randomUUID().slice(0, 8)), userId });
      source = typeof outcome.rows[0]?.[0] === "string" ? outcome.rows[0][0] as string : null;
    } catch (error) {
      throw asReportError(error);
    }
  }
  return source === report ? null : report;
}

/** D570: a date column's first and last day (the preview's range), D672: in `zone` when given. */
async function readDays(context: Found, userId: string, reportId: string, zone: string | null): Promise<{ from: string; to: string } | null> {
  const { datasource, found } = context;
  const col = sqlIdentifier(found.column);
  const day = zone ? `toDate(${col}, ${sqlString(zone)})` : `toDate(${col})`;
  try {
    const outcome = await runGuarded(datasource, `SELECT toString(min(${day})) AS first_day, toString(max(${day})) AS last_day FROM ${tableRef(found.table)}`, { classes: ["select"], maxRows: 1, queryId: queryIdFor("fltd", reportId.replace(/-/g, "").slice(0, 12), crypto.randomUUID().slice(0, 8)), userId });
    const [from, to] = outcome.rows[0] ?? [];
    return typeof from === "string" && typeof to === "string" ? { from, to } : null;
  } catch (error) {
    throw asReportError(error);
  }
}

/** D671: a numeric column's lowest, highest, and median finite value (null when it holds none). */
async function readNumbers(context: Found, userId: string, reportId: string): Promise<FilterNumbers | null> {
  const { datasource, found } = context;
  const value = `toFloat64(${sqlIdentifier(found.column)})`;
  try {
    const outcome = await runGuarded(datasource, `SELECT count() AS n, min(${value}) AS low, max(${value}) AS high, median(${value}) AS middle FROM ${tableRef(found.table)} WHERE isFinite(${value})`, { classes: ["select"], maxRows: 1, queryId: queryIdFor("fltr", reportId.replace(/-/g, "").slice(0, 12), crypto.randomUUID().slice(0, 8)), userId });
    const [count, low, high, middle] = (outcome.rows[0] ?? []).map(Number);
    if (!count || ![low, high, middle].every((item) => Number.isFinite(item))) return null;
    return { min: low!, max: high!, median: middle! };
  } catch (error) {
    throw asReportError(error);
  }
}

const takenIds = (spec: ReportSpec) => spec.parameters.flatMap((param) => [param.id, ...placeholdersOf(param).map((item) => item.name)]);

/**
 * POST …/filters/preview (the owner): the options the filter would have, a suggested id and label, and
 * (D562) the existing filters on the same table it can follow (`narrowBy`), with `narrowBy` the ones picked
 * (D673: and `narrowSkipped`, the others with the reason). D569, D570, D671: `kind` picks text contains,
 * a date range, or a number range where the column offers them (a date range previews the column's first
 * and last day, D672 in the report's zone; a number range its lowest, highest, and median value).
 */
export async function previewFilter(reportId: string, userId: string, input: { table: string; column: string; narrowBy?: string[]; kind?: FilterKind }): Promise<FilterPreview> {
  const context = await findColumn(reportId, userId, input.table, input.column);
  const kind = pickedKind(context.found, input.kind);
  const { found, spec } = context;
  const suggested = suggestedFilter(found.column, takenIds(spec));
  const bare = { column: found, optionsQuery: "", sample: [], optionCount: 0, truncated: false, distinct: 0, suggested, narrowBy: [], kind };
  if (kind === "date_range") {
    const zone = await dayZoneFor(context, userId, reportId);
    return { ...bare, range: await readDays(context, userId, reportId, zone), dayZone: zone };
  }
  if (kind === "number_range") return { ...bare, numbers: await readNumbers(context, userId, reportId) };
  const narrow = kind === "multi_select" ? pickedParents(context, input.narrowBy) : [];
  const read = await readOptions(context, userId, reportId, narrow, kind);
  const choices = kind === "multi_select" ? choicesFor(context) : { offered: [], skipped: [] };
  return {
    column: found, optionsQuery: read.optionsQuery, sample: read.options.slice(0, FILTER_LIMITS.sample), optionCount: read.options.length, truncated: read.truncated, distinct: read.distinct, suggested,
    narrowBy: choices.offered.map((parent) => ({ paramId: parent.paramId, label: parent.label, column: parent.column, picked: narrow.some((item) => item.paramId === parent.paramId), ...(parent.expression ? { expression: parent.expression } : {}) })),
    ...(choices.skipped.length ? { narrowSkipped: choices.skipped } : {}),
    kind
  };
}

type Actor = { userId: string; role: string; keyId?: string | null };

const cleanLabel = (label: string) => label.replace(/[\u0000-\u001f\u007f<>{}]+/g, " ").replace(/\s+/g, " ").trim().slice(0, PARAM_LIMITS.label);

function ownerActor(actor: Actor, reportId: string) {
  const report = ownedReport(reportId, actor.userId);
  if (actor.role === "viewer" || actor.role === "guest") throw new ReportError(403, "ROLE_READ_ONLY", "Your role cannot change reports");
  return report;
}

export type AddFilterInput = { table: string; column: string; label?: string; id?: string; narrowBy?: string[]; kind?: FilterKind; exclude?: boolean; preset?: string };

/**
 * POST …/filters (the owner; MCP `add_report_filter`): checks the column and the id, runs the options
 * query (it must return a row), and queues an instruction carrying the structured request. The edit
 * agent's proposal waits in Changes (never auto-applied). D562: `narrowBy` names existing filters on the
 * same table whose picks narrow this one's choices (its options query reads them; the agent adds it after them).
 * D568: `exclude` lets readers leave values out; D569: `kind: "text"` is a text-contains filter; D570:
 * `kind: "date_range"` with a default `preset` (the default results change: reviewed by hand; D672: by
 * day in the report's zone); D671: `kind: "number_range"` (Float64 ends, starting at Any).
 */
export async function requestAddFilter(actor: Actor, reportId: string, input: AddFilterInput): Promise<ReportInstruction> {
  ownerActor(actor, reportId);
  const context = await findColumn(reportId, actor.userId, input.table, input.column);
  const { found, spec } = context;
  const kind = pickedKind(found, input.kind);
  if (spec.parameters.length >= PARAM_LIMITS.parameters) throw new ReportError(409, "LIMIT_REACHED", `A report has at most ${PARAM_LIMITS.parameters} filters`);
  if (!spec.blocks.length) throw new ReportError(409, "INVALID", "The report has no blocks to filter yet");
  const taken = takenIds(spec);
  const suggested = suggestedFilter(found.column, taken);
  const id = input.id ?? suggested.id;
  if (!PARAM_ID.test(id)) throw new ReportError(400, "INVALID", "The filter id must match [a-z][a-z0-9_]{0,29}");
  const provides = placeholdersOf({ id, type: kind, chType: kindChType(kind, found) } as never).map((item) => item.name);
  if ([id, ...provides].some((name) => taken.includes(name))) throw new ReportError(409, "INVALID", `The report already has a parameter ${id}`);
  const label = cleanLabel(input.label ?? suggested.label) || suggested.label;
  let request: AddFilterRequest;
  if (kind === "date_range") {
    const preset = input.preset ?? "30d";
    if (preset === "custom" || !(DATE_PRESETS as readonly string[]).includes(preset)) throw new ReportError(400, "INVALID", `preset must be one of ${DATE_PRESETS.filter((item) => item !== "custom").join(", ")}`);
    const zone = await dayZoneFor(context, actor.userId, reportId);
    request = { kind: "add_filter", type: "date_range", id, label, table: found.table, column: found.column, chType: "Date", optionsQuery: "", preset, condition: filterCondition("date_range", id, found.column, "Date", false, zone), ...(zone ? { zone } : {}) };
  } else if (kind === "number_range") {
    const numbers = await readNumbers(context, actor.userId, reportId);
    request = { kind: "add_filter", type: "number_range", id, label, table: found.table, column: found.column, chType: "Float64", optionsQuery: "", condition: filterCondition("number_range", id, found.column, "Float64"), numbers };
  } else if (kind === "text") {
    const read = await readOptions(context, actor.userId, reportId, [], "text");
    request = { kind: "add_filter", type: "text", id, label, table: found.table, column: found.column, chType: "String", optionsQuery: read.optionsQuery, condition: filterCondition("text", id, found.column, "String") };
  } else {
    const narrow = pickedParents(context, input.narrowBy);
    const read = await readOptions(context, actor.userId, reportId, narrow);
    request = { kind: "add_filter", id, label, table: found.table, column: found.column, chType: found.chType, optionsQuery: read.optionsQuery, ...(input.exclude ? { exclude: true, condition: filterCondition("multi_select", id, found.column, found.chType, true) } : {}) };
  }
  const what = kind === "date_range" ? `, a date range starting at ${DATE_PRESET_LABELS[request.preset as DatePreset] ?? request.preset}${request.zone ? ` (days in ${request.zone})` : ""}` : kind === "number_range" ? ", a number range" : kind === "text" ? ", text contains" : request.exclude ? ", values can be left out" : "";
  const narrowed = request.optionsQuery && placeholdersIn(request.optionsQuery).length ? `, narrowed by ${pickedParents(context, input.narrowBy).map((parent) => parent.label).join(" and ")}` : "";
  const instruction = await addInstruction(actor, reportId, { text: `Add a filter: ${label} (${found.table}.${found.column})${what}${narrowed}`, request });
  audit(actor.userId, null, "reports.filter.request", { reportId, instructionId: instruction.id, kind: "add_filter", type: kind, paramId: id, table: found.table, column: found.column, sensitive: found.sensitive || undefined, ...(request.exclude ? { exclude: true } : {}), ...(input.narrowBy?.length && kind === "multi_select" ? { narrowBy: input.narrowBy } : {}), ...(actor.keyId ? { via: "mcp", keyId: actor.keyId } : {}) });
  return instruction;
}

/**
 * DELETE …/filters/:paramId (the owner, in the app only: D180 keeps removals off MCP): removed by the
 * edit agent. A multi-select, text, or number range filter is checked against its results with the
 * filter at All, empty, or Any; D670: a date range has no window that filters nothing, so its removal is
 * reviewed by hand (each changed query must still run). A select or number has no such value: Changes.
 */
export async function requestRemoveFilter(actor: Actor, reportId: string, paramId: string): Promise<ReportInstruction> {
  const report = ownerActor(actor, reportId);
  const spec = parseSpec(report.spec_json);
  const param = spec.parameters.find((item) => item.id === paramId);
  if (!param) throw new ReportError(404, "NOT_FOUND", "This report has no filter with that id");
  if (!(REMOVABLE_FILTER_TYPES as readonly string[]).includes(param.type)) throw new ReportError(400, "INVALID", "A single select or a number filter has no value that filters nothing, so it is not removed this way; ask for the change in Changes");
  const type = param.type as RemovableFilterType;
  const instruction = await addInstruction(actor, reportId, { text: `Remove the filter ${param.label}`, request: { kind: "remove_filter", id: param.id, label: param.label, ...(type !== "multi_select" ? { type } : {}) } });
  audit(actor.userId, null, "reports.filter.request", { reportId, instructionId: instruction.id, kind: "remove_filter", type, paramId, ...(actor.keyId ? { via: "mcp", keyId: actor.keyId } : {}) });
  return instruction;
}

