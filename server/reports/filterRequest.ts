import { audit } from "../db";
import type { ReportSpec } from "../../shared/reports";
import { PARAM_ID, PARAM_LIMITS } from "../../shared/reportParams";
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

/** The options query for a column, from catalog identifiers only. */
export function optionsQueryFor(table: string, column: string): string {
  const [db, name] = table.split(".") as [string, string];
  return `SELECT toString(${sqlIdentifier(column)}) AS value FROM ${sqlIdentifier(db)}.${sqlIdentifier(name)} GROUP BY value ORDER BY count() DESC LIMIT ${PARAM_LIMITS.options}`;
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

async function findColumn(reportId: string, userId: string, table: string, column: string): Promise<{ found: FilterColumn; spec: ReportSpec; datasource: DatasourceRow }> {
  const view = await filterColumns(reportId, userId);
  const found = view.columns.find((item) => item.table === table && item.column === column);
  if (!found) throw new ReportError(400, "INVALID", "Pick a text or whole-number column of a table this report's queries read");
  const report = ownedReport(reportId, userId);
  return { found, spec: parseSpec(report.spec_json), datasource: usableDatasource(report.datasource_id) };
}

/** Runs the options query and counts the distinct values (refused past FILTER_LIMITS.distinct or with no rows). */
async function readOptions(datasource: DatasourceRow, found: FilterColumn, userId: string, reportId: string): Promise<{ optionsQuery: string; options: string[]; truncated: boolean; distinct: number }> {
  const optionsQuery = optionsQueryFor(found.table, found.column);
  const short = reportId.replace(/-/g, "").slice(0, 12);
  try {
    const counted = await runGuarded(datasource, `SELECT uniq(${sqlIdentifier(found.column)}) AS distinct_values FROM ${found.table.split(".").map(sqlIdentifier).join(".")}`, { classes: ["select"], maxRows: 1, queryId: queryIdFor("fltn", short, crypto.randomUUID().slice(0, 8)), userId });
    const distinct = Number(counted.rows[0]?.[0] ?? 0);
    if (distinct > FILTER_LIMITS.distinct) throw new ReportError(400, "INVALID", `${found.column} has about ${distinct.toLocaleString("en-US")} different values; a filter takes columns with at most ${FILTER_LIMITS.distinct.toLocaleString("en-US")}`);
    const read = await runOptionsQuery(datasource, optionsQuery, { userId, queryId: queryIdFor("fltopt", short, crypto.randomUUID().slice(0, 8)) });
    if (!read.options.length) throw new ReportError(400, "INVALID", `${found.table} has no values in ${found.column} to filter by`);
    return { optionsQuery, options: read.options, truncated: read.truncated, distinct };
  } catch (error) {
    throw asReportError(error);
  }
}

/** POST …/filters/preview (the owner): the options the filter would have, and a suggested id and label. */
export async function previewFilter(reportId: string, userId: string, input: { table: string; column: string }): Promise<FilterPreview> {
  const { found, spec, datasource } = await findColumn(reportId, userId, input.table, input.column);
  const read = await readOptions(datasource, found, userId, reportId);
  return {
    column: found, optionsQuery: read.optionsQuery, sample: read.options.slice(0, FILTER_LIMITS.sample), optionCount: read.options.length, truncated: read.truncated, distinct: read.distinct,
    suggested: suggestedFilter(found.column, spec.parameters.flatMap((param) => param.type === "date_range" ? [param.id, `${param.id}_from`, `${param.id}_to`] : [param.id]))
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
 * agent's proposal waits in Changes (never auto-applied).
 */
export async function requestAddFilter(actor: Actor, reportId: string, input: { table: string; column: string; label?: string; id?: string }): Promise<ReportInstruction> {
  ownerActor(actor, reportId);
  const { found, spec, datasource } = await findColumn(reportId, actor.userId, input.table, input.column);
  if (spec.parameters.length >= PARAM_LIMITS.parameters) throw new ReportError(409, "LIMIT_REACHED", `A report has at most ${PARAM_LIMITS.parameters} filters`);
  if (!spec.blocks.length) throw new ReportError(409, "INVALID", "The report has no blocks to filter yet");
  const taken = spec.parameters.flatMap((param) => param.type === "date_range" ? [param.id, `${param.id}_from`, `${param.id}_to`] : [param.id]);
  const suggested = suggestedFilter(found.column, taken);
  const id = input.id ?? suggested.id;
  if (!PARAM_ID.test(id)) throw new ReportError(400, "INVALID", "The filter id must match [a-z][a-z0-9_]{0,29}");
  if (taken.includes(id)) throw new ReportError(409, "INVALID", `The report already has a parameter ${id}`);
  const label = cleanLabel(input.label ?? suggested.label) || suggested.label;
  const read = await readOptions(datasource, found, actor.userId, reportId);
  const request: AddFilterRequest = { kind: "add_filter", id, label, table: found.table, column: found.column, chType: found.chType, optionsQuery: read.optionsQuery };
  const instruction = await addInstruction(actor, reportId, { text: `Add a filter: ${label} (${found.table}.${found.column})`, request });
  audit(actor.userId, null, "reports.filter.request", { reportId, instructionId: instruction.id, kind: "add_filter", paramId: id, table: found.table, column: found.column, sensitive: found.sensitive || undefined, ...(actor.keyId ? { via: "mcp", keyId: actor.keyId } : {}) });
  return instruction;
}

/** DELETE …/filters/:paramId (the owner; MCP `remove_report_filter`): a multi-select filter, removed by the edit agent and checked against its All results. */
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

