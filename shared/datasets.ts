/**
 * Datasets (§B.10, D811): the workspace's own data, queried by structured queries only (never SQL).
 * A dataset is registered by its module on the server (server/datasets/registry.ts); the client and
 * MCP see its public description and send structured queries to `POST /api/datasets/query`.
 */

export const DATASET_COLUMN_TYPES = ["string", "number", "date", "datetime", "bool", "money", "duration"] as const;
export type DatasetColumnType = typeof DATASET_COLUMN_TYPES[number];

export const DATASET_MEASURES = ["sum", "avg", "count", "min", "max", "count_distinct"] as const;
export type DatasetMeasureFn = typeof DATASET_MEASURES[number];

export const TIME_BUCKETS = ["day", "week", "month", "quarter"] as const;
export type TimeBucket = typeof TIME_BUCKETS[number];

export type DatasetColumn = {
  name: string;
  type: DatasetColumnType;
  label: string;
  /** Can be grouped by. */
  dimension?: boolean;
  /** The aggregations it allows (count of rows is always allowed). */
  measures?: DatasetMeasureFn[];
};

/** What GET /api/datasets returns per dataset. */
export type DatasetInfo = {
  id: string;
  module: string;
  label: string;
  description: string;
  columns: DatasetColumn[];
  timeColumn: string | null;
};

export const FILTER_OPS = ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between", "contains", "is_null", "not_null"] as const;
export type FilterOp = typeof FILTER_OPS[number];
export type DatasetFilter = { column: string; op: FilterOp; value?: string | number | boolean | Array<string | number> };

export type DatasetMeasure = { fn: DatasetMeasureFn; column?: string; as?: string };

export const DATASET_ROW_LIMIT = 1000;

export type StructuredQuery = {
  dataset: string;
  measures: DatasetMeasure[];
  dimensions?: string[];
  filters?: DatasetFilter[];
  /** Inclusive dates (YYYY-MM-DD) or instants on the dataset's time column. */
  timeRange?: { from?: string; to?: string };
  timeBucket?: TimeBucket;
  /** By an output column name (a dimension, `bucket`, or a measure's `as`). */
  sort?: Array<{ column: string; dir: "asc" | "desc" }>;
  limit?: number;
  /** IANA zone for buckets and date ranges (default UTC). */
  tz?: string;
};

export type DatasetResult = {
  columns: Array<{ name: string; type: DatasetColumnType | "bucket" }>;
  rows: Array<Array<string | number | boolean | null>>;
  truncated: boolean;
};

/** The default output name of a measure: `count`, `sum_hours`, … */
export const measureName = (measure: DatasetMeasure) => measure.as ?? (measure.column ? `${measure.fn}_${measure.column}` : measure.fn);
