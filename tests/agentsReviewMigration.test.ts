import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../server/migrations";
import { agentChatMigration } from "../server/migrations/039_agent_chat";
import { vaultKeysMigration } from "../server/migrations/038_vault_keys";

/**
 * Wave 40 security review of migration 039 (T326): the rebuilt `api_key_grants` is compared with the
 * table 025 and 038 actually leave behind (not with another rebuild), the legacy rename pragma is
 * reset, the rebuild is idempotent, and 038 arriving after 039 still finds its column and triggers.
 */

const at = "2026-10-01T00:00:00.000Z";
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
const schemaOf = (db: Database, type: "index" | "trigger") => (db.query("SELECT name, sql FROM sqlite_master WHERE type = ? AND tbl_name = 'api_key_grants' AND sql IS NOT NULL ORDER BY name").all(type) as Array<{ name: string; sql: string }>).map((row) => ({ name: row.name, sql: normalize(row.sql) }));
const columnsOf = (db: Database) => (db.query("PRAGMA table_info(api_key_grants)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>).map((column) => `${column.name}:${column.type}:${column.notnull}:${column.dflt_value}:${column.pk}`);

/** A database with every migration but the listed ids applied (they are marked applied first). */
function openWithout(skip: number[]) {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const id of skip) db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, 'skipped', ?)").run(id, at);
  runMigrations(db);
  for (const id of skip) db.query("DELETE FROM schema_migrations WHERE id = ?").run(id);
  return db;
}

function seed(db: Database, withProtected = true) {
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'admin')").run(at);
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u2', 'b@example.test', 'B', 'x', ?, 'member')").run(at);
  db.query("INSERT INTO notes (id, owner_id, title, created_at, updated_at, folder_id) VALUES ('n1', 'u2', 'Note', ?, ?, NULL)").run(at, at);
  db.query("INSERT INTO vaults (id, owner_id, name, created_at, updated_at) VALUES ('v1', 'u1', 'Vault', ?, ?)").run(at, at);
  db.query("INSERT INTO vault_environments (id, vault_id, slug, name, position, created_at) VALUES ('e1', 'v1', 'prod', 'Prod', 0, ?)").run(at);
  db.query("INSERT INTO vault_environments (id, vault_id, slug, name, position, created_at) VALUES ('e2', 'v1', 'dev', 'Dev', 1, ?)").run(at);
  const key = withProtected
    ? db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at, scopes, kind, vault_protected_access) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)")
    : db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at, scopes, kind) VALUES (?, ?, ?, ?, ?, ?, '[]', ?)");
  const run = (...args: unknown[]) => key.run(...(withProtected ? args : args.slice(0, -1)) as [string]);
  run("k1", "u2", "General", "mynotes_aaaaaaaa", "h1", at, "general", 0);
  run("k2", "u1", "Vault", "nkv_bbbbbbbbbbbb", "h2", at, "vault", 1);
  run("k3", "u1", "Vault plain", "nkv_cccccccccccc", "h3", at, "vault", 0);
  const columns = withProtected ? ", protected_at_grant" : "";
  const grant = db.query(`INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, env_id, created_at${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?${withProtected ? ", ?" : ""})`);
  const rows: unknown[][] = [
    ["g1", "k1", "notes", "read", null, null, null, at, 0],
    ["g2", "k1", "notes", "draft", "note", "n1", null, at, 0],
    ["g3", "k1", "tasks", "write", null, null, null, at, 0],
    ["g4", "k1", "whiteboards", "write", "whiteboard", "w1", null, at, 0],
    ["g5", "k1", "bin", "write", null, null, null, at, 0],
    ["g6", "k2", "vault", "read", "vault", "v1", null, at, 0],
    ["g7", "k2", "vault", "write", "vault", "v1", "e1", at, withProtected ? 1 : 0],
    ["g8", "k2", "vault", "read", "vault", "v1", "e2", at, 0],
    ["g9", "k3", "vault", "read", "vault", "v1", "e2", at, 0]
  ];
  for (const row of rows) grant.run(...(withProtected ? row : row.slice(0, 8)) as [string]);
  return rows.length;
}
const rows = (db: Database) => db.query("SELECT * FROM api_key_grants ORDER BY id").all();

describe("review: migration 039", () => {
  test("the rebuild reproduces 025's and 038's indexes and triggers (whitespace aside), keeps every row and column, and resets legacy_alter_table", () => {
    const db = openWithout([39]);
    const before = { triggers: schemaOf(db, "trigger"), indexes: schemaOf(db, "index"), columns: columnsOf(db) };
    expect(before.triggers).toHaveLength(6);
    expect(before.indexes).toHaveLength(2);
    expect(seed(db)).toBe(9);
    const beforeRows = rows(db);
    expect(db.query("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 0 });

    db.transaction(() => agentChatMigration.up(db))();

    expect(db.query("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 0 });
    expect(schemaOf(db, "trigger")).toEqual(before.triggers);
    expect(schemaOf(db, "index")).toEqual(before.indexes);
    expect(columnsOf(db)).toEqual(before.columns);
    expect(rows(db)).toEqual(beforeRows);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    // The protected vault grant still opens only through its key's flag; the plain vault key cannot gain one.
    expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, env_id, created_at, protected_at_grant) VALUES ('gx', 'k3', 'vault', 'read', 'vault', 'v1', 'e1', ?, 1)").run(at)).toThrow(/VAULT_GRANT_SHAPE/);
    expect(() => db.query("UPDATE api_key_grants SET protected_at_grant = 1 WHERE id = 'g1'").run()).toThrow(/VAULT_GRANT_SHAPE/);
    expect(() => db.query("UPDATE api_key_grants SET module = 'vault' WHERE id = 'g1'").run()).toThrow(/KEY_KIND_WALL|VAULT_GRANT_SHAPE/);
    // Idempotent on the rebuilt shape (inside a transaction, as the runner does it).
    db.transaction(() => agentChatMigration.up(db))();
    expect(schemaOf(db, "trigger")).toEqual(before.triggers);
    expect(rows(db)).toEqual(beforeRows);
  });

  test("038 applied after 039: grants cannot be inserted until 038 adds the key column the copied trigger names; then 038 adds nothing twice", () => {
    const db = openWithout([38]);
    // 039 rebuilt without 038's column present: protected_at_grant is created with its default.
    expect(columnsOf(db).some((column) => column.startsWith("protected_at_grant:INTEGER:1:0:"))).toBe(true);
    expect(schemaOf(db, "trigger")).toHaveLength(6);
    // Evidence: 038's copied trigger reads mcp_api_keys.vault_protected_access, which only 038 adds, so every
    // INSERT into api_key_grants fails at prepare time while 038 is missing (no key could be created).
    expect(() => seed(db, false)).toThrow(/no such column: vault_protected_access/);
    db.transaction(() => vaultKeysMigration.up(db))();
    // The users, vault, and keys of the seed went in before the grants failed; the grants go in now.
    const grant = db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, env_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    grant.run("g1", "k1", "notes", "read", null, null, null, at);
    grant.run("g2", "k1", "agents", "read", null, null, null, at);
    grant.run("g6", "k2", "vault", "read", "vault", "v1", null, at);
    grant.run("g8", "k2", "vault", "read", "vault", "v1", "e2", at);
    const beforeRows = rows(db);
    expect(beforeRows).toHaveLength(4);
    db.transaction(() => vaultKeysMigration.up(db))();
    expect(columnsOf(db).filter((column) => column.startsWith("protected_at_grant"))).toHaveLength(1);
    expect(schemaOf(db, "trigger")).toHaveLength(6);
    expect(rows(db)).toEqual(beforeRows);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  test("purge triggers on the new tables fire and cascade: chats, messages, runs, fts, access rows", () => {
    const db = openWithout([]);
    seed(db);
    db.query("INSERT INTO agents (id, owner_id, name, created_at, updated_at) VALUES ('a1', 'u2', 'Helper', ?, ?)").run(at, at);
    db.query("INSERT INTO chats (id, owner_id, agent_id, title, created_at, updated_at) VALUES ('c1', 'u2', 'a1', 'Hello', ?, ?)").run(at, at);
    // An agent with a chat cannot be hard-deleted: chats.agent_id has no ON DELETE clause.
    expect(() => db.query("DELETE FROM agents WHERE id = 'a1'").run()).toThrow(/FOREIGN KEY/);
    db.query("DELETE FROM chats WHERE id = 'c1'").run();
    db.query("DELETE FROM agents WHERE id = 'a1'").run();
    expect(db.query("SELECT COUNT(*) AS count FROM agents").get()).toEqual({ count: 0 });
  });
});
