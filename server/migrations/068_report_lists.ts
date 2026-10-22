import type { Migration } from "./types";

/**
 * Report lists (report organization phase 3, docs/plan/REPORTS_ORG.md; lane LISTS, D550–D559).
 *
 * - `report_lists`: a person's named, ordered list of reports ("Lists": Nook already has Collections).
 *   One owner (`owner_id`), who renames, shares, and deletes it (to the Bin: `deleted_at`, `purge_after`,
 *   D553). `visibility` is the reports' own audience (D551): `private`, `selected` (the people and groups
 *   below), or `all_users` (every person, never guests; view only).
 * - `report_list_items`: the reports in a list, in order (`position`, 0, 1, 2…). A report sits in many
 *   lists. A list never grants access (D487, D550): every read of its items goes through
 *   `readableReportSql`. Purging the report or the list removes its rows (cascade).
 * - `report_list_members` / `report_list_group_shares`: who else sees the list (`view`) or curates it
 *   (`edit`: add, remove, reorder). The report tables' shape (052), not `group_grants` (D551: its
 *   resource_kind CHECK would need the never-rebuilt 025 table rebuilt). Removing the person or the group
 *   removes the row (cascade).
 *
 * Needs 050. Transactional and filesystem-free; re-running changes nothing.
 */
export const reportListsMigration: Migration = {
  id: 68,
  name: "report_lists",
  up(db) {
    // A database without 050 yet (tests that apply every migration but one) has no reports to list (053's rule).
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get()) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_lists (
        id TEXT PRIMARY KEY CHECK (length(id) <= 64),
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','selected','all_users')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        purge_after TEXT,
        purge_started_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_lists_owner ON report_lists(owner_id, name) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS report_lists_audience ON report_lists(visibility) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS report_lists_binned ON report_lists(purge_after) WHERE deleted_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS report_list_items (
        list_id TEXT NOT NULL REFERENCES report_lists(id) ON DELETE CASCADE,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (list_id, report_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_list_items_order ON report_list_items(list_id, position, report_id);
      CREATE INDEX IF NOT EXISTS report_list_items_report ON report_list_items(report_id);

      CREATE TABLE IF NOT EXISTS report_list_members (
        list_id TEXT NOT NULL REFERENCES report_lists(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        level TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','edit')),
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (list_id, user_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_list_members_user ON report_list_members(user_id, list_id);

      CREATE TABLE IF NOT EXISTS report_list_group_shares (
        list_id TEXT NOT NULL REFERENCES report_lists(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
        level TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','edit')),
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (list_id, group_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_list_group_shares_group ON report_list_group_shares(group_id, list_id);
    `);
  }
};
