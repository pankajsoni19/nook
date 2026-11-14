import type { Migration } from "./types";
import { shortIdSql } from "./083_short_ids";

/**
 * Townhall (docs/plan/WORKSPACE_MODULES.md §G.1, §D.7 Townhall, D1070–D1099): all-hands and AMA
 * sessions with audience questions, upvotes, moderation, live polls, and a recap.
 *
 * - `townhall_sessions`: the sharing container (`townhall_session`: owner, visibility, share_role; people
 *   and groups in `item_members` / `item_group_grants`), a friendly short id, the Bin columns, and the
 *   session's state (`upcoming` → `live` → `ended`) and settings (anonymous questions, review before
 *   showing, comments). `pinned_question_id` / `active_poll_id` are what the presenter view shows.
 *   `public_token_seed` re-derives the audience link's token under the workspace key (D1076), so the
 *   host can show the QR code again; the link itself is a `public_links` row (hash only).
 * - `townhall_questions`: one row per question. An anonymous question stores no author id, only a keyed
 *   hash of the person (`asker_hash`, D1073), so "my questions" works and nobody can read who asked.
 *   `merged_into` hides a duplicate inside the question it was merged into (its votes move there).
 * - `townhall_votes`: one upvote per voter (a keyed hash of the person or public participant, D1073).
 * - `townhall_polls`: live polls; the question itself is a question of the session's question set
 *   (host `townhall_session`, the shared engine, D802), the votes are engine responses (D1074).
 * - `townhall_attendance`: who joined (members by user id, public participants by hash), for the recap.
 * - Purge triggers clear the session's grants, links, activity, comments, schedules, public links, and
 *   question sets and responses (§B.13).
 *
 * Needs 083, 085, 086, 087, 089. Transactional and filesystem-free; re-running changes nothing.
 */
const SHORT_ID = `short_id TEXT NOT NULL DEFAULT (${shortIdSql}) CHECK (length(short_id) = 10 AND short_id GLOB '[0-9]*' AND short_id NOT GLOB '*[^0-9a-z]*')`;
const BIN = `deleted_at TEXT, deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL, purge_after TEXT, purge_started_at TEXT,
        CHECK ((deleted_at IS NULL) = (purge_after IS NULL))`;

export const townhallMigration: Migration = {
  id: 115,
  name: "townhall",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS townhall_sessions (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        ${SHORT_ID},
        owner_id TEXT NOT NULL REFERENCES users(id),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 20000),
        starts_at TEXT CHECK (starts_at IS NULL OR length(starts_at) <= 40),
        ends_at TEXT CHECK (ends_at IS NULL OR length(ends_at) <= 40),
        event_id TEXT CHECK (event_id IS NULL OR length(event_id) <= 64),
        state TEXT NOT NULL DEFAULT 'upcoming' CHECK (state IN ('upcoming','live','ended')),
        questions_open INTEGER NOT NULL DEFAULT 1 CHECK (questions_open IN (0,1)),
        allow_anonymous INTEGER NOT NULL DEFAULT 1 CHECK (allow_anonymous IN (0,1)),
        moderation TEXT NOT NULL DEFAULT 'off' CHECK (moderation IN ('off','review')),
        allow_comments INTEGER NOT NULL DEFAULT 1 CHECK (allow_comments IN (0,1)),
        reminder_minutes INTEGER NOT NULL DEFAULT 15 CHECK (reminder_minutes BETWEEN 0 AND 1440),
        pinned_question_id TEXT CHECK (pinned_question_id IS NULL OR length(pinned_question_id) = 36),
        active_poll_id TEXT CHECK (active_poll_id IS NULL OR length(active_poll_id) = 36),
        public_token_seed TEXT CHECK (public_token_seed IS NULL OR length(public_token_seed) <= 80),
        recap_note_id TEXT CHECK (recap_note_id IS NULL OR length(recap_note_id) = 36),
        went_live_at TEXT,
        ended_at TEXT,
        visibility TEXT NOT NULL DEFAULT 'all_users' CHECK (visibility IN ('private','selected','all_users')),
        share_role TEXT NOT NULL DEFAULT 'view' CHECK (share_role IN ('view','comment','edit','manage')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ${BIN}
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS townhall_sessions_short_id ON townhall_sessions(short_id);
      CREATE INDEX IF NOT EXISTS townhall_sessions_owner ON townhall_sessions(owner_id, deleted_at);
      CREATE INDEX IF NOT EXISTS townhall_sessions_list ON townhall_sessions(deleted_at, state, starts_at);
      CREATE INDEX IF NOT EXISTS townhall_sessions_purge ON townhall_sessions(purge_after) WHERE deleted_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS townhall_questions (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        session_id TEXT NOT NULL REFERENCES townhall_sessions(id) ON DELETE CASCADE,
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        author_label TEXT CHECK (author_label IS NULL OR length(author_label) BETWEEN 1 AND 80),
        anonymous INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0,1)),
        asker_hash TEXT NOT NULL CHECK (length(asker_hash) = 64),
        body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
        status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','answered','hidden')),
        starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0,1)),
        merged_into TEXT REFERENCES townhall_questions(id) ON DELETE SET NULL,
        vote_count INTEGER NOT NULL DEFAULT 0 CHECK (vote_count >= 0),
        card_id TEXT CHECK (card_id IS NULL OR length(card_id) = 36),
        answered_at TEXT,
        answered_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        via TEXT NOT NULL DEFAULT 'web' CHECK (via IN ('web','mcp','rest','agent','public')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (anonymous = 0 OR author_id IS NULL)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS townhall_questions_session ON townhall_questions(session_id, created_at, id);
      CREATE INDEX IF NOT EXISTS townhall_questions_author ON townhall_questions(author_id) WHERE author_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS townhall_questions_merged ON townhall_questions(merged_into) WHERE merged_into IS NOT NULL;

      CREATE TABLE IF NOT EXISTS townhall_votes (
        question_id TEXT NOT NULL REFERENCES townhall_questions(id) ON DELETE CASCADE,
        voter_hash TEXT NOT NULL CHECK (length(voter_hash) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY (question_id, voter_hash)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS townhall_polls (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        session_id TEXT NOT NULL REFERENCES townhall_sessions(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL CHECK (length(question_id) BETWEEN 1 AND 16),
        kind TEXT NOT NULL CHECK (kind IN ('single','multi','word_cloud','rating','open_text')),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','closed')),
        results_hidden INTEGER NOT NULL DEFAULT 0 CHECK (results_hidden IN (0,1)),
        position INTEGER NOT NULL DEFAULT 0,
        opened_at TEXT,
        closed_at TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, question_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS townhall_polls_session ON townhall_polls(session_id, position, created_at);

      CREATE TABLE IF NOT EXISTS townhall_attendance (
        session_id TEXT NOT NULL REFERENCES townhall_sessions(id) ON DELETE CASCADE,
        attendee_hash TEXT NOT NULL CHECK (length(attendee_hash) = 64),
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        via TEXT NOT NULL CHECK (via IN ('web','public')),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (session_id, attendee_hash)
      ) STRICT, WITHOUT ROWID;

      CREATE TRIGGER IF NOT EXISTS townhall_sessions_purge AFTER DELETE ON townhall_sessions
      BEGIN
        DELETE FROM item_members WHERE item_kind = 'townhall_session' AND item_id = OLD.id;
        DELETE FROM item_group_grants WHERE item_kind = 'townhall_session' AND item_id = OLD.id;
        DELETE FROM api_key_grants WHERE resource_kind = 'townhall_session' AND resource_id = OLD.id;
        DELETE FROM work_links WHERE (a_kind = 'townhall_session' AND a_id = OLD.id) OR (b_kind = 'townhall_session' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'townhall_session' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'townhall_session' AND item_id = OLD.id;
        DELETE FROM schedules WHERE owner_kind = 'townhall_session' AND owner_id = OLD.id;
        DELETE FROM public_links WHERE kind = 'townhall_session' AND item_id = OLD.id;
        DELETE FROM responses WHERE host_kind = 'townhall_session' AND host_id = OLD.id;
        DELETE FROM question_sets WHERE host_kind = 'townhall_session' AND host_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS townhall_questions_purge AFTER DELETE ON townhall_questions
      BEGIN
        DELETE FROM work_links WHERE (a_kind = 'townhall_question' AND a_id = OLD.id) OR (b_kind = 'townhall_question' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'townhall_question' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'townhall_question' AND item_id = OLD.id;
      END;
    `);
  }
};
