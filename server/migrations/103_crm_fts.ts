import type { Migration } from "./types";

/**
 * Contacts search (docs/plan/WORKSPACE_MODULES.md §B.12, §D.5): one FTS5 index over contacts (name,
 * job title, company, emails, phones), companies (name, domain, description), deals (title), and
 * interactions (title, body), kept by triggers so writes from any module (Bookings' and Forms' upserts
 * included) are indexed. `crm_search` maps each item to the FTS rowid; queries join the live tables and
 * the reader's books, so access is never decided by the index (T560).
 *
 * Needs 088 and 102. Backfills existing rows. Re-running changes nothing.
 */
const contactRow = (id: string) => `INSERT INTO crm_search (kind, item_id, book_id, title, body)
  SELECT 'contact', c.id, c.book_id, c.display_name,
    trim(COALESCE(c.job_title, '') || ' ' || COALESCE((SELECT co.name FROM companies co WHERE co.id = c.company_id), '') || ' ' ||
      COALESCE((SELECT group_concat(ch.value, ' ') FROM contact_channels ch WHERE ch.contact_id = c.id), ''))
  FROM contacts c WHERE c.id = ${id}`;

export const crmFtsMigration: Migration = {
  id: 103,
  name: "crm_fts",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crm_search (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('contact','company','deal','interaction')),
        item_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        UNIQUE (kind, item_id)
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS crm_fts USING fts5(title, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
      CREATE TRIGGER IF NOT EXISTS crm_search_ai AFTER INSERT ON crm_search BEGIN INSERT INTO crm_fts (rowid, title, body) VALUES (new.id, new.title, new.body); END;
      CREATE TRIGGER IF NOT EXISTS crm_search_ad AFTER DELETE ON crm_search BEGIN DELETE FROM crm_fts WHERE rowid = old.id; END;

      CREATE TRIGGER IF NOT EXISTS crm_contacts_fts_ai AFTER INSERT ON contacts BEGIN ${contactRow("new.id")}; END;
      CREATE TRIGGER IF NOT EXISTS crm_contacts_fts_au AFTER UPDATE OF display_name, job_title, company_id ON contacts BEGIN
        DELETE FROM crm_search WHERE kind = 'contact' AND item_id = new.id; ${contactRow("new.id")}; END;
      CREATE TRIGGER IF NOT EXISTS crm_contacts_fts_ad AFTER DELETE ON contacts BEGIN DELETE FROM crm_search WHERE kind = 'contact' AND item_id = old.id; END;
      CREATE TRIGGER IF NOT EXISTS crm_channels_fts_ai AFTER INSERT ON contact_channels BEGIN
        DELETE FROM crm_search WHERE kind = 'contact' AND item_id = new.contact_id; ${contactRow("new.contact_id")}; END;
      CREATE TRIGGER IF NOT EXISTS crm_channels_fts_au AFTER UPDATE ON contact_channels BEGIN
        DELETE FROM crm_search WHERE kind = 'contact' AND item_id = new.contact_id; ${contactRow("new.contact_id")}; END;
      CREATE TRIGGER IF NOT EXISTS crm_channels_fts_ad AFTER DELETE ON contact_channels BEGIN
        DELETE FROM crm_search WHERE kind = 'contact' AND item_id = old.contact_id; ${contactRow("old.contact_id")}; END;

      CREATE TRIGGER IF NOT EXISTS crm_companies_fts_ai AFTER INSERT ON companies BEGIN
        INSERT INTO crm_search (kind, item_id, book_id, title, body) VALUES ('company', new.id, new.book_id, new.name, trim(COALESCE(new.domain, '') || ' ' || substr(new.description, 1, 2000))); END;
      CREATE TRIGGER IF NOT EXISTS crm_companies_fts_au AFTER UPDATE OF name, domain, description ON companies BEGIN
        DELETE FROM crm_search WHERE kind = 'company' AND item_id = new.id;
        INSERT INTO crm_search (kind, item_id, book_id, title, body) VALUES ('company', new.id, new.book_id, new.name, trim(COALESCE(new.domain, '') || ' ' || substr(new.description, 1, 2000))); END;
      CREATE TRIGGER IF NOT EXISTS crm_companies_fts_ad AFTER DELETE ON companies BEGIN DELETE FROM crm_search WHERE kind = 'company' AND item_id = old.id; END;

      CREATE TRIGGER IF NOT EXISTS crm_deals_fts_ai AFTER INSERT ON deals BEGIN
        INSERT INTO crm_search (kind, item_id, book_id, title, body) VALUES ('deal', new.id, new.book_id, new.title, COALESCE(new.next_step, '')); END;
      CREATE TRIGGER IF NOT EXISTS crm_deals_fts_au AFTER UPDATE OF title, next_step ON deals BEGIN
        DELETE FROM crm_search WHERE kind = 'deal' AND item_id = new.id;
        INSERT INTO crm_search (kind, item_id, book_id, title, body) VALUES ('deal', new.id, new.book_id, new.title, COALESCE(new.next_step, '')); END;
      CREATE TRIGGER IF NOT EXISTS crm_deals_fts_ad AFTER DELETE ON deals BEGIN DELETE FROM crm_search WHERE kind = 'deal' AND item_id = old.id; END;

      CREATE TRIGGER IF NOT EXISTS crm_interactions_fts_ai AFTER INSERT ON interactions BEGIN
        INSERT INTO crm_search (kind, item_id, book_id, title, body) VALUES ('interaction', new.id, new.book_id, new.title, substr(new.body_md, 1, 20000)); END;
      CREATE TRIGGER IF NOT EXISTS crm_interactions_fts_au AFTER UPDATE OF title, body_md ON interactions BEGIN
        DELETE FROM crm_search WHERE kind = 'interaction' AND item_id = new.id;
        INSERT INTO crm_search (kind, item_id, book_id, title, body) VALUES ('interaction', new.id, new.book_id, new.title, substr(new.body_md, 1, 20000)); END;
      CREATE TRIGGER IF NOT EXISTS crm_interactions_fts_ad AFTER DELETE ON interactions BEGIN DELETE FROM crm_search WHERE kind = 'interaction' AND item_id = old.id; END;
    `);
    // Backfill what 088 rows exist already (bookings or forms may have written contacts before Contacts shipped).
    db.exec(`
      INSERT OR IGNORE INTO crm_search (kind, item_id, book_id, title, body)
        SELECT 'contact', c.id, c.book_id, c.display_name,
          trim(COALESCE(c.job_title, '') || ' ' || COALESCE((SELECT co.name FROM companies co WHERE co.id = c.company_id), '') || ' ' ||
            COALESCE((SELECT group_concat(ch.value, ' ') FROM contact_channels ch WHERE ch.contact_id = c.id), ''))
        FROM contacts c;
      INSERT OR IGNORE INTO crm_search (kind, item_id, book_id, title, body)
        SELECT 'company', id, book_id, name, trim(COALESCE(domain, '') || ' ' || substr(description, 1, 2000)) FROM companies;
    `);
  }
};
