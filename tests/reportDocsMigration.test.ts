import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrations, runMigrations } from "../server/migrations";
import { reportDocsMigration } from "../server/migrations/064_report_docs";

/** Migration 064 (lane DOCS, D515–D517): report_docs backfilled from the one-doc columns, snapshot and run doc ids, instruction kinds and docs. */
const at = "2026-10-20T00:00:00.000Z";
const hash = (char: string) => char.repeat(64);

function openDb(upTo: number) {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of registeredMigrations.filter((item) => item.id <= upTo)) {
    db.transaction(() => {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
    })();
  }
  return db;
}

describe("migration 064 report_docs", () => {
  test("backfills each report's one doc as its first doc; snapshots point at it; old columns, specs, and runs are unchanged; re-running changes nothing", () => {
    const db = openDb(63);
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    db.query("INSERT INTO agent_tool_servers (id, slug, name, transport, url, created_at, updated_at) VALUES ('s1', 'outline', 'Outline', 'http', 'https://docs.example.test/mcp', ?, ?)").run(at, at);
    db.query(`INSERT INTO reports (id, owner_id, title, doc_source, doc_server_id, doc_tool, doc_arg, doc_ref, doc_hash, spec_json, created_at, updated_at)
      VALUES ('r1', 'u1', 'From Outline', 'server', 's1', 'fetch', 'id', 'https://docs.example.test/doc/a', ?, '{"version":1,"blocks":[],"queries":[]}', ?, ?)`).run(hash("a"), at, at);
    db.query("INSERT INTO reports (id, owner_id, title, doc_source, doc_tool, doc_ref, doc_hash, created_at, updated_at) VALUES ('r2', 'u1', 'From a note', 'nook', 'read_note', 'https://nook.example.test/notes/n1', NULL, ?, ?)").run(at, at);
    db.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES ('r3', 'u1', 'Blank', ?, ?)").run(at, at);
    db.query("INSERT INTO report_doc_snapshots (id, report_id, sha256, title, markdown, fetched_at) VALUES ('s-old', 'r1', ?, 'Old title', '# old', '2026-10-01T00:00:00.000Z')").run(hash("b"));
    db.query("INSERT INTO report_doc_snapshots (id, report_id, sha256, title, markdown, fetched_at) VALUES ('s-new', 'r1', ?, 'Revenue metrics', '# new', '2026-10-02T00:00:00.000Z')").run(hash("a"));
    db.query("INSERT INTO report_runs (id, report_id, kind, trigger, status, doc_snapshot_id, started_at) VALUES ('run1', 'r1', 'generate', 'user', 'succeeded', 's-new', ?)").run(at);
    const before = db.query("SELECT * FROM reports ORDER BY id").all();

    runMigrations(db);
    const docs = db.query("SELECT report_id, position, source, server_id, tool, arg, ref, title, hash, added_by, added_via, created_at FROM report_docs ORDER BY report_id").all();
    expect(docs).toEqual([
      { report_id: "r1", position: 0, source: "server", server_id: "s1", tool: "fetch", arg: "id", ref: "https://docs.example.test/doc/a", title: "Revenue metrics", hash: hash("a"), added_by: "u1", added_via: "create", created_at: at },
      { report_id: "r2", position: 0, source: "nook", server_id: null, tool: "read_note", arg: null, ref: "https://nook.example.test/notes/n1", title: null, hash: null, added_by: "u1", added_via: "create", created_at: at }
    ]);
    const r1Doc = (db.query("SELECT id FROM report_docs WHERE report_id = 'r1'").get() as { id: string }).id;
    expect(db.query("SELECT id, doc_id FROM report_doc_snapshots ORDER BY id").all()).toEqual([{ id: "s-new", doc_id: r1Doc }, { id: "s-old", doc_id: r1Doc }]);
    // Old reports keep every column as it was (the one-doc columns mirror the first doc).
    expect(db.query("SELECT * FROM reports ORDER BY id").all()).toEqual(before);
    expect(db.query("SELECT doc_snapshot_id, docs_json FROM report_runs WHERE id = 'run1'").get()).toEqual({ doc_snapshot_id: "s-new", docs_json: null });

    // The new columns' rules.
    expect(() => db.query("INSERT INTO report_docs (id, report_id, position, source, server_id, ref, created_at) VALUES ('x', 'r3', 0, 'nook', 's1', 'n', ?)").run(at)).toThrow();
    expect(() => db.query("INSERT INTO report_docs (id, report_id, position, source, ref, added_via, created_at) VALUES ('x', 'r3', 0, 'nook', 'n', 'mcp', ?)").run(at)).toThrow();
    expect(() => db.query("UPDATE report_runs SET docs_json = 'nope' WHERE id = 'run1'").run()).toThrow();
    db.query("INSERT INTO report_instructions (id, report_id, text, status, position, created_at, updated_at) VALUES ('i1', 'r1', 'Add refunds', 'queued', 1, ?, ?)").run(at, at);
    expect(db.query("SELECT kind, after_block_id FROM report_instructions WHERE id = 'i1'").get()).toEqual({ kind: "change", after_block_id: null });
    expect(() => db.query("UPDATE report_instructions SET kind = 'remove' WHERE id = 'i1'").run()).toThrow();

    // An instruction's docs: one row per position, the text at most 512 KiB; no trigger touches the
    // status updates (their changed-row counts stay 1).
    db.query(`INSERT INTO report_instruction_docs (id, instruction_id, position, source, ref, title, sha256, bytes, markdown, created_at)
      VALUES ('d1', 'i1', 0, 'nook', 'n2', 'Refund rules', ?, 7, '# rules', ?)`).run(hash("c"), at);
    expect(() => db.query(`INSERT INTO report_instruction_docs (id, instruction_id, position, source, ref, sha256, bytes, markdown, created_at)
      VALUES ('d2', 'i1', 0, 'nook', 'n3', ?, 7, 'x', ?)`).run(hash("c"), at)).toThrow();
    expect(db.query("UPDATE report_instructions SET status = 'rejected' WHERE id = 'i1'").run().changes).toBe(1);
    expect(db.query("SELECT markdown FROM report_instruction_docs WHERE id = 'd1'").get()).toEqual({ markdown: "# rules" });
    // The docs go with their report and instruction.
    db.query("DELETE FROM reports WHERE id = 'r1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM report_docs WHERE report_id = 'r1'").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM report_instruction_docs").get()).toEqual({ count: 0 });

    reportDocsMigration.up(db);
    expect(db.query("SELECT COUNT(*) AS count FROM report_docs").get()).toEqual({ count: 1 });
    expect((db.query("SELECT id FROM schema_migrations WHERE id >= 63 ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id)).toEqual([63, 64, 65, 66, 68, 69, 73, 74]);
  });
});
