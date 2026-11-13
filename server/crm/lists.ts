import { audit, db, now } from "../db";
import { newShortId } from "../../shared/friendlyUrls";
import { FILTER_OPS, isCrmEntity, type CrmEntity, type CrmList, type CrmView, type CrmViewConfig } from "../../shared/crm";
import { cleanRef, cleanText, CrmError, invalid, notFound, readableBooksSql, refColumn, requireBook } from "./core";

/**
 * Static lists and saved views (§D.5): a list is a hand-picked set of contacts, companies, or deals
 * in one book (editors manage them); a view is a saved filter, sort, and layout, shared with the
 * book (editors) or personal (anyone who reads the book).
 */

type ListRow = { id: string; short_id: string; book_id: string; name: string; entity: CrmEntity; created_at: string; count: number };
const toList = (row: ListRow): CrmList => ({ id: row.id, shortId: row.short_id, bookId: row.book_id, name: row.name, entity: row.entity, count: row.count, createdAt: row.created_at });
const LIST_SELECT = `SELECT l.id, l.short_id, l.book_id, l.name, l.entity, l.created_at, (SELECT COUNT(*) FROM crm_list_members m WHERE m.list_id = l.id) AS count
  FROM crm_lists l JOIN contact_books b ON b.id = l.book_id`;

export function listLists(userId: string, options: { bookIds?: readonly string[] | null; entity?: CrmEntity | null } = {}): CrmList[] {
  const where = ["l.deleted_at IS NULL", readableBooksSql("b")];
  const params: Record<string, string> = { userId };
  if (options.bookIds) { where.push("l.book_id IN (SELECT value FROM json_each($books))"); params.books = JSON.stringify(options.bookIds); }
  if (options.entity) { where.push("l.entity = $entity"); params.entity = options.entity; }
  return (db.query(`${LIST_SELECT} WHERE ${where.join(" AND ")} ORDER BY l.name COLLATE NOCASE LIMIT 500`).all(params) as ListRow[]).map(toList);
}

export function readList(ref: string, userId: string): CrmList {
  const clean = cleanRef(ref);
  if (!clean) throw notFound("List not found");
  const row = db.query(`${LIST_SELECT} WHERE ${refColumn(clean, "l")} = $ref AND l.deleted_at IS NULL AND ${readableBooksSql("b")}`).get({ ref: clean, userId }) as ListRow | null;
  if (!row) throw notFound("List not found");
  return toList(row);
}

export function createList(userId: string, input: { bookId?: string; name?: unknown; entity?: unknown }): CrmList {
  return db.transaction(() => {
    const book = requireBook(input.bookId ?? "", userId, "edit");
    const name = cleanText(input.name, 80, "The name");
    if (!name) throw invalid("Name the list");
    if (!isCrmEntity(input.entity)) throw invalid("A list holds contacts, companies, or deals");
    if ((db.query("SELECT COUNT(*) AS n FROM crm_lists WHERE book_id = ? AND deleted_at IS NULL").get(book.id) as { n: number }).n >= 200) throw new CrmError(400, "LIMIT_REACHED", "A book can have up to 200 lists");
    const id = crypto.randomUUID();
    const timestamp = now();
    db.query("INSERT INTO crm_lists (id, short_id, book_id, name, entity, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, newShortId(), book.id, name, input.entity, userId, timestamp, timestamp);
    audit(userId, null, "crm.list_create", { bookId: book.id, listId: id });
    return readList(id, userId);
  })();
}

export function updateList(ref: string, userId: string, input: { name?: unknown }): CrmList {
  return db.transaction(() => {
    const list = readList(ref, userId);
    requireBook(list.bookId, userId, "edit");
    const name = cleanText(input.name, 80, "The name");
    if (!name) throw invalid("Name the list");
    db.query("UPDATE crm_lists SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), list.id);
    return readList(list.id, userId);
  })();
}

export function deleteList(ref: string, userId: string) {
  return db.transaction(() => {
    const list = readList(ref, userId);
    requireBook(list.bookId, userId, "edit");
    db.query("DELETE FROM crm_lists WHERE id = ?").run(list.id);
    audit(userId, null, "crm.list_delete", { bookId: list.bookId, listId: list.id });
    return { deleted: true };
  })();
}

const ENTITY_TABLE: Record<CrmEntity, string> = { contact: "contacts", company: "companies", deal: "deals" };

/** Adds or removes members (ids of the list's entity in its book). */
export function changeListMembers(ref: string, userId: string, input: { add?: unknown; remove?: unknown }): CrmList {
  return db.transaction(() => {
    const list = readList(ref, userId);
    requireBook(list.bookId, userId, "edit");
    const ids = (value: unknown) => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 500) throw invalid("Up to 500 at a time");
      return value.map((item) => { const id = cleanRef(item); if (!id) throw invalid("Unknown item"); return id; });
    };
    const add = ids(input.add);
    for (const ref of add) {
      const row = db.query(`SELECT id FROM ${ENTITY_TABLE[list.entity]} WHERE ${refColumn(ref)} = ? AND book_id = ? AND deleted_at IS NULL`).get(ref, list.bookId) as { id: string } | null;
      if (!row) throw invalid(`Add ${list.entity === "company" ? "companies" : `${list.entity}s`} of this book`);
      db.query("INSERT OR IGNORE INTO crm_list_members (list_id, item_id, added_by, added_at) VALUES (?, ?, ?, ?)").run(list.id, row.id, userId, now());
    }
    for (const id of ids(input.remove)) db.query("DELETE FROM crm_list_members WHERE list_id = ? AND item_id = ?").run(list.id, id);
    if ((db.query("SELECT COUNT(*) AS n FROM crm_list_members WHERE list_id = ?").get(list.id) as { n: number }).n > 10_000) throw new CrmError(400, "LIMIT_REACHED", "A list holds up to 10,000 items");
    audit(userId, null, "crm.list_members", { bookId: list.bookId, listId: list.id, added: add.length });
    return readList(list.id, userId);
  })();
}

// ----------------------------------------------------------------------------- saved views

type ViewRow = { id: string; book_id: string; entity: CrmEntity; name: string; kind: "table" | "board"; config_json: string; owner_id: string | null; position: number };
const toView = (row: ViewRow, userId: string): CrmView => ({ id: row.id, bookId: row.book_id, entity: row.entity, name: row.name, kind: row.kind, config: JSON.parse(row.config_json) as CrmViewConfig, shared: row.owner_id === null, mine: row.owner_id === userId, position: row.position });

function cleanConfig(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
  const config = value as CrmViewConfig;
  const out: CrmViewConfig = {};
  if (config.filters !== undefined) {
    if (!Array.isArray(config.filters) || config.filters.length > 20) throw invalid("Up to 20 filters");
    out.filters = config.filters.map((filter) => {
      if (!filter || typeof filter.field !== "string" || filter.field.length > 40 || !(FILTER_OPS as readonly string[]).includes(filter.op)) throw invalid("Invalid filter");
      return { field: filter.field, op: filter.op, ...(filter.value !== undefined ? { value: filter.value } : {}) };
    });
  }
  if (config.sort && typeof config.sort.field === "string") out.sort = { field: config.sort.field.slice(0, 40), dir: config.sort.dir === "desc" ? "desc" : "asc" };
  if (Array.isArray(config.columns)) out.columns = config.columns.filter((column): column is string => typeof column === "string").map((column) => column.slice(0, 40)).slice(0, 40);
  if (typeof config.q === "string") out.q = config.q.slice(0, 100);
  if (typeof config.listId === "string" && cleanRef(config.listId)) out.listId = config.listId;
  if (typeof config.pipelineId === "string" && cleanRef(config.pipelineId)) out.pipelineId = config.pipelineId;
  if (config.layout === "board" || config.layout === "table") out.layout = config.layout;
  const json = JSON.stringify(out);
  if (json.length > 8192) throw invalid("The view is too large");
  return json;
}

export function listViews(userId: string, options: { bookId: string; entity?: CrmEntity | null }): CrmView[] {
  const book = requireBook(options.bookId, userId);
  const rows = db.query(`SELECT * FROM crm_views WHERE book_id = ? AND (owner_id IS NULL OR owner_id = ?) ${options.entity ? "AND entity = ?" : ""} ORDER BY position, name`)
    .all(...[book.id, userId, ...(options.entity ? [options.entity] : [])]) as ViewRow[];
  return rows.map((row) => toView(row, userId));
}

function readView(id: string, userId: string) {
  const row = cleanRef(id) ? db.query("SELECT * FROM crm_views WHERE id = ?").get(id.toLowerCase()) as ViewRow | null : null;
  if (!row || (row.owner_id !== null && row.owner_id !== userId)) throw notFound("View not found");
  const book = requireBook(row.book_id, userId);
  return { row, book };
}

export function createView(userId: string, input: { bookId?: string; entity?: unknown; name?: unknown; kind?: unknown; config?: unknown; shared?: unknown }): CrmView {
  return db.transaction(() => {
    const shared = input.shared === true;
    const book = requireBook(input.bookId ?? "", userId, shared ? "edit" : "view");
    if (!isCrmEntity(input.entity)) throw invalid("A view shows contacts, companies, or deals");
    const name = cleanText(input.name, 60, "The name");
    if (!name) throw invalid("Name the view");
    if ((db.query("SELECT COUNT(*) AS n FROM crm_views WHERE book_id = ?").get(book.id) as { n: number }).n >= 300) throw new CrmError(400, "LIMIT_REACHED", "Too many views in this book");
    const id = crypto.randomUUID();
    const timestamp = now();
    const position = ((db.query("SELECT MAX(position) AS p FROM crm_views WHERE book_id = ?").get(book.id) as { p: number | null }).p ?? 0) + 1;
    db.query("INSERT INTO crm_views (id, book_id, entity, name, kind, config_json, owner_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, book.id, input.entity, name, input.kind === "board" ? "board" : "table", cleanConfig(input.config), shared ? null : userId, position, timestamp, timestamp);
    return toView(db.query("SELECT * FROM crm_views WHERE id = ?").get(id) as ViewRow, userId);
  })();
}

export function updateView(id: string, userId: string, input: { name?: unknown; config?: unknown; kind?: unknown }): CrmView {
  return db.transaction(() => {
    const { row, book } = readView(id, userId);
    if (row.owner_id === null) requireBook(book.id, userId, "edit");
    const name = input.name === undefined ? row.name : cleanText(input.name, 60, "The name");
    if (!name) throw invalid("Name the view");
    db.query("UPDATE crm_views SET name = ?, kind = ?, config_json = ?, updated_at = ? WHERE id = ?")
      .run(name, input.kind === undefined ? row.kind : input.kind === "board" ? "board" : "table", input.config === undefined ? row.config_json : cleanConfig(input.config), now(), row.id);
    return toView(db.query("SELECT * FROM crm_views WHERE id = ?").get(row.id) as ViewRow, userId);
  })();
}

export function deleteView(id: string, userId: string) {
  return db.transaction(() => {
    const { row, book } = readView(id, userId);
    if (row.owner_id === null) requireBook(book.id, userId, "edit");
    db.query("DELETE FROM crm_views WHERE id = ?").run(row.id);
    return { deleted: true };
  })();
}
