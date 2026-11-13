import type { Migration } from "./types";
import { shortIdSql } from "./083_short_ids";

/**
 * Forms, polls, and find-a-time polls (docs/plan/WORKSPACE_MODULES.md §D.1, D840–D846).
 *
 * - `forms`: one table for the three kinds (D840). The questions live in the question engine
 *   (`question_sets`/`responses` with host kind `form`, 087). Who answers (`audience`,
 *   `audience_json`) is separate from who reads results and edits (`visibility`, `share_role`, and the
 *   generic `item_members`/`item_group_grants` rows of kind `form`, D842). Bin columns, a revision,
 *   and a friendly short id (D771) as every workspace container.
 * - `form_actions` / `form_action_runs`: what a response does (create a card, save a contact, notify
 *   people) and each run's outcome, retried by a schedule when it fails (D845).
 * - `form_visits`: the completion funnel (views → starts → submits) per day, no personal data.
 *
 * Purge triggers clear the form's links, activity, comments, members, group grants, key grants,
 * schedules, public links, and every question set and response it hosts. Needs 083, 085–089.
 */
const SHORT_ID = `short_id TEXT NOT NULL DEFAULT (${shortIdSql}) CHECK (length(short_id) = 10 AND short_id GLOB '[0-9]*' AND short_id NOT GLOB '*[^0-9a-z]*')`;

export const formsMigration: Migration = {
  id: 90,
  name: "forms",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS forms (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        ${SHORT_ID},
        owner_id TEXT NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK (kind IN ('form','poll','time_poll')),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        description_md TEXT NOT NULL DEFAULT '' CHECK (length(description_md) <= 20000),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
        audience TEXT NOT NULL DEFAULT 'workspace' CHECK (audience IN ('workspace','selected','public')),
        audience_json TEXT NOT NULL DEFAULT '{"users":[],"groups":[]}' CHECK (json_valid(audience_json) AND length(audience_json) <= 8192),
        anonymous INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0,1)),
        limit_per TEXT NOT NULL DEFAULT 'person' CHECK (limit_per IN ('none','person','browser')),
        allow_edit INTEGER NOT NULL DEFAULT 0 CHECK (allow_edit IN (0,1)),
        results_visibility TEXT NOT NULL DEFAULT 'owner_only' CHECK (results_visibility IN ('owner_only','live','after_vote','after_close')),
        display TEXT NOT NULL DEFAULT 'page' CHECK (display IN ('page','stepper')),
        opens_at TEXT,
        closes_at TEXT,
        max_responses INTEGER CHECK (max_responses IS NULL OR max_responses BETWEEN 1 AND 100000),
        verify_email INTEGER NOT NULL DEFAULT 0 CHECK (verify_email IN (0,1)),
        theme_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(theme_json) AND length(theme_json) <= 2048),
        ending_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ending_json) AND length(ending_json) <= 8192),
        settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json) AND length(settings_json) <= 8192),
        calendar_id TEXT CHECK (calendar_id IS NULL OR length(calendar_id) <= 64),
        finalized_slot_id TEXT CHECK (finalized_slot_id IS NULL OR length(finalized_slot_id) <= 16),
        finalized_event_id TEXT CHECK (finalized_event_id IS NULL OR length(finalized_event_id) <= 64),
        response_count INTEGER NOT NULL DEFAULT 0 CHECK (response_count >= 0),
        last_response_at TEXT,
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','selected','all_users')),
        share_role TEXT NOT NULL DEFAULT 'view' CHECK (share_role IN ('view','comment','edit','manage')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        deleted_at TEXT,
        deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        purge_after TEXT,
        purge_started_at TEXT,
        CHECK ((deleted_at IS NULL) = (purge_after IS NULL))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS forms_short_id ON forms(short_id);
      CREATE INDEX IF NOT EXISTS forms_owner ON forms(owner_id, deleted_at, updated_at);
      CREATE INDEX IF NOT EXISTS forms_status ON forms(status, closes_at);
      CREATE INDEX IF NOT EXISTS forms_audience ON forms(audience, status) WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS form_actions (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('create_card','save_contact','create_deal','notify')),
        config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json) AND length(config_json) <= 16384),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        position INTEGER NOT NULL DEFAULT 0,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS form_actions_form ON form_actions(form_id, position);

      CREATE TABLE IF NOT EXISTS form_action_runs (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        action_id TEXT NOT NULL REFERENCES form_actions(id) ON DELETE CASCADE,
        response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('done','failed','pending')),
        result_ref TEXT CHECK (result_ref IS NULL OR length(result_ref) <= 120),
        error TEXT CHECK (error IS NULL OR length(error) <= 500),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (action_id, response_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS form_action_runs_open ON form_action_runs(status, updated_at) WHERE status <> 'done';
      CREATE INDEX IF NOT EXISTS form_action_runs_response ON form_action_runs(response_id);

      CREATE TABLE IF NOT EXISTS form_visits (
        form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
        day TEXT NOT NULL CHECK (length(day) = 10),
        views INTEGER NOT NULL DEFAULT 0,
        starts INTEGER NOT NULL DEFAULT 0,
        submits INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (form_id, day)
      ) STRICT, WITHOUT ROWID;

      CREATE TRIGGER IF NOT EXISTS forms_purge AFTER DELETE ON forms
      BEGIN
        DELETE FROM work_links WHERE (a_kind = 'form' AND a_id = OLD.id) OR (b_kind = 'form' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'form' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'form' AND item_id = OLD.id;
        DELETE FROM item_members WHERE item_kind = 'form' AND item_id = OLD.id;
        DELETE FROM item_group_grants WHERE item_kind = 'form' AND item_id = OLD.id;
        DELETE FROM api_key_grants WHERE resource_kind = 'form' AND resource_id = OLD.id;
        DELETE FROM schedules WHERE owner_kind = 'form' AND owner_id = OLD.id;
        DELETE FROM public_links WHERE kind IN ('form','time_poll_guest') AND item_id = OLD.id;
        DELETE FROM responses WHERE host_kind = 'form' AND host_id = OLD.id;
        DELETE FROM question_sets WHERE host_kind = 'form' AND host_id = OLD.id;
      END;
    `);
  }
};
