import { audit, db, now } from "../db";
import { itemLevel, readableContainerSql } from "../access/workspaceItems";
import { LEVEL_RANK, type ItemLevel } from "../access/levels";
import { canWriteContent } from "../team/userRole";
import { readWorkspaceSettings } from "../workspaceSettings";
import { buildSchema, readValues, validateValues, SchemaError, type FieldInput, type FieldDefinition } from "../collections/schema";
import { createContactBook } from "../people/contacts";
import { upsertSchedule } from "../schedules/service";
import { notify } from "../notify";
import { isCurrency } from "../../shared/money";
import { isShortId } from "../../shared/friendlyUrls";
import {
  CRM_FIELD_TYPES, DEFAULT_LIFECYCLES, DEFAULT_ROTTING_DAYS, DEFAULT_STAGES, emptyCrmFields,
  type CrmBook, type CrmEntity, type CrmFieldDef, type CrmFields, type CrmFieldValue, type CrmUser
} from "../../shared/crm";

/**
 * Contacts core (docs/plan/WORKSPACE_MODULES.md §D.5): errors, book access, books and their settings,
 * custom fields (the Collections field engine, D960–D961), and small shared helpers. Every service
 * in server/crm/* checks the caller's level on the record's book here: readers of a book read its
 * contacts, companies, deals, and interactions; editors (edit and up, and a writing Team role) change
 * them; managers change the book's settings, fields, and pipelines (T560). Missing, binned, and
 * unreadable are the same NOT_FOUND.
 */

export class CrmError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}
export const notFound = (what = "Not found") => new CrmError(404, "NOT_FOUND", what);
export const invalid = (message: string, details?: Record<string, unknown>) => new CrmError(400, "INVALID", message, details);

export type BookRow = {
  id: string; short_id: string; owner_id: string; name: string; color: string | null; system_kind: string | null; visibility: "private" | "selected" | "all_users";
  share_role: string; settings_json: string; fields_json: string; revision: number; deleted_at: string | null; created_at: string; updated_at: string;
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A UUID or a short id, lower case; null for anything else. */
export const cleanRef = (ref: unknown): string | null => typeof ref === "string" && (UUID.test(ref) || isShortId(ref.toLowerCase())) ? ref.toLowerCase() : null;
export const refColumn = (ref: string, alias = "") => `${alias ? `${alias}.` : ""}${UUID.test(ref) ? "id" : "short_id"}`;

/** The live, non-system book row for a ref (id or short id), or null. */
export function bookRow(ref: string): BookRow | null {
  const clean = cleanRef(ref);
  if (!clean) return null;
  return db.query(`SELECT * FROM contact_books WHERE ${refColumn(clean)} = ? AND deleted_at IS NULL AND system_kind IS NULL`).get(clean) as BookRow | null;
}

export const levelOnBook = (bookId: string, userId: string): ItemLevel => itemLevel("contact_book", bookId, userId);

export type Need = "view" | "comment" | "edit" | "manage" | "owner";

/** Throws NOT_FOUND unless the user reads the book, READ_ONLY unless they hold `need`. */
export function requireBook(ref: string, userId: string, need: Need = "view"): BookRow & { level: ItemLevel } {
  const book = bookRow(ref);
  if (!book) throw notFound("Contact book not found");
  const level = levelOnBook(book.id, userId);
  if (level === "none") throw notFound("Contact book not found");
  if (LEVEL_RANK[level] < LEVEL_RANK[need] || (need !== "view" && !canWriteContent(userId))) {
    throw new CrmError(403, "READ_ONLY", need === "manage" || need === "owner" ? "Only the book's owner or a manager can change this" : "You can read this book but not change it");
  }
  return { ...book, level };
}

/** The SQL predicate for books (alias `b`) the user (`$userId`) reads at `minLevel`, non-system only. */
export const readableBooksSql = (alias = "b", minLevel: "view" | "edit" = "view") => `(${readableContainerSql("contact_book", alias, { minLevel })} AND ${alias}.system_kind IS NULL)`;

export type BookSettings = CrmBook["settings"];
export function bookSettings(book: Pick<BookRow, "settings_json">): BookSettings {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(book.settings_json) as Record<string, unknown>; } catch { /* default */ }
  const lifecycles = Array.isArray(raw.lifecycles) ? raw.lifecycles.filter((value): value is string => typeof value === "string").slice(0, 20) : [...DEFAULT_LIFECYCLES];
  const rotting = typeof raw.rottingDays === "number" && Number.isInteger(raw.rottingDays) && raw.rottingDays >= 1 && raw.rottingDays <= 365 ? raw.rottingDays : DEFAULT_ROTTING_DAYS;
  return { linkCompaniesByDomain: raw.linkCompaniesByDomain !== false, lifecycles, rottingDays: rotting, currency: typeof raw.currency === "string" && isCurrency(raw.currency) ? raw.currency : null };
}

/** The currency new deals in a book use: the book's, else the workspace's (§G.1 Q6). */
export const bookCurrency = (book: Pick<BookRow, "settings_json">) => bookSettings(book).currency ?? readWorkspaceSettings().defaultCurrency;

// ---------------------------------------------------------------------------- custom fields (D960–D961)

export function bookFields(book: Pick<BookRow, "fields_json">): CrmFields {
  try {
    const value = JSON.parse(book.fields_json) as unknown;
    if (!value || Array.isArray(value) || typeof value !== "object") return emptyCrmFields();
    const fields = emptyCrmFields();
    for (const entity of ["contact", "company", "deal"] as const) {
      const list = (value as Record<string, unknown>)[entity];
      if (Array.isArray(list)) fields[entity] = list.filter((field) => field && typeof field === "object" && (CRM_FIELD_TYPES as readonly string[]).includes((field as CrmFieldDef).type)) as CrmFieldDef[];
    }
    return fields;
  } catch {
    return emptyCrmFields();
  }
}

// The engine's first field must be text (a collection's title); CRM fields have none, so a fixed placeholder stands in.
const PRIMARY: FieldDefinition = { id: "f_00000000", name: "⁣record", type: "text" };

/** Validates a book's custom fields for one entity with the Collections engine; returns the canonical list. */
export function buildFields(input: unknown, previous: readonly CrmFieldDef[]): CrmFieldDef[] {
  if (!Array.isArray(input) || input.length > 30) throw invalid("Up to 30 custom fields per kind");
  for (const field of input as Array<{ type?: unknown }>) if (!(CRM_FIELD_TYPES as readonly string[]).includes(String(field?.type))) throw invalid("Choose a field type Contacts supports");
  try {
    const schema = buildSchema([{ id: PRIMARY.id, name: PRIMARY.name, type: "text" }, ...(input as FieldInput[])], { fields: [PRIMARY, ...(previous as FieldDefinition[])] }, { allowRelations: true });
    return schema.fields.slice(1) as CrmFieldDef[];
  } catch (error) {
    if (error instanceof SchemaError) throw new CrmError(400, error.code, error.message);
    throw error;
  }
}

/** Stored custom values projected on the current fields (lenient read). */
export const readCustom = (fields: readonly CrmFieldDef[], json: string): Record<string, CrmFieldValue> => {
  try { return readValues({ fields: fields as FieldDefinition[] }, JSON.parse(json)); } catch { return {}; }
};

/** Validates a custom-values patch (keyed by field id or name) over the stored values; throws INVALID with field errors. */
export function writeCustom(fields: readonly CrmFieldDef[], stored: string, patch: unknown, bookId: string, userId: string, mode: "create" | "update"): string {
  const base = readCustom(fields, stored);
  const byName = new Map(fields.map((field) => [field.name.toLowerCase(), field.id]));
  const keyed: Record<string, unknown> = {};
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) keyed[fields.some((field) => field.id === key) ? key : byName.get(key.toLowerCase()) ?? key] = value;
  }
  const result = validateValues({ fields: fields as FieldDefinition[] }, keyed, base, {
    canLinkNote: () => false,
    canUsePerson: (id) => db.query("SELECT 1 FROM users WHERE id = ? AND kind = 'person' AND disabled_at IS NULL").get(id) !== null,
    canUseContact: (id) => db.query(`SELECT 1 FROM contacts c JOIN contact_books b ON b.id = c.book_id WHERE c.id = $id AND c.deleted_at IS NULL AND c.book_id = $book AND ${readableBooksSql("b")}`).get({ id, book: bookId, userId }) !== null
  }, mode);
  if (!result.ok) throw invalid("Check the custom fields", { fieldErrors: result.fieldErrors });
  return JSON.stringify(result.values);
}

// ---------------------------------------------------------------------------- small helpers

export const userRef = (id: string | null, name: string | null): CrmUser | null => id ? { id, name: name ?? "Former member" } : null;
export const parseTags = (json: string): string[] => { try { const value = JSON.parse(json) as unknown; return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : []; } catch { return []; } };
export function cleanTags(tags: unknown): string {
  if (tags === undefined || tags === null) return "[]";
  if (!Array.isArray(tags)) throw invalid("Tags are a list of words");
  const clean = [...new Set(tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
  const json = JSON.stringify(clean);
  if (json.length > 2048) throw invalid("Too many tags");
  return json;
}
export const cleanText = (value: unknown, max: number, what: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid(`${what} must be text`);
  const text = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
  if (text.length > max) throw invalid(`${what} is at most ${max} characters`);
  return text || null;
};
export const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
export function cleanDate(value: unknown, what: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isDate(value)) throw invalid(`${what} is a date (YYYY-MM-DD)`);
  return value;
}
/** A person id the record may name (a live team member), or null; throws for anyone else. */
export function cleanUserId(value: unknown, what = "Owner"): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !UUID.test(value) || !db.query("SELECT 1 FROM users WHERE id = ? AND kind = 'person' AND disabled_at IS NULL").get(value.toLowerCase())) throw invalid(`${what} must be a team member`);
  return value.toLowerCase();
}

/** A keyset cursor of [sort value, id]. */
export const encodeCursor = (value: string | number | null, id: string) => Buffer.from(JSON.stringify([value, id])).toString("base64url");
export function decodeCursor(value: unknown): [string | number | null, string] | null {
  if (typeof value !== "string" || !value || value.length > 400) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === "string" && (parsed[0] === null || typeof parsed[0] === "string" || typeof parsed[0] === "number") ? [parsed[0], parsed[1]] : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------- books

const counts = (bookId: string) => db.query(`SELECT
    (SELECT COUNT(*) FROM contacts WHERE book_id = $id AND deleted_at IS NULL) AS contacts,
    (SELECT COUNT(*) FROM companies WHERE book_id = $id AND deleted_at IS NULL) AS companies,
    (SELECT COUNT(*) FROM deals WHERE book_id = $id AND deleted_at IS NULL) AS deals`).get({ id: bookId }) as CrmBook["counts"];

export function toBook(book: BookRow, userId: string): CrmBook {
  const owner = db.query("SELECT display_name FROM users WHERE id = ?").get(book.owner_id) as { display_name: string } | null;
  const level = levelOnBook(book.id, userId);
  return {
    id: book.id, shortId: book.short_id, name: book.name, color: book.color, ownerId: book.owner_id, ownerName: owner?.display_name ?? "Former member",
    visibility: book.visibility, level: level === "none" ? "view" : level, settings: bookSettings(book), fields: bookFields(book), counts: counts(book.id)
  };
}

/** Books the user reads, by name. `onlyIds` narrows (a key's chosen books). */
export function listBooks(userId: string, onlyIds: readonly string[] | null = null): CrmBook[] {
  const rows = db.query(`SELECT b.* FROM contact_books b WHERE ${readableBooksSql("b")}
      ${onlyIds ? "AND b.id IN (SELECT value FROM json_each($ids))" : ""} ORDER BY b.name COLLATE NOCASE, b.id LIMIT 200`)
    .all({ userId, ...(onlyIds ? { ids: JSON.stringify(onlyIds) } : {}) }) as BookRow[];
  return rows.map((row) => toBook(row, userId));
}

/** Creates a book with its first pipeline (five stages) and its daily rotting check. */
export function createBook(userId: string, input: { name?: unknown; color?: unknown; visibility?: unknown }): CrmBook {
  if (!canWriteContent(userId)) throw new CrmError(403, "READ_ONLY", "Your team role is read-only");
  const name = cleanText(input.name, 120, "The name");
  if (!name) throw invalid("Name the book");
  const visibility = input.visibility === "all_users" || input.visibility === "selected" ? input.visibility : "private";
  return db.transaction(() => {
    const id = createContactBook({ ownerId: userId, name, color: cleanText(input.color, 24, "The color"), visibility: visibility === "selected" ? "private" : visibility, settings: { linkCompaniesByDomain: true } });
    db.query("UPDATE contact_books SET fields_json = ? WHERE id = ?").run(JSON.stringify(emptyCrmFields()), id);
    createPipelineRows(id, "Sales pipeline", null, DEFAULT_STAGES);
    ensureRottingSchedule(id, userId);
    audit(userId, null, "crm.book_create", { bookId: id });
    return toBook(bookRow(id)!, userId);
  })();
}

export function createPipelineRows(bookId: string, name: string, currency: string | null, stages: ReadonlyArray<{ name: string; kind: "open" | "won" | "lost"; probability: number; rotDays?: number | null; color?: string | null }>) {
  const id = crypto.randomUUID();
  const timestamp = now();
  const position = ((db.query("SELECT MAX(position) AS p FROM pipelines WHERE book_id = ?").get(bookId) as { p: number | null }).p ?? 0) + 1;
  db.query("INSERT INTO pipelines (id, book_id, name, currency, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, bookId, name, currency, position, timestamp, timestamp);
  const insert = db.query("INSERT INTO pipeline_stages (id, pipeline_id, name, kind, probability, rot_days, color, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  stages.forEach((stage, index) => insert.run(crypto.randomUUID(), id, stage.name, stage.kind, stage.probability, stage.rotDays ?? null, stage.color ?? null, index + 1));
  return id;
}

/** One `crm.rotting` schedule per book, daily at 08:00 UTC (D964). */
export function ensureRottingSchedule(bookId: string, userId: string | null) {
  if (db.query("SELECT 1 FROM schedules WHERE owner_kind = 'contact_book' AND owner_id = ? AND purpose = 'crm.rotting'").get(bookId)) return;
  upsertSchedule({ kind: "contact_book", id: bookId }, "crm.rotting", { cadence: { weekdays: [0, 1, 2, 3, 4, 5, 6], at: "08:00" } }, {}, { userId });
}

export function updateBook(ref: string, userId: string, input: { name?: unknown; color?: unknown; settings?: Partial<BookSettings> }): CrmBook {
  return db.transaction(() => {
    const book = requireBook(ref, userId, "manage");
    const name = input.name === undefined ? book.name : cleanText(input.name, 120, "The name");
    if (!name) throw invalid("Name the book");
    const color = input.color === undefined ? book.color : cleanText(input.color, 24, "The color");
    const patch = input.settings ?? {};
    const next = { ...JSON.parse(book.settings_json || "{}") as Record<string, unknown> };
    if (patch.linkCompaniesByDomain !== undefined) next.linkCompaniesByDomain = patch.linkCompaniesByDomain === true;
    if (patch.lifecycles !== undefined) {
      if (!Array.isArray(patch.lifecycles) || patch.lifecycles.length > 20) throw invalid("Up to 20 lifecycle stages");
      next.lifecycles = [...new Set(patch.lifecycles.map((value) => String(value).trim().slice(0, 40)).filter(Boolean))];
    }
    if (patch.rottingDays !== undefined) {
      if (!Number.isInteger(patch.rottingDays) || patch.rottingDays < 1 || patch.rottingDays > 365) throw invalid("Rotting days are 1 to 365");
      next.rottingDays = patch.rottingDays;
    }
    if (patch.currency !== undefined) {
      if (patch.currency !== null && !isCurrency(patch.currency)) throw invalid("Choose a currency code");
      next.currency = patch.currency;
    }
    db.query("UPDATE contact_books SET name = ?, color = ?, settings_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(name, color, JSON.stringify(next), now(), book.id);
    audit(userId, null, "crm.book_update", { bookId: book.id });
    return toBook(bookRow(book.id)!, userId);
  })();
}

/** Replaces one entity's custom fields (managers). */
export function setBookFields(ref: string, userId: string, entity: CrmEntity, input: unknown): CrmBook {
  return db.transaction(() => {
    const book = requireBook(ref, userId, "manage");
    const fields = bookFields(book);
    fields[entity] = buildFields(input, fields[entity]);
    const json = JSON.stringify(fields);
    if (json.length > 65_536) throw invalid("The fields are too large");
    db.query("UPDATE contact_books SET fields_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(json, now(), book.id);
    audit(userId, null, "crm.book_fields", { bookId: book.id, entity, count: fields[entity].length });
    return toBook(bookRow(book.id)!, userId);
  })();
}

/** Moves a book to the Bin (its owner only). */
export function binBook(ref: string, userId: string) {
  return db.transaction(() => {
    const book = requireBook(ref, userId, "owner");
    const timestamp = now();
    db.query("UPDATE contact_books SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, userId, new Date(Date.now() + 30 * 86_400_000).toISOString(), timestamp, book.id);
    audit(userId, null, "crm.book_delete", { bookId: book.id });
    return { binned: true };
  })();
}

/** The book of a contact, company, or deal (live), or null. */
export function bookOf(kind: CrmEntity, id: string): string | null {
  const table = kind === "contact" ? "contacts" : kind === "company" ? "companies" : "deals";
  const clean = cleanRef(id);
  if (!clean) return null;
  return (db.query(`SELECT book_id FROM ${table} WHERE ${refColumn(clean)} = ? AND deleted_at IS NULL`).get(clean) as { book_id: string } | null)?.book_id ?? null;
}

/** Notifies only people who read the book (a record's title is theirs to see, T560). */
export function notifyReaders(bookId: string, input: Parameters<typeof notify>[0]) {
  const readers = input.userIds.filter((userId) => levelOnBook(bookId, userId) !== "none");
  if (!readers.length) return { notified: [] as string[] };
  return notify({ ...input, userIds: readers });
}
