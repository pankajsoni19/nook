import type { Migration } from "./types";
import { shortIdSql } from "./083_short_ids";

/**
 * Time (lane TIME, docs/plan/WORKSPACE_MODULES.md §D.2, D870–D899):
 *
 * - `time_projects`: the sharing container (owner, visibility, share_role; members and group grants in
 *   `item_members` / `item_group_grants` as kind `time_project`), with an optional client (a company,
 *   088) and an optional linked board (one project per board among live projects, D876), billable
 *   default, an hourly rate in minor units and the project's currency (the workspace currency when it
 *   was made, D885), a budget, settings, a friendly short id, and the Bin columns.
 * - `time_member_rates`: a person's rate on a project, over the project's rate.
 * - `time_entries`: one block of time. `started_at` + `duration_s` (+ `ended_at` once stopped); a
 *   running timer has neither (D871), and a person has at most one (D870, the partial unique index).
 *   The rate and currency are copied when the entry is written, so later rate changes never reprice
 *   history (D884). `target_kind`/`target_id` is the work it tracks (a card, goal, contact, …).
 * - `time_tags`: the workspace's tag list (names are free text on entries, up to 5).
 * - `time_approvals`: a person's week on a project, submitted / approved / rejected (D874).
 * - `time_user_settings`: each person's reminders (D888).
 *
 * Needs 001, 009 (boards), 083, 085, 086, and 088. Transactional and filesystem-free; re-running
 * changes nothing.
 */
const SHORT_ID = `short_id TEXT NOT NULL DEFAULT (${shortIdSql}) CHECK (length(short_id) = 10 AND short_id NOT GLOB '*[^0-9a-z]*')`;

export const timeMigration: Migration = {
  id: 93,
  name: "time",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS time_projects (
        id TEXT PRIMARY KEY,
        ${SHORT_ID},
        owner_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        code TEXT CHECK (code IS NULL OR length(code) BETWEEN 1 AND 12),
        color TEXT NOT NULL DEFAULT 'amber' CHECK (length(color) BETWEEN 1 AND 24),
        company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
        board_id TEXT REFERENCES boards(id) ON DELETE SET NULL,
        billable_default INTEGER NOT NULL DEFAULT 1 CHECK (billable_default IN (0,1)),
        rate_minor INTEGER CHECK (rate_minor IS NULL OR (rate_minor >= 0 AND rate_minor <= 100000000000)),
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        budget_kind TEXT NOT NULL DEFAULT 'none' CHECK (budget_kind IN ('none','hours','money')),
        budget_value INTEGER CHECK (budget_value IS NULL OR (budget_value >= 0 AND budget_value <= 9000000000000000)),
        budget_period TEXT NOT NULL DEFAULT 'total' CHECK (budget_period IN ('total','monthly')),
        settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json) AND json_type(settings_json) = 'object' AND length(settings_json) <= 4096),
        archived_at TEXT,
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','selected','all_users')),
        share_role TEXT NOT NULL DEFAULT 'edit' CHECK (share_role IN ('view','comment','edit','manage')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        purge_after TEXT,
        purge_started_at TEXT,
        CHECK ((deleted_at IS NULL) = (purge_after IS NULL))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS time_projects_short_id ON time_projects(short_id);
      CREATE UNIQUE INDEX IF NOT EXISTS time_projects_board ON time_projects(board_id) WHERE board_id IS NOT NULL AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS time_projects_owner ON time_projects(owner_id, deleted_at);
      CREATE INDEX IF NOT EXISTS time_projects_company ON time_projects(company_id) WHERE company_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS time_member_rates (
        project_id TEXT NOT NULL REFERENCES time_projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rate_minor INTEGER NOT NULL CHECK (rate_minor >= 0 AND rate_minor <= 100000000000),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS time_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES time_projects(id) ON DELETE SET NULL,
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
        started_at TEXT NOT NULL CHECK (length(started_at) BETWEEN 20 AND 30),
        ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) BETWEEN 20 AND 30),
        duration_s INTEGER CHECK (duration_s IS NULL OR (duration_s >= 0 AND duration_s <= 86400)),
        tz TEXT NOT NULL DEFAULT 'UTC' CHECK (length(tz) BETWEEN 1 AND 64),
        billable INTEGER NOT NULL DEFAULT 0 CHECK (billable IN (0,1)),
        rate_minor INTEGER CHECK (rate_minor IS NULL OR rate_minor >= 0),
        currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
        tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array' AND length(tags_json) <= 512),
        target_kind TEXT CHECK (target_kind IS NULL OR length(target_kind) BETWEEN 2 AND 24),
        target_id TEXT CHECK (target_id IS NULL OR length(target_id) BETWEEN 1 AND 64),
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('timer','manual','timesheet','calendar','import','mcp','proposal')),
        locked_at TEXT,
        locked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((ended_at IS NULL) = (duration_s IS NULL)),
        CHECK ((target_kind IS NULL) = (target_id IS NULL))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS time_entries_running ON time_entries(user_id) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS time_entries_user ON time_entries(user_id, started_at DESC, id);
      CREATE INDEX IF NOT EXISTS time_entries_project ON time_entries(project_id, started_at) WHERE project_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS time_entries_target ON time_entries(target_kind, target_id, started_at) WHERE target_kind IS NOT NULL;

      CREATE TABLE IF NOT EXISTS time_tags (
        name TEXT PRIMARY KEY COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 40),
        color TEXT CHECK (color IS NULL OR length(color) <= 24),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS time_approvals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES time_projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        week_start TEXT NOT NULL CHECK (length(week_start) = 10),
        status TEXT NOT NULL CHECK (status IN ('submitted','approved','rejected')),
        note TEXT CHECK (note IS NULL OR length(note) <= 500),
        decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        decided_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, user_id, week_start)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS time_approvals_pending ON time_approvals(project_id, status);

      CREATE TABLE IF NOT EXISTS time_user_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        daily_reminder INTEGER NOT NULL DEFAULT 0 CHECK (daily_reminder IN (0,1)),
        reminder_at TEXT NOT NULL DEFAULT '17:00' CHECK (length(reminder_at) = 5),
        reminder_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]' CHECK (json_valid(reminder_days) AND length(reminder_days) <= 32),
        long_timer_hours INTEGER NOT NULL DEFAULT 8 CHECK (long_timer_hours BETWEEN 0 AND 24),
        tz TEXT NOT NULL DEFAULT 'UTC' CHECK (length(tz) BETWEEN 1 AND 64),
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }
};
