import { audit, db, now } from "../db";
import { POSITION_STEP } from "../tasks/boardOrder";
import { CsvError, neutralizeFormula, parseCsv, restoreNeutralized, writeCsv } from "./csv";
import { parseValue, validateValues, type CollectionSchema, type FieldDefinition, type FieldValue, type RowValues } from "./schema";
import { indexRow } from "./search";
import { pickablePersonByEmail, pickablePersonByName, readableContactIdByReference } from "../people/summaries";
import { CollectionError, LIMITS, matchingRows, presentRows, requireEditableCollection, requireReadableCollection, schemaOf, valueContext, withCollectionLock } from "./service";

/**
 * CSV import and export (WAVES_10-12.md D59, T55, T56).
 *
 * Import takes CSV text inside JSON (≤ 2 MB, no multipart path), a header row
 * plus up to 5000 rows of up to 50 columns, maps each column to a field (or
 * skips it), and validates every cell with the same strict rules as the API.
 * A dry run returns a preview and the errors; a real import inserts every row
 * in one transaction or nothing. Five imports per minute per user.
 *
 * Export writes the rows a query would return, with a UTF-8 BOM, and
 * neutralizes text that a spreadsheet would run as a formula.
 */
export const IMPORT_LIMITS = { bytes: 2_000_000, rows: 5000, columns: 50, preview: 20, errors: 50, perMinute: 5 } as const;

const importRequests = new Map<string, number[]>();

/** Test hook: forget the import rate-limit history. */
export function resetImportRateLimit() {
  importRequests.clear();
}

function importRateLimited(userId: string, time = Date.now()) {
  const windowStart = time - 60_000;
  const stamps = (importRequests.get(userId) ?? []).filter((stamp) => stamp > windowStart);
  if (stamps.length >= IMPORT_LIMITS.perMinute) {
    importRequests.set(userId, stamps);
    return true;
  }
  stamps.push(time);
  importRequests.set(userId, stamps);
  if (importRequests.size > 1000) for (const [key, value] of importRequests) if ((value[value.length - 1] ?? 0) <= windowStart) importRequests.delete(key);
  return false;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x", "✓", "checked"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "", "unchecked"]);

const uuidCell = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Converts one CSV cell to the input parseValue expects for the field; undefined means "leave empty".
 * Person cells name a member by id, email, or exact unique name; contact cells a contact the importer
 * can read by id, email, or exact unique name (D1203). parseValue then checks them like any write.
 */
function cellInput(field: FieldDefinition, raw: string, userId: string): { ok: true; input: unknown } | { ok: false; error: string } {
  const cell = raw.trim();
  if (cell === "") return { ok: true, input: undefined };
  switch (field.type) {
    case "text":
      return { ok: true, input: restoreNeutralized(raw) };
    case "url":
      return { ok: true, input: restoreNeutralized(cell) };
    case "number": {
      const normalized = cell.replace(/,/g, "");
      return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(normalized) ? { ok: true, input: Number(normalized) } : { ok: false, error: "Enter a number" };
    }
    case "date":
      return { ok: true, input: cell };
    case "checkbox": {
      const word = cell.toLowerCase();
      if (TRUE_WORDS.has(word)) return { ok: true, input: true };
      if (FALSE_WORDS.has(word)) return { ok: true, input: false };
      return { ok: false, error: "Use yes or no" };
    }
    case "select": {
      const option = matchOption(field, restoreNeutralized(cell));
      return option ? { ok: true, input: option } : { ok: false, error: `No option “${cell.slice(0, 60)}”` };
    }
    case "multi_select": {
      const ids: string[] = [];
      for (const part of cell.split(";").map((item) => item.trim()).filter(Boolean)) {
        const option = matchOption(field, restoreNeutralized(part));
        if (!option) return { ok: false, error: `No option “${part.slice(0, 60)}”` };
        ids.push(option);
      }
      return { ok: true, input: ids };
    }
    case "note":
      return { ok: true, input: cell };
    case "person": {
      const text = restoreNeutralized(cell);
      const id = uuidCell.test(text) ? text : text.includes("@") ? pickablePersonByEmail(text) : pickablePersonByName(text);
      return id ? { ok: true, input: id } : { ok: false, error: `No team member “${text.slice(0, 60)}”` };
    }
    case "contact": {
      const text = restoreNeutralized(cell);
      const id = uuidCell.test(text) ? text : readableContactIdByReference(text, userId);
      return id ? { ok: true, input: id } : { ok: false, error: `No contact “${text.slice(0, 60)}” you can read` };
    }
    default:
      return { ok: false, error: "Files can't be imported" };
  }
}

function matchOption(field: FieldDefinition, text: string) {
  const folded = text.normalize("NFC").trim().toLowerCase();
  return field.options?.find((option) => option.label.toLowerCase() === folded || option.id === text.trim())?.id ?? null;
}

export type ImportInput = { csv: string; mapping?: Array<string | null>; dryRun: boolean };
export type ImportError = { row: number; column: number; fieldId: string | null; message: string };

/** Maps header columns to fields: the explicit mapping, or fields whose name matches the header (case-insensitive). */
function resolveMapping(schema: CollectionSchema, header: string[], mapping: Array<string | null> | undefined) {
  const byId = new Map(schema.fields.map((field) => [field.id, field]));
  if (mapping === undefined) {
    const byName = new Map(schema.fields.map((field) => [field.name.toLowerCase(), field]));
    const used = new Set<string>();
    return header.map((name) => {
      const field = byName.get(restoreNeutralized(name).trim().toLowerCase());
      if (!field || field.type === "file" || used.has(field.id)) return null;
      used.add(field.id);
      return field;
    });
  }
  if (mapping.length !== header.length) throw new CollectionError(400, `The mapping has ${mapping.length} entries for ${header.length} columns`, "INVALID_MAPPING");
  const used = new Set<string>();
  return mapping.map((fieldId) => {
    if (fieldId === null) return null;
    const field = byId.get(fieldId);
    if (!field) throw new CollectionError(400, "The mapping names an unknown field", "INVALID_MAPPING");
    if (field.type === "file") throw new CollectionError(400, "Files can't be imported", "INVALID_MAPPING");
    if (used.has(fieldId)) throw new CollectionError(400, `“${field.name}” is mapped twice`, "INVALID_MAPPING");
    used.add(fieldId);
    return field;
  });
}

export function importRows(userId: string, collectionId: string, input: ImportInput) {
  if (Buffer.byteLength(input.csv, "utf8") > IMPORT_LIMITS.bytes) throw new CollectionError(413, "CSV imports can be at most 2 MB", "IMPORT_TOO_LARGE");
  requireEditableCollection(collectionId, userId);
  if (importRateLimited(userId)) throw new CollectionError(429, "Too many imports. Try again in a minute.", "RATE_LIMITED");
  let records: string[][];
  try {
    records = parseCsv(input.csv, { maxRecords: IMPORT_LIMITS.rows + 1, maxColumns: IMPORT_LIMITS.columns });
  } catch (error) {
    if (error instanceof CsvError) throw new CollectionError(400, `Line ${error.line}: ${error.message}`, "INVALID_CSV", { line: error.line });
    throw error;
  }
  const [header, ...data] = records;
  if (!header) throw new CollectionError(400, "The CSV is empty", "INVALID_CSV");

  return withCollectionLock(collectionId, () => {
    const collection = requireEditableCollection(collectionId, userId);
    const schema = schemaOf(collection);
    const columns = resolveMapping(schema, header, input.mapping);
    if (!columns.some(Boolean)) throw new CollectionError(400, "No column matches a field", "INVALID_MAPPING");
    const context = valueContext(userId);
    const errors: ImportError[] = [];
    let errorCount = 0;
    const prepared: RowValues[] = [];
    const record = (row: number, column: number, fieldId: string | null, message: string) => {
      errorCount += 1;
      if (errors.length < IMPORT_LIMITS.errors) errors.push({ row, column, fieldId, message });
    };
    data.forEach((cells, index) => {
      const rowNumber = index + 1;
      const values: Record<string, unknown> = {};
      let rowOk = true;
      columns.forEach((field, column) => {
        if (!field) return;
        const converted = cellInput(field, cells[column] ?? "", userId);
        if (!converted.ok) {
          record(rowNumber, column + 1, field.id, converted.error);
          rowOk = false;
          return;
        }
        if (converted.input === undefined) return;
        const parsed = parseValue(field, converted.input, context);
        if (!parsed.ok) {
          record(rowNumber, column + 1, field.id, parsed.error);
          rowOk = false;
        } else if (parsed.value !== null) {
          values[field.id] = parsed.value;
        }
      });
      if (!rowOk) return;
      const result = validateValues(schema, values, {}, context, "create");
      if (!result.ok) {
        for (const [fieldId, message] of Object.entries(result.fieldErrors)) record(rowNumber, 0, fieldId === "_" ? null : fieldId, message);
        return;
      }
      prepared.push(result.values);
    });

    const live = (db.query("SELECT COUNT(*) AS count FROM collection_rows WHERE collection_id = ? AND deleted_at IS NULL").get(collectionId) as { count: number }).count;
    const mapped = columns.map((field) => field?.id ?? null);
    if (input.dryRun) {
      return { dryRun: true, header, total: data.length, valid: prepared.length, errorCount, errors, mapping: mapped, preview: prepared.slice(0, IMPORT_LIMITS.preview), wouldExceedLimit: live + data.length > LIMITS.liveRowsPerCollection };
    }
    if (errorCount) throw new CollectionError(400, `${errorCount} ${errorCount === 1 ? "cell needs" : "cells need"} fixing; nothing was imported`, "IMPORT_INVALID", { errorCount, errors });
    if (live + prepared.length > LIMITS.liveRowsPerCollection) throw new CollectionError(409, `A collection can have up to ${LIMITS.liveRowsPerCollection} rows`, "LIMIT_REACHED");
    db.transaction(() => {
      const last = db.query("SELECT MAX(position) AS position FROM collection_rows WHERE collection_id = ? AND deleted_at IS NULL").get(collectionId) as { position: number | null };
      let position = last.position ?? 0;
      const timestamp = now();
      const insert = db.query(`INSERT INTO collection_rows (id, collection_id, position, values_json, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const values of prepared) {
        const id = crypto.randomUUID();
        position += POSITION_STEP;
        insert.run(id, collectionId, position, JSON.stringify(values), userId, userId, timestamp, timestamp);
        indexRow(id, schema, collection.schema_version);
      }
      db.query("UPDATE collections SET updated_at = ? WHERE id = ?").run(timestamp, collectionId);
      audit(userId, null, "collection.import", { collectionId, count: prepared.length });
    })();
    return { inserted: prepared.length };
  });
}

function exportCell(field: FieldDefinition, value: FieldValue | undefined): string {
  if (value === undefined) return "";
  switch (field.type) {
    case "number":
      return typeof value === "number" ? String(value) : "";
    case "date":
      return typeof value === "string" ? value : "";
    case "checkbox":
      return value === true ? "true" : "";
    case "select":
      return neutralizeFormula(field.options?.find((option) => option.id === value)?.label ?? "");
    case "multi_select":
      return neutralizeFormula((Array.isArray(value) ? value : []).map((id) => field.options?.find((option) => option.id === id)?.label ?? "").filter(Boolean).join("; "));
    default:
      return typeof value === "string" ? neutralizeFormula(value) : "";
  }
}

/** The rows `POST /:c/query { viewId }` would return (all pages), as CSV. Note titles and contact names follow the reader's access. */
export function exportRows(userId: string, collectionId: string, viewId?: string) {
  const collection = requireReadableCollection(collectionId, userId);
  const { schema, rows } = matchingRows(collection, viewId ? { viewId } : {});
  const hidden = new Set<string>();
  if (viewId) {
    const view = db.query("SELECT config_json FROM collection_views WHERE id = ? AND collection_id = ?").get(viewId, collectionId) as { config_json: string } | null;
    for (const id of (view ? (JSON.parse(view.config_json) as { hiddenFieldIds?: string[] }).hiddenFieldIds ?? [] : [])) hidden.add(id);
  }
  const fields = schema.fields.filter((field, index) => index === 0 || !hidden.has(field.id));
  const presented = presentRows(schema, rows, userId);
  const records = [fields.map((field) => neutralizeFormula(field.name))];
  for (const row of presented) {
    records.push(fields.map((field) => {
      if (field.type === "note") {
        const link = row.links[field.id];
        return link && "title" in link ? neutralizeFormula(link.title) : "";
      }
      if (field.type === "file") return neutralizeFormula((row.files[field.id] ?? []).map((file) => file.name).join("; "));
      if (field.type === "person" || field.type === "contact") {
        // A contact the reader cannot read exports empty, like a restricted note (T640).
        const person = row.people[field.id];
        return person && "name" in person && !(person.kind === "user" && person.former && person.name === "Former member") ? neutralizeFormula(person.name) : "";
      }
      return exportCell(field, row.values[field.id]);
    }));
  }
  audit(userId, null, "collection.export", { collectionId, count: presented.length });
  return { csv: writeCsv(records), name: collection.name, count: presented.length };
}
