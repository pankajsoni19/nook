import type { Migration } from "./types";

/**
 * One person's collapsed lanes in a Tasks view (lane VIEWS, D639, T443):
 *
 * - `task_view_prefs` keeps, per person and view, the lanes of the board layout they collapsed.
 *   `view_key` is a saved view's id (task_views, migration 020) or `my` for My work, so it has no
 *   foreign key: the service deletes a view's rows with the view, and the person's go with them.
 * - `collapsed_lanes` is a JSON array of lane keys (`s:<state>` or `c:<state>:<folded name>`), at
 *   most 1 KiB by CHECK. It changes only what that person sees.
 *
 * Needs 020. Transactional and filesystem-free; re-running changes nothing.
 */
export const taskViewPrefsMigration: Migration = {
  id: 77,
  name: "task_view_prefs",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_view_prefs (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        view_key TEXT NOT NULL CHECK (view_key = 'my' OR length(view_key) = 36),
        collapsed_lanes TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(collapsed_lanes) AND json_type(collapsed_lanes) = 'array' AND length(collapsed_lanes) <= 1024),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, view_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_task_view_prefs_view ON task_view_prefs(view_key);
    `);
  }
};
