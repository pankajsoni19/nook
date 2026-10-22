import { audit } from "../db";
import type { ReportSpec } from "../../shared/reports";
import { bindValues, DATE_PRESET_LABELS, DATE_PRESETS, defaultValues, PARAM_ID, PARAM_LIMITS, placeholdersIn, placeholdersOf, type DatePreset } from "../../shared/reportParams";
import { FILTER_LIMITS, type AddFilterRequest, type FilterColumn, type FilterColumnsView, type FilterKind, type FilterPreview, type ReportInstruction } from "../../shared/reportsEdit";
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
import { sqlIdentifier } from "./sqlGuard";
import { reportToday } from "./paramZone";


/**
 * Add filter and Remove filter (lane FILTERS, D534, D535; docs/plan/REPORT_FILTERS.md F3).
 *
 * - **Columns.** The owner picks a column of a table the report's queries read (`classify(sql).tables`,
 *   on the data source's allowlist), from the schema catalog. v1 offers text, enum, and integer columns
 *   as a multi-select whose default is All (`[]`), so the default results must not change. Columns named
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

/** D570: whether a column is a day or a time (a date range filters it by day). */
export function isDateType(type: string): boolean {
  let inner = type.trim();
  for (let match = /^(LowCardinality|Nullable)\((.*)\)$/.exec(inner); match; match = /^(LowCardinality|Nullable)\((.*)\)$/.exec(inner)) inner = match[2]!.trim();
  return /^(Date|Date32|DateTime|DateTime64)(\(.*\))?$/.test(inner);
}

/** D569, D570: what Add filter offers for a column type: text a list or "contains", whole numbers a list, dates a date range. */
export function filterKinds(type: string): FilterKind[] {
  if (isDateType(type)) return ["date_range"];
  const chType = filterChType(type);
  if (!chType) return [];
  return chType === "Array(String)" ? ["multi_select", "text"] : ["multi_select"];
}

/** A column as the agent's condition names it (a plain name as is, anything else quoted). */
const columnRef = (column: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(column) ? column : sqlIdentifier(column);

/**
 * D568–D570: the exact condition the edit agent puts in each query that reads the table, built from
 * identifiers: a multi-select `(empty(p) OR col IN p)` (with exclusion `(col IN p) != p_not`), text
 * contains `positionCaseInsensitive`, and a date range by day.
 */
export function filterCondition(kind: FilterKind, id: string, column: string, chType: string, exclude = false): string {
  const col = columnRef(column);
  if (kind === "text") return `(empty({${id}:String}) OR positionCaseInsensitive(toString(${col}), {${id}:String}) > 0)`;
  if (kind === "date_range") return `toDate(${col}) BETWEEN {${id}_from:Date} AND {${id}_to:Date}`;
  const placeholder = `{${id}:${chType}}`;
  return exclude ? `(empty(${placeholder}) OR (${col} IN ${placeholder}) != {${id}_not:UInt8})` : `(empty(${placeholder}) OR ${col} IN ${placeholder})`;
}

/** D562: an existing select or multi-select a new filter's choices may follow ("Narrow by Country"). */
export type NarrowParent = { paramId: string; label: string; column: string; type: "select" | "multi_select"; chType: string };

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
    return parent.type === "multi_select" ? `(empty(${placeholder}) OR (${sqlIdentifier(parent.column)} IN ${placeholder}) != {${parent.paramId}_not:UInt8})` : `${sqlIdentifier(parent.column)} = ${placeholder}`;
  });
  return `SELECT toString(${sqlIdentifier(column)}) AS value FROM ${sqlIdentifier(db)}.${sqlIdentifier(name)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} GROUP BY value ORDER BY count() DESC LIMIT ${PARAM_LIMITS.options}`;
}

/** The column an options query lists, when its first column is one plain column (or `toString` of one) of a single table. */
const OPTION_COLUMN = /^\s*SELECT\s+(?:DISTINCT\s+)?(?:toString\(\s*)?(`(?:[^`\\]|\\.)+`|[A-Za-z_][A-Za-z0-9_]*)\s*\)?\s+(?:AS\s+`?[A-Za-z_][A-Za-z0-9_]*`?\s+)?FROM\s/i;
export function optionColumnOf(sql: string): string | null {
  const match = OPTION_COLUMN.exec(sql);
  if (!match) return null;
  const raw = match[1]!;
  return raw.startsWith("`") ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
}

/**
 * D562: the report's selects and multi-selects whose options query lists one column of `table` (the
 * only table it reads) that binds as the parameter's type, so a new filter on the table can follow them.
 */
export function narrowParents(spec: Pick<ReportSpec, "parameters">, table: string, columns: readonly FilterColumn[], database: string, except?: string): NarrowParent[] {
  const out: NarrowParent[] = [];
  for (const param of spec.parameters) {
    if (param.type !== "select" && param.type !== "multi_select") continue;
    const tables = queryTables(param.optionsQuery, database);
    const column = optionColumnOf(param.optionsQuery);
    if (tables.length !== 1 || tables[0] !== table || !column || column === except) continue;
    const found = columns.find((item) => item.table === table && item.column === column);
    if (!found || found.chType !== (param.type === "multi_select" ? param.chType : `Array(${param.chType})`)) continue;
    out.push({ paramId: param.id, label: param.label, column, type: param.type, chType: param.chType });
  }
  return out;
}

/** A parameter id and label from a column name ("plan_tier" → plan_tier, "Plan tier"), unique among the report's. */
export function suggestedFilter(column: string, taken: readonly string[]): { id: string; label: string } {
  let base = column.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "").slice(0, 26) || "filter";
  if (!PARAM_ID.test(base)) base = "filter";
  let id = base;
  for (let n = 2; taken.includes(id) || taken.some((other) => other === `${id}_from` || other === `${id}_to`); n += 1) id = `${base}_${n}`;
  const words = column.replace(/[_\-.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  const label = (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, PARAM_LIMITS.label) || "Filter";
  return { id, label };
}

/** GET …/filters/columns (the owner): the columns Add filter offers, most-read tables first. */
export async function filterColumns(reportId: string, userId: string): Promise<FilterColumnsView> {
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
  for (const table of tables) {
    const name = `${table.db}.${table.name}`;
    for (const column of table.columns) {
      // D570: dates too (a date range); D569: text also as "contains".
      const kinds = filterKinds(column.type);
      if (!kinds.length) continue;
      const chType = kinds[0] === "date_range" ? "Date" : filterChType(column.type)!;
      columns.push({ table: name, column: column.name, type: column.type, chType, comment: column.comment ?? "", readBy: readers.get(name) ?? [], sensitive: SENSITIVE.test(column.name) || SENSITIVE.test(column.comment ?? ""), kinds });
    }
  }
  columns.sort((a, b) => b.readBy.length - a.readBy.length || a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
  return { columns, queries: queries.length, slotsLeft: Math.max(0, PARAM_LIMITS.parameters - spec.parameters.length) };
}

type Found = { found: FilterColumn; spec: ReportSpec; datasource: DatasourceRow; columns: FilterColumn[] };

async function findColumn(reportId: string, userId: string, table: string, column: string): Promise<Found> {
  const view = await filterColumns(reportId, userId);
  const found = view.columns.find((item) => item.table === table && item.column === column);
  if (!found) throw new ReportError(400, "INVALID", "Pick a text, whole-number, or date column of a table this report's queries read");
  const report = ownedReport(reportId, userId);
  return { found, spec: parseSpec(report.spec_json), datasource: usableDatasource(report.datasource_id), columns: view.columns };
}

/** D562: the parents a request names (`narrowBy`, parameter ids), each one an offered Narrow by choice (400 otherwise). */
function pickedParents(context: Found, narrowBy: readonly string[] | undefined): NarrowParent[] {
  if (!narrowBy?.length) return [];
  const offered = narrowParents(context.spec, context.found.table, context.columns, context.datasource.database, context.found.column);
  return [...new Set(narrowBy)].map((paramId) => {
    const parent = offered.find((item) => item.paramId === paramId);
    if (!parent) throw new ReportError(400, "INVALID", `${paramId.slice(0, 30)} is not a filter on ${context.found.table} this one can follow`);
    return parent;
  });
}

/** The kind asked for, one the column offers (its first by default). */
function pickedKind(found: FilterColumn, kind: FilterKind | undefined): FilterKind {
  if (kind === undefined) return found.kinds[0]!;
  if (!found.kinds.includes(kind)) throw new ReportError(400, "INVALID", `${found.column} cannot be filtered as ${kind === "date_range" ? "a date range" : kind === "text" ? "text contains" : "a list"}`);
  return kind;
}

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

/** D570: a date column's first and last day (the preview's range). */
async function readDays(context: Found, userId: string, reportId: string): Promise<{ from: string; to: string } | null> {
  const { datasource, found } = context;
  const col = sqlIdentifier(found.column);
  try {
    const outcome = await runGuarded(datasource, `SELECT toString(min(toDate(${col}))) AS first_day, toString(max(toDate(${col}))) AS last_day FROM ${found.table.split(".").map(sqlIdentifier).join(".")}`, { classes: ["select"], maxRows: 1, queryId: queryIdFor("fltd", reportId.replace(/-/g, "").slice(0, 12), crypto.randomUUID().slice(0, 8)), userId });
    const [from, to] = outcome.rows[0] ?? [];
    return typeof from === "string" && typeof to === "string" ? { from, to } : null;
  } catch (error) {
    throw asReportError(error);
  }
}

const takenIds = (spec: ReportSpec) => spec.parameters.flatMap((param) => [param.id, ...placeholdersOf(param).map((item) => item.name)]);

/**
 * POST …/filters/preview (the owner): the options the filter would have, a suggested id and label, and
 * (D562) the existing filters on the same table it can follow (`narrowBy`), with `narrowBy` the ones picked.
 * D569, D570: `kind` picks text contains or a date range where the column offers them (a date range
 * previews the column's first and last day instead of values).
 */
export async function previewFilter(reportId: string, userId: string, input: { table: string; column: string; narrowBy?: string[]; kind?: FilterKind }): Promise<FilterPreview> {
  const context = await findColumn(reportId, userId, input.table, input.column);
  const kind = pickedKind(context.found, input.kind);
  const { found, spec, datasource, columns } = context;
  const suggested = suggestedFilter(found.column, takenIds(spec));
  if (kind === "date_range") {
    return { column: found, optionsQuery: "", sample: [], optionCount: 0, truncated: false, distinct: 0, suggested, narrowBy: [], kind, range: await readDays(context, userId, reportId) };
  }
  const narrow = kind === "multi_select" ? pickedParents(context, input.narrowBy) : [];
  const read = await readOptions(context, userId, reportId, narrow, kind);
  return {
    column: found, optionsQuery: read.optionsQuery, sample: read.options.slice(0, FILTER_LIMITS.sample), optionCount: read.options.length, truncated: read.truncated, distinct: read.distinct, suggested,
    narrowBy: kind === "multi_select" ? narrowParents(spec, found.table, columns, datasource.database, found.column).map((parent) => ({ paramId: parent.paramId, label: parent.label, column: parent.column, picked: narrow.some((item) => item.paramId === parent.paramId) })) : [],
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
 * `kind: "date_range"` with a default `preset` (the default results change: reviewed by hand).
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
  const provides = placeholdersOf({ id, type: kind === "text" ? "text" : kind, chType: kind === "date_range" ? "Date" : kind === "text" ? "String" : found.chType } as never).map((item) => item.name);
  if ([id, ...provides].some((name) => taken.includes(name))) throw new ReportError(409, "INVALID", `The report already has a parameter ${id}`);
  const label = cleanLabel(input.label ?? suggested.label) || suggested.label;
  let request: AddFilterRequest;
  if (kind === "date_range") {
    const preset = input.preset ?? "30d";
    if (preset === "custom" || !(DATE_PRESETS as readonly string[]).includes(preset)) throw new ReportError(400, "INVALID", `preset must be one of ${DATE_PRESETS.filter((item) => item !== "custom").join(", ")}`);
    request = { kind: "add_filter", type: "date_range", id, label, table: found.table, column: found.column, chType: "Date", optionsQuery: "", preset, condition: filterCondition("date_range", id, found.column, "Date") };
  } else if (kind === "text") {
    const read = await readOptions(context, actor.userId, reportId, [], "text");
    request = { kind: "add_filter", type: "text", id, label, table: found.table, column: found.column, chType: "String", optionsQuery: read.optionsQuery, condition: filterCondition("text", id, found.column, "String") };
  } else {
    const narrow = pickedParents(context, input.narrowBy);
    const read = await readOptions(context, actor.userId, reportId, narrow);
    request = { kind: "add_filter", id, label, table: found.table, column: found.column, chType: found.chType, optionsQuery: read.optionsQuery, ...(input.exclude ? { exclude: true, condition: filterCondition("multi_select", id, found.column, found.chType, true) } : {}) };
  }
  const what = kind === "date_range" ? `, a date range starting at ${DATE_PRESET_LABELS[request.preset as DatePreset] ?? request.preset}` : kind === "text" ? ", text contains" : request.exclude ? ", values can be left out" : "";
  const narrowed = request.optionsQuery && placeholdersIn(request.optionsQuery).length ? `, narrowed by ${pickedParents(context, input.narrowBy).map((parent) => parent.label).join(" and ")}` : "";
  const instruction = await addInstruction(actor, reportId, { text: `Add a filter: ${label} (${found.table}.${found.column})${what}${narrowed}`, request });
  audit(actor.userId, null, "reports.filter.request", { reportId, instructionId: instruction.id, kind: "add_filter", type: kind, paramId: id, table: found.table, column: found.column, sensitive: found.sensitive || undefined, ...(request.exclude ? { exclude: true } : {}), ...(input.narrowBy?.length && kind === "multi_select" ? { narrowBy: input.narrowBy } : {}), ...(actor.keyId ? { via: "mcp", keyId: actor.keyId } : {}) });
  return instruction;
}

/** DELETE …/filters/:paramId (the owner, in the app only: D180 keeps removals off MCP): a multi-select filter, removed by the edit agent and checked against its All results. */
export async function requestRemoveFilter(actor: Actor, reportId: string, paramId: string): Promise<ReportInstruction> {
  const report = ownerActor(actor, reportId);
  const spec = parseSpec(report.spec_json);
  const param = spec.parameters.find((item) => item.id === paramId);
  if (!param) throw new ReportError(404, "NOT_FOUND", "This report has no filter with that id");
  if (param.type !== "multi_select") throw new ReportError(400, "INVALID", "Only a multi-select filter is removed this way; ask for other changes in Changes");
  const instruction = await addInstruction(actor, reportId, { text: `Remove the filter ${param.label}`, request: { kind: "remove_filter", id: param.id, label: param.label } });
  audit(actor.userId, null, "reports.filter.request", { reportId, instructionId: instruction.id, kind: "remove_filter", paramId, ...(actor.keyId ? { via: "mcp", keyId: actor.keyId } : {}) });
  return instruction;
}

