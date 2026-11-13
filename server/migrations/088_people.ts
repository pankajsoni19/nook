import type { Migration } from "./types";
import { shortIdSql } from "./083_short_ids";

/**
 * People: contact books, companies, contacts, and their channels (docs/plan/WORKSPACE_MODULES.md §B.3,
 * D806, D807). Foundation tables, because Bookings, Forms, and Time write them in Wave 2; the
 * Contacts lane (`crm`) owns the UI and everything around them (deals, interactions, lists).
 *
 * - `contact_books`: the sharing container (owner, visibility, share_role; members and group grants
 *   in `item_members` / `item_group_grants` as kind `contact_book`). `system_kind = 'clients'` is a
 *   person's hidden "Clients" book, created lazily for Time when Contacts is off (D807), one per owner.
 * - `companies`: unique domain per book among live rows; `contacts`: one display name always.
 * - `contact_channels`: emails, phones, URLs, socials; an email is unique per book (normalized).
 * - Every top-level row has a friendly short id (D771; filled by default) and the Bin columns.
 * - Purge triggers clear `work_links`, `item_activity`, `item_comments`, member rows, group grants,
 *   and key grants of a purged book, company, or contact.
 *
 * Needs 001, 025, 083, 085, and 086. Transactional and filesystem-free; re-running changes nothing.
 */
const SHORT_ID = `short_id TEXT NOT NULL DEFAULT (${shortIdSql}) CHECK (length(short_id) = 10 AND short_id GLOB '[0-9]*' AND short_id NOT GLOB '*[^0-9a-z]*')`;
const BIN = `deleted_at TEXT, deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL, purge_after TEXT, purge_started_at TEXT,
        CHECK ((deleted_at IS NULL) = (purge_after IS NULL))`;

export const peopleMigration: Migration = {
  id: 88,
  name: "people",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS contact_books (
        id TEXT PRIMARY KEY,
        ${SHORT_ID},
        owner_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        color TEXT CHECK (color IS NULL OR length(color) <= 24),
        system_kind TEXT CHECK (system_kind IS NULL OR system_kind IN ('clients')),
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','selected','all_users')),
        share_role TEXT NOT NULL DEFAULT 'view' CHECK (share_role IN ('view','comment','edit','manage')),
        settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json) AND length(settings_json) <= 8192),
        fields_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fields_json) AND length(fields_json) <= 65536),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ${BIN}
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS contact_books_short_id ON contact_books(short_id);
      CREATE INDEX IF NOT EXISTS contact_books_owner ON contact_books(owner_id, deleted_at);
      CREATE UNIQUE INDEX IF NOT EXISTS contact_books_one_system ON contact_books(owner_id, system_kind) WHERE system_kind IS NOT NULL;

      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        ${SHORT_ID},
        book_id TEXT NOT NULL REFERENCES contact_books(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
        domain TEXT CHECK (domain IS NULL OR (length(domain) BETWEEN 1 AND 253 AND domain = lower(domain))),
        website TEXT CHECK (website IS NULL OR length(website) <= 2048),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 20000),
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        custom_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(custom_json) AND length(custom_json) <= 16384),
        tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json) AND length(tags_json) <= 2048),
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','booking','form','mcp','email_domain')),
        last_interaction_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ${BIN}
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS companies_short_id ON companies(short_id);
      CREATE UNIQUE INDEX IF NOT EXISTS companies_domain ON companies(book_id, domain) WHERE domain IS NOT NULL AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS companies_book ON companies(book_id, name);

      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        ${SHORT_ID},
        book_id TEXT NOT NULL REFERENCES contact_books(id) ON DELETE CASCADE,
        first_name TEXT CHECK (first_name IS NULL OR length(first_name) <= 80),
        last_name TEXT CHECK (last_name IS NULL OR length(last_name) <= 80),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
        company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
        job_title TEXT CHECK (job_title IS NULL OR length(job_title) <= 120),
        owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        lifecycle TEXT CHECK (lifecycle IS NULL OR length(lifecycle) <= 40),
        tz TEXT CHECK (tz IS NULL OR length(tz) <= 64),
        location TEXT CHECK (location IS NULL OR length(location) <= 200),
        avatar_document_id TEXT CHECK (avatar_document_id IS NULL OR length(avatar_document_id) <= 64),
        custom_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(custom_json) AND length(custom_json) <= 16384),
        tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json) AND length(tags_json) <= 2048),
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','booking','form','mcp','email_domain')),
        source_ref TEXT CHECK (source_ref IS NULL OR length(source_ref) <= 80),
        -- Fields a person edited by hand (D806): upserts never overwrite these.
        edited_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(edited_json) AND length(edited_json) <= 1024),
        last_interaction_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ${BIN}
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS contacts_short_id ON contacts(short_id);
      CREATE INDEX IF NOT EXISTS contacts_book ON contacts(book_id, display_name);
      CREATE INDEX IF NOT EXISTS contacts_company ON contacts(company_id) WHERE company_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS contact_channels (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES contact_books(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('email','phone','url','social')),
        value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 254),
        value_norm TEXT NOT NULL CHECK (length(value_norm) BETWEEN 1 AND 254),
        label TEXT CHECK (label IS NULL OR length(label) <= 40),
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS contact_channels_email ON contact_channels(book_id, value_norm) WHERE kind = 'email';
      CREATE INDEX IF NOT EXISTS contact_channels_contact ON contact_channels(contact_id, position);
      CREATE INDEX IF NOT EXISTS contact_channels_value ON contact_channels(value_norm);

      CREATE TRIGGER IF NOT EXISTS contact_books_purge AFTER DELETE ON contact_books
      BEGIN
        DELETE FROM item_members WHERE item_kind = 'contact_book' AND item_id = OLD.id;
        DELETE FROM item_group_grants WHERE item_kind = 'contact_book' AND item_id = OLD.id;
        DELETE FROM api_key_grants WHERE resource_kind = 'contact_book' AND resource_id = OLD.id;
        DELETE FROM item_activity WHERE item_kind = 'contact_book' AND item_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS companies_purge AFTER DELETE ON companies
      BEGIN
        DELETE FROM work_links WHERE (a_kind = 'company' AND a_id = OLD.id) OR (b_kind = 'company' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'company' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'company' AND item_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS contacts_purge AFTER DELETE ON contacts
      BEGIN
        DELETE FROM work_links WHERE (a_kind = 'contact' AND a_id = OLD.id) OR (b_kind = 'contact' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'contact' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'contact' AND item_id = OLD.id;
      END;
    `);
  }
};
