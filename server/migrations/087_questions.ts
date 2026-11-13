import type { Migration } from "./types";

/**
 * The question engine's storage (docs/plan/WORKSPACE_MODULES.md §B.2, D802).
 *
 * - `question_sets`: immutable published versions per host plus at most one draft (partial unique
 *   index). Hosts: forms, standups (`checkin`), booking types, townhall sessions. The set is JSON
 *   (shared/questions/types.ts), at most 256 KiB.
 * - `responses`: one per submission, pinning the set version it answered. A respondent is a user,
 *   a contact, a guest (name and email typed on a public page), or anonymous (no identity stored at
 *   all; one-per-person on an anonymous host uses `dedupe_hash`, a keyed HMAC, D843). The subject
 *   (`subject_kind`/`subject_id`) is what the response is about, e.g. a standup round.
 * - `response_answers`: one normalized row per answered value (a choice option per row, numbers in
 *   `value_num`, text in `value_text`, structured answers in `value_json`), so summaries aggregate in SQL.
 *
 * One-per-person rules differ by host and are enforced in the service. Needs only 001. Transactional
 * and filesystem-free; re-running changes nothing.
 */
export const questionsMigration: Migration = {
  id: 87,
  name: "questions",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS question_sets (
        id TEXT PRIMARY KEY,
        host_kind TEXT NOT NULL CHECK (host_kind IN ('form','checkin','booking_type','townhall_session')),
        host_id TEXT NOT NULL CHECK (length(host_id) BETWEEN 1 AND 64),
        version INTEGER NOT NULL CHECK (version >= 0),
        status TEXT NOT NULL CHECK (status IN ('draft','published')),
        set_json TEXT NOT NULL CHECK (json_valid(set_json) AND length(CAST(set_json AS BLOB)) <= 262144),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (host_kind, host_id, version),
        CHECK ((status = 'draft') = (version = 0))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS question_sets_one_draft ON question_sets(host_kind, host_id) WHERE status = 'draft';

      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        host_kind TEXT NOT NULL CHECK (host_kind IN ('form','checkin','booking_type','townhall_session')),
        host_id TEXT NOT NULL CHECK (length(host_id) BETWEEN 1 AND 64),
        set_version INTEGER NOT NULL CHECK (set_version >= 1),
        subject_kind TEXT CHECK (subject_kind IS NULL OR (length(subject_kind) BETWEEN 1 AND 32 AND subject_kind NOT GLOB '*[^a-z_]*')),
        subject_id TEXT CHECK (subject_id IS NULL OR length(subject_id) <= 64),
        respondent_kind TEXT NOT NULL CHECK (respondent_kind IN ('user','contact','guest','anonymous')),
        respondent_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        respondent_contact_id TEXT CHECK (respondent_contact_id IS NULL OR length(respondent_contact_id) <= 64),
        respondent_name TEXT CHECK (respondent_name IS NULL OR length(respondent_name) <= 120),
        respondent_email TEXT CHECK (respondent_email IS NULL OR length(respondent_email) <= 254),
        dedupe_hash TEXT CHECK (dedupe_hash IS NULL OR length(dedupe_hash) = 64),
        status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','pending_verification')),
        score REAL,
        meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json) AND length(meta_json) <= 4096),
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        CHECK (respondent_kind <> 'anonymous' OR (respondent_user_id IS NULL AND respondent_contact_id IS NULL AND respondent_name IS NULL AND respondent_email IS NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS responses_host ON responses(host_kind, host_id, submitted_at DESC, id);
      CREATE INDEX IF NOT EXISTS responses_user ON responses(respondent_user_id, host_kind) WHERE respondent_user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS responses_subject ON responses(subject_kind, subject_id) WHERE subject_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS responses_dedupe ON responses(host_kind, host_id, dedupe_hash) WHERE dedupe_hash IS NOT NULL;

      CREATE TABLE IF NOT EXISTS response_answers (
        response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL CHECK (length(question_id) BETWEEN 1 AND 16),
        ord INTEGER NOT NULL DEFAULT 0 CHECK (ord >= 0),
        option_id TEXT CHECK (option_id IS NULL OR length(option_id) <= 64),
        value_text TEXT CHECK (value_text IS NULL OR length(value_text) <= 10000),
        value_num REAL,
        value_json TEXT CHECK (value_json IS NULL OR (json_valid(value_json) AND length(value_json) <= 16384)),
        PRIMARY KEY (response_id, question_id, ord)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS response_answers_option ON response_answers(question_id, option_id);
      -- A purged response's comments and links go with it (item kind 'response').
      CREATE TRIGGER IF NOT EXISTS responses_purge AFTER DELETE ON responses
      BEGIN
        DELETE FROM work_links WHERE (a_kind = 'response' AND a_id = OLD.id) OR (b_kind = 'response' AND b_id = OLD.id);
        DELETE FROM item_comments WHERE item_kind = 'response' AND item_id = OLD.id;
        DELETE FROM item_activity WHERE item_kind = 'response' AND item_id = OLD.id;
        DELETE FROM attachment_links WHERE host_kind = 'response' AND host_id = OLD.id;
      END;
    `);
  }
};
