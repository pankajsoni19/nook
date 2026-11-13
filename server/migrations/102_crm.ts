import type { Migration } from "./types";
import { shortIdSql } from "./083_short_ids";

/**
 * Contacts (module `crm`, docs/plan/WORKSPACE_MODULES.md §D.5, D960–D966): pipelines and stages,
 * deals, interactions and their subjects, lists, saved views, follow-ups, and CSV import jobs. The
 * people tables themselves (contact books, contacts, companies, channels) are foundation (088).
 *
 * - A pipeline belongs to a book; a stage is open, won, or lost with a probability (D962).
 * - A deal's status mirrors its stage's kind; won and lost stamp `closed_at`. Deals have the Bin columns.
 * - An interaction belongs to a book and names any number of contacts, companies, and deals (D963).
 * - `crm_list_members.item_id` is the member's id (a contact, company, or deal by the list's entity).
 *
 * Needs 088. Transactional and filesystem-free; re-running changes nothing.
 */
const SHORT_ID = `short_id TEXT NOT NULL DEFAULT (${shortIdSql}) CHECK (length(short_id) = 10 AND short_id GLOB '[0-9]*' AND short_id NOT GLOB '*[^0-9a-z]*')`;

export const crmMigration: Migration = {
  id: 102,
  name: "crm",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipelines (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES contact_books(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        currency TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]')),
        position REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS pipelines_book ON pipelines(book_id, position) WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS pipeline_stages (
        id TEXT PRIMARY KEY,
        pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        kind TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')),
        probability INTEGER NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
        rot_days INTEGER CHECK (rot_days IS NULL OR rot_days BETWEEN 1 AND 365),
        color TEXT CHECK (color IS NULL OR length(color) <= 24),
        position REAL NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS pipeline_stages_pipeline ON pipeline_stages(pipeline_id, position);

      CREATE TABLE IF NOT EXISTS deals (
        id TEXT PRIMARY KEY,
        ${SHORT_ID},
        book_id TEXT NOT NULL REFERENCES contact_books(id) ON DELETE CASCADE,
        pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        stage_id TEXT NOT NULL REFERENCES pipeline_stages(id),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        value_minor INTEGER CHECK (value_minor IS NULL OR value_minor BETWEEN 0 AND 9000000000000000),
        currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
        expected_close_on TEXT CHECK (expected_close_on IS NULL OR expected_close_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
        next_step TEXT CHECK (next_step IS NULL OR length(next_step) <= 200),
        next_step_on TEXT CHECK (next_step_on IS NULL OR next_step_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
        closed_at TEXT,
        lost_reason TEXT CHECK (lost_reason IS NULL OR length(lost_reason) <= 200),
        stage_entered_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        rot_notified_at TEXT,
        position REAL NOT NULL DEFAULT 0,
        custom_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(custom_json) AND length(custom_json) <= 16384),
        tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json) AND length(tags_json) <= 2048),
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','booking','form','mcp')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT, deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL, purge_after TEXT, purge_started_at TEXT,
        CHECK ((deleted_at IS NULL) = (purge_after IS NULL))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS deals_short_id ON deals(short_id);
      CREATE INDEX IF NOT EXISTS deals_board ON deals(pipeline_id, stage_id, position) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS deals_owner ON deals(owner_id, status);
      CREATE INDEX IF NOT EXISTS deals_close ON deals(expected_close_on);
      CREATE INDEX IF NOT EXISTS deals_book ON deals(book_id, updated_at);
      CREATE INDEX IF NOT EXISTS deals_company ON deals(company_id) WHERE company_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS deal_contacts (
        deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        role TEXT CHECK (role IS NULL OR length(role) <= 40),
        PRIMARY KEY (deal_id, contact_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS deal_contacts_contact ON deal_contacts(contact_id);

      CREATE TABLE IF NOT EXISTS deal_stage_changes (
        id TEXT PRIMARY KEY,
        deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        from_stage_id TEXT,
        to_stage_id TEXT NOT NULL,
        value_minor INTEGER,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS deal_stage_changes_deal ON deal_stage_changes(deal_id, at);

      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES contact_books(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('note','call','meeting','email','message','task','booking','form','other')),
        direction TEXT NOT NULL DEFAULT 'none' CHECK (direction IN ('in','out','none')),
        occurred_at TEXT NOT NULL,
        duration_s INTEGER CHECK (duration_s IS NULL OR duration_s BETWEEN 0 AND 86400),
        title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 200),
        body_md TEXT NOT NULL DEFAULT '' CHECK (length(body_md) <= 20000),
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','booking','form','task','import','mcp')),
        source_ref TEXT CHECK (source_ref IS NULL OR length(source_ref) <= 80),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS interactions_book ON interactions(book_id, occurred_at);
      CREATE UNIQUE INDEX IF NOT EXISTS interactions_source ON interactions(source, source_ref) WHERE source_ref IS NOT NULL;

      CREATE TABLE IF NOT EXISTS interaction_subjects (
        interaction_id TEXT NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
        subject_kind TEXT NOT NULL CHECK (subject_kind IN ('contact','company','deal')),
        subject_id TEXT NOT NULL,
        PRIMARY KEY (interaction_id, subject_kind, subject_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS interaction_subjects_subject ON interaction_subjects(subject_kind, subject_id);

      CREATE TABLE IF NOT EXISTS crm_lists (
        id TEXT PRIMARY KEY,
        ${SHORT_ID},
        book_id TEXT NOT NULL REFERENCES contact_books(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        entity TEXT NOT NULL CHECK (entity IN ('contact','company','deal')),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS crm_lists_short_id ON crm_lists(short_id);
      CREATE INDEX IF NOT EXISTS crm_lists_book ON crm_lists(book_id, entity) WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS crm_list_members (
        list_id TEXT NOT NULL REFERENCES crm_lists(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (list_id, item_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS crm_list_members_item ON crm_list_members(item_id);

      CREATE TABLE IF NOT EXISTS crm_views (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES contact_books(id) ON DELETE CASCADE,
        entity TEXT NOT NULL CHECK (entity IN ('contact','company','deal')),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        kind TEXT NOT NULL DEFAULT 'table' CHECK (kind IN ('table','board')),
        config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json) AND length(config_json) <= 8192),
        owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        position REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS crm_views_book ON crm_views(book_id, entity, position);

      CREATE TABLE IF NOT EXISTS crm_followups (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES contact_books(id) ON DELETE CASCADE,
        subject_kind TEXT NOT NULL CHECK (subject_kind IN ('contact','company','deal')),
        subject_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        due_at TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
        done_at TEXT,
        notified_at TEXT,
        schedule_id TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS crm_followups_user ON crm_followups(user_id, done_at, due_at);
      CREATE INDEX IF NOT EXISTS crm_followups_subject ON crm_followups(subject_kind, subject_id);

      CREATE TABLE IF NOT EXISTS crm_import_jobs (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES contact_books(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entity TEXT NOT NULL CHECK (entity IN ('contact','company')),
        status TEXT NOT NULL CHECK (status IN ('preview','committed','undone','failed')),
        mapping_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(mapping_json) AND length(mapping_json) <= 16384),
        stats_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stats_json) AND length(stats_json) <= 8192),
        csv_text TEXT CHECK (csv_text IS NULL OR length(csv_text) <= 5242880),
        changes_json TEXT CHECK (changes_json IS NULL OR json_valid(changes_json)),
        created_at TEXT NOT NULL,
        finished_at TEXT,
        undo_until TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS crm_import_jobs_user ON crm_import_jobs(user_id, created_at);
    `);
  }
};
