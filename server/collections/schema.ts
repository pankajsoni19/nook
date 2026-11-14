import { z } from "zod";

/**
 * Collection schemas and row values (docs/plan/WAVES_10-12.md §3.1, D55).
 * Pure: no database access, so every rule is unit-testable.
 *
 * - Field ids (`f_` + 8) and option ids (`o_` + 6) are generated here, never
 *   accepted from clients except to name a field or option that already exists.
 * - `fields[0]` is the text primary field, the row's title everywhere.
 * - Writes are strict (`validateValues`); reads are lenient (`readValues`):
 *   values of removed fields, removed options, or a now-incompatible type
 *   read as empty and are dropped on the row's next write.
 */

export const FIELD_TYPES = ["text", "number", "date", "checkbox", "select", "multi_select", "url", "note", "file", "person", "contact"] as const;
/**
 * Relation types (Contacts lane, D961): `person` holds one team member's id, `contact` one contact's id.
 * Contacts' custom fields and Collections both create and edit them (D1200); a reader sees a contact's
 * name only when they can read its book (D1201, T640).
 */
export const RELATION_FIELD_TYPES = ["person", "contact"] as const;
export type FieldType = typeof FIELD_TYPES[number];
export const OPTION_COLORS = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;
export type OptionColor = typeof OPTION_COLORS[number];

export const FIELD_ID = /^f_[a-z0-9]{8}$/;
export const OPTION_ID = /^o_[a-z0-9]{6}$/;

export const SCHEMA_LIMITS = {
  fields: 50,
  fieldName: 60,
  options: 100,
  optionLabel: 60,
  unit: 8,
  maxDecimals: 6,
  text: 4000,
  url: 2048,
  multiSelect: 20,
  schemaBytes: 65_536,
  rowBytes: 16_384
} as const;

export type SelectOption = { id: string; label: string; color: OptionColor };
export type FieldDefinition = {
  id: string;
  name: string;
  type: FieldType;
  required?: true;
  number?: { decimals: number; unit: string };
  options?: SelectOption[];
};
export type CollectionSchema = { fields: FieldDefinition[] };

/** A stored value. `file` values are never stored: they are derived from attachment links. */
export type FieldValue = string | number | boolean | string[];
export type RowValues = Record<string, FieldValue>;

export class SchemaError extends Error {
  constructor(readonly code: "INVALID_SCHEMA" | "INCOMPATIBLE_TYPE_CHANGE", message: string) {
    super(message);
  }
}

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** True when any object key in `value` (at any depth) could reach an object prototype (T53). */
export function hasPrototypeKeys(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some((item) => hasPrototypeKeys(item, depth + 1));
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (PROTOTYPE_KEYS.has(key)) return true;
      if (hasPrototypeKeys((value as Record<string, unknown>)[key], depth + 1)) return true;
    }
  }
  return false;
}

/** Wraps a zod schema so that prototype keys anywhere in the input are rejected before parsing. */
export const safeJson = <T extends z.ZodType>(schema: T) =>
  z.unknown().refine((value) => !hasPrototypeKeys(value), "Keys such as __proto__ are not allowed").pipe(schema);

// C0/C1 controls and bidi overrides never belong in a name or label.
const controlCharacters = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;
export const labelSchema = (max: number) => z.string().transform((value) => value.normalize("NFC").trim()).pipe(
  z.string().min(1).max(max).refine((value) => !controlCharacters.test(value), "Names cannot contain control characters")
);

const optionInput = z.object({
  id: z.string().regex(OPTION_ID).optional(),
  label: labelSchema(SCHEMA_LIMITS.optionLabel),
  color: z.enum(OPTION_COLORS).default("gray")
}).strict();

export const fieldInput = z.object({
  id: z.string().regex(FIELD_ID).optional(),
  // MCP tools and CSV key values by field name, and those keys are refused or dropped as prototype keys.
  name: labelSchema(SCHEMA_LIMITS.fieldName).refine((name) => !PROTOTYPE_KEYS.has(name), "This name is reserved. Choose another."),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  number: z.object({
    decimals: z.number().int().min(0).max(SCHEMA_LIMITS.maxDecimals).default(0),
    unit: z.string().trim().max(SCHEMA_LIMITS.unit).refine((value) => !controlCharacters.test(value)).default("")
  }).strict().optional(),
  options: z.array(optionInput).max(SCHEMA_LIMITS.options).optional()
}).strict();
export type FieldInput = z.input<typeof fieldInput>;

export const fieldsInput = z.array(fieldInput).min(1, "A collection needs at least one field").max(SCHEMA_LIMITS.fields, `A collection can have up to ${SCHEMA_LIMITS.fields} fields`);

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomId(prefix: string, length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = prefix;
  // 256 % 36 = 4, so bytes 252–255 would bias four characters; redraw them.
  for (let index = 0; index < length; index += 1) {
    let byte = bytes[index]!;
    while (byte >= 252) byte = crypto.getRandomValues(new Uint8Array(1))[0]!;
    id += ID_ALPHABET[byte % 36];
  }
  return id;
}
export const newFieldId = () => randomId("f_", 8);
export const newOptionId = () => randomId("o_", 6);

/** text ↔ url and select → multi_select keep their values; every other change is refused (§3.1). */
export function typeChangeAllowed(from: FieldType, to: FieldType) {
  if (from === to) return true;
  if ((from === "text" && to === "url") || (from === "url" && to === "text")) return true;
  return from === "select" && to === "multi_select";
}

const fold = (value: string) => value.normalize("NFC").toLowerCase();

/**
 * Validates field input and returns the canonical schema. With `previous`
 * (PUT /schema), ids name existing fields and options; fields and options
 * without an id are new and get fresh ids. Throws SchemaError.
 */
/**
 * `_options.allowRelations` is accepted for callers written before D1200 (Contacts passes it);
 * relation fields are allowed everywhere now.
 */
export function buildSchema(input: FieldInput[], previous: CollectionSchema | null = null, _options: { allowRelations?: boolean } = {}): CollectionSchema {
  const parsed = fieldsInput.safeParse(input);
  if (!parsed.success) throw new SchemaError("INVALID_SCHEMA", parsed.error.issues[0]?.message ?? "Invalid fields");
  const fields = parsed.data;
  const previousById = new Map((previous?.fields ?? []).map((field) => [field.id, field]));
  const usedIds = new Set<string>(previousById.keys());
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const result: FieldDefinition[] = [];

  for (const [index, field] of fields.entries()) {
    const folded = fold(field.name);
    if (seenNames.has(folded)) throw new SchemaError("INVALID_SCHEMA", `Two fields are named “${field.name}”`);
    seenNames.add(folded);
    let id: string;
    let before: FieldDefinition | undefined;
    if (field.id !== undefined) {
      before = previousById.get(field.id);
      if (!before) throw new SchemaError("INVALID_SCHEMA", "Field ids are assigned by the server");
      if (seenIds.has(field.id)) throw new SchemaError("INVALID_SCHEMA", "A field is listed twice");
      if (!typeChangeAllowed(before.type, field.type)) {
        throw new SchemaError("INCOMPATIBLE_TYPE_CHANGE", `“${before.name}” can't change from ${before.type} to ${field.type}`);
      }
      id = field.id;
    } else {
      do id = newFieldId(); while (usedIds.has(id));
      usedIds.add(id);
    }
    seenIds.add(id);
    if (index === 0 && field.type !== "text") throw new SchemaError("INVALID_SCHEMA", "The first field must be a text field");
    if (field.number && field.type !== "number") throw new SchemaError("INVALID_SCHEMA", `“${field.name}” is not a number field`);
    const selectLike = field.type === "select" || field.type === "multi_select";
    if (field.options && !selectLike) throw new SchemaError("INVALID_SCHEMA", `“${field.name}” can't have options`);
    if (field.required && field.type === "file") throw new SchemaError("INVALID_SCHEMA", "File fields can't be required");

    const definition: FieldDefinition = { id, name: field.name, type: field.type };
    if (field.required) definition.required = true;
    if (field.type === "number") definition.number = { decimals: field.number?.decimals ?? 0, unit: field.number?.unit ?? "" };
    if (selectLike) {
      const previousOptions = new Map((before?.options ?? []).map((option) => [option.id, option]));
      const optionIds = new Set<string>(previousOptions.keys());
      const seenOptionIds = new Set<string>();
      const seenLabels = new Set<string>();
      definition.options = (field.options ?? []).map((option) => {
        const label = fold(option.label);
        if (seenLabels.has(label)) throw new SchemaError("INVALID_SCHEMA", `“${field.name}” has two options named “${option.label}”`);
        seenLabels.add(label);
        let optionId: string;
        if (option.id !== undefined) {
          if (!previousOptions.has(option.id) || seenOptionIds.has(option.id)) throw new SchemaError("INVALID_SCHEMA", "Option ids are assigned by the server");
          optionId = option.id;
        } else {
          do optionId = newOptionId(); while (optionIds.has(optionId));
          optionIds.add(optionId);
        }
        seenOptionIds.add(optionId);
        return { id: optionId, label: option.label, color: option.color ?? "gray" };
      });
    }
    result.push(definition);
  }
  const schema = { fields: result };
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > SCHEMA_LIMITS.schemaBytes) throw new SchemaError("INVALID_SCHEMA", "The schema is too large");
  return schema;
}

/** Parses stored schema JSON. Stored schemas were built by buildSchema, so this only narrows the type. */
export function parseStoredSchema(json: string): CollectionSchema {
  const value = JSON.parse(json) as CollectionSchema;
  return { fields: Array.isArray(value?.fields) ? value.fields : [] };
}

// ---------------------------------------------------------------------------
// Values

/** Controls other than tab and newline, bidi overrides and isolates, and BOM/zero-width no-break. */
const textControls = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩﻿]/g;
const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function cleanText(value: string) {
  return value.replace(/\r\n?/g, "\n").normalize("NFC").replace(textControls, "").trim();
}

export function isRealDate(value: string) {
  const match = isoDate.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isHttpUrl(value: string) {
  if (value.length > SCHEMA_LIMITS.url || /[\s\u0000-\u001F\u007F]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/** The value as the field reads it now, or undefined when it reads as empty (lenient reads, D55). */
export function readValue(field: FieldDefinition, raw: unknown): FieldValue | undefined {
  switch (field.type) {
    case "text":
      return typeof raw === "string" && raw !== "" ? raw : undefined;
    case "url":
      return typeof raw === "string" && isHttpUrl(raw) ? raw : undefined;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    case "date":
      return typeof raw === "string" && isRealDate(raw) ? raw : undefined;
    case "checkbox":
      return raw === true ? true : undefined;
    case "select":
      return typeof raw === "string" && field.options?.some((option) => option.id === raw) ? raw : undefined;
    case "multi_select": {
      // A select changed to multi_select still holds a single id.
      const ids = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
      const known = [...new Set(ids.filter((id): id is string => typeof id === "string" && field.options?.some((option) => option.id === id) === true))];
      return known.length ? known.slice(0, SCHEMA_LIMITS.multiSelect) : undefined;
    }
    case "note":
    case "person":
    case "contact":
      return typeof raw === "string" && uuidPattern.test(raw) ? raw : undefined;
    default:
      return undefined;
  }
}

/** Stored values projected onto the current schema: unknown fields and invalid values are dropped. */
export function readValues(schema: CollectionSchema, stored: unknown): RowValues {
  const source = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
  const values: RowValues = {};
  for (const field of schema.fields) {
    if (!Object.hasOwn(source, field.id)) continue;
    const value = readValue(field, source[field.id]);
    if (value !== undefined) values[field.id] = value;
  }
  return values;
}

export type ValueContext = {
  /** Whether the writer can read note `id` now (D58: only readable notes can be linked). */
  canLinkNote: (id: string) => boolean;
  /** `person` fields (D961): whether `id` is a team member the writer may name. Absent: refused. */
  canUsePerson?: (id: string) => boolean;
  /** `contact` fields (D961): whether the writer can read contact `id`. Absent: refused. */
  canUseContact?: (id: string) => boolean;
};

type Parsed = { ok: true; value: FieldValue | null } | { ok: false; error: string };

/** Strict write validation for one field. `null` (or an empty value) clears the field. */
export function parseValue(field: FieldDefinition, input: unknown, context: ValueContext): Parsed {
  if (input === null) return { ok: true, value: null };
  switch (field.type) {
    case "text": {
      if (typeof input !== "string") return { ok: false, error: "Enter text" };
      const text = cleanText(input);
      if (text.length > SCHEMA_LIMITS.text) return { ok: false, error: `Use at most ${SCHEMA_LIMITS.text} characters` };
      return { ok: true, value: text === "" ? null : text };
    }
    case "url": {
      if (typeof input !== "string") return { ok: false, error: "Enter a link" };
      const url = input.trim();
      if (url === "") return { ok: true, value: null };
      return isHttpUrl(url) ? { ok: true, value: url } : { ok: false, error: "Enter an http or https link" };
    }
    case "number":
      return typeof input === "number" && Number.isFinite(input) ? { ok: true, value: input } : { ok: false, error: "Enter a number" };
    case "date":
      if (input === "") return { ok: true, value: null };
      return typeof input === "string" && isRealDate(input) ? { ok: true, value: input } : { ok: false, error: "Enter a date as YYYY-MM-DD" };
    case "checkbox":
      if (typeof input !== "boolean") return { ok: false, error: "Use true or false" };
      return { ok: true, value: input ? true : null };
    case "select":
      if (input === "") return { ok: true, value: null };
      return typeof input === "string" && field.options?.some((option) => option.id === input) ? { ok: true, value: input } : { ok: false, error: "Choose one of the options" };
    case "multi_select": {
      if (!Array.isArray(input) || input.some((id) => typeof id !== "string")) return { ok: false, error: "Choose options" };
      const ids = [...new Set(input as string[])];
      if (ids.length > SCHEMA_LIMITS.multiSelect) return { ok: false, error: `Choose at most ${SCHEMA_LIMITS.multiSelect} options` };
      if (ids.some((id) => !field.options?.some((option) => option.id === id))) return { ok: false, error: "Choose from the options" };
      return { ok: true, value: ids.length ? ids : null };
    }
    case "note": {
      if (input === "") return { ok: true, value: null };
      if (typeof input !== "string" || !uuidPattern.test(input.toLowerCase())) return { ok: false, error: "Choose a note" };
      const id = input.toLowerCase();
      return context.canLinkNote(id) ? { ok: true, value: id } : { ok: false, error: "You can't link this note" };
    }
    case "file":
      return { ok: false, error: "Attach files to this field instead" };
    case "person":
    case "contact": {
      if (input === "") return { ok: true, value: null };
      const check = field.type === "person" ? context.canUsePerson : context.canUseContact;
      if (typeof input !== "string" || !uuidPattern.test(input.toLowerCase())) return { ok: false, error: field.type === "person" ? "Choose a team member" : "Choose a contact" };
      const id = input.toLowerCase();
      return check?.(id) ? { ok: true, value: id } : { ok: false, error: field.type === "person" ? "Choose a team member" : "You can't link this contact" };
    }
  }
}

export type ValuesResult = { ok: true; values: RowValues } | { ok: false; fieldErrors: Record<string, string> };

const isEmpty = (value: FieldValue | undefined) => value === undefined;

/**
 * Validates `input` (a patch keyed by field id) and merges it over `base`
 * (already projected with readValues, so removed fields drop out here). On
 * create, required fields must be set; on update, a required field cannot be
 * cleared. Rows larger than 16 KiB of JSON are refused.
 */
export function validateValues(schema: CollectionSchema, input: unknown, base: RowValues, context: ValueContext, mode: "create" | "update"): ValuesResult {
  const fieldErrors: Record<string, string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input) || hasPrototypeKeys(input)) return { ok: false, fieldErrors: { _: "Values must be an object keyed by field id" } };
  const byId = new Map(schema.fields.map((field) => [field.id, field]));
  const values: RowValues = { ...base };
  const keys = Object.keys(input);
  if (keys.length > SCHEMA_LIMITS.fields) return { ok: false, fieldErrors: { _: "Too many values" } };
  for (const key of keys) {
    const field = byId.get(key);
    if (!field) {
      fieldErrors[key.slice(0, 16)] = "Unknown field";
      continue;
    }
    const parsed = parseValue(field, (input as Record<string, unknown>)[key], context);
    if (!parsed.ok) {
      fieldErrors[key] = parsed.error;
      continue;
    }
    if (parsed.value === null) {
      delete values[key];
      if (field.required && mode === "update") fieldErrors[key] = "This field is required";
    } else {
      values[key] = parsed.value;
    }
  }
  if (mode === "create") {
    for (const field of schema.fields) if (field.required && isEmpty(values[field.id]) && !fieldErrors[field.id]) fieldErrors[field.id] = "This field is required";
  }
  if (Object.keys(fieldErrors).length) return { ok: false, fieldErrors };
  if (Buffer.byteLength(JSON.stringify(values), "utf8") > SCHEMA_LIMITS.rowBytes) return { ok: false, fieldErrors: { _: "This row is too large" } };
  return { ok: true, values };
}

/** The primary field's text, the row's title everywhere (D55). */
export function rowTitle(schema: CollectionSchema, values: RowValues) {
  const primary = schema.fields[0];
  const value = primary ? values[primary.id] : undefined;
  return typeof value === "string" ? value : "";
}
