import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrations } from "../server/migrations";
import { vaultKeyFlagConfirmMigration } from "../server/migrations/076_vault_key_flag_confirm";

/**
 * Migration 076 (lane VAULTKEY, D625, T441): a vault key's settings may be raised on an existing key
 * only while the server holds a confirmation row for it (the re-authenticated Edit path); any other
 * raise is still refused by the database, as migration 038 did for every raise.
 */
describe("migration 076 vault_key_flag_confirm", () => {
  const at = "2026-10-22T00:00:00.000Z";
  test("before: every raise refused; after: only a confirmed one; lowering always works; re-running changes nothing", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const migration of registeredMigrations.filter((item) => item.id < 76)) sqlite.transaction(() => migration.up(sqlite))();
    sqlite.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    sqlite.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, scopes, created_at, kind, expires_at) VALUES ('k1', 'u1', 'Deploy', 'nkv_abcdefghijkl', 'h1', '[]', ?, 'vault', ?)").run(at, "2027-01-01T00:00:00.000Z");
    const raise = () => sqlite.query("UPDATE mcp_api_keys SET allow_mcp_value_reads = 1 WHERE id = 'k1'").run();
    expect(raise).toThrow(/WIDENING_NOT_ALLOWED/);

    sqlite.transaction(() => vaultKeyFlagConfirmMigration.up(sqlite))();
    sqlite.transaction(() => vaultKeyFlagConfirmMigration.up(sqlite))();
    // Unconfirmed: still refused, both flags.
    expect(raise).toThrow(/WIDENING_NOT_ALLOWED/);
    expect(() => sqlite.query("UPDATE mcp_api_keys SET vault_protected_access = 1 WHERE id = 'k1'").run()).toThrow(/WIDENING_NOT_ALLOWED/);
    // A confirmation for another key does not count.
    sqlite.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, scopes, created_at, kind, expires_at) VALUES ('k2', 'u1', 'Other', 'nkv_bcdefghijklm', 'h2', '[]', ?, 'vault', ?)").run(at, "2027-01-01T00:00:00.000Z");
    sqlite.query("INSERT INTO vault_key_flag_confirmations (key_id, created_at) VALUES ('k2', ?)").run(at);
    expect(raise).toThrow(/WIDENING_NOT_ALLOWED/);
    // Confirmed for this key, inside one transaction, as the server does it.
    sqlite.transaction(() => {
      sqlite.query("INSERT INTO vault_key_flag_confirmations (key_id, created_at) VALUES ('k1', ?)").run(at);
      raise();
      sqlite.query("DELETE FROM vault_key_flag_confirmations WHERE key_id = 'k1'").run();
    })();
    expect(sqlite.query("SELECT allow_mcp_value_reads FROM mcp_api_keys WHERE id = 'k1'").get()).toEqual({ allow_mcp_value_reads: 1 });
    // Lowering never needs one; a confirmation goes with its key.
    sqlite.query("UPDATE mcp_api_keys SET allow_mcp_value_reads = 0 WHERE id = 'k1'").run();
    sqlite.query("DELETE FROM mcp_api_keys WHERE id = 'k2'").run();
    expect(sqlite.query("SELECT COUNT(*) AS n FROM vault_key_flag_confirmations").get()).toEqual({ n: 0 });
    // General keys never hold the flags, even with a confirmation row.
    sqlite.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, scopes, created_at) VALUES ('g1', 'u1', 'G', 'mynotes_abcdefgh', 'h3', '[]', ?)").run(at);
    sqlite.query("INSERT INTO vault_key_flag_confirmations (key_id, created_at) VALUES ('g1', ?)").run(at);
    expect(() => sqlite.query("UPDATE mcp_api_keys SET allow_mcp_value_reads = 1 WHERE id = 'g1'").run()).toThrow(/VAULT_FLAGS_ON_GENERAL_KEY/);
  });
});
