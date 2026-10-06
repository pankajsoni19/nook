import type { Migration } from "./types";

/**
 * The agent Audit log's guards (Wave 42 "AC-C", docs/plan/research/2026-09-30-agentic-chat-module.md
 * §7.3, §10, D365, D366, T317). 039 created the tables (`agent_runs`, `agent_audit_entries`,
 * `agent_audit_steps`) but none of the append-only triggers §10 lists, so this migration adds them.
 * The Messages plan's migration, which the AC-A as-built note moved to 040, moves to 041.
 *
 * - `agent_rate_limits`: the per-key run windows (20 a minute, 500 a UTC day), so a restart does
 *   not reset them (server/vault/limits.ts is the pattern; its table belongs to the vault).
 * - `agent_retention_guard`: one row, held only inside the hourly sweeper's transaction, carrying
 *   the cutoff it deletes before. Without that row nothing deletes an API or MCP run.
 * - API and MCP runs (`via <> 'chat'`) always carry a key and never a chat (D365: they never create
 *   chats), checked on insert.
 * - Their `agent_runs` row changes only while the run is live (`finished_at IS NULL`) and never in
 *   its identity columns; once finished it is frozen. Chat runs keep their AC-A lifecycle.
 * - A run is deleted only by the guarded retention sweep (rows older than the guard's cutoff, and
 *   never newer than 7 days whatever the cutoff says), or by the cascade when its key row is deleted.
 * - `agent_audit_entries` (input and output): no edits except filling `output_text` once, while
 *   the run is live; `agent_audit_steps`: no edits at all. Either deletes only with its run (the
 *   cascade, when the run row is already gone).
 *
 * Also two indexes for the Audit log's readers (admins list across keys; managers count per agent).
 * Needs 005 and 039. Transactional and filesystem-free; re-running changes nothing.
 */
export const agentAuditMigration: Migration = {
  id: 40,
  name: "agent_audit",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_retention_guard (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cutoff TEXT NOT NULL CHECK (length(cutoff) BETWEEN 20 AND 32)
      ) STRICT;

      -- Per-key run limits (plan §7.2: 20 a minute, 500 a day), kept across restarts (the vault's pattern).
      CREATE TABLE IF NOT EXISTS agent_rate_limits (
        bucket TEXT PRIMARY KEY CHECK (length(bucket) <= 120),
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL CHECK (count >= 0),
        previous_count INTEGER NOT NULL DEFAULT 0 CHECK (previous_count >= 0)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS agent_runs_audit_time ON agent_runs(queued_at DESC) WHERE via <> 'chat';
      CREATE INDEX IF NOT EXISTS agent_runs_audit_agent ON agent_runs(agent_id, queued_at DESC) WHERE via <> 'chat';

      CREATE TRIGGER IF NOT EXISTS agent_runs_audit_shape BEFORE INSERT ON agent_runs
      WHEN NEW.via <> 'chat' AND (NEW.key_id IS NULL OR NEW.chat_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'AUDIT_SHAPE'); END;

      CREATE TRIGGER IF NOT EXISTS agent_runs_audit_no_update BEFORE UPDATE ON agent_runs
      WHEN OLD.via <> 'chat' AND (
        OLD.finished_at IS NOT NULL
        OR NEW.id IS NOT OLD.id OR NEW.via IS NOT OLD.via OR NEW.agent_id IS NOT OLD.agent_id OR NEW.agent_revision IS NOT OLD.agent_revision
        OR NEW.prompt_sha256 IS NOT OLD.prompt_sha256 OR NEW.preamble_version IS NOT OLD.preamble_version OR NEW.chat_id IS NOT OLD.chat_id
        OR NEW.user_id IS NOT OLD.user_id OR NEW.key_id IS NOT OLD.key_id OR NEW.client_address IS NOT OLD.client_address
        OR NEW.label IS NOT OLD.label OR NEW.queued_at IS NOT OLD.queued_at OR NEW.purge_after IS NOT OLD.purge_after
      )
      BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;

      CREATE TRIGGER IF NOT EXISTS agent_runs_audit_no_delete BEFORE DELETE ON agent_runs
      WHEN OLD.via <> 'chat'
        AND EXISTS (SELECT 1 FROM mcp_api_keys WHERE id = OLD.key_id)
        AND NOT (
          EXISTS (SELECT 1 FROM agent_retention_guard g WHERE OLD.queued_at < g.cutoff)
          AND OLD.queued_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
        )
      BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;

      CREATE TRIGGER IF NOT EXISTS agent_audit_entries_no_update BEFORE UPDATE ON agent_audit_entries
      WHEN NOT (
        OLD.output_text IS NULL AND NEW.run_id = OLD.run_id AND NEW.input_text = OLD.input_text
        AND (SELECT finished_at FROM agent_runs WHERE id = OLD.run_id) IS NULL
      )
      BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS agent_audit_entries_no_delete BEFORE DELETE ON agent_audit_entries
      WHEN EXISTS (SELECT 1 FROM agent_runs WHERE id = OLD.run_id)
      BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;

      CREATE TRIGGER IF NOT EXISTS agent_audit_steps_no_update BEFORE UPDATE ON agent_audit_steps
      BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS agent_audit_steps_no_delete BEFORE DELETE ON agent_audit_steps
      WHEN EXISTS (SELECT 1 FROM agent_runs WHERE id = OLD.run_id)
      BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
    `);
  }
};
