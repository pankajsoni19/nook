/**
 * Reports on "This workspace" (docs/plan/WORKSPACE_MODULES.md §B.10, §D.8, lane W3-REPORTS, D1060–D1069).
 *
 * A report whose source is the workspace keeps, in each saved query's `sql`, a **structured dataset
 * query** (shared/datasets.ts) as JSON, never SQL. It runs through the dataset registry with the
 * **reader's** own access (the product owner's Q3 answer): two people may see different numbers on the
 * same report, and nothing a reader sees was computed with someone else's access.
 *
 * Two additions to a plain structured query, both resolved on the server before it runs:
 * - `timeRange.preset`: a relative range (Last 30 days, Month to date, …) on the report's today, so a
 *   saved or scheduled report moves with the calendar.
 * - Report parameters (D489): a value that is exactly a placeholder `{name:Type}` (a time range end, a
 *   filter value) is the parameter's bound value. A multi-select bound to nothing picked (All) drops
 *   its filter; an open end of a number range drops its bound.
 *
 * Pure: no server or client imports beyond shared/, so both sides and the tests share it.
 */

import { DATASET_MEASURES, FILTER_OPS, TIME_BUCKETS, type DatasetColumnType, type DatasetFilter, type StructuredQuery, type TimeBucket } from "./datasets";
import { DATE_PRESETS, parseArrayLiteral, resolveDateRange, unescapeParamString, type BoundParam, type DatePreset } from "./reportParams";

/** The data source id a workspace report shows as (`datasourceId`), and its name. */
export const WORKSPACE_SOURCE_ID = "workspace";
export const WORKSPACE_SOURCE_NAME = "This workspace";
export const isWorkspaceSource = (id: string | null | undefined) => id === WORKSPACE_SOURCE_ID;

export type RelativePreset = Exclude<DatePreset, "custom">;
export const RELATIVE_PRESETS = DATE_PRESETS.filter((preset): preset is RelativePreset => preset !== "custom");

/** A saved workspace query: a structured query whose time range may be relative. */
export type ReportDatasetQuery = Omit<StructuredQuery, "timeRange"> & { timeRange?: { from?: string; to?: string; preset?: RelativePreset } };

const PLACEHOLDER = /^\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_(), ]+?)\s*\}$/;
export const isPlaceholder = (value: unknown): value is string => typeof value === "string" && PLACEHOLDER.test(value);
export const placeholderText = (name: string, type: string) => `{${name}:${type}}`;

const KEYS = new Set(["dataset", "measures", "dimensions", "filters", "timeRange", "timeBucket", "sort", "limit", "tz"]);
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Reads a saved query's text as a workspace query: the shape only (words from the fixed lists, sizes);
 * the dataset registry checks names and measures when it runs. Null with the reason when it is not one.
 */
export function parseDatasetQuery(text: string): { ok: true; query: ReportDatasetQuery } | { ok: false; error: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, error: "A query on This workspace is a structured query (JSON), not SQL" }; }
  if (!isObject(value)) return { ok: false, error: "A structured query is a JSON object" };
  for (const key of Object.keys(value)) if (!KEYS.has(key)) return { ok: false, error: `A structured query has no field ${key.slice(0, 40)}` };
  if (typeof value.dataset !== "string" || !/^[a-z]+\.[a-z_]+$/.test(value.dataset)) return { ok: false, error: "dataset names a dataset, such as time.entries" };
  if (!Array.isArray(value.measures) || !value.measures.length || value.measures.length > 10) return { ok: false, error: "Ask for 1 to 10 measures" };
  for (const measure of value.measures) {
    if (!isObject(measure) || !(DATASET_MEASURES as readonly string[]).includes(String(measure.fn))) return { ok: false, error: `A measure's fn is one of ${DATASET_MEASURES.join(", ")}` };
    if (measure.column !== undefined && typeof measure.column !== "string") return { ok: false, error: "A measure's column is a column name" };
    if (measure.as !== undefined && (typeof measure.as !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(measure.as))) return { ok: false, error: "A measure's as is a name such as total_hours" };
  }
  if (value.dimensions !== undefined && (!Array.isArray(value.dimensions) || value.dimensions.length > 5 || value.dimensions.some((item) => typeof item !== "string"))) return { ok: false, error: "dimensions lists up to 5 column names" };
  if (value.filters !== undefined) {
    if (!Array.isArray(value.filters) || value.filters.length > 20) return { ok: false, error: "filters lists up to 20 filters" };
    for (const filter of value.filters) {
      if (!isObject(filter) || typeof filter.column !== "string" || !(FILTER_OPS as readonly string[]).includes(String(filter.op))) return { ok: false, error: `A filter is {column, op, value}; op is one of ${FILTER_OPS.join(", ")}` };
      const ok = (item: unknown) => typeof item === "string" ? item.length <= 500 : typeof item === "number" || typeof item === "boolean";
      if (filter.value !== undefined && !(ok(filter.value) || (Array.isArray(filter.value) && filter.value.length <= 100 && filter.value.every((item) => typeof item === "string" ? item.length <= 500 : typeof item === "number")))) return { ok: false, error: "A filter value is a string, number, true or false, or a list" };
    }
  }
  if (value.timeRange !== undefined) {
    const range = value.timeRange;
    if (!isObject(range) || Object.keys(range).some((key) => !["from", "to", "preset"].includes(key))) return { ok: false, error: "timeRange is {from?, to?} or {preset}" };
    if (range.preset !== undefined && !(RELATIVE_PRESETS as readonly string[]).includes(String(range.preset))) return { ok: false, error: `timeRange.preset is one of ${RELATIVE_PRESETS.join(", ")}` };
    if ((range.from !== undefined && typeof range.from !== "string") || (range.to !== undefined && typeof range.to !== "string")) return { ok: false, error: "timeRange.from and to are dates (YYYY-MM-DD) or {name:Date} placeholders" };
    if (range.preset !== undefined && (range.from !== undefined || range.to !== undefined)) return { ok: false, error: "timeRange is a preset or from/to, not both" };
  }
  if (value.timeBucket !== undefined && !(TIME_BUCKETS as readonly string[]).includes(String(value.timeBucket))) return { ok: false, error: `timeBucket is one of ${TIME_BUCKETS.join(", ")}` };
  if (value.sort !== undefined && (!Array.isArray(value.sort) || value.sort.length > 5 || value.sort.some((item) => !isObject(item) || typeof item.column !== "string" || (item.dir !== "asc" && item.dir !== "desc")))) return { ok: false, error: "sort lists up to 5 {column, dir: asc|desc}" };
  if (value.limit !== undefined && (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 1000)) return { ok: false, error: "limit is 1 to 1000" };
  if (value.tz !== undefined && (typeof value.tz !== "string" || value.tz.length > 64)) return { ok: false, error: "tz is an IANA time zone" };
  return { ok: true, query: value as unknown as ReportDatasetQuery };
}

/** Whether a saved query's text is a structured query (JSON) rather than SQL: SQL never starts with `{`. */
export const looksLikeDatasetQuery = (text: string) => text.trimStart().startsWith("{");

/** The text a workspace query is saved as (stable, readable in Inspect). */
export const datasetQueryText = (query: ReportDatasetQuery) => JSON.stringify(query, null, 2);

export class DatasetBindError extends Error {}

/** A placeholder's bound value as the dataset registry takes it (a string, a number, or a list). */
function boundValue(text: string, bound: ReadonlyMap<string, BoundParam>): string | number | Array<string | number> | null {
  const match = PLACEHOLDER.exec(text)!;
  const param = bound.get(match[1]!);
  if (!param) throw new DatasetBindError(`${text} names no parameter of this report`);
  const type = param.type.replace(/\s+/g, "");
  if (type === "Date") return param.value;
  if (type === "String") return unescapeParamString(param.value);
  if (type.startsWith("Array(")) {
    const element = type.slice(6, -1);
    const items = parseArrayLiteral(param.value, element) ?? [];
    return element === "String" ? items : items.map(Number);
  }
  // A number range's open end binds as the type's lowest or highest value (D567): no bound at all here.
  if (param.value === "inf" || param.value === "-inf") return null;
  const number = Number(param.value);
  return Number.isFinite(number) && Math.abs(number) < 9e15 ? number : null;
}

/**
 * The structured query a saved workspace query runs as: presets resolved on `today`, placeholders
 * bound. Throws DatasetBindError for a placeholder of no parameter.
 */
export function bindDatasetQuery(query: ReportDatasetQuery, bound: readonly BoundParam[], today: string): StructuredQuery {
  const byName = new Map(bound.map((item) => [item.name, item]));
  const out: StructuredQuery = { ...query, timeRange: undefined } as StructuredQuery;
  delete out.timeRange;
  if (query.timeRange?.preset) {
    const range = resolveDateRange({ preset: query.timeRange.preset }, today);
    out.timeRange = { from: range.from, to: range.to };
  } else if (query.timeRange) {
    const end = (value: string | undefined) => {
      if (value === undefined) return undefined;
      if (!isPlaceholder(value)) return value;
      const resolved = boundValue(value, byName);
      return typeof resolved === "string" ? resolved : undefined;
    };
    const from = end(query.timeRange.from);
    const to = end(query.timeRange.to);
    if (from !== undefined || to !== undefined) out.timeRange = { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
  }
  if (query.filters) {
    const filters: DatasetFilter[] = [];
    for (const filter of query.filters) {
      if (!isPlaceholder(filter.value)) { filters.push(filter); continue; }
      const value = boundValue(filter.value, byName);
      // All (nothing picked) and an open range end filter nothing.
      if (value === null || (Array.isArray(value) && !value.length)) continue;
      if (Array.isArray(value) && filter.op !== "in" && filter.op !== "not_in") throw new DatasetBindError(`${filter.column}: a list filters with in or not_in`);
      filters.push({ ...filter, value: Array.isArray(value) ? value : value });
    }
    out.filters = filters;
  }
  return out;
}

/**
 * The ClickHouse-style type a workspace result column carries, so charts, tables, and formats read it
 * as they read any report result: counts are UInt64, numbers Float64, money (minor units) Int64,
 * seconds Float64, days Date, instants DateTime, and day and week buckets Date (month and quarter
 * buckets are labels such as 2026-11 and 2026-Q4).
 */
export function resultColumnType(type: DatasetColumnType | "bucket", context: { measure?: string; bucket?: TimeBucket } = {}): string {
  if (context.measure === "count" || context.measure === "count_distinct") return "UInt64";
  if (context.measure === "avg") return "Float64";
  switch (type) {
    case "bucket": return context.bucket === "day" || context.bucket === "week" ? "Date" : "String";
    case "number": return "Float64";
    case "money": return "Int64";
    case "duration": return "Float64";
    case "date": return "Date";
    case "datetime": return "DateTime";
    case "bool": return "Bool";
    default: return "String";
  }
}
