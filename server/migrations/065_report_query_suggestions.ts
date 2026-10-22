import type { Migration } from "./types";

/**
 * Suggested query edits (lane EDIT, D527): a person at the comment level writes a saved query's new
 * SQL, previews it, and sends it to the owner, who applies or rejects it like an edit agent's
 * proposal. A suggestion is a `report_instructions` row whose proposal a person wrote, not an agent:
 * `suggested_query` names the query it changes (NULL for every instruction to the edit agent). It
 * waits in the queue with its proposal already made; at the head it becomes `proposed` with no agent run.
 *
 * Needs 052. Transactional and filesystem-free; re-running changes nothing.
 */
export const reportQuerySuggestionsMigration: Migration = {
  id: 65,
  name: "report_query_suggestions",
  up(db) {
    // A database without 052 yet (tests that apply every migration but one) has no instructions.
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'report_instructions'").get()) return;
    const columns = db.query("PRAGMA table_info(report_instructions)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "suggested_query")) {
      db.exec("ALTER TABLE report_instructions ADD COLUMN suggested_query TEXT CHECK (suggested_query IS NULL OR length(suggested_query) BETWEEN 1 AND 40)");
    }
  }
};
