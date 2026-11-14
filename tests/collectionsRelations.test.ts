import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { addRow, call, fieldByName, newCollection, shareCollection, type Collection } from "./support/collections";

const { createMcpApiKey } = await import("../server/mcp");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetImportRateLimit } = await import("../server/collections/importExport");
type McpScope = import("../server/mcpScopes").McpScope;

/**
 * Person and contact fields in Collections (D1200–D1205, T640–T642): created in the field editor,
 * set and cleared on rows, resolved per viewer (a contact whose book the viewer can't read is hidden),
 * filtered and sorted, imported and exported, and read and written over MCP.
 */

type Json = Record<string, any>;
const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = JSON.parse(text) as Json; } catch { json = { text }; }
  return { status: response.status, body: json };
};

let owner: Session;
let teammate: Session;
let reader: Session;
let collection: Collection;
let who: string;
let client: string;
let title: string;
let ana: string;
let ben: string;
let secret: string;

beforeAll(async () => {
  owner = await createUser("Rel owner");
  teammate = await createUser("Rel teammate");
  reader = await createUser("Rel reader");
  const book = await api(owner, "POST", "/crm/books", { name: "Rel clients" });
  expect(book.status).toBe(201);
  const bookId = book.body.book.id as string;
  ana = (await api(owner, "POST", "/crm/contacts", { bookId, name: "Ana Relation", email: "ana@rel.example" })).body.contact.id;
  ben = (await api(owner, "POST", "/crm/contacts", { bookId, name: "Ben Relation", email: "ben@rel.example" })).body.contact.id;
  const otherBook = await api(teammate, "POST", "/crm/books", { name: "Teammate private" });
  secret = (await api(teammate, "POST", "/crm/contacts", { bookId: otherBook.body.book.id, name: "Secret Person", email: "secret@rel.example" })).body.contact.id;
  collection = await newCollection(owner, { name: "Accounts", fields: [{ name: "Name", type: "text" }, { name: "Who", type: "person" }, { name: "Client", type: "contact" }] });
  title = fieldByName(collection, "Name").id;
  who = fieldByName(collection, "Who").id;
  client = fieldByName(collection, "Client").id;
  await shareCollection(owner, collection.id, "selected", [reader.userId, teammate.userId], "editor");
});

beforeEach(() => { resetMcpLimits(); resetImportRateLimit(); });

describe("person and contact fields", () => {
  test("Collections creates them and keeps their type (D1200)", async () => {
    expect(collection.fields.map((field) => field.type)).toEqual(["text", "person", "contact"]);
    const renamed = await call(owner, "PUT", `/${collection.id}/schema`, { fields: collection.fields.map((field) => ({ id: field.id, name: field.name === "Who" ? "Owner" : field.name, type: field.type })), schemaVersion: collection.schema_version });
    expect(renamed.status).toBe(200);
    const back = await call(owner, "PUT", `/${collection.id}/schema`, { fields: collection.fields.map((field) => ({ id: field.id, name: field.name, type: field.type })), schemaVersion: renamed.body.collection.schema_version });
    collection = back.body.collection;
    expect((await call(owner, "PUT", `/${collection.id}/schema`, { fields: collection.fields.map((field) => ({ id: field.id, name: field.name, type: field.id === who ? "text" : field.type })), schemaVersion: collection.schema_version })).body.code).toBe("INCOMPATIBLE_TYPE_CHANGE");
  });

  test("rows set, resolve, and clear values; writers may only name members and readable contacts (T641)", async () => {
    const row = await addRow(owner, collection.id, { [title]: "Acme", [who]: teammate.userId, [client]: ana });
    expect(row.values).toMatchObject({ [who]: teammate.userId, [client]: ana });
    expect((row as Json).people[who]).toMatchObject({ kind: "user", id: teammate.userId, name: "Rel teammate" });
    expect((row as Json).people[client]).toMatchObject({ kind: "contact", id: ana, name: "Ana Relation" });

    const stranger = await call(owner, "POST", `/${collection.id}/rows`, { values: { [title]: "X", [client]: secret } });
    expect(stranger.status).toBe(400);
    expect(stranger.body.fieldErrors[client]).toBe("You can't link this contact");
    expect((await call(owner, "POST", `/${collection.id}/rows`, { values: { [title]: "X", [client]: crypto.randomUUID() } })).body.fieldErrors[client]).toBe("You can't link this contact");
    expect((await call(owner, "POST", `/${collection.id}/rows`, { values: { [title]: "X", [who]: crypto.randomUUID() } })).body.fieldErrors[who]).toBe("Choose a team member");

    const cleared = await call(owner, "PATCH", `/rows/${row.id}`, { values: { [who]: null, [client]: "" }, revision: row.revision });
    expect(cleared.status).toBe(200);
    expect(cleared.body.row.values[who]).toBeUndefined();
    expect(cleared.body.row.people).toEqual({});
  });

  test("a reader who can't read the contact's book sees a hidden contact, never its name (T640)", async () => {
    // The teammate links their private contact; the owner and the reader can't read that book.
    const row = await addRow(teammate, collection.id, { [title]: "Secretive", [client]: secret });
    expect((row as Json).people[client]).toMatchObject({ name: "Secret Person" });
    const seen = await call(reader, "GET", `/rows/${row.id}`);
    expect(seen.body.row.people[client]).toEqual({ kind: "contact", id: secret, hidden: true });
    expect(JSON.stringify(seen.body)).not.toContain("Secret Person");
    const query = await call(owner, "POST", `/${collection.id}/query`, {});
    expect(JSON.stringify(query.body)).not.toContain("Secret Person");
    // Search never indexes contact names.
    expect((await call(teammate, "POST", `/${collection.id}/query`, { q: "Person" })).body.rows).toHaveLength(0);
    // The owner can't put it back by undo after clearing it either.
    const cleared = await call(teammate, "PATCH", `/rows/${row.id}`, { values: { [client]: null }, revision: row.revision });
    db.query("UPDATE collection_rows SET updated_by = ? WHERE id = ?").run(owner.userId, row.id);
    const undone = await call(owner, "POST", `/rows/${row.id}/undo`, { revision: cleared.body.row.revision });
    expect(undone.status).toBe(400);
    const csv = await request(`/collections/${collection.id}/export.csv`, {}, reader);
    expect(await csv.text()).not.toContain("Secret Person");
  });

  test("filters by one member or contact and sorts by member name; contact sort is refused (D1202)", async () => {
    const c = await newCollection(owner, { name: "Sorted", fields: [{ name: "Name", type: "text" }, { name: "Who", type: "person" }, { name: "Client", type: "contact" }] });
    const [t, w, k] = c.fields.map((field) => field.id) as [string, string, string];
    await addRow(owner, c.id, { [t]: "one", [w]: teammate.userId, [k]: ana });
    await addRow(owner, c.id, { [t]: "two", [w]: owner.userId, [k]: ben });
    await addRow(owner, c.id, { [t]: "three" });
    const titles = async (body: unknown) => ((await call(owner, "POST", `/${c.id}/query`, body)).body.rows as Json[]).map((row) => row.title);
    expect(await titles({ filters: [{ fieldId: k, op: "is", value: ana }] })).toEqual(["one"]);
    expect(await titles({ filters: [{ fieldId: k, op: "is_not", value: ana }] })).toEqual(["two", "three"]);
    expect(await titles({ filters: [{ fieldId: w, op: "empty" }] })).toEqual(["three"]);
    expect(await titles({ filters: [{ fieldId: w, op: "is", value: owner.userId.toUpperCase() }] })).toEqual(["two"]);
    expect(await titles({ sort: [{ fieldId: w, direction: "asc" }] })).toEqual(["two", "one", "three"]);
    expect((await call(owner, "POST", `/${c.id}/query`, { sort: [{ fieldId: k, direction: "asc" }] })).status).toBe(400);
    expect((await call(owner, "POST", `/${c.id}/query`, { filters: [{ fieldId: k, op: "is", value: "Ana" }] })).status).toBe(400);
  });

  test("CSV import takes ids, emails, or names; export writes names (D1203)", async () => {
    const c = await newCollection(owner, { name: "Imported", fields: [{ name: "Name", type: "text" }, { name: "Who", type: "person" }, { name: "Client", type: "contact" }] });
    const csv = `Name,Who,Client\nA,Rel teammate,ana@rel.example\nB,${owner.userId},Ben Relation\n`;
    const result = await call(owner, "POST", `/${c.id}/import`, { csv, dryRun: false });
    expect(result.body).toEqual({ inserted: 2 });
    const bad = await call(owner, "POST", `/${c.id}/import`, { csv: "Name,Client\nC,secret@rel.example\n", dryRun: true });
    expect(bad.body.errors[0].message).toContain("No contact");
    const exported = await (await request(`/collections/${c.id}/export.csv`, {}, owner)).text();
    expect(exported).toContain("Rel teammate,Ana Relation");
    expect(exported).toContain("Rel owner,Ben Relation");
  });

  test("the people resolver names members and hides unreadable contacts (D1206)", async () => {
    const result = await api(owner, "GET", `/people/resolve?users=${teammate.userId}&contacts=${ana},${secret}`);
    expect(result.status).toBe(200);
    expect(result.body.people).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "user", id: teammate.userId, name: "Rel teammate" }),
      expect.objectContaining({ kind: "contact", id: ana, name: "Ana Relation" }),
      { kind: "contact", id: secret, hidden: true }
    ]));
  });
});

describe("MCP (D1204, T642)", () => {
  const direct = async (scopes: McpScope[], name: string, args: Record<string, unknown>) => {
    const key = createMcpApiKey(owner.userId, `Rel ${scopes.join(" ")}`, scopes);
    const result = await invokeMcpToolForTests(name, args, key.id);
    return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Json };
  };

  test("writes accept emails and names; rows return names; contacts need crm:read", async () => {
    const created = await direct(["collections:write", "crm:read"], "create_row", { collectionId: collection.id, values: { Name: "Via agent", Who: "Rel teammate", Client: "ben@rel.example" } });
    expect(created.isError).toBe(false);
    const read = await direct(["collections:read", "crm:read"], "get_row", { rowId: created.value.rowId });
    expect(read.value.row.values.Who).toEqual({ userId: teammate.userId, name: "Rel teammate" });
    expect(read.value.row.values.Client).toEqual({ contactId: ben, name: "Ben Relation" });

    const blind = await direct(["collections:write"], "get_row", { rowId: created.value.rowId });
    expect(blind.value.row.values.Client).toEqual({ restricted: true });
    expect(JSON.stringify(blind.value)).not.toContain("Ben Relation");
    const refused = await direct(["collections:write"], "create_row", { collectionId: collection.id, values: { Name: "No", Client: ana } });
    expect(refused.value.code).toBe("NOT_FOUND");

    const filtered = await direct(["collections:read", "crm:read"], "query_rows", { collectionId: collection.id, filters: [{ field: "Client", op: "is", value: "Ben Relation" }] });
    expect(filtered.value.rows.map((row: Json) => row.title)).toEqual(["Via agent"]);
    expect((await direct(["collections:read"], "query_rows", { collectionId: collection.id, filters: [{ field: "Client", op: "is", value: ben }] })).value.code).toBe("NOT_FOUND");
  });
});

describe("client helpers", () => {
  test("cells and cards show names, and “A contact” for a hidden one", async () => {
    const { displayValue, OPERATORS, SORTABLE_TYPES } = await import("../src/collections/values");
    const field = (type: "person" | "contact") => ({ id: "f_aaaaaaaa", name: "X", type });
    const id = crypto.randomUUID();
    expect(displayValue(field("person"), { values: { f_aaaaaaaa: id }, links: {}, people: { f_aaaaaaaa: { kind: "user", id, name: "Kim" } } })).toBe("Kim");
    expect(displayValue(field("contact"), { values: { f_aaaaaaaa: id }, links: {}, people: { f_aaaaaaaa: { kind: "contact", id, hidden: true } } })).toBe("A contact");
    expect(displayValue(field("contact"), { values: {}, links: {} })).toBe("");
    expect(OPERATORS.contact).toEqual(["is", "is_not", "empty", "not_empty"]);
    expect(SORTABLE_TYPES).toContain("person");
    expect(SORTABLE_TYPES).not.toContain("contact");
  });
});
