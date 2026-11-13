import { audit, db, now } from "../db";
import { itemLevel, readableContainerSql, readableIds } from "../access/workspaceItems";
import { LEVEL_RANK } from "../access/levels";
import { recordItemActivity } from "../activity/service";
import { registerActivityKinds } from "../../shared/itemActivity";
import { contactDisplayName, emailDomain, splitName, type ContactSource, type ContactSummary, type PersonSummary } from "../../shared/people";
import { isEmail, normalizeEmail, normalizePhone } from "../../shared/questions";
import { isFreeMailDomain } from "../../shared/freeMailDomains";
import { newShortId } from "../../shared/friendlyUrls";

/**
 * People core (docs/plan/WORKSPACE_MODULES.md §B.3, D806, D807, T503): contact books, contacts, and
 * companies are foundation tables (088), because Bookings, Forms, and Time write them in Wave 2; the
 * Contacts module (`crm`) owns their UI and everything around them.
 *
 * - `upsertContactByEmail` finds a contact by normalized email in the book, else creates one; it fills
 *   only empty fields and never overwrites a field a person edited by hand (D806, `edited_json`); it
 *   links or creates the company by email domain when the book's setting is on and the domain is not
 *   free mail.
 * - A contact is readable by readers of its book; a chip on an item the viewer can read whose book
 *   they cannot shows "A contact" without details (`contactSummaries`, T503).
 * - Each person has one hidden system book "Clients" (D807), created lazily for Time when Contacts
 *   is off; it holds Time's clients (companies) and is never listed as a book.
 */

registerActivityKinds("core", {
  contact_created: { shape: "event", coalesce: false },
  contact_filled: { shape: "event", coalesce: false },
  company_created: { shape: "event", coalesce: false }
});

export class PeopleError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) {
    super(message);
  }
}

type BookRow = { id: string; owner_id: string; settings_json: string; deleted_at: string | null; system_kind: string | null };

const bookRow = (bookId: string) => db.query("SELECT id, owner_id, settings_json, deleted_at, system_kind FROM contact_books WHERE id = ?").get(bookId) as BookRow | null;

/** The book ids the user can read (at `minLevel`), the system "Clients" book included when it is theirs. */
export const readableBookIds = (userId: string, minLevel: "view" | "comment" | "edit" | "manage" = "view") => readableIds("contact_book", userId, minLevel);

/** Whether the user can write contacts in the book (edit and up, not binned). */
export function canEditBook(bookId: string, userId: string) {
  return LEVEL_RANK[itemLevel("contact_book", bookId, userId)] >= LEVEL_RANK.edit;
}

/** Creates a contact book owned by `ownerId`. */
export function createContactBook(input: { ownerId: string; name: string; color?: string | null; visibility?: "private" | "selected" | "all_users"; settings?: Record<string, unknown>; systemKind?: "clients" | null }) {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new PeopleError(400, "INVALID", "A contact book needs a name of at most 120 characters");
  const id = crypto.randomUUID();
  const timestamp = now();
  db.query(`INSERT INTO contact_books (id, short_id, owner_id, name, color, system_kind, visibility, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, newShortId(), input.ownerId, name, input.color ?? null, input.systemKind ?? null, input.visibility ?? "private", JSON.stringify(input.settings ?? { linkCompaniesByDomain: true }), timestamp, timestamp);
  audit(input.ownerId, null, "people.book_created", { bookId: id, system: input.systemKind ?? null });
  return id;
}

/** The person's hidden "Clients" book (D807), created on first use. */
export function ensureClientsBook(ownerId: string): string {
  const existing = db.query("SELECT id FROM contact_books WHERE owner_id = ? AND system_kind = 'clients'").get(ownerId) as { id: string } | null;
  if (existing) return existing.id;
  return createContactBook({ ownerId, name: "Clients", systemKind: "clients", settings: { linkCompaniesByDomain: false } });
}

const settingsOf = (book: BookRow) => {
  try { return JSON.parse(book.settings_json) as { linkCompaniesByDomain?: boolean }; } catch { return {}; }
};

/** Finds or creates the company for a domain in a book (live companies; unique by domain). */
export function companyForDomain(bookId: string, domain: string, options: { name?: string | null; source: ContactSource; actorId: string | null }): { companyId: string; created: boolean } {
  const lower = domain.trim().toLowerCase();
  const existing = db.query("SELECT id FROM companies WHERE book_id = ? AND domain = ? AND deleted_at IS NULL").get(bookId, lower) as { id: string } | null;
  if (existing) return { companyId: existing.id, created: false };
  const id = crypto.randomUUID();
  const timestamp = now();
  const name = options.name?.trim() || lower.split(".").slice(-2, -1)[0]?.replace(/^./, (letter) => letter.toUpperCase()) || lower;
  db.query(`INSERT INTO companies (id, short_id, book_id, name, domain, website, source, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, newShortId(), bookId, name.slice(0, 200), lower, `https://${lower}`, options.source === "email_domain" ? "email_domain" : options.source, options.actorId, timestamp, timestamp);
  recordItemActivity({ itemKind: "company", itemId: id, container: { kind: "contact_book", id: bookId }, actorId: options.actorId, kind: "company_created", payload: { extra: { source: options.source } } });
  return { companyId: id, created: true };
}

/** A company by name in a book (case-insensitive), created when missing. */
function companyByName(bookId: string, name: string, source: ContactSource, actorId: string | null) {
  const existing = db.query("SELECT id FROM companies WHERE book_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL").get(bookId, name.trim()) as { id: string } | null;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const timestamp = now();
  db.query(`INSERT INTO companies (id, short_id, book_id, name, source, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, newShortId(), bookId, name.trim().slice(0, 200), source, actorId, timestamp, timestamp);
  recordItemActivity({ itemKind: "company", itemId: id, container: { kind: "contact_book", id: bookId }, actorId, kind: "company_created", payload: { extra: { source } } });
  return id;
}

export type UpsertResult = { contactId: string; created: boolean; companyId: string | null; filled: string[] };

/**
 * Upsert by email (§B.3, D806). The caller checked the actor may write the book (or the module acts
 * for its owner, e.g. a public booking). Fills only empty fields; never overwrites a field in
 * `edited_json`. Call inside the caller's transaction.
 */
export function upsertContactByEmail(bookId: string, input: { email: string; name?: string | null; phone?: string | null; company?: string | null },
  context: { source: ContactSource; sourceRef?: string | null; actor: string | null }): UpsertResult {
  const book = bookRow(bookId);
  if (!book || book.deleted_at !== null) throw new PeopleError(404, "NOT_FOUND", "Contact book not found");
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new PeopleError(400, "INVALID", "Enter an email address");
  const phone = input.phone ? normalizePhone(input.phone) : null;
  const timestamp = now();
  const linkByDomain = settingsOf(book).linkCompaniesByDomain !== false;
  const domain = emailDomain(email);
  const companyFor = (): string | null => {
    if (input.company?.trim()) return companyByName(bookId, input.company, context.source, context.actor);
    if (linkByDomain && domain && !isFreeMailDomain(domain)) return companyForDomain(bookId, domain, { source: "email_domain", actorId: context.actor }).companyId;
    return null;
  };
  const existing = db.query(`SELECT c.id, c.first_name, c.last_name, c.display_name, c.company_id, c.edited_json, c.deleted_at FROM contact_channels ch JOIN contacts c ON c.id = ch.contact_id
    WHERE ch.book_id = ? AND ch.kind = 'email' AND ch.value_norm = ?`).get(bookId, email) as { id: string; first_name: string | null; last_name: string | null; display_name: string; company_id: string | null; edited_json: string; deleted_at: string | null } | null;
  if (existing && existing.deleted_at === null) {
    const edited = new Set(JSON.parse(existing.edited_json) as string[]);
    const filled: string[] = [];
    const sets: string[] = [];
    const values: Array<string | null> = [];
    const name = input.name?.trim();
    const derived = contactDisplayName({ email });
    if (name && !edited.has("name") && (!existing.first_name && !existing.last_name) && (existing.display_name === derived || existing.display_name === "Unnamed contact")) {
      const parts = splitName(name);
      sets.push("first_name = ?", "last_name = ?", "display_name = ?");
      values.push(parts.firstName, parts.lastName, contactDisplayName({ name }));
      filled.push("name");
    }
    let companyId = existing.company_id;
    if (!companyId && !edited.has("company")) {
      companyId = companyFor();
      if (companyId) { sets.push("company_id = ?"); values.push(companyId); filled.push("company"); }
    }
    if (phone && !edited.has("phone") && !db.query("SELECT 1 FROM contact_channels WHERE contact_id = ? AND kind = 'phone'").get(existing.id)) {
      db.query("INSERT INTO contact_channels (id, book_id, contact_id, kind, value, value_norm, is_primary, position, created_at) VALUES (?, ?, ?, 'phone', ?, ?, 1, 1, ?)").run(crypto.randomUUID(), bookId, existing.id, phone, phone, timestamp);
      filled.push("phone");
    }
    if (sets.length) db.query(`UPDATE contacts SET ${sets.join(", ")}, updated_at = ?, revision = revision + 1 WHERE id = ?`).run(...values, timestamp, existing.id);
    if (filled.length) {
      recordItemActivity({ itemKind: "contact", itemId: existing.id, container: { kind: "contact_book", id: bookId }, actorId: context.actor, kind: "contact_filled", payload: { extra: { fields: filled.join(","), source: context.source } } });
      audit(context.actor, null, "people.contact_filled", { bookId, contactId: existing.id, fields: filled, source: context.source });
    }
    return { contactId: existing.id, created: false, companyId, filled };
  }
  if (existing) {
    // A binned contact keeps its email until it is purged (the unique index): the upsert brings it back.
    db.query("UPDATE contacts SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, updated_at = ? WHERE id = ?").run(timestamp, existing.id);
    audit(context.actor, null, "people.contact_restored", { bookId, contactId: existing.id, source: context.source });
    return { contactId: existing.id, created: false, companyId: existing.company_id, filled: [] };
  }
  const parts = input.name?.trim() ? splitName(input.name) : { firstName: null, lastName: null };
  const id = crypto.randomUUID();
  const companyId = companyFor();
  db.query(`INSERT INTO contacts (id, short_id, book_id, first_name, last_name, display_name, company_id, source, source_ref, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, newShortId(), bookId, parts.firstName, parts.lastName, contactDisplayName({ name: input.name, email }), companyId, context.source, context.sourceRef?.slice(0, 80) ?? null, context.actor, timestamp, timestamp);
  db.query("INSERT INTO contact_channels (id, book_id, contact_id, kind, value, value_norm, is_primary, position, created_at) VALUES (?, ?, ?, 'email', ?, ?, 1, 0, ?)").run(crypto.randomUUID(), bookId, id, email, email, timestamp);
  if (phone) db.query("INSERT INTO contact_channels (id, book_id, contact_id, kind, value, value_norm, is_primary, position, created_at) VALUES (?, ?, ?, 'phone', ?, ?, 1, 1, ?)").run(crypto.randomUUID(), bookId, id, phone, phone, timestamp);
  recordItemActivity({ itemKind: "contact", itemId: id, container: { kind: "contact_book", id: bookId }, actorId: context.actor, kind: "contact_created", payload: { extra: { source: context.source } } });
  audit(context.actor, null, "people.contact_created", { bookId, contactId: id, source: context.source });
  return { contactId: id, created: true, companyId, filled: [] };
}

/** Marks fields a person edited by hand, so later upserts leave them alone (D806). Lanes call it from their edit service. */
export function markContactEdited(contactId: string, fields: readonly ("name" | "company" | "phone" | "job_title" | "location" | "tz")[]) {
  const row = db.query("SELECT edited_json FROM contacts WHERE id = ?").get(contactId) as { edited_json: string } | null;
  if (!row) return;
  const edited = new Set([...(JSON.parse(row.edited_json) as string[]), ...fields]);
  db.query("UPDATE contacts SET edited_json = ? WHERE id = ?").run(JSON.stringify([...edited]), contactId);
}

type ContactRow = { id: string; short_id: string; book_id: string; display_name: string; first_name: string | null; last_name: string | null; company_id: string | null; company_name: string | null;
  job_title: string | null; owner_id: string | null; last_interaction_at: string | null; updated_at: string; email: string | null; phone: string | null };

const contactSelect = `SELECT c.id, c.short_id, c.book_id, c.display_name, c.first_name, c.last_name, c.company_id, co.name AS company_name, c.job_title, c.owner_id, c.last_interaction_at, c.updated_at,
  (SELECT ch.value FROM contact_channels ch WHERE ch.contact_id = c.id AND ch.kind = 'email' ORDER BY ch.is_primary DESC, ch.position LIMIT 1) AS email,
  (SELECT ch.value FROM contact_channels ch WHERE ch.contact_id = c.id AND ch.kind = 'phone' ORDER BY ch.is_primary DESC, ch.position LIMIT 1) AS phone
  FROM contacts c LEFT JOIN companies co ON co.id = c.company_id AND co.deleted_at IS NULL`;

const toContact = (row: ContactRow): ContactSummary => ({
  id: row.id, shortId: row.short_id, bookId: row.book_id, displayName: row.display_name, firstName: row.first_name, lastName: row.last_name, email: row.email, phone: row.phone,
  companyId: row.company_id, companyName: row.company_name, jobTitle: row.job_title, ownerId: row.owner_id, lastInteractionAt: row.last_interaction_at, updatedAt: row.updated_at
});

/**
 * Chips for contacts named on an item the viewer can read (T503): details for contacts in books the
 * viewer can read, `{ kind: "contact", id, hidden: true }` ("A contact") for the rest, and for missing ones.
 */
export function contactSummaries(contactIds: readonly string[], viewerId: string): Map<string, PersonSummary> {
  const result = new Map<string, PersonSummary>();
  const ids = [...new Set(contactIds.map((id) => id.toLowerCase()))].slice(0, 500);
  if (!ids.length) return result;
  const rows = db.query(`${contactSelect} JOIN contact_books b ON b.id = c.book_id WHERE c.id IN (SELECT value FROM json_each($ids)) AND c.deleted_at IS NULL AND ${readableContainerSql("contact_book", "b")}`)
    .all({ ids: JSON.stringify(ids), userId: viewerId }) as ContactRow[];
  const readable = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = readable.get(id);
    result.set(id, row ? { kind: "contact", id, name: row.display_name, email: row.email, companyId: row.company_id, companyName: row.company_name, bookId: row.book_id, shortId: row.short_id } : { kind: "contact", id, hidden: true });
  }
  return result;
}

/** One contact for a reader of its book, or null (missing, binned, unreadable look the same). */
export function readableContact(contactRef: string, viewerId: string): ContactSummary | null {
  const column = /^[0-9][0-9a-z]{9}$/.test(contactRef) ? "c.short_id" : "c.id";
  const row = db.query(`${contactSelect} JOIN contact_books b ON b.id = c.book_id WHERE ${column} = $ref AND c.deleted_at IS NULL AND ${readableContainerSql("contact_book", "b")}`)
    .get({ ref: contactRef.toLowerCase(), userId: viewerId }) as ContactRow | null;
  return row ? toContact(row) : null;
}

/** Contacts the viewer can read whose name or email matches `q` (people pickers). */
export function searchContacts(viewerId: string, q: string, options: { bookIds?: readonly string[]; limit?: number } = {}): ContactSummary[] {
  const needle = q.trim().toLowerCase();
  const limit = Math.min(options.limit ?? 20, 50);
  const books = options.bookIds?.length ? options.bookIds.map((id) => id.toLowerCase()) : null;
  const rows = db.query(`${contactSelect} JOIN contact_books b ON b.id = c.book_id
      WHERE c.deleted_at IS NULL AND ${readableContainerSql("contact_book", "b")}
        ${books ? "AND c.book_id IN (SELECT value FROM json_each($books))" : ""}
        AND ($q = '' OR instr(lower(c.display_name), $q) > 0 OR EXISTS (SELECT 1 FROM contact_channels ch WHERE ch.contact_id = c.id AND ch.kind = 'email' AND instr(ch.value_norm, $q) > 0))
      ORDER BY c.display_name COLLATE NOCASE LIMIT $limit`).all({ userId: viewerId, q: needle, limit, ...(books ? { books: JSON.stringify(books) } : {}) }) as ContactRow[];
  return rows.map(toContact);
}
