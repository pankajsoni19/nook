import type { Migration } from "./types";
import { shortIdSql } from "./083_short_ids";

/**
 * Standups (module id `checkins`, docs/plan/WORKSPACE_MODULES.md §D.4, D930–D959).
 *
 * - `checkins`: the sharing container (access kind `checkin`, members and group grants in the generic
 *   `item_members` / `item_group_grants`), with its schedule (`schedule_json`: weekdays, time, zone
 *   mode, zone, every N weeks), deadline and reminder, summary options, and the Bin columns.
 * - `checkin_participants`: who answers; `via_group_id` marks rows expanded from a participant group
 *   (`checkin_participant_groups`), re-synced when groups change and before each round (D937).
 * - `checkin_rounds`: one per cadence date (D931); `checkin_round_participants` is each person's
 *   state in a round (pending, answered, late, skipped, out) with their own open and deadline instants;
 *   `response_id` is NULL for anonymous standups (D934: who answered, never what).
 * - `checkin_blockers`: cards a blockers answer named (D935), so a round lists them on top and the next
 *   round offers "Unblock".
 * - `checkin_subscriptions`: a person's choice about round summaries (absent: the default).
 * - Purge triggers clear the module's rows in shared tables (links, activity, comments, members, group
 *   grants, key grants, schedules, question sets, responses, reactions).
 *
 * Needs 083, 085, 086, 087, and 089. Transactional and filesystem-free; re-running changes nothing.
 */
const SHORT_ID = `short_id TEXT NOT NULL DEFAULT (${shortIdSql}) CHECK (length(short_id) = 10 AND short_id GLOB '[0-9]*' AND short_id NOT GLOB '*[^0-9a-z]*')`;
const BIN = `deleted_at TEXT, deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL, purge_after TEXT, purge_started_at TEXT,
        CHECK ((deleted_at IS NULL) = (purge_after IS NULL))`;

export const checkinsMigration: Migration = {
  id: 99,
  name: "checkins",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS checkins (
        id TEXT PRIMARY KEY,
        ${SHORT_ID},
        owner_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        template TEXT NOT NULL CHECK (template IN ('standup','weekly','retro','pulse','custom')),
        description_md TEXT NOT NULL DEFAULT '' CHECK (length(description_md) <= 4000),
        anonymous INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0, 1)),
        private_answers INTEGER NOT NULL DEFAULT 0 CHECK (private_answers IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
        schedule_json TEXT NOT NULL CHECK (json_valid(schedule_json) AND length(schedule_json) <= 2048),
        tz TEXT NOT NULL DEFAULT 'UTC' CHECK (length(tz) BETWEEN 1 AND 64),
        deadline_minutes INTEGER NOT NULL DEFAULT 360 CHECK (deadline_minutes BETWEEN 30 AND 10080),
        reminder_minutes_before INTEGER CHECK (reminder_minutes_before IS NULL OR reminder_minutes_before BETWEEN 5 AND 10080),
        summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json) AND length(summary_json) <= 4096),
        audience TEXT NOT NULL DEFAULT 'participants' CHECK (audience IN ('participants')),
        visibility TEXT NOT NULL DEFAULT 'selected' CHECK (visibility IN ('private','selected','all_users')),
        share_role TEXT NOT NULL DEFAULT 'view' CHECK (share_role IN ('view','comment','edit','manage')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ${BIN}
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS checkins_short_id ON checkins(short_id);
      CREATE INDEX IF NOT EXISTS checkins_owner ON checkins(owner_id, deleted_at);

      CREATE TABLE IF NOT EXISTS checkin_participant_groups (
        checkin_id TEXT NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (checkin_id, group_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS checkin_participants (
        checkin_id TEXT NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tz TEXT CHECK (tz IS NULL OR length(tz) BETWEEN 1 AND 64),
        tz_auto INTEGER NOT NULL DEFAULT 1 CHECK (tz_auto IN (0, 1)),
        paused_until TEXT CHECK (paused_until IS NULL OR length(paused_until) = 10),
        joined_at TEXT NOT NULL,
        via_group_id TEXT REFERENCES user_groups(id) ON DELETE CASCADE,
        PRIMARY KEY (checkin_id, user_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS checkin_participants_user ON checkin_participants(user_id);

      CREATE TABLE IF NOT EXISTS checkin_rounds (
        id TEXT PRIMARY KEY,
        checkin_id TEXT NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
        round_date TEXT NOT NULL CHECK (length(round_date) = 10),
        opens_at TEXT NOT NULL,
        closes_at TEXT NOT NULL,
        closed_at TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('scheduled','open','closed')),
        manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1)),
        answered_count INTEGER NOT NULL DEFAULT 0,
        participant_count INTEGER NOT NULL DEFAULT 0,
        summary_md TEXT CHECK (summary_md IS NULL OR length(summary_md) <= 20000),
        created_at TEXT NOT NULL,
        UNIQUE (checkin_id, round_date)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS checkin_rounds_open ON checkin_rounds(status, closes_at);

      CREATE TABLE IF NOT EXISTS checkin_round_participants (
        round_id TEXT NOT NULL REFERENCES checkin_rounds(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','late','skipped','out')),
        opens_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        notified_at TEXT,
        reminded_at TEXT,
        nudged_at TEXT,
        answered_at TEXT,
        response_id TEXT,
        PRIMARY KEY (round_id, user_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS checkin_round_participants_user ON checkin_round_participants(user_id, status);

      CREATE TABLE IF NOT EXISTS checkin_blockers (
        round_id TEXT NOT NULL REFERENCES checkin_rounds(id) ON DELETE CASCADE,
        response_id TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (response_id, card_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS checkin_blockers_round ON checkin_blockers(round_id);
      CREATE INDEX IF NOT EXISTS checkin_blockers_card ON checkin_blockers(card_id);

      CREATE TABLE IF NOT EXISTS checkin_subscriptions (
        checkin_id TEXT NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        summaries INTEGER NOT NULL CHECK (summaries IN (0, 1)),
        PRIMARY KEY (checkin_id, user_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TRIGGER IF NOT EXISTS checkins_purge AFTER DELETE ON checkins
      BEGIN
        DELETE FROM item_members WHERE item_kind = 'checkin' AND item_id = OLD.id;
        DELETE FROM item_group_grants WHERE item_kind = 'checkin' AND item_id = OLD.id;
        DELETE FROM api_key_grants WHERE resource_kind = 'checkin' AND resource_id = OLD.id;
        DELETE FROM item_activity WHERE item_kind = 'checkin' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'checkin' AND item_id = OLD.id;
        DELETE FROM work_links WHERE (a_kind = 'checkin' AND a_id = OLD.id) OR (b_kind = 'checkin' AND b_id = OLD.id);
        DELETE FROM schedules WHERE owner_kind = 'checkin' AND owner_id = OLD.id;
        DELETE FROM responses WHERE host_kind = 'checkin' AND host_id = OLD.id;
        DELETE FROM question_sets WHERE host_kind = 'checkin' AND host_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS checkin_rounds_purge AFTER DELETE ON checkin_rounds
      BEGIN
        DELETE FROM work_links WHERE (a_kind = 'checkin_round' AND a_id = OLD.id) OR (b_kind = 'checkin_round' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'checkin_round' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'checkin_round' AND item_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS checkin_responses_purge AFTER DELETE ON responses WHEN OLD.host_kind = 'checkin'
      BEGIN
        DELETE FROM work_links WHERE (a_kind = 'checkin_round' AND a_id = OLD.id) OR (b_kind = 'checkin_round' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'checkin_round' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'checkin_round' AND item_id = OLD.id;
        DELETE FROM reactions WHERE target_kind = 'checkin_answer' AND target_id = OLD.id;
        DELETE FROM checkin_blockers WHERE response_id = OLD.id;
      END;
    `);
  }
};
