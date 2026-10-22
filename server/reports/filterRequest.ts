import { audit } from "../db";
import type { ReportSpec } from "../../shared/reports";
import { bindValues, defaultValues, PARAM_ID, PARAM_LIMITS } from "../../shared/reportParams";
import { FILTER_LIMITS, type AddFilterRequest, type FilterColumn, type FilterColumnsView, type FilterPreview, type ReportInstruction } from "../../shared/reportsEdit";
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
    return parent.type === "multi_select" ? `(empty(${placeholder}) OR ${sqlIdentifier(parent.column)} IN ${placeholder})` : `${sqlIdentifier(parent.column)} = ${placeholder}`;
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
      const chType = filterChType(column.type);
      if (!chType) continue;
      columns.push({ table: name, column: column.name, type: column.type, chType, comment: column.comment ?? "", readBy: readers.get(name) ?? [], sensitive: SENSITIVE.test(column.name) || SENSITIVE.test(column.comment ?? "") });
    }
  }
  columns.sort((a, b) => b.readBy.length - a.readBy.length || a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
  return { columns, queries: queries.length, slotsLeft: Math.max(0, PARAM_LIMITS.parameters - spec.parameters.length) };
}

type Found = { found: FilterColumn; spec: ReportSpec; datasource: DatasourceRow; columns: FilterColumn[] };

async function findColumn(reportId: string, userId: string, table: string, column: string): Promise<Found> {
  const view = await filterColumns(reportId, userId);
  const found = view.columns.find((item) => item.table === table && item.column === column);
  if (!found) throw new ReportError(400, "INVALID", "Pick a text or whole-number column of a table this report's queries read");
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

/**
 * Runs the options query and counts the distinct values (refused past FILTER_LIMITS.distinct or with no
 * rows). D562: a narrowed options query runs with its parents at their defaults (All for a multi-select).
 */
async function readOptions(context: Found, userId: string, reportId: string, narrow: readonly NarrowParent[] = []): Promise<{ optionsQuery: string; options: string[]; truncated: boolean; distinct: number }> {
  const { datasource, found, spec } = context;
  const optionsQuery = optionsQueryFor(found.table, found.column, narrow);
  const short = reportId.replace(/-/g, "").slice(0, 12);
  try {
    const counted = await runGuarded(datasource, `SELECT uniq(${sqlIdentifier(found.column)}) AS distinct_values FROM ${found.table.split(".").map(sqlIdentifier).join(".")}`, { classes: ["select"], maxRows: 1, queryId: queryIdFor("fltn", short, crypto.randomUUID().slice(0, 8)), userId });
    const distinct = Number(counted.rows[0]?.[0] ?? 0);
    if (distinct > FILTER_LIMITS.distinct) throw new ReportError(400, "INVALID", `${found.column} has about ${distinct.toLocaleString("en-US")} different values; a filter takes columns with at most ${FILTER_LIMITS.distinct.toLocaleString("en-US")}`);
    const bound = bindValues(spec.parameters, defaultValues(spec.parameters), reportToday(reportId));
    const read = await runOptionsQuery(datasource, optionsQuery, { userId, queryId: queryIdFor("fltopt", short, crypto.randomUUID().slice(0, 8)), params: bound });
    if (!read.options.length) throw new ReportError(400, "INVALID", `${found.table} has no values in ${found.column} to filter by`);
    return { optionsQuery, options: read.options, truncated: read.truncated, distinct };
  } catch (error) {
    throw asReportError(error);
  }
}

/**
 * POST …/filters/preview (the owner): the options the filter would have, a suggested id and label, and
 * (D562) the existing filters on the same table it can follow (`narrowBy`), with `narrowBy` the ones picked.
 */
export async function previewFilter(reportId: string, userId: string, input: { table: string; column: string; narrowBy?: string[] }): Promise<FilterPreview> {
  const context = await findColumn(reportId, userId, input.table, input.column);
  const narrow = pickedParents(context, input.narrowBy);
  const read = await readOptions(context, userId, reportId, narrow);
  const { found, spec, datasource, columns } = context;
  return {
    column: found, optionsQuery: read.optionsQuery, sample: read.options.slice(0, FILTER_LIMITS.sample), optionCount: read.options.length, truncated: read.truncated, distinct: read.distinct,
    suggested: suggestedFilter(found.column, spec.parameters.flatMap((param) => param.type === "date_range" ? [param.id, `${param.id}_from`, `${param.id}_to`] : [param.id])),
    narrowBy: narrowParents(spec, found.table, columns, datasource.database, found.column).map((parent) => ({ paramId: parent.paramId, label: parent.label, column: parent.column, picked: narrow.some((item) => item.paramId === parent.paramId) }))
  };
}

type Actor = { userId: string; role: string; keyId?: string | null };

const cleanLabel = (label: string) => label.replace(/[\u0000-\u001f\u007f<>{}]+/g, " ").replace(/\s+/g, " ").trim().slice(0, PARAM_LIMITS.label);

function ownerActor(actor: Actor, reportId: string) {
  const report = ownedReport(reportId, actor.userId);
  if (actor.role === "viewer" || actor.role === "guest") throw new ReportError(403, "ROLE_READ_ONLY", "Your role cannot change reports");
  return report;
}

/**
 * POST …/filters (the owner; MCP `add_report_filter`): checks the column and the id, runs the options
 * query (it must return a row), and queues an instruction carrying the structured request. The edit
 * agent's proposal waits in Changes (never auto-applied). D562: `narrowBy` names existing filters on the
 * same table whose picks narrow this one's choices (its options query reads them; the agent adds it after them).
 */
export async function requestAddFilter(actor: Actor, reportId: string, input: { table: string; column: string; label?: string; id?: string; narrowBy?: string[] }): Promise<ReportInstruction> {
  ownerActor(actor, reportId);
  const context = await findColumn(reportId, actor.userId, input.table, input.column);
  const { found, spec } = context;
  if (spec.parameters.length >= PARAM_LIMITS.parameters) throw new ReportError(409, "LIMIT_REACHED", `A report has at most ${PARAM_LIMITS.parameters} filters`);
  if (!spec.blocks.length) throw new ReportError(409, "INVALID", "The report has no blocks to filter yet");
  const taken = spec.parameters.flatMap((param) => param.type === "date_range" ? [param.id, `${param.id}_from`, `${param.id}_to`] : [param.id]);
  const suggested = suggestedFilter(found.column, taken);
  const id = input.id ?? suggested.id;
  if (!PARAM_ID.test(id)) throw new ReportError(400, "INVALID", "The filter id must match [a-z][a-z0-9_]{0,29}");
  if (taken.includes(id)) throw new ReportError(409, "INVALID", `The report already has a parameter ${id}`);
  const label = cleanLabel(input.label ?? suggested.label) || suggested.label;
  const narrow = pickedParents(context, input.narrowBy);
  const read = await readOptions(context, actor.userId, reportId, narrow);
  const request: AddFilterRequest = { kind: "add_filter", id, label, table: found.table, column: found.column, chType: found.chType, optionsQuery: read.optionsQuery };
  const instruction = await addInstruction(actor, reportId, { text: `Add a filter: ${label} (${found.table}.${found.column})${narrow.length ? `, narrowed by ${narrow.map((parent) => parent.label).join(" and ")}` : ""}`, request });
  audit(actor.userId, null, "reports.filter.request", { reportId, instructionId: instruction.id, kind: "add_filter", paramId: id, table: found.table, column: found.column, sensitive: found.sensitive || undefined, ...(narrow.length ? { narrowBy: narrow.map((parent) => parent.paramId) } : {}), ...(actor.keyId ? { via: "mcp", keyId: actor.keyId } : {}) });
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

