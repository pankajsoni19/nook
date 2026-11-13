import type { Migration } from "./types";
import { shortIdSql } from "./083_short_ids";

/**
 * Goals (lane GOALS, docs/plan/WORKSPACE_MODULES.md §D.3, D900–D906):
 *
 * - `goal_periods`: workspace-wide cycles ("Q1 2027"), local dates, end after start.
 * - `goals`: objectives and KPIs; nest by `parent_id` (alignment, no access inheritance, D900); a level
 *   is an optional team (`group_id`) or a person (the owner). The sharing container of kind `goal`
 *   (owner, visibility, share_role; members and groups in `item_members` / `item_group_grants`).
 *   `progress` is owner-computed (§G.1 Q4) and stored; `final_progress` is the close snapshot (D905).
 * - `goal_contributors`: people who work on a goal besides its owner (they may check in, D907).
 * - `key_results`: metric, direction, start → target, current, weight, and the progress source
 *   (`source_kind`, `source_json`, `source_error`, D906).
 * - `kr_milestones`: a milestone KR's checklist; `kr_values`: the history chart, one point per KR and
 *   instant (`at`, D903); `goal_checkins`: health, confidence 1–10, note, and the values typed.
 *
 * Needs 001, 025, 083, 085, 086. Transactional and filesystem-free; re-running changes nothing.
 */
const SHORT_ID = `short_id TEXT NOT NULL DEFAULT (${shortIdSql}) CHECK (length(short_id) = 10 AND short_id GLOB '[0-9]*' AND short_id NOT GLOB '*[^0-9a-z]*')`;
const BIN = `deleted_at TEXT, deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL, purge_after TEXT, purge_started_at TEXT,
        CHECK ((deleted_at IS NULL) = (purge_after IS NULL))`;

export const goalsMigration: Migration = {
  id: 96,
  name: "goals",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS goal_periods (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        starts_on TEXT NOT NULL CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        ends_on TEXT NOT NULL CHECK (ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        CHECK (ends_on > starts_on)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS goal_periods_dates ON goal_periods(starts_on, ends_on);

      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        ${SHORT_ID},
        owner_id TEXT NOT NULL REFERENCES users(id),
        parent_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
        period_id TEXT REFERENCES goal_periods(id) ON DELETE SET NULL,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        description_md TEXT NOT NULL DEFAULT '' CHECK (length(CAST(description_md AS BLOB)) <= 20000),
        kind TEXT NOT NULL DEFAULT 'objective' CHECK (kind IN ('objective','kpi')),
        group_id TEXT REFERENCES user_groups(id) ON DELETE SET NULL,
        start_on TEXT CHECK (start_on IS NULL OR start_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        due_on TEXT CHECK (due_on IS NULL OR due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('draft','active','achieved','missed','dropped','carried_over')),
        health TEXT NOT NULL DEFAULT 'none' CHECK (health IN ('none','on_track','at_risk','off_track')),
        progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
        progress_mode TEXT NOT NULL DEFAULT 'key_results' CHECK (progress_mode IN ('key_results','children','manual')),
        checkin_cadence TEXT NOT NULL DEFAULT 'weekly' CHECK (checkin_cadence IN ('none','weekly','biweekly','monthly')),
        last_checkin_at TEXT,
        closed_at TEXT,
        final_progress REAL CHECK (final_progress IS NULL OR (final_progress >= 0 AND final_progress <= 1)),
        position REAL NOT NULL DEFAULT 0,
        color TEXT CHECK (color IS NULL OR length(color) <= 16),
        visibility TEXT NOT NULL DEFAULT 'all_users' CHECK (visibility IN ('private','selected','all_users')),
        share_role TEXT NOT NULL DEFAULT 'view' CHECK (share_role IN ('view','comment','edit')),
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ${BIN},
        CHECK (parent_id IS NULL OR parent_id <> id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS goals_short_id ON goals(short_id);
      CREATE INDEX IF NOT EXISTS goals_period_parent ON goals(period_id, parent_id);
      CREATE INDEX IF NOT EXISTS goals_parent ON goals(parent_id) WHERE parent_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS goals_owner ON goals(owner_id);
      CREATE INDEX IF NOT EXISTS goals_group ON goals(group_id) WHERE group_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS goals_binned ON goals(purge_after) WHERE deleted_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS goal_contributors (
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (goal_id, user_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS goal_contributors_user ON goal_contributors(user_id);

      CREATE TABLE IF NOT EXISTS key_results (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        metric TEXT NOT NULL DEFAULT 'number' CHECK (metric IN ('number','percent','currency','boolean','milestones')),
        direction TEXT NOT NULL DEFAULT 'increase' CHECK (direction IN ('increase','decrease','stay_above','stay_below')),
        start_value REAL NOT NULL DEFAULT 0,
        target_value REAL NOT NULL DEFAULT 100,
        current_value REAL NOT NULL DEFAULT 0,
        unit TEXT CHECK (unit IS NULL OR length(unit) <= 16),
        currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
        weight REAL NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 100),
        source_kind TEXT NOT NULL DEFAULT 'manual' CHECK (length(source_kind) BETWEEN 1 AND 32),
        source_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_json) AND length(source_json) <= 8192),
        source_error TEXT CHECK (source_error IS NULL OR length(source_error) <= 300),
        auto_updated_at TEXT,
        progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
        position REAL NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS key_results_goal ON key_results(goal_id, position);
      CREATE INDEX IF NOT EXISTS key_results_auto ON key_results(source_kind, auto_updated_at) WHERE source_kind <> 'manual';

      CREATE TABLE IF NOT EXISTS kr_milestones (
        id TEXT PRIMARY KEY,
        kr_id TEXT NOT NULL REFERENCES key_results(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        done_at TEXT,
        position REAL NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS kr_milestones_kr ON kr_milestones(kr_id, position);

      CREATE TABLE IF NOT EXISTS kr_values (
        kr_id TEXT NOT NULL REFERENCES key_results(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        value REAL NOT NULL,
        progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
        source TEXT NOT NULL CHECK (source IN ('checkin','auto','edit')),
        PRIMARY KEY (kr_id, at)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS goal_checkins (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        health TEXT NOT NULL CHECK (health IN ('none','on_track','at_risk','off_track')),
        confidence INTEGER CHECK (confidence IS NULL OR (confidence BETWEEN 1 AND 10)),
        note_md TEXT NOT NULL DEFAULT '' CHECK (length(CAST(note_md AS BLOB)) <= 10000),
        values_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(values_json) AND length(values_json) <= 8192),
        progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
        via TEXT NOT NULL DEFAULT 'web' CHECK (length(via) <= 16),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS goal_checkins_goal ON goal_checkins(goal_id, created_at DESC, id);
    `);
  }
};
