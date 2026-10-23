import { addColumn, type Migration } from "./types";

/**
 * Views slice 2 (lane VIEWS2, D655–D659, T448–T450):
 *
 * - `task_view_pins`: a board's owner (or a manager) pins a view they own that is on that board, and
 *   everyone who can open the board then reads the view in the board's picker, listed first (D658).
 *   Pins go with the board, the view, or nobody (`pinned_by` is kept for the audit trail only).
 * - `board_view_prefs.show_all_levels`: "Show all levels on the board" per person on the server (D659;
 *   NULL until they choose, so the app can carry an older per-device choice over once), and
 *   `collapsed_rows`: the swimlanes they collapsed (D656), lane-key strings, at most 1 KiB.
 * - `task_view_prefs.own_collapse`, `collapsed_columns`, `collapsed_rows`: "Keep this view's own
 *   collapsed columns" on a board view (D657, default off: the view shares the board's), and the
 *   view's own columns and rows while it is on.
 *
 * Needs 009, 020, 074, and 077. Transactional and filesystem-free; re-running changes nothing.
 */
const boundedArray = (column: string) => `TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(${column}) AND json_type(${column}) = 'array' AND length(${column}) <= 1024)`;

export const taskViewPinsMigration: Migration = {
  id: 78,
  name: "task_view_pins",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_view_pins (
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        view_id TEXT NOT NULL REFERENCES task_views(id) ON DELETE CASCADE,
        pinned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (board_id, view_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_task_view_pins_view ON task_view_pins(view_id);
    `);
    addColumn(db, "board_view_prefs", "show_all_levels", "INTEGER CHECK (show_all_levels IS NULL OR show_all_levels IN (0,1))");
    addColumn(db, "board_view_prefs", "collapsed_rows", boundedArray("collapsed_rows"));
    addColumn(db, "task_view_prefs", "own_collapse", "INTEGER NOT NULL DEFAULT 0 CHECK (own_collapse IN (0,1))");
    addColumn(db, "task_view_prefs", "collapsed_columns", boundedArray("collapsed_columns"));
    addColumn(db, "task_view_prefs", "collapsed_rows", boundedArray("collapsed_rows"));
  }
};
