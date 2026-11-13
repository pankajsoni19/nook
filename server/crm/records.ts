import { audit, db, now } from "../db";
import { recordItemActivity } from "../activity/service";
import { companyForDomain, markContactEdited } from "../people/contacts";
import { NO_FILTER, type SqlFilter } from "../keyResources";
import { isFreeMailDomain } from "../../shared/freeMailDomains";
import { contactDisplayName, emailDomain, splitName, type ContactSource } from "../../shared/people";
import { isEmail, normalizeEmail, normalizePhone } from "../../shared/questions";
import { newShortId } from "../../shared/friendlyUrls";
import { crmCompanyPath, crmContactPath, type CrmCompany, type CrmCompanyDetail, type CrmContact, type CrmContactDetail, type CrmFilter, type CrmSort } from "../../shared/crm";
import {
  bookFields, bookRow, bookSettings, cleanRef, cleanTags, cleanText, cleanUserId, CrmError, decodeCursor, encodeCursor, invalid, notFound, parseTags,
  readableBooksSql, readCustom, refColumn, requireBook, userRef, writeCustom, type BookRow
} from "./core";
import { afterCursor, compileFilters, sortSql } from "./query";
import { dealsFor } from "./deals";

/**
 * Contacts and companies (§D.5): list with filters, sorts, lists, and keyset pages; read with channels,
 * deals, and lists; create with dedupe by email (contacts) and domain (companies); update (marking hand
 * edits so later upserts leave them alone, D806); move to the Bin; find duplicates; merge (D965).
 */

type ContactRow = {
  id: string; short_id: string; book_id: string; display_name: string; first_name: string | null; last_name: string | null; company_id: string | null; company_name: string | null;
  job_title: string | null; owner_id: string | null; owner_name: string | null; lifecycle: string | null; location: string | null; tz: string | null; custom_json: string; tags_json: string;
  source: string; last_interaction_at: string | null; created_at: string; updated_at: string; revision: number; email: string | null; phone: string | null; sort_value?: string | number | null;
};

export const CONTACT_SELECT = `SELECT c.id, c.short_id, c.book_id, c.display_name, c.first_name, c.last_name, c.company_id, co.name AS company_name, c.job_title, c.owner_id, u.display_name AS owner_name,
  c.lifecycle, c.location, c.tz, c.custom_json, c.tags_json, c.source, c.last_interaction_at, c.created_at, c.updated_at, c.revision,
  (SELECT ch.value FROM contact_channels ch WHERE ch.contact_id = c.id AND ch.kind = 'email' ORDER BY ch.is_primary DESC, ch.position LIMIT 1) AS email,
  (SELECT ch.value FROM contact_channels ch WHERE ch.contact_id = c.id AND ch.kind = 'phone' ORDER BY ch.is_primary DESC, ch.position LIMIT 1) AS phone`;
const CONTACT_FROM = `FROM contacts c JOIN contact_books b ON b.id = c.book_id LEFT JOIN companies co ON co.id = c.company_id AND co.deleted_at IS NULL LEFT JOIN users u ON u.id = c.owner_id`;

const fieldsCache = () => {
  const cache = new Map<string, ReturnType<typeof bookFields>>();
  return (bookId: string) => {
    let fields = cache.get(bookId);
    if (!fields) {
      const row = db.query("SELECT fields_json FROM contact_books WHERE id = ?").get(bookId) as Pick<BookRow, "fields_json"> | null;
      fields = row ? bookFields(row) : bookFields({ fields_json: "{}" });
      cache.set(bookId, fields);
    }
    return fields;
  };
};

export function toContact(row: ContactRow, fields = fieldsCache()): CrmContact {
  return {
    id: row.id, shortId: row.short_id, bookId: row.book_id, displayName: row.display_name, firstName: row.first_name, lastName: row.last_name, email: row.email, phone: row.phone,
    jobTitle: row.job_title, companyId: row.company_id, companyName: row.company_name, owner: userRef(row.owner_id, row.owner_name), lifecycle: row.lifecycle, location: row.location, tz: row.tz,
    tags: parseTags(row.tags_json), source: row.source, custom: readCustom(fields(row.book_id).contact, row.custom_json), lastInteractionAt: row.last_interaction_at,
    createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision, href: crmContactPath(row.display_name, row.short_id)
  };
}

export type ListInput = { bookIds?: readonly string[] | null; q?: string; listId?: string | null; filters?: CrmFilter[]; sort?: CrmSort; cursor?: string | null; limit?: number; keyFilter?: SqlFilter; companyId?: string | null };

function listScope(input: ListInput, userId: string, alias: string) {
  const where = [`${readableBooksSql("b")}`, `${alias}.deleted_at IS NULL`];
  const params: Record<string, string | number> = { userId };
  if (input.bookIds) { where.push(`${alias}.book_id IN (SELECT value FROM json_each($bookIds))`); params.bookIds = JSON.stringify(input.bookIds); }
  const key = input.keyFilter ?? NO_FILTER;
  where.push(key.sql);
  Object.assign(params, key.params);
  if (input.listId) {
    const list = cleanRef(input.listId);
    if (!list) throw invalid("Unknown list");
    where.push(`${alias}.id IN (SELECT m.item_id FROM crm_list_members m JOIN crm_lists l ON l.id = m.list_id WHERE l.${refColumn(list)} = $listId AND l.deleted_at IS NULL)`);
    params.listId = list;
  }
  return { where, params };
}

/** One page of contacts the user reads. */
export function listContacts(userId: string, input: ListInput): { items: CrmContact[]; nextCursor: string | null } {
  const fields = fieldsCache();
  const custom = input.bookIds?.length === 1 ? fields(input.bookIds[0]!).contact : [];
  const { where, params } = listScope(input, userId, "c");
  const q = input.q?.trim().toLowerCase().slice(0, 100);
  if (q) {
    where.push(`(instr(lower(c.display_name), $q) > 0 OR instr(lower(COALESCE(co.name, '')), $q) > 0 OR EXISTS (SELECT 1 FROM contact_channels qch WHERE qch.contact_id = c.id AND instr(qch.value_norm, $q) > 0))`);
    params.q = q;
  }
  if (input.companyId) { where.push("c.company_id = $companyId"); params.companyId = input.companyId; }
  const filters = compileFilters("contact", input.filters, custom, userId);
  where.push(...filters.where);
  Object.assign(params, filters.params);
  const sort = sortSql("contact", input.sort, custom, "lower(c.display_name)");
  const after = afterCursor(sort.expr, sort.dir, "c.id", decodeCursor(input.cursor), params);
  if (after) where.push(after);
  const limit = Math.min(Math.max(1, input.limit ?? 50), 200);
  params.limit = limit + 1;
  const rows = db.query(`${CONTACT_SELECT}, ${sort.expr} AS sort_value ${CONTACT_FROM} WHERE ${where.join(" AND ")} ORDER BY ${sort.expr} ${sort.dir}, c.id ${sort.dir} LIMIT $limit`).all(params) as ContactRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map((row) => toContact(row, fields)), nextCursor: rows.length > limit && last ? encodeCursor(last.sort_value ?? null, last.id) : null };
}

/** A live contact the user reads (by id or short id), with its book's level. */
export function readContactRow(ref: string, userId: string) {
  const clean = cleanRef(ref);
  if (!clean) throw notFound("Contact not found");
  const row = db.query(`${CONTACT_SELECT} ${CONTACT_FROM} WHERE ${refColumn(clean, "c")} = $ref AND c.deleted_at IS NULL AND ${readableBooksSql("b")}`).get({ ref: clean, userId }) as ContactRow | null;
  if (!row) throw notFound("Contact not found");
  return row;
}

const listsOf = (itemId: string) => db.query("SELECT l.id, l.name FROM crm_list_members m JOIN crm_lists l ON l.id = m.list_id WHERE m.item_id = ? AND l.deleted_at IS NULL ORDER BY l.name").all(itemId) as Array<{ id: string; name: string }>;

export function getContact(ref: string, userId: string): CrmContactDetail {
  const row = readContactRow(ref, userId);
  const book = requireBook(row.book_id, userId);
  const channels = (db.query("SELECT id, kind, value, label, is_primary FROM contact_channels WHERE contact_id = ? ORDER BY kind, is_primary DESC, position").all(row.id) as Array<{ id: string; kind: "email"; value: string; label: string | null; is_primary: number }>)
    .map((channel) => ({ id: channel.id, kind: channel.kind, value: channel.value, label: channel.label, isPrimary: channel.is_primary === 1 }));
  return { ...toContact(row), channels, deals: dealsFor("contact", row.id, userId), lists: listsOf(row.id), canEdit: ["edit", "manage", "owner"].includes(book.level), duplicates: duplicatesOf(row) };
}

function duplicatesOf(row: ContactRow) {
  const found = db.query(`SELECT c.id, c.display_name, CASE WHEN lower(c.display_name) = lower($name) THEN 'Same name' ELSE 'Same phone' END AS reason FROM contacts c
    WHERE c.book_id = $book AND c.id <> $id AND c.deleted_at IS NULL AND (lower(c.display_name) = lower($name)
      OR ($phone IS NOT NULL AND EXISTS (SELECT 1 FROM contact_channels ch WHERE ch.contact_id = c.id AND ch.kind = 'phone' AND ch.value_norm = $phone))) LIMIT 5`)
    .all({ book: row.book_id, id: row.id, name: row.display_name, phone: row.phone ? normalizePhone(row.phone) : null }) as Array<{ id: string; display_name: string; reason: string }>;
  return found.map((item) => ({ id: item.id, displayName: item.display_name, reason: item.reason }));
}

export type ContactInput = {
  bookId?: string; name?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null; jobTitle?: string | null;
  companyId?: string | null; companyName?: string | null; ownerId?: string | null; lifecycle?: string | null; location?: string | null; tz?: string | null; tags?: string[]; custom?: Record<string, unknown>;
};

/** A company for a contact: one of the book's by id, or by name (created when missing). */
function companyRef(bookId: string, input: { companyId?: string | null; companyName?: string | null }, source: ContactSource, actorId: string): string | null | undefined {
  if (input.companyId !== undefined && input.companyId !== null && input.companyId !== "") {
    const id = cleanRef(input.companyId);
    const row = id ? db.query(`SELECT id FROM companies WHERE ${refColumn(id)} = ? AND book_id = ? AND deleted_at IS NULL`).get(id, bookId) as { id: string } | null : null;
    if (!row) throw invalid("Choose a company in this book");
    return row.id;
  }
  const name = cleanText(input.companyName, 200, "The company");
  if (name) {
    const existing = db.query("SELECT id FROM companies WHERE book_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL").get(bookId, name) as { id: string } | null;
    if (existing) return existing.id;
    return insertCompany(bookId, { name }, source, actorId);
  }
  if (input.companyId === null || input.companyId === "" || input.companyName === null || input.companyName === "") return null;
  return undefined;
}

function cleanEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 254) throw invalid("Enter an email address");
  const email = normalizeEmail(value);
  if (!isEmail(email)) throw invalid("Enter an email address");
  return email;
}
function cleanPhone(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 60) throw invalid("Enter a phone number");
  const phone = normalizePhone(value);
  if (!phone) throw invalid("Enter a phone number");
  return phone;
}

const emailOwner = (bookId: string, email: string) => db.query("SELECT ch.contact_id, c.display_name, c.deleted_at FROM contact_channels ch JOIN contacts c ON c.id = ch.contact_id WHERE ch.book_id = ? AND ch.kind = 'email' AND ch.value_norm = ?")
  .get(bookId, email) as { contact_id: string; display_name: string; deleted_at: string | null } | null;

function setPrimaryChannel(bookId: string, contactId: string, kind: "email" | "phone", value: string | null) {
  const primary = db.query("SELECT id FROM contact_channels WHERE contact_id = ? AND kind = ? ORDER BY is_primary DESC, position LIMIT 1").get(contactId, kind) as { id: string } | null;
  if (value === null) {
    if (primary) db.query("DELETE FROM contact_channels WHERE id = ?").run(primary.id);
    return;
  }
  if (primary) db.query("UPDATE contact_channels SET value = ?, value_norm = ?, is_primary = 1 WHERE id = ?").run(value, value.toLowerCase(), primary.id);
  else db.query("INSERT INTO contact_channels (id, book_id, contact_id, kind, value, value_norm, is_primary, position, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
    .run(crypto.randomUUID(), bookId, contactId, kind, value, value.toLowerCase(), kind === "email" ? 0 : 1, now());
}

/** Creates a contact (edit on the book). An email another contact of the book has is 409 EXISTS with its id (dedupe). Call inside a transaction or alone. */
export function createContact(userId: string, input: ContactInput, source: ContactSource = "manual"): CrmContact {
  return db.transaction(() => {
    const book = requireBook(input.bookId ?? "", userId, "edit");
    const email = cleanEmail(input.email);
    const phone = cleanPhone(input.phone);
    if (email) {
      const owner = emailOwner(book.id, email);
      if (owner) throw new CrmError(409, "EXISTS", owner.deleted_at ? "A contact in the Bin has this email; restore it instead" : `${owner.display_name} already has this email`, { contactId: owner.contact_id });
    }
    const first = cleanText(input.firstName, 80, "The first name");
    const last = cleanText(input.lastName, 80, "The last name");
    const full = cleanText(input.name, 160, "The name");
    const parts = !first && !last && full ? splitName(full) : { firstName: first, lastName: last };
    const displayName = contactDisplayName({ firstName: parts.firstName, lastName: parts.lastName, name: !first && !last ? full : null, email });
    if (displayName === "Unnamed contact" && !email && !phone) throw invalid("Give the contact a name or an email");
    const settings = bookSettings(book);
    let companyId = companyRef(book.id, input, source, userId) ?? null;
    const domain = emailDomain(email);
    if (companyId === null && input.companyId === undefined && input.companyName === undefined && email && settings.linkCompaniesByDomain && domain && !isFreeMailDomain(domain)) {
      companyId = companyForDomain(book.id, domain, { source: "email_domain", actorId: userId }).companyId;
    }
    const id = crypto.randomUUID();
    const timestamp = now();
    const custom = writeCustom(bookFields(book).contact, "{}", input.custom ?? {}, book.id, userId, "create");
    db.query(`INSERT INTO contacts (id, short_id, book_id, first_name, last_name, display_name, company_id, job_title, owner_id, lifecycle, location, tz, custom_json, tags_json, source, created_by, created_at, updated_at, last_interaction_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(id, newShortId(), book.id, parts.firstName, parts.lastName, displayName, companyId, cleanText(input.jobTitle, 120, "The job title"), cleanUserId(input.ownerId) ?? (input.ownerId === undefined ? userId : null),
        cleanText(input.lifecycle, 40, "The lifecycle"), cleanText(input.location, 200, "The location"), cleanText(input.tz, 64, "The time zone"), custom, cleanTags(input.tags), source, userId, timestamp, timestamp);
    if (email) setPrimaryChannel(book.id, id, "email", email);
    if (phone) setPrimaryChannel(book.id, id, "phone", phone);
    recordItemActivity({ itemKind: "contact", itemId: id, container: { kind: "contact_book", id: book.id }, actorId: userId, kind: "created", payload: { to: { label: displayName } } });
    audit(userId, null, "crm.contact_create", { bookId: book.id, contactId: id, source });
    return toContact(readContactRow(id, userId));
  })();
}

const CONTACT_LABELS: Record<string, string> = { name: "Name", email: "Email", phone: "Phone", jobTitle: "Job title", company: "Company", owner: "Owner", lifecycle: "Lifecycle", location: "Location", tz: "Time zone", tags: "Tags", custom: "Custom fields" };

/** Updates a contact (edit on its book); `expectedRevision` makes a stale write 409 CONFLICT. */
export function updateContact(ref: string, userId: string, patch: ContactInput & { expectedRevision?: number }): CrmContact {
  return db.transaction(() => {
    const row = readContactRow(ref, userId);
    const book = requireBook(row.book_id, userId, "edit");
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== row.revision) throw new CrmError(409, "CONFLICT", "Someone else changed this contact. Reload and try again.", { revision: row.revision });
    const sets: string[] = [];
    const values: Array<string | null> = [];
    const changed: string[] = [];
    const edited: Array<"name" | "company" | "phone" | "job_title" | "location" | "tz"> = [];
    const set = (column: string, value: string | null, label: string) => { sets.push(`${column} = ?`); values.push(value); if (!changed.includes(label)) changed.push(label); };
    if (patch.firstName !== undefined || patch.lastName !== undefined || patch.name !== undefined) {
      let first = patch.firstName !== undefined ? cleanText(patch.firstName, 80, "The first name") : row.first_name;
      let last = patch.lastName !== undefined ? cleanText(patch.lastName, 80, "The last name") : row.last_name;
      if (patch.name !== undefined && patch.firstName === undefined && patch.lastName === undefined) {
        const full = cleanText(patch.name, 160, "The name");
        ({ firstName: first, lastName: last } = full ? splitName(full) : { firstName: null, lastName: null });
      }
      const name = contactDisplayName({ firstName: first, lastName: last, email: row.email });
      set("first_name", first, "Name"); set("last_name", last, "Name"); set("display_name", name, "Name");
      edited.push("name");
    }
    if (patch.email !== undefined) {
      const email = cleanEmail(patch.email);
      if (email && email !== row.email?.toLowerCase()) {
        const owner = emailOwner(book.id, email);
        if (owner && owner.contact_id !== row.id) throw new CrmError(409, "EXISTS", `${owner.display_name} already has this email`, { contactId: owner.contact_id });
      }
      if ((email ?? null) !== (row.email?.toLowerCase() ?? null)) { setPrimaryChannel(book.id, row.id, "email", email); changed.push(CONTACT_LABELS.email!); }
    }
    if (patch.phone !== undefined) {
      const phone = cleanPhone(patch.phone);
      if (phone !== row.phone) { setPrimaryChannel(book.id, row.id, "phone", phone); changed.push(CONTACT_LABELS.phone!); edited.push("phone"); }
    }
    if (patch.jobTitle !== undefined) { set("job_title", cleanText(patch.jobTitle, 120, "The job title"), "Job title"); edited.push("job_title"); }
    if (patch.companyId !== undefined || patch.companyName !== undefined) {
      const companyId = companyRef(book.id, patch, "manual", userId);
      if (companyId !== undefined) { set("company_id", companyId, "Company"); edited.push("company"); }
    }
    if (patch.ownerId !== undefined) set("owner_id", cleanUserId(patch.ownerId), "Owner");
    if (patch.lifecycle !== undefined) set("lifecycle", cleanText(patch.lifecycle, 40, "The lifecycle"), "Lifecycle");
    if (patch.location !== undefined) { set("location", cleanText(patch.location, 200, "The location"), "Location"); edited.push("location"); }
    if (patch.tz !== undefined) { set("tz", cleanText(patch.tz, 64, "The time zone"), "Time zone"); edited.push("tz"); }
    if (patch.tags !== undefined) set("tags_json", cleanTags(patch.tags), "Tags");
    if (patch.custom !== undefined) set("custom_json", writeCustom(bookFields(book).contact, row.custom_json, patch.custom, book.id, userId, "update"), "Custom fields");
    if (!changed.length) return toContact(row);
    db.query(`UPDATE contacts SET ${[...sets, "updated_at = ?", "revision = revision + 1"].join(", ")} WHERE id = ?`).run(...values, now(), row.id);
    if (edited.length) markContactEdited(row.id, edited);
    recordItemActivity({ itemKind: "contact", itemId: row.id, container: { kind: "contact_book", id: book.id }, actorId: userId, kind: "crm_updated", payload: { extra: { fields: changed.join(", ") } } });
    audit(userId, null, "crm.contact_update", { bookId: book.id, contactId: row.id, fields: changed });
    return toContact(readContactRow(row.id, userId));
  })();
}

/** Moves a contact to the Bin (edit on its book). */
export function binContact(ref: string, userId: string) {
  return db.transaction(() => {
    const row = readContactRow(ref, userId);
    requireBook(row.book_id, userId, "edit");
    const timestamp = now();
    db.query("UPDATE contacts SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ?").run(timestamp, userId, new Date(Date.now() + 30 * 86_400_000).toISOString(), timestamp, row.id);
    recordItemActivity({ itemKind: "contact", itemId: row.id, container: { kind: "contact_book", id: row.book_id }, actorId: userId, kind: "binned" });
    audit(userId, null, "crm.contact_delete", { bookId: row.book_id, contactId: row.id });
    return { binned: true, id: row.id };
  })();
}

/** Candidate duplicate pairs in a book (same name, or same phone; emails are unique per book already). */
export function contactDuplicates(bookRef: string, userId: string) {
  const book = requireBook(bookRef, userId);
  const pairs = db.query(`SELECT a.id AS a, b.id AS b, CASE WHEN lower(a.display_name) = lower(b.display_name) THEN 'Same name' ELSE 'Same phone' END AS reason
    FROM contacts a JOIN contacts b ON b.book_id = a.book_id AND b.id > a.id AND b.deleted_at IS NULL
    WHERE a.book_id = $book AND a.deleted_at IS NULL AND (lower(a.display_name) = lower(b.display_name)
      OR EXISTS (SELECT 1 FROM contact_channels pa JOIN contact_channels pb ON pb.value_norm = pa.value_norm AND pb.kind = 'phone' WHERE pa.contact_id = a.id AND pa.kind = 'phone' AND pb.contact_id = b.id))
    LIMIT 50`).all({ book: book.id }) as Array<{ a: string; b: string; reason: string }>;
  const fields = fieldsCache();
  const read = (id: string) => toContact(db.query(`${CONTACT_SELECT} ${CONTACT_FROM} WHERE c.id = ?`).get(id) as ContactRow, fields);
  return pairs.map((pair) => ({ a: read(pair.a), b: read(pair.b), reason: pair.reason }));
}

/** Moves every reference from one record to another (merge, D965). Lanes' tables are touched only when they exist. */
function moveReferences(kind: "contact" | "company", fromId: string, toId: string) {
  db.query("UPDATE OR IGNORE interaction_subjects SET subject_id = ? WHERE subject_kind = ? AND subject_id = ?").run(toId, kind, fromId);
  db.query("DELETE FROM interaction_subjects WHERE subject_kind = ? AND subject_id = ?").run(kind, fromId);
  db.query("UPDATE OR IGNORE crm_list_members SET item_id = ? WHERE item_id = ?").run(toId, fromId);
  db.query("DELETE FROM crm_list_members WHERE item_id = ?").run(fromId);
  db.query("UPDATE crm_followups SET subject_id = ? WHERE subject_kind = ? AND subject_id = ?").run(toId, kind, fromId);
  db.query("UPDATE OR IGNORE work_links SET a_id = ? WHERE a_kind = ? AND a_id = ?").run(toId, kind, fromId);
  db.query("UPDATE OR IGNORE work_links SET b_id = ? WHERE b_kind = ? AND b_id = ?").run(toId, kind, fromId);
  db.query("UPDATE item_comments SET item_id = ? WHERE item_kind = ? AND item_id = ?").run(toId, kind, fromId);
  const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  const refs: Array<[string, string]> = kind === "contact"
    ? [["responses", "respondent_contact_id"], ["bookings", "contact_id"], ["time_entries", "contact_id"]]
    : [["time_projects", "company_id"], ["bookings", "company_id"], ["time_entries", "company_id"]];
  for (const [table, column] of refs) if (tables.has(table) && columns(table).includes(column)) db.query(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(toId, fromId);
}

/**
 * Merges `sourceRef` into `targetRef` (D965, T562: same book only): the target keeps its non-empty
 * fields and takes the source's where it has none; channels, tags, deals, interactions, lists,
 * follow-ups, links, comments, and other modules' references move; the source is deleted.
 */
export function mergeContacts(sourceRef: string, targetRef: string, userId: string): CrmContact {
  return db.transaction(() => {
    const source = readContactRow(sourceRef, userId);
    const target = readContactRow(targetRef, userId);
    if (source.id === target.id) throw invalid("Choose two different contacts");
    if (source.book_id !== target.book_id) throw new CrmError(400, "OTHER_BOOK", "Only contacts in the same book can be merged");
    requireBook(target.book_id, userId, "edit");
    const full = (id: string) => db.query("SELECT * FROM contacts WHERE id = ?").get(id) as Record<string, string | null>;
    const s = full(source.id);
    const t = full(target.id);
    const fill = ["first_name", "last_name", "company_id", "job_title", "owner_id", "lifecycle", "location", "tz", "avatar_document_id", "last_interaction_at"];
    const sets: string[] = [];
    const values: Array<string | null> = [];
    for (const column of fill) if ((t[column] === null || t[column] === "") && s[column]) { sets.push(`${column} = ?`); values.push(s[column]!); }
    if (s.last_interaction_at && t.last_interaction_at && s.last_interaction_at > t.last_interaction_at) { sets.push("last_interaction_at = ?"); values.push(s.last_interaction_at); }
    const tags = JSON.stringify([...new Set([...parseTags(t.tags_json!), ...parseTags(s.tags_json!)])].slice(0, 30));
    const custom = JSON.stringify({ ...JSON.parse(s.custom_json!), ...JSON.parse(t.custom_json!) });
    if (custom.length <= 16_384) { sets.push("custom_json = ?"); values.push(custom); }
    sets.push("tags_json = ?"); values.push(tags);
    if ((!t.first_name && !t.last_name) && (s.first_name || s.last_name)) { sets.push("display_name = ?"); values.push(s.display_name!); }
    // Channels: the source's that the target lacks move over (an email stays unique per book).
    const targetValues = new Set((db.query("SELECT kind || ':' || value_norm AS key FROM contact_channels WHERE contact_id = ?").all(target.id) as Array<{ key: string }>).map((row) => row.key));
    for (const channel of db.query("SELECT id, kind, value_norm FROM contact_channels WHERE contact_id = ?").all(source.id) as Array<{ id: string; kind: string; value_norm: string }>) {
      if (targetValues.has(`${channel.kind}:${channel.value_norm}`)) db.query("DELETE FROM contact_channels WHERE id = ?").run(channel.id);
      else db.query("UPDATE contact_channels SET contact_id = ?, is_primary = 0, position = position + 10 WHERE id = ?").run(target.id, channel.id);
    }
    db.query("INSERT OR IGNORE INTO deal_contacts (deal_id, contact_id, role) SELECT deal_id, ?, role FROM deal_contacts WHERE contact_id = ?").run(target.id, source.id);
    db.query("DELETE FROM deal_contacts WHERE contact_id = ?").run(source.id);
    moveReferences("contact", source.id, target.id);
    db.query(`UPDATE contacts SET ${[...sets, "updated_at = ?", "revision = revision + 1"].join(", ")} WHERE id = ?`).run(...values, now(), target.id);
    db.query("DELETE FROM contacts WHERE id = ?").run(source.id);
    recordItemActivity({ itemKind: "contact", itemId: target.id, container: { kind: "contact_book", id: target.book_id }, actorId: userId, kind: "crm_merged", payload: { extra: { merged_from: source.display_name.slice(0, 120) } } });
    audit(userId, null, "crm.contact_merge", { bookId: target.book_id, contactId: target.id, mergedId: source.id });
    return toContact(readContactRow(target.id, userId));
  })();
}

// ----------------------------------------------------------------------------- companies

type CompanyRow = {
  id: string; short_id: string; book_id: string; name: string; domain: string | null; website: string | null; description: string; owner_id: string | null; owner_name: string | null;
  tags_json: string; source: string; custom_json: string; last_interaction_at: string | null; created_at: string; updated_at: string; revision: number; contact_count: number; open_deals: number; sort_value?: string | number | null;
};
const COMPANY_SELECT = `SELECT co.id, co.short_id, co.book_id, co.name, co.domain, co.website, co.description, co.owner_id, u.display_name AS owner_name, co.tags_json, co.source, co.custom_json,
  co.last_interaction_at, co.created_at, co.updated_at, co.revision,
  (SELECT COUNT(*) FROM contacts cc WHERE cc.company_id = co.id AND cc.deleted_at IS NULL) AS contact_count,
  (SELECT COUNT(*) FROM deals dd WHERE dd.company_id = co.id AND dd.deleted_at IS NULL AND dd.status = 'open') AS open_deals`;
const COMPANY_FROM = "FROM companies co JOIN contact_books b ON b.id = co.book_id LEFT JOIN users u ON u.id = co.owner_id";

export function toCompany(row: CompanyRow, fields = fieldsCache()): CrmCompany {
  return {
    id: row.id, shortId: row.short_id, bookId: row.book_id, name: row.name, domain: row.domain, website: row.website, description: row.description, owner: userRef(row.owner_id, row.owner_name),
    tags: parseTags(row.tags_json), source: row.source, custom: readCustom(fields(row.book_id).company, row.custom_json), contactCount: row.contact_count, openDeals: row.open_deals,
    lastInteractionAt: row.last_interaction_at, createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision, href: crmCompanyPath(row.name, row.short_id)
  };
}

export function listCompanies(userId: string, input: ListInput): { items: CrmCompany[]; nextCursor: string | null } {
  const fields = fieldsCache();
  const custom = input.bookIds?.length === 1 ? fields(input.bookIds[0]!).company : [];
  const { where, params } = listScope(input, userId, "co");
  const q = input.q?.trim().toLowerCase().slice(0, 100);
  if (q) { where.push("(instr(lower(co.name), $q) > 0 OR instr(COALESCE(co.domain, ''), $q) > 0)"); params.q = q; }
  const filters = compileFilters("company", input.filters, custom, userId);
  where.push(...filters.where);
  Object.assign(params, filters.params);
  const sort = sortSql("company", input.sort, custom, "lower(co.name)");
  const after = afterCursor(sort.expr, sort.dir, "co.id", decodeCursor(input.cursor), params);
  if (after) where.push(after);
  const limit = Math.min(Math.max(1, input.limit ?? 50), 200);
  params.limit = limit + 1;
  const rows = db.query(`${COMPANY_SELECT}, ${sort.expr} AS sort_value ${COMPANY_FROM} WHERE ${where.join(" AND ")} ORDER BY ${sort.expr} ${sort.dir}, co.id ${sort.dir} LIMIT $limit`).all(params) as CompanyRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map((row) => toCompany(row, fields)), nextCursor: rows.length > limit && last ? encodeCursor(last.sort_value ?? null, last.id) : null };
}

export function readCompanyRow(ref: string, userId: string): CompanyRow {
  const clean = cleanRef(ref);
  if (!clean) throw notFound("Company not found");
  const row = db.query(`${COMPANY_SELECT} ${COMPANY_FROM} WHERE ${refColumn(clean, "co")} = $ref AND co.deleted_at IS NULL AND ${readableBooksSql("b")}`).get({ ref: clean, userId }) as CompanyRow | null;
  if (!row) throw notFound("Company not found");
  return row;
}

export function getCompany(ref: string, userId: string): CrmCompanyDetail {
  const row = readCompanyRow(ref, userId);
  const book = requireBook(row.book_id, userId);
  return { ...toCompany(row), contacts: listContacts(userId, { bookIds: [row.book_id], companyId: row.id, limit: 200 }).items, deals: dealsFor("company", row.id, userId), lists: listsOf(row.id), canEdit: ["edit", "manage", "owner"].includes(book.level) };
}

export type CompanyInput = { bookId?: string; name?: string | null; domain?: string | null; website?: string | null; description?: string | null; ownerId?: string | null; tags?: string[]; custom?: Record<string, unknown> };

function cleanDomain(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw invalid("Enter a domain like acme.com");
  const domain = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]!;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain) || domain.length > 253) throw invalid("Enter a domain like acme.com");
  return domain;
}
function cleanWebsite(value: unknown): string | null {
  const text = cleanText(value, 2048, "The website");
  if (!text) return null;
  const url = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); return parsed.toString(); } catch { throw invalid("Enter a website link"); }
}

function insertCompany(bookId: string, input: CompanyInput, source: ContactSource, actorId: string, extra: { domain?: string | null; website?: string | null; description?: string; ownerId?: string | null; tags?: string; custom?: string } = {}) {
  const id = crypto.randomUUID();
  const timestamp = now();
  const name = cleanText(input.name, 200, "The name");
  if (!name) throw invalid("Name the company");
  db.query(`INSERT INTO companies (id, short_id, book_id, name, domain, website, description, owner_id, custom_json, tags_json, source, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, newShortId(), bookId, name, extra.domain ?? null, extra.website ?? null, extra.description ?? "", extra.ownerId ?? null, extra.custom ?? "{}", extra.tags ?? "[]", source, actorId, timestamp, timestamp);
  recordItemActivity({ itemKind: "company", itemId: id, container: { kind: "contact_book", id: bookId }, actorId, kind: "created", payload: { to: { label: name } } });
  return id;
}

export function createCompany(userId: string, input: CompanyInput, source: ContactSource = "manual"): CrmCompany {
  return db.transaction(() => {
    const book = requireBook(input.bookId ?? "", userId, "edit");
    const domain = cleanDomain(input.domain) ?? (input.website ? cleanDomain(cleanWebsite(input.website)) : null);
    if (domain) {
      const existing = db.query("SELECT id, name FROM companies WHERE book_id = ? AND domain = ? AND deleted_at IS NULL").get(book.id, domain) as { id: string; name: string } | null;
      if (existing) throw new CrmError(409, "EXISTS", `${existing.name} already has this domain`, { companyId: existing.id });
    }
    const id = insertCompany(book.id, input, source, userId, {
      domain, website: cleanWebsite(input.website) ?? (domain ? `https://${domain}` : null), description: cleanText(input.description, 20_000, "The description") ?? "",
      ownerId: cleanUserId(input.ownerId) ?? (input.ownerId === undefined ? userId : null), tags: cleanTags(input.tags), custom: writeCustom(bookFields(book).company, "{}", input.custom ?? {}, book.id, userId, "create")
    });
    audit(userId, null, "crm.company_create", { bookId: book.id, companyId: id, source });
    return toCompany(readCompanyRow(id, userId));
  })();
}

export function updateCompany(ref: string, userId: string, patch: CompanyInput & { expectedRevision?: number }): CrmCompany {
  return db.transaction(() => {
    const row = readCompanyRow(ref, userId);
    const book = requireBook(row.book_id, userId, "edit");
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== row.revision) throw new CrmError(409, "CONFLICT", "Someone else changed this company. Reload and try again.", { revision: row.revision });
    const sets: string[] = [];
    const values: Array<string | null> = [];
    const changed: string[] = [];
    const set = (column: string, value: string | null, label: string) => { sets.push(`${column} = ?`); values.push(value); changed.push(label); };
    if (patch.name !== undefined) { const name = cleanText(patch.name, 200, "The name"); if (!name) throw invalid("Name the company"); set("name", name, "Name"); }
    if (patch.domain !== undefined) {
      const domain = cleanDomain(patch.domain);
      if (domain && domain !== row.domain && db.query("SELECT 1 FROM companies WHERE book_id = ? AND domain = ? AND deleted_at IS NULL AND id <> ?").get(book.id, domain, row.id)) throw new CrmError(409, "EXISTS", "Another company has this domain");
      set("domain", domain, "Domain");
    }
    if (patch.website !== undefined) set("website", cleanWebsite(patch.website), "Website");
    if (patch.description !== undefined) set("description", cleanText(patch.description, 20_000, "The description") ?? "", "Description");
    if (patch.ownerId !== undefined) set("owner_id", cleanUserId(patch.ownerId), "Owner");
    if (patch.tags !== undefined) set("tags_json", cleanTags(patch.tags), "Tags");
    if (patch.custom !== undefined) set("custom_json", writeCustom(bookFields(book).company, row.custom_json, patch.custom, book.id, userId, "update"), "Custom fields");
    if (!sets.length) return toCompany(row);
    db.query(`UPDATE companies SET ${[...sets, "updated_at = ?", "revision = revision + 1"].join(", ")} WHERE id = ?`).run(...values, now(), row.id);
    recordItemActivity({ itemKind: "company", itemId: row.id, container: { kind: "contact_book", id: book.id }, actorId: userId, kind: "crm_updated", payload: { extra: { fields: changed.join(", ") } } });
    audit(userId, null, "crm.company_update", { bookId: book.id, companyId: row.id, fields: changed });
    return toCompany(readCompanyRow(row.id, userId));
  })();
}

export function binCompany(ref: string, userId: string) {
  return db.transaction(() => {
    const row = readCompanyRow(ref, userId);
    requireBook(row.book_id, userId, "edit");
    const timestamp = now();
    db.query("UPDATE companies SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ?").run(timestamp, userId, new Date(Date.now() + 30 * 86_400_000).toISOString(), timestamp, row.id);
    recordItemActivity({ itemKind: "company", itemId: row.id, container: { kind: "contact_book", id: row.book_id }, actorId: userId, kind: "binned" });
    audit(userId, null, "crm.company_delete", { bookId: row.book_id, companyId: row.id });
    return { binned: true, id: row.id };
  })();
}

/** Merges one company into another of the same book (D965): contacts, deals, interactions, lists, links move. */
export function mergeCompanies(sourceRef: string, targetRef: string, userId: string): CrmCompany {
  return db.transaction(() => {
    const source = readCompanyRow(sourceRef, userId);
    const target = readCompanyRow(targetRef, userId);
    if (source.id === target.id) throw invalid("Choose two different companies");
    if (source.book_id !== target.book_id) throw new CrmError(400, "OTHER_BOOK", "Only companies in the same book can be merged");
    requireBook(target.book_id, userId, "edit");
    db.query("UPDATE contacts SET company_id = ? WHERE company_id = ?").run(target.id, source.id);
    db.query("UPDATE deals SET company_id = ? WHERE company_id = ?").run(target.id, source.id);
    moveReferences("company", source.id, target.id);
    const domain = target.domain ?? source.domain;
    db.query("DELETE FROM companies WHERE id = ?").run(source.id);
    db.query(`UPDATE companies SET domain = ?, website = COALESCE(website, ?), description = CASE WHEN description = '' THEN ? ELSE description END, owner_id = COALESCE(owner_id, ?),
      tags_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`)
      .run(domain, source.website, source.description, source.owner_id, JSON.stringify([...new Set([...parseTags(target.tags_json), ...parseTags(source.tags_json)])].slice(0, 30)), now(), target.id);
    recordItemActivity({ itemKind: "company", itemId: target.id, container: { kind: "contact_book", id: target.book_id }, actorId: userId, kind: "crm_merged", payload: { extra: { merged_from: source.name.slice(0, 120) } } });
    audit(userId, null, "crm.company_merge", { bookId: target.book_id, companyId: target.id, mergedId: source.id });
    return toCompany(readCompanyRow(target.id, userId));
  })();
}

export { bookRow };
