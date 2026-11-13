import { createHash } from "node:crypto";
import { z } from "zod";
import { FIELD_ID, isRealDate, type CollectionSchema, type FieldDefinition, type FieldType } from "./schema";

/**
 * The server-side row query (WAVES_10-12.md §3.3, D56, T54). Pure: builds SQL
 * text and parameters from a validated spec.
 *
 * - Operators are an enumerated list per field type.
 * - Field ids are checked against the schema; JSON paths are bound as
 *   parameters (`json_extract(r.values_json, ?)`), never interpolated.
 * - The only SQL text that varies is chosen from fixed fragments here.
 */
export const OPERATORS = {
  text: ["contains", "equals", "empty", "not_empty"],
  url: ["contains", "equals", "empty", "not_empty"],
  number: ["eq", "lt", "lte", "gt", "gte", "empty"],
  date: ["eq", "lt", "lte", "gt", "gte", "empty"],
  checkbox: ["is"],
  select: ["is", "is_not", "in"],
  multi_select: ["has_any", "has_all"],
  note: ["empty", "not_empty"],
  file: ["empty", "not_empty"],
  // Contacts lane (D961): relation fields filter by presence until Wave 3 adds pickers here.
  person: ["empty", "not_empty"],
  contact: ["empty", "not_empty"]
} as const satisfies Record<FieldType, readonly string[]>;
export type Operator = typeof OPERATORS[FieldType][number];

const ALL_OPERATORS = [...new Set(Object.values(OPERATORS).flat())] as [Operator, ...Operator[]];
const SORTABLE = new Set<FieldType>(["text", "url", "number", "date", "checkbox", "select"]);

export const QUERY_LIMITS = { sort: 3, filters: 10, q: 200, value: 200, inList: 20, pageSize: 100, defaultPageSize: 50 } as const;

const filterValue = z.union([z.string().max(QUERY_LIMITS.value), z.number(), z.boolean(), z.array(z.string().max(16)).max(QUERY_LIMITS.inList)]);
export const sortSpec = z.object({ fieldId: z.string().regex(FIELD_ID), direction: z.enum(["asc", "desc"]).default("asc") }).strict();
export const filterSpec = z.object({ fieldId: z.string().regex(FIELD_ID), op: z.enum(ALL_OPERATORS), value: filterValue.optional() }).strict();
export const querySpecShape = {
  sort: z.array(sortSpec).max(QUERY_LIMITS.sort).optional(),
  filters: z.array(filterSpec).max(QUERY_LIMITS.filters).optional(),
  q: z.string().max(QUERY_LIMITS.q).optional()
};
export type SortSpec = z.infer<typeof sortSpec>;
export type FilterSpec = z.infer<typeof filterSpec>;
export type QuerySpec = { sort?: SortSpec[]; filters?: FilterSpec[]; q?: string };

export class QueryError extends Error {}

export type Binding = string | number;
export type CompiledQuery = { where: string; whereParams: Binding[]; orderBy: string; orderParams: Binding[] };

const path = (field: FieldDefinition) => `$.${field.id}`;
const extract = "json_extract(r.values_json, ?)";
const attachmentExists = `EXISTS (SELECT 1 FROM collection_row_attachments a JOIN documents d ON d.id = a.document_id AND d.deleted_at IS NULL
  WHERE a.row_id = r.id AND a.field_id = ?)`;

function optionIds(field: FieldDefinition, value: unknown, min: number) {
  const ids = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!ids || ids.length < min || ids.length > QUERY_LIMITS.inList) throw new QueryError(`Choose options for “${field.name}”`);
  for (const id of ids) if (typeof id !== "string" || !field.options?.some((option) => option.id === id)) throw new QueryError(`Unknown option for “${field.name}”`);
  return [...new Set(ids as string[])];
}

function compileFilter(field: FieldDefinition, filter: FilterSpec): { sql: string; params: Binding[] } {
  const allowed = OPERATORS[field.type] as readonly string[];
  if (!allowed.includes(filter.op)) throw new QueryError(`“${filter.op}” does not apply to ${field.type} fields`);
  const p = path(field);
  const { op, value } = filter;
  if (field.type === "file") {
    return { sql: op === "empty" ? `NOT ${attachmentExists}` : attachmentExists, params: [field.id] };
  }
  if (op === "empty") {
    return field.type === "text" || field.type === "url"
      ? { sql: `COALESCE(${extract}, '') = ''`, params: [p] }
      : { sql: `${extract} IS NULL`, params: [p] };
  }
  if (op === "not_empty") return { sql: `COALESCE(${extract}, '') <> ''`, params: [p] };
  switch (field.type) {
    case "text":
    case "url": {
      if (typeof value !== "string" || value === "") throw new QueryError(`Enter text to match in “${field.name}”`);
      if (op === "contains") return { sql: `instr(lower(${extract}), lower(?)) > 0`, params: [p, value] };
      return { sql: `lower(${extract}) = lower(?)`, params: [p, value] };
    }
    case "number":
    case "date": {
      const valid = field.type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === "string" && isRealDate(value);
      if (!valid) throw new QueryError(field.type === "number" ? `Enter a number for “${field.name}”` : `Enter a date for “${field.name}”`);
      const comparison = { eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" }[op as "eq" | "lt" | "lte" | "gt" | "gte"];
      const typeGuard = field.type === "number" ? "IN ('integer','real')" : "= 'text'";
      return { sql: `(json_type(r.values_json, ?) ${typeGuard} AND ${extract} ${comparison} ?)`, params: [p, p, value as string | number] };
    }
    case "checkbox":
      if (typeof value !== "boolean") throw new QueryError(`Use true or false for “${field.name}”`);
      return { sql: value ? `COALESCE(${extract}, 0) = 1` : `COALESCE(${extract}, 0) <> 1`, params: [p] };
    case "select": {
      if (op === "in") {
        const ids = optionIds(field, value, 1);
        return { sql: `${extract} IN (${ids.map(() => "?").join(", ")})`, params: [p, ...ids] };
      }
      const [id] = optionIds(field, typeof value === "string" ? value : null, 1);
      return op === "is" ? { sql: `${extract} = ?`, params: [p, id] } : { sql: `COALESCE(${extract}, '') <> ?`, params: [p, id] };
    }
    case "multi_select": {
      const ids = optionIds(field, value, 1);
      const list = ids.map(() => "?").join(", ");
      // json_each on a single string (a select changed to multi_select) yields that one value.
      if (op === "has_any") return { sql: `EXISTS (SELECT 1 FROM json_each(r.values_json, ?) je WHERE je.value IN (${list}))`, params: [p, ...ids] };
      return { sql: `(SELECT COUNT(DISTINCT je.value) FROM json_each(r.values_json, ?) je WHERE je.value IN (${list})) = ?`, params: [p, ...ids, ids.length] };
    }
    default:
      throw new QueryError(`“${op}” does not apply to ${field.type} fields`);
  }
}

function compileSort(field: FieldDefinition, sort: SortSpec): { sql: string; params: Binding[] } {
  if (!SORTABLE.has(field.type)) throw new QueryError(`${field.type} fields can't be sorted`);
  const direction = sort.direction === "desc" ? "DESC" : "ASC";
  let expression = extract;
  let params: Binding[] = [path(field)];
  if (field.type === "text" || field.type === "url") expression = `lower(${extract})`;
  if (field.type === "checkbox") expression = `COALESCE(${extract}, 0)`;
  // Values of the wrong JSON type read as empty (lenient reads), so they sort with the empties.
  if (field.type === "number" || field.type === "date") {
    expression = `CASE WHEN json_type(r.values_json, ?) ${field.type === "number" ? "IN ('integer','real')" : "= 'text'"} THEN ${extract} END`;
    params = [path(field), path(field)];
  }
  if (field.type === "select") {
    const options = field.options ?? [];
    if (!options.length) return { sql: "", params: [] };
    expression = `CASE ${extract} ${options.map(() => "WHEN ? THEN ?").join(" ")} ELSE NULL END`;
    params = [path(field), ...options.flatMap((option, index) => [option.id, index])];
  }
  // Empty values sort last in both directions.
  return { sql: `(${expression}) IS NULL, (${expression}) ${direction}`, params: [...params, ...params] };
}

/**
 * Compiles a spec against the schema. Strict mode (request input) throws
 * QueryError on unknown fields or operators; lenient mode (a saved view whose
 * fields may since have been removed) drops clauses that no longer apply. A
 * function decides per clause: true means that clause is lenient.
 */
export type ClauseMode = "strict" | "lenient" | ((clause: { sort: SortSpec } | { filter: FilterSpec }) => boolean);

export function compileQuery(schema: CollectionSchema, spec: QuerySpec, mode: ClauseMode = "strict"): CompiledQuery {
  const lenient = (clause: { sort: SortSpec } | { filter: FilterSpec }) => mode === "lenient" || (typeof mode === "function" && mode(clause));
  const byId = new Map(schema.fields.map((field) => [field.id, field]));
  const where: string[] = [];
  const whereParams: Binding[] = [];
  for (const filter of spec.filters ?? []) {
    const field = byId.get(filter.fieldId);
    try {
      if (!field) throw new QueryError("Unknown field in filter");
      const compiled = compileFilter(field, filter);
      where.push(compiled.sql);
      whereParams.push(...compiled.params);
    } catch (error) {
      if (!lenient({ filter }) || !(error instanceof QueryError)) throw error;
    }
  }
  const q = spec.q?.normalize("NFC").trim();
  if (q) {
    const searchable = schema.fields.filter((field) => field.type === "text" || field.type === "url");
    where.push(`(${searchable.map(() => `instr(lower(COALESCE(${extract}, '')), lower(?)) > 0`).join(" OR ") || "0"})`);
    for (const field of searchable) whereParams.push(path(field), q);
  }
  const order: string[] = [];
  const orderParams: Binding[] = [];
  const sorted = new Set<string>();
  for (const sort of spec.sort ?? []) {
    const field = byId.get(sort.fieldId);
    try {
      if (!field) throw new QueryError("Unknown field in sort");
      if (sorted.has(field.id)) throw new QueryError("A field is sorted twice");
      sorted.add(field.id);
      const compiled = compileSort(field, sort);
      if (compiled.sql) {
        order.push(compiled.sql);
        orderParams.push(...compiled.params);
      }
    } catch (error) {
      if (!lenient({ sort }) || !(error instanceof QueryError)) throw error;
    }
  }
  order.push("r.position", "r.id");
  return { where: where.length ? where.join(" AND ") : "1", whereParams, orderBy: order.join(", "), orderParams };
}

// ---------------------------------------------------------------------------
// Cursor: an opaque offset bound to the schema version and the query spec.

export type Cursor = { schemaVersion: number; offset: number; key: string };
export const MAX_OFFSET = 10_000;

export const specKey = (spec: QuerySpec & { viewId?: string | null }) =>
  createHash("sha256").update(JSON.stringify([spec.viewId ?? null, spec.sort ?? [], spec.filters ?? [], spec.q ?? ""])).digest("base64url").slice(0, 16);

export const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify([cursor.schemaVersion, cursor.offset, cursor.key])).toString("base64url");

export function decodeCursor(value: string): Cursor | null {
  if (value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [schemaVersion, offset, key] = parsed as [unknown, unknown, unknown];
    if (!Number.isSafeInteger(schemaVersion) || !Number.isSafeInteger(offset) || typeof key !== "string") return null;
    if ((offset as number) < 0 || (offset as number) > MAX_OFFSET || (schemaVersion as number) < 1) return null;
    return { schemaVersion: schemaVersion as number, offset: offset as number, key };
  } catch {
    return null;
  }
}
