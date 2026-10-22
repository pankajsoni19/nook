import type { Migration } from "./types";

/**
 * Report filters, later slices (lane FILT2, docs/plan/REPORT_FILTERS.md "Later"; D560, D565):
 *
 * - `report_param_linked_options`: a linked filter's choices (D560: a select whose options query
 *   reads parameters declared before it), one list per report, parameter, and `parents_hash` (the
 *   sha256 of the options query and the bound values of the parents it reads). At most 50 lists a
 *   report are kept, the most recently used (`last_used_at`); they go with the report.
 * - `report_param_views`: a reader's saved views (D565): named sets of parameter values, personal to
 *   the person who saved them (anyone who can read the report), at most one of them "my default view"
 *   per person and report. Names are unique per person and report regardless of case. They go with
 *   the report or the person.
 *
 * Needs 050 and 063. Transactional and filesystem-free; re-running changes nothing.
 */
export const reportFilterViewsMigration: Migration = {
  id: 69,
  name: "report_filter_views",
  up(db) {
    // A database without the reports tables yet (tests that apply every migration but one) gets nothing.
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get()) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_param_linked_options (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        param_id TEXT NOT NULL CHECK (length(param_id) BETWEEN 1 AND 30),
        parents_hash TEXT NOT NULL CHECK (length(parents_hash) = 64),
        sql TEXT NOT NULL,
        values_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(values_json) AND length(values_json) <= 65536),
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
        error TEXT CHECK (error IS NULL OR length(error) <= 1000),
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (report_id, param_id, parents_hash)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_param_linked_options_used ON report_param_linked_options(report_id, last_used_at DESC);
      CREATE TABLE IF NOT EXISTS report_param_views (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        values_json TEXT NOT NULL CHECK (json_valid(values_json) AND length(values_json) <= 16384),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS report_param_views_name ON report_param_views(report_id, user_id, name COLLATE NOCASE);
      CREATE UNIQUE INDEX IF NOT EXISTS report_param_views_default ON report_param_views(report_id, user_id) WHERE is_default = 1;
      CREATE INDEX IF NOT EXISTS report_param_views_user ON report_param_views(user_id);
    `);
  }
};
