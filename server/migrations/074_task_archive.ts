import { addColumn, type Migration } from "./types";

/**
 * Collapsed columns and auto-archived cards (lane TASKS, D602–D609, T433–T434):
 *
 * - `boards.auto_archive_days`: a card that has sat in a done column (`board_columns.state = 'done'`,
 *   migration 020) this many days is archived by the hourly sweep; NULL turns it off. Every board,
 *   new or existing, starts at 30 (D604).
 * - `cards.done_at`: when the card last came into a done column (NULL outside one). Moving between
 *   two done columns keeps it; leaving and coming back starts it again (D603). Backfilled from
 *   `updated_at` for live cards already in a done column: every move writes `updated_at`, so it is
 *   never earlier than the card's arrival there.
 * - `cards.archived_at`: when the sweep archived the card. An archived card is still a live card
 *   (not the Bin): hidden from the board unless the viewer shows archived cards, and restored with
 *   one click or by moving it to another column (D605).
 * - `board_view_prefs`: one person's view of one board (D602, D606): the columns they collapsed and
 *   whether they show archived cards. Any reader keeps their own; it goes with the board or the user.
 *
 * Needs 009, 011, and 020. Transactional and filesystem-free; re-running changes nothing.
 */
export const taskArchiveMigration: Migration = {
  id: 74,
  name: "task_archive",
  up(db) {
    addColumn(db, "boards", "auto_archive_days", "INTEGER DEFAULT 30 CHECK (auto_archive_days IS NULL OR auto_archive_days BETWEEN 1 AND 365)");
    addColumn(db, "cards", "done_at", "TEXT");
    addColumn(db, "cards", "archived_at", "TEXT");
    db.exec(`
      UPDATE cards SET done_at = updated_at
        WHERE done_at IS NULL AND deleted_at IS NULL
          AND column_id IN (SELECT id FROM board_columns WHERE state = 'done');
      CREATE INDEX IF NOT EXISTS idx_cards_done_at ON cards(done_at)
        WHERE deleted_at IS NULL AND archived_at IS NULL AND done_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS board_view_prefs (
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        collapsed_columns TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(collapsed_columns) AND json_type(collapsed_columns) = 'array' AND length(collapsed_columns) <= 1024),
        show_archived INTEGER NOT NULL DEFAULT 0 CHECK (show_archived IN (0,1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (board_id, user_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_board_view_prefs_user ON board_view_prefs(user_id);
    `);
  }
};
