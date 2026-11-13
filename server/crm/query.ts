import { invalid } from "./core";
import { FILTER_OPS, type CrmEntity, type CrmFieldDef, type CrmFilter, type CrmSort } from "../../shared/crm";

/**
 * List filters and sorts for contacts, companies, and deals (§D.5 "filters on any field incl.
 * custom"), compiled to SQL with bound values. Field names come from a fixed table or are custom field
 * ids checked against the book's definitions (`f_` + 8 characters), so no input reaches the SQL text.
 */

type FieldSql = { sql: string; type: "text" | "number" | "date" | "user" | "tags" | "channel" | "bool" };

const BUILTIN: Record<CrmEntity, Record<string, FieldSql>> = {
  contact: {
    name: { sql: "c.display_name", type: "text" },
    email: { sql: "c.id", type: "channel" },
    company: { sql: "co.name", type: "text" },
    owner: { sql: "c.owner_id", type: "user" },
    lifecycle: { sql: "c.lifecycle", type: "text" },
    tag: { sql: "c.tags_json", type: "tags" },
    source: { sql: "c.source", type: "text" },
    job_title: { sql: "c.job_title", type: "text" },
    last_interaction: { sql: "c.last_interaction_at", type: "date" },
    created: { sql: "c.created_at", type: "date" },
    updated: { sql: "c.updated_at", type: "date" }
  },
  company: {
    name: { sql: "co.name", type: "text" },
    domain: { sql: "co.domain", type: "text" },
    owner: { sql: "co.owner_id", type: "user" },
    tag: { sql: "co.tags_json", type: "tags" },
    source: { sql: "co.source", type: "text" },
    last_interaction: { sql: "co.last_interaction_at", type: "date" },
    created: { sql: "co.created_at", type: "date" },
    updated: { sql: "co.updated_at", type: "date" }
  },
  deal: {
    title: { sql: "d.title", type: "text" },
    pipeline: { sql: "d.pipeline_id", type: "text" },
    stage: { sql: "d.stage_id", type: "text" },
    status: { sql: "d.status", type: "text" },
    owner: { sql: "d.owner_id", type: "user" },
    company: { sql: "co.name", type: "text" },
    value: { sql: "d.value_minor", type: "number" },
    expected_close: { sql: "d.expected_close_on", type: "date" },
    next_step: { sql: "d.next_step_on", type: "date" },
    tag: { sql: "d.tags_json", type: "tags" },
    last_activity: { sql: "d.last_activity_at", type: "date" },
    created: { sql: "d.created_at", type: "date" },
    updated: { sql: "d.updated_at", type: "date" }
  }
};
const ALIAS: Record<CrmEntity, string> = { contact: "c", company: "co", deal: "d" };

export const builtinFields = (entity: CrmEntity) => Object.keys(BUILTIN[entity]);

function fieldSql(entity: CrmEntity, name: string, custom: readonly CrmFieldDef[]): FieldSql {
  const builtin = BUILTIN[entity][name];
  if (builtin) return builtin;
  const field = custom.find((item) => item.id === name || item.name.toLowerCase() === name.toLowerCase());
  if (!field || !/^f_[a-z0-9]{8}$/.test(field.id)) throw invalid(`Unknown field ${name.slice(0, 40)}`);
  const sql = `json_extract(${ALIAS[entity]}.custom_json, '$.${field.id}')`;
  return { sql, type: field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "checkbox" ? "bool" : field.type === "multi_select" ? "tags" : "text" };
}

export type Compiled = { where: string[]; params: Record<string, string | number> };

/** Compiles filters (all must hold). `me` as a user value means the viewer. */
export function compileFilters(entity: CrmEntity, filters: readonly CrmFilter[] | undefined, custom: readonly CrmFieldDef[], viewerId: string, prefix = "f"): Compiled {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  let counter = 0;
  const bind = (value: unknown) => {
    const name = `${prefix}${counter++}`;
    if (typeof value === "boolean") params[name] = value ? 1 : 0;
    else if (typeof value === "number" && Number.isFinite(value)) params[name] = value;
    else if (typeof value === "string" && value.length <= 300) params[name] = value === "me" ? viewerId : value;
    else throw invalid("A filter value is text or a number");
    return `$${name}`;
  };
  if ((filters?.length ?? 0) > 20) throw invalid("Up to 20 filters");
  for (const filter of filters ?? []) {
    if (!filter || typeof filter.field !== "string" || !(FILTER_OPS as readonly string[]).includes(filter.op)) throw invalid("Invalid filter");
    const field = fieldSql(entity, filter.field, custom);
    if (field.type === "channel") {
      const email = `EXISTS (SELECT 1 FROM contact_channels ch WHERE ch.contact_id = c.id AND ch.kind = 'email'`;
      if (filter.op === "empty") where.push(`NOT ${email})`);
      else if (filter.op === "not_empty") where.push(`${email})`);
      else where.push(`${email} AND instr(ch.value_norm, lower(${bind(String(filter.value ?? ""))})) > 0)`);
      continue;
    }
    if (field.type === "tags") {
      const has = (value: unknown) => `EXISTS (SELECT 1 FROM json_each(${field.sql}) t WHERE lower(t.value) = lower(${bind(String(value))}))`;
      if (filter.op === "empty") where.push(`COALESCE(json_array_length(${field.sql}), 0) = 0`);
      else if (filter.op === "not_empty") where.push(`COALESCE(json_array_length(${field.sql}), 0) > 0`);
      else if (filter.op === "neq") where.push(`NOT ${has(filter.value)}`);
      else if (filter.op === "in" && Array.isArray(filter.value)) where.push(`(${filter.value.slice(0, 50).map(has).join(" OR ") || "0"})`);
      else where.push(has(filter.value));
      continue;
    }
    switch (filter.op) {
      case "empty": where.push(`(${field.sql} IS NULL OR ${field.sql} = '')`); break;
      case "not_empty": where.push(`(${field.sql} IS NOT NULL AND ${field.sql} <> '')`); break;
      case "eq": where.push(field.type === "text" ? `lower(${field.sql}) = lower(${bind(filter.value)})` : `${field.sql} = ${bind(filter.value)}`); break;
      case "neq": where.push(field.type === "text" ? `lower(COALESCE(${field.sql}, '')) <> lower(${bind(filter.value)})` : `${field.sql} IS NOT ${bind(filter.value)}`); break;
      case "contains": where.push(`instr(lower(COALESCE(${field.sql}, '')), lower(${bind(String(filter.value ?? ""))})) > 0`); break;
      case "gt": where.push(`${field.sql} > ${bind(filter.value)}`); break;
      case "lt": where.push(`${field.sql} < ${bind(filter.value)}`); break;
      case "in": {
        if (!Array.isArray(filter.value) || !filter.value.length || filter.value.length > 100) throw invalid("A list of 1 to 100 values");
        where.push(`${field.sql} IN (${filter.value.map(bind).join(", ")})`);
        break;
      }
    }
  }
  return { where, params };
}

/** The ORDER BY expression of a sort, and whether it is numeric (for the keyset cursor). */
export function sortSql(entity: CrmEntity, sort: CrmSort | undefined, custom: readonly CrmFieldDef[], fallback: string): { expr: string; dir: "ASC" | "DESC"; numeric: boolean } {
  if (!sort) return { expr: `COALESCE(${fallback}, '')`, dir: "ASC", numeric: false };
  const field = fieldSql(entity, sort.field, custom);
  if (field.type === "channel" || field.type === "tags") throw invalid("That field can't be sorted");
  const numeric = field.type === "number" || field.type === "bool";
  return { expr: numeric ? `COALESCE(${field.sql}, -9e18)` : `COALESCE(${field.type === "text" ? `lower(${field.sql})` : field.sql}, '')`, dir: sort.dir === "desc" ? "DESC" : "ASC", numeric };
}

/** The keyset condition after a cursor for `expr dir, id dir`. */
export function afterCursor(expr: string, dir: "ASC" | "DESC", idColumn: string, cursor: [string | number | null, string] | null, params: Record<string, string | number>) {
  if (!cursor) return null;
  params.cursorValue = cursor[0] ?? "";
  params.cursorId = cursor[1];
  const op = dir === "ASC" ? ">" : "<";
  return `(${expr} ${op} $cursorValue OR (${expr} = $cursorValue AND ${idColumn} ${op} $cursorId))`;
}
