import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { compileQuery, decodeCursor, encodeCursor, OPERATORS, QueryError, specKey, type QuerySpec } from "../server/collections/query";
import { buildSchema, type FieldDefinition } from "../server/collections/schema";

const schema = buildSchema([
  { name: "Name", type: "text" },
  { name: "Price", type: "number" },
  { name: "When", type: "date" },
  { name: "Done", type: "checkbox" },
  { name: "Kind", type: "select", options: [{ label: "b-second" }, { label: "a-first" }] },
  { name: "Tags", type: "multi_select", options: [{ label: "x" }, { label: "y" }, { label: "z" }] },
  { name: "Link", type: "url" },
  { name: "Note", type: "note" },
  { name: "Files", type: "file" }
]);
const [name, price, when, done, kind, tags, link, note, files] = schema.fields as FieldDefinition[];
const [kindB, kindA] = kind!.options!;
const [tagX, tagY, tagZ] = tags!.options!;

const db = new Database(":memory:");
db.exec(`CREATE TABLE collection_rows (id TEXT PRIMARY KEY, position REAL, values_json TEXT);
  CREATE TABLE collection_row_attachments (row_id TEXT, document_id TEXT, field_id TEXT);
  CREATE TABLE documents (id TEXT PRIMARY KEY, deleted_at TEXT);`);
const rows: Array<[string, Record<string, unknown>]> = [
  ["r1", { [name!.id]: "Apple pie", [price!.id]: 3.5, [when!.id]: "2024-01-05", [done!.id]: true, [kind!.id]: kindA!.id, [tags!.id]: [tagX!.id, tagY!.id], [link!.id]: "https://a.test" }],
  ["r2", { [name!.id]: "banana", [price!.id]: 10, [when!.id]: "2024-03-01", [kind!.id]: kindB!.id, [tags!.id]: [tagY!.id], [note!.id]: "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e" }],
  ["r3", { [name!.id]: "Cherry", [price!.id]: -2, [tags!.id]: tagZ!.id }],
  ["r4", { [price!.id]: "12" }]
];
rows.forEach(([id, values], index) => db.query("INSERT INTO collection_rows VALUES (?, ?, ?)").run(id, (index + 1) * 1024, JSON.stringify(values)));
db.query("INSERT INTO documents VALUES ('d1', NULL), ('d2', '2024-01-01')").run();
db.query(`INSERT INTO collection_row_attachments VALUES ('r2', 'd1', '${files!.id}'), ('r3', 'd2', '${files!.id}')`).run();

function run(spec: QuerySpec, mode: "strict" | "lenient" = "strict") {
  const compiled = compileQuery(schema, spec, mode);
  return (db.query(`SELECT id FROM collection_rows r WHERE ${compiled.where} ORDER BY ${compiled.orderBy}`).all(...compiled.whereParams, ...compiled.orderParams) as Array<{ id: string }>).map((row) => row.id);
}

describe("collection query builder", () => {
  test("filters by every operator family", () => {
    expect(run({ filters: [{ fieldId: name!.id, op: "contains", value: "AN" }] })).toEqual(["r2"]);
    expect(run({ filters: [{ fieldId: name!.id, op: "equals", value: "apple PIE" }] })).toEqual(["r1"]);
    expect(run({ filters: [{ fieldId: name!.id, op: "empty" }] })).toEqual(["r4"]);
    expect(run({ filters: [{ fieldId: name!.id, op: "not_empty" }] })).toEqual(["r1", "r2", "r3"]);
    // A number stored as a string (a lenient read) never matches a numeric comparison.
    expect(run({ filters: [{ fieldId: price!.id, op: "gt", value: 3 }] })).toEqual(["r1", "r2"]);
    expect(run({ filters: [{ fieldId: price!.id, op: "lte", value: -2 }] })).toEqual(["r3"]);
    expect(run({ filters: [{ fieldId: price!.id, op: "eq", value: 10 }] })).toEqual(["r2"]);
    expect(run({ filters: [{ fieldId: when!.id, op: "gte", value: "2024-02-01" }] })).toEqual(["r2"]);
    expect(run({ filters: [{ fieldId: when!.id, op: "empty" }] })).toEqual(["r3", "r4"]);
    expect(run({ filters: [{ fieldId: done!.id, op: "is", value: true }] })).toEqual(["r1"]);
    expect(run({ filters: [{ fieldId: done!.id, op: "is", value: false }] })).toEqual(["r2", "r3", "r4"]);
    expect(run({ filters: [{ fieldId: kind!.id, op: "is", value: kindB!.id }] })).toEqual(["r2"]);
    expect(run({ filters: [{ fieldId: kind!.id, op: "is_not", value: kindB!.id }] })).toEqual(["r1", "r3", "r4"]);
    expect(run({ filters: [{ fieldId: kind!.id, op: "in", value: [kindA!.id, kindB!.id] }] })).toEqual(["r1", "r2"]);
    expect(run({ filters: [{ fieldId: tags!.id, op: "has_any", value: [tagY!.id, tagZ!.id] }] })).toEqual(["r1", "r2", "r3"]);
    expect(run({ filters: [{ fieldId: tags!.id, op: "has_all", value: [tagX!.id, tagY!.id] }] })).toEqual(["r1"]);
    expect(run({ filters: [{ fieldId: link!.id, op: "not_empty" }] })).toEqual(["r1"]);
    expect(run({ filters: [{ fieldId: note!.id, op: "not_empty" }] })).toEqual(["r2"]);
    // A binned attachment does not count.
    expect(run({ filters: [{ fieldId: files!.id, op: "not_empty" }] })).toEqual(["r2"]);
    expect(run({ filters: [{ fieldId: files!.id, op: "empty" }] })).toEqual(["r1", "r3", "r4"]);
    expect(run({ filters: [{ fieldId: price!.id, op: "gt", value: 0 }, { fieldId: kind!.id, op: "is", value: kindA!.id }] })).toEqual(["r1"]);
    expect(run({ q: "ERR" })).toEqual(["r3"]);
    expect(run({ q: "a.test" })).toEqual(["r1"]);
  });

  test("sorts with empty values last and select fields by option order", () => {
    expect(run({ sort: [{ fieldId: name!.id, direction: "asc" }] })).toEqual(["r1", "r2", "r3", "r4"]);
    expect(run({ sort: [{ fieldId: name!.id, direction: "desc" }] })).toEqual(["r3", "r2", "r1", "r4"]);
    // r4's price is a string, which reads as empty and sorts last.
    expect(run({ sort: [{ fieldId: price!.id, direction: "desc" }] })).toEqual(["r2", "r1", "r3", "r4"]);
    expect(run({ sort: [{ fieldId: price!.id, direction: "asc" }] })).toEqual(["r3", "r1", "r2", "r4"]);
    expect(run({ sort: [{ fieldId: when!.id, direction: "desc" }] })).toEqual(["r2", "r1", "r3", "r4"]);
    // Option order: b-second is listed first, so it sorts first.
    expect(run({ sort: [{ fieldId: kind!.id, direction: "asc" }] })).toEqual(["r2", "r1", "r3", "r4"]);
    expect(run({ sort: [{ fieldId: done!.id, direction: "desc" }, { fieldId: name!.id, direction: "desc" }] })).toEqual(["r1", "r3", "r2", "r4"]);
  });

  test("rejects unknown fields, operators that do not fit the type, and bad values", () => {
    const rejects = (spec: QuerySpec) => expect(() => compileQuery(schema, spec)).toThrow(QueryError);
    rejects({ filters: [{ fieldId: "f_zzzzzzzz", op: "empty" }] });
    rejects({ sort: [{ fieldId: "f_zzzzzzzz", direction: "asc" }] });
    rejects({ filters: [{ fieldId: price!.id, op: "contains", value: "1" }] });
    rejects({ filters: [{ fieldId: name!.id, op: "gt", value: 1 }] });
    rejects({ filters: [{ fieldId: price!.id, op: "gt", value: "1" }] });
    rejects({ filters: [{ fieldId: when!.id, op: "lt", value: "2024-02-30" }] });
    rejects({ filters: [{ fieldId: done!.id, op: "is", value: "yes" }] });
    rejects({ filters: [{ fieldId: kind!.id, op: "is", value: "o_zzzzzz" }] });
    rejects({ filters: [{ fieldId: tags!.id, op: "has_any", value: [] }] });
    rejects({ filters: [{ fieldId: name!.id, op: "contains", value: "" }] });
    rejects({ sort: [{ fieldId: tags!.id, direction: "asc" }] });
    rejects({ sort: [{ fieldId: files!.id, direction: "asc" }] });
    rejects({ sort: [{ fieldId: name!.id, direction: "asc" }, { fieldId: name!.id, direction: "desc" }] });
    // Lenient mode (saved views) drops clauses that no longer apply.
    expect(run({ filters: [{ fieldId: "f_zzzzzzzz", op: "empty" }], sort: [{ fieldId: "f_zzzzzzzz", direction: "asc" }] }, "lenient")).toEqual(["r1", "r2", "r3", "r4"]);
    expect(Object.keys(OPERATORS).sort()).toEqual(["checkbox", "contact", "date", "file", "multi_select", "note", "number", "person", "select", "text", "url"]);
  });

  test("never interpolates values or paths into SQL", () => {
    const hostile = `x') OR 1=1 --`;
    const compiled = compileQuery(schema, { filters: [{ fieldId: name!.id, op: "contains", value: hostile }], q: hostile, sort: [{ fieldId: kind!.id, direction: "desc" }] });
    const sql = `${compiled.where} ${compiled.orderBy}`;
    expect(sql).not.toContain(hostile);
    expect(sql).not.toContain(name!.id);
    expect(sql).not.toContain(kindA!.id);
    expect(compiled.whereParams).toContain(`$.${name!.id}`);
    expect(run({ filters: [{ fieldId: name!.id, op: "contains", value: hostile }] })).toEqual([]);
  });

  test("cursors round-trip and reject tampering", () => {
    const key = specKey({ filters: [], viewId: null });
    const cursor = encodeCursor({ schemaVersion: 3, offset: 50, key });
    expect(decodeCursor(cursor)).toEqual({ schemaVersion: 3, offset: 50, key });
    expect(specKey({ q: "a" })).not.toBe(specKey({ q: "b" }));
    for (const bad of ["", "!!!", Buffer.from("[1,2]").toString("base64url"), encodeCursor({ schemaVersion: 1, offset: 20_000, key }), encodeCursor({ schemaVersion: 0, offset: 0, key }), "a".repeat(200)]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});
