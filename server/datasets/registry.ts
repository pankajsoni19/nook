import { db } from "../db";
import { zoneOffsetMs } from "../../shared/calendarRecurrence";
import { isValidTimeZone } from "../../shared/calendarRecurrence";
import {
  DATASET_MEASURES, DATASET_ROW_LIMIT, FILTER_OPS, measureName, TIME_BUCKETS,
  type DatasetColumn, type DatasetInfo, type DatasetResult, type StructuredQuery
} from "../../shared/datasets";
import type { McpScope } from "../mcpScopes";
import type { Role } from "../team/roles";

/**
 * Datasets (docs/plan/WORKSPACE_MODULES.md §B.10, D811, T502): the workspace's own data for module
 * Insights, MCP, and (Wave 3) Reports, queried by **structured queries only**. A module registers a
 * dataset as columns (each an SQL expression the module wrote), a FROM clause, and a `scope` predicate
 * that limits rows to what the viewer can read; `runDatasetQuery` compiles a validated structured query
 * to parameterized SQLite with the scope always ANDed in. No text from the query ever reaches the SQL
 * except as a bound parameter: column names, functions, buckets, and operators are looked up in the
 * dataset's own tables.
 */

export type DatasetColumnDef = DatasetColumn & { sql: string };

export type DatasetDef = {
  id: string;
  module: string;
  label: string;
  description: string;
  columns: DatasetColumnDef[];
  /** The `name` of the column ranges and buckets use, or null. */
  timeColumn: string | null;
  /** `FROM …` without the keyword, with its joins. */
  from: string;
  /** Rows the viewer may read: SQL plus named parameters (`$userId` is bound for you). */
  scope: (viewer: { userId: string; role: Role }) => { sql: string; params?: Record<string, string | number> };
  /** MCP: the scope a key needs to list and query it. */
  readScope: McpScope;
  /** Roles that have the module (default: every role but guest). */
  roles?: readonly Role[];
};

const datasets = new Map<string, DatasetDef>();

export function registerDataset(def: DatasetDef) {
  if (!/^[a-z]+\.[a-z_]+$/.test(def.id)) throw new Error(`Invalid dataset id ${def.id}`);
  if (datasets.has(def.id)) throw new Error(`Dataset ${def.id} is already registered`);
  for (const column of def.columns) if (!/^[a-z][a-z0-9_]{0,39}$/.test(column.name)) throw new Error(`Invalid column ${column.name} in ${def.id}`);
  if (def.timeColumn && !def.columns.some((column) => column.name === def.timeColumn)) throw new Error(`Unknown time column in ${def.id}`);
  datasets.set(def.id, def);
  return () => { if (datasets.get(def.id) === def) datasets.delete(def.id); };
}

export const datasetDef = (id: string) => datasets.get(id) ?? null;
export const datasetAllowed = (def: DatasetDef, role: Role) => (def.roles ?? ["admin", "member", "viewer"]).includes(role);

export const datasetInfo = (def: DatasetDef): DatasetInfo => ({
  id: def.id, module: def.module, label: def.label, description: def.description, timeColumn: def.timeColumn,
  columns: def.columns.map(({ sql: _sql, ...column }) => column)
});

/** The datasets a role can query. */
export const listDatasets = (role: Role) => [...datasets.values()].filter((def) => datasetAllowed(def, role)).map(datasetInfo);

export class DatasetError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const BUCKET_FORMATS: Record<string, (expr: string) => string> = {
  day: (expr) => `strftime('%Y-%m-%d', ${expr})`,
  week: (expr) => `date(${expr}, '-' || ((CAST(strftime('%w', ${expr}) AS INTEGER) + 6) % 7) || ' days')`,
  month: (expr) => `strftime('%Y-%m', ${expr})`,
  quarter: (expr) => `strftime('%Y', ${expr}) || '-Q' || ((CAST(strftime('%m', ${expr}) AS INTEGER) + 2) / 3)`
};

/**
 * Runs a structured query for a viewer (§B.10). Throws DatasetError (400) for anything invalid; never
 * returns rows outside `scope(viewer)`. `extraScope` narrows further (a chosen-item key's keyFilter).
 */
export function runDatasetQuery(query: StructuredQuery, viewer: { userId: string; role: Role }, extraScope?: { sql: string; params: Record<string, string> }): DatasetResult {
  const def = datasets.get(query.dataset);
  if (!def || !datasetAllowed(def, viewer.role)) throw new DatasetError("Unknown dataset");
  const columns = new Map(def.columns.map((column) => [column.name, column]));
  const params: Record<string, string | number> = { userId: viewer.userId };
  let counter = 0;
  const bind = (value: string | number | boolean) => { const name = `p${counter++}`; params[name] = typeof value === "boolean" ? (value ? 1 : 0) : value; return `$${name}`; };
  const tz = query.tz ?? "UTC";
  if (!isValidTimeZone(tz)) throw new DatasetError("Unknown time zone");
  const shiftMinutes = Math.round(zoneOffsetMs(Date.now(), tz) / 60_000);
  const zoned = (expr: string) => shiftMinutes ? `datetime(${expr}, '${shiftMinutes >= 0 ? "+" : ""}${shiftMinutes} minutes')` : expr;

  const select: string[] = [];
  const outColumns: DatasetResult["columns"] = [];
  const group: string[] = [];
  const names = new Set<string>();
  // Output columns are selected under internal aliases ("_q0", "_q1", …) that no table column can
  // share. GROUP BY resolves a name that is both an alias and a column of a joined table as the
  // column (ambiguous when two joined tables have it, CRM D980), so grouping by the dataset's own
  // column names broke datasets whose joins share a column name; the aliases are mapped back below.
  const aliases = new Map<string, string>();
  const alias = (name: string) => { const internal = `"_q${aliases.size}"`; aliases.set(name, internal); return internal; };
  for (const name of query.dimensions ?? []) {
    const column = columns.get(name);
    if (!column?.dimension) throw new DatasetError(`${name} cannot be grouped by`);
    if (names.has(name)) throw new DatasetError(`${name} is listed twice`);
    names.add(name);
    const as = alias(name);
    select.push(`${column.sql} AS ${as}`);
    group.push(as);
    outColumns.push({ name, type: column.type });
  }
  if (query.timeBucket) {
    if (!(TIME_BUCKETS as readonly string[]).includes(query.timeBucket) || !def.timeColumn) throw new DatasetError("This dataset has no time to bucket by");
    const as = alias("bucket");
    select.push(`${BUCKET_FORMATS[query.timeBucket]!(zoned(columns.get(def.timeColumn)!.sql))} AS ${as}`);
    group.push(as);
    outColumns.push({ name: "bucket", type: "bucket" });
    names.add("bucket");
  }
  if (!query.measures?.length || query.measures.length > 10) throw new DatasetError("Ask for 1 to 10 measures");
  for (const measure of query.measures) {
    if (!(DATASET_MEASURES as readonly string[]).includes(measure.fn)) throw new DatasetError("Unknown measure");
    const name = measureName(measure);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name) || names.has(name)) throw new DatasetError(`Invalid measure name ${name}`);
    names.add(name);
    if (measure.fn === "count" && !measure.column) {
      select.push(`COUNT(*) AS ${alias(name)}`);
      outColumns.push({ name, type: "number" });
      continue;
    }
    const column = measure.column ? columns.get(measure.column) : undefined;
    if (!column || !(column.measures ?? []).includes(measure.fn)) throw new DatasetError(`${measure.column ?? "?"} does not allow ${measure.fn}`);
    const sql = measure.fn === "count_distinct" ? `COUNT(DISTINCT ${column.sql})` : `${measure.fn.toUpperCase()}(${column.sql})`;
    select.push(`${sql} AS ${alias(name)}`);
    outColumns.push({ name, type: measure.fn === "count" || measure.fn === "count_distinct" ? "number" : column.type });
  }
  const where: string[] = [];
  const scope = def.scope(viewer);
  where.push(`(${scope.sql})`);
  Object.assign(params, scope.params ?? {});
  if (extraScope) {
    where.push(`(${extraScope.sql})`);
    Object.assign(params, extraScope.params);
  }
  for (const filter of (query.filters ?? []).slice(0, 20)) {
    const column = columns.get(filter.column);
    if (!column) throw new DatasetError(`Unknown column ${filter.column}`);
    if (!(FILTER_OPS as readonly string[]).includes(filter.op)) throw new DatasetError("Unknown filter");
    const scalar = (value: unknown) => {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new DatasetError(`${filter.column}: a value is needed`);
      if (typeof value === "string" && value.length > 500) throw new DatasetError("A filter value is at most 500 characters");
      return bind(value);
    };
    const list = () => {
      if (!Array.isArray(filter.value) || !filter.value.length || filter.value.length > 100) throw new DatasetError(`${filter.column}: a list of 1 to 100 values is needed`);
      return `(${filter.value.map(scalar).join(", ")})`;
    };
    switch (filter.op) {
      case "eq": where.push(`${column.sql} = ${scalar(filter.value)}`); break;
      case "neq": where.push(`${column.sql} IS NOT ${scalar(filter.value)}`); break;
      case "in": where.push(`${column.sql} IN ${list()}`); break;
      case "not_in": where.push(`${column.sql} NOT IN ${list()}`); break;
      case "gt": where.push(`${column.sql} > ${scalar(filter.value)}`); break;
      case "gte": where.push(`${column.sql} >= ${scalar(filter.value)}`); break;
      case "lt": where.push(`${column.sql} < ${scalar(filter.value)}`); break;
      case "lte": where.push(`${column.sql} <= ${scalar(filter.value)}`); break;
      case "between": {
        if (!Array.isArray(filter.value) || filter.value.length !== 2) throw new DatasetError(`${filter.column}: between needs two values`);
        where.push(`${column.sql} BETWEEN ${scalar(filter.value[0])} AND ${scalar(filter.value[1])}`);
        break;
      }
      case "contains": where.push(`instr(lower(${column.sql}), lower(${scalar(filter.value)})) > 0`); break;
      case "is_null": where.push(`${column.sql} IS NULL`); break;
      case "not_null": where.push(`${column.sql} IS NOT NULL`); break;
    }
  }
  if (query.timeRange && (query.timeRange.from || query.timeRange.to)) {
    if (!def.timeColumn) throw new DatasetError("This dataset has no time range");
    const time = columns.get(def.timeColumn)!.sql;
    const bound = (value: string, end: boolean) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return bind(new Date(Date.parse(`${value}T00:00:00Z`) - shiftMinutes * 60_000 + (end ? 86_400_000 : 0)).toISOString());
      if (!Number.isNaN(Date.parse(value)) && value.length <= 40) return bind(new Date(value).toISOString());
      throw new DatasetError("A time range is dates (YYYY-MM-DD) or instants");
    };
    if (query.timeRange.from) where.push(`${time} >= ${bound(query.timeRange.from, false)}`);
    if (query.timeRange.to) where.push(`${time} < ${bound(query.timeRange.to, true)}`);
  }
  const order: string[] = [];
  for (const sort of (query.sort ?? []).slice(0, 5)) {
    if (!names.has(sort.column)) throw new DatasetError(`Sort by an output column (${sort.column} is not one)`);
    order.push(`${aliases.get(sort.column)!} ${sort.dir === "asc" ? "ASC" : "DESC"}`);
  }
  if (!order.length && names.has("bucket")) order.push(`${aliases.get("bucket")!} ASC`);
  const limit = Math.min(Math.max(1, query.limit ?? DATASET_ROW_LIMIT), DATASET_ROW_LIMIT);
  params.rowLimit = limit + 1;
  const sql = `SELECT ${select.join(", ")} FROM ${def.from} WHERE ${where.join(" AND ")}${group.length ? ` GROUP BY ${group.join(", ")}` : ""}${order.length ? ` ORDER BY ${order.join(", ")}` : ""} LIMIT $rowLimit`;
  const rows = db.query(sql).all(params as Record<string, string | number>) as Array<Record<string, string | number | null>>;
  return {
    columns: outColumns,
    rows: rows.slice(0, limit).map((row) => outColumns.map((column) => {
      const value = row[aliases.get(column.name)!.slice(1, -1)] ?? null;
      return column.type === "bool" && typeof value === "number" ? value === 1 : value;
    })),
    truncated: rows.length > limit
  };
}
