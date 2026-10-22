import type { Migration } from "./types";

/**
 * Vault key settings turned on through Edit (lane VAULTKEY, D625, T441). Migration 038's trigger
 * `api_keys_vault_flags_widen` refused raising `allow_mcp_value_reads` or `vault_protected_access`
 * on an existing key outright, so only a rotation or a new key could turn either on. Edit may now
 * turn them on after the owner re-authenticates, and the database still refuses any other raise:
 *
 * - `vault_key_flag_confirmations`: one row per key while the server applies a re-authenticated
 *   edit. The server inserts it, raises the flags, and deletes it in one transaction, so a committed
 *   database never holds a row (and the table is empty after every edit).
 * - The trigger is replaced: raising either flag aborts with `WIDENING_NOT_ALLOWED` unless that key
 *   has a confirmation row. A stray `UPDATE` (a script, a bug in another code path, a hand-edit)
 *   still cannot turn a setting on; only the code path that checked the password can.
 * - `api_keys_vault_flags_general_update`: a general key never holds either flag, on update as 038
 *   already ensured on insert (the old widen trigger had covered it by refusing every raise).
 *
 * Needs 038. Transactional and filesystem-free; re-running changes nothing.
 */
export const vaultKeyFlagConfirmMigration: Migration = {
  id: 76,
  name: "vault_key_flag_confirm",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vault_key_flag_confirmations (
        key_id TEXT PRIMARY KEY REFERENCES mcp_api_keys(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      DROP TRIGGER IF EXISTS api_keys_vault_flags_widen;
      CREATE TRIGGER api_keys_vault_flags_widen BEFORE UPDATE OF allow_mcp_value_reads, vault_protected_access ON mcp_api_keys
      WHEN (NEW.allow_mcp_value_reads > OLD.allow_mcp_value_reads OR NEW.vault_protected_access > OLD.vault_protected_access)
        AND NOT EXISTS (SELECT 1 FROM vault_key_flag_confirmations WHERE key_id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'WIDENING_NOT_ALLOWED'); END;
      CREATE TRIGGER IF NOT EXISTS api_keys_vault_flags_general_update BEFORE UPDATE OF allow_mcp_value_reads, vault_protected_access, kind ON mcp_api_keys
      WHEN NEW.kind <> 'vault' AND (NEW.allow_mcp_value_reads = 1 OR NEW.vault_protected_access = 1)
      BEGIN SELECT RAISE(ABORT, 'VAULT_FLAGS_ON_GENERAL_KEY'); END;
    `);
  }
};
