import type { Migration } from "./types";

/**
 * Contacts purge triggers (docs/plan/WORKSPACE_MODULES.md §B.13, §D.5): a purged deal takes its
 * `work_links`, item activity, comments, schedules, follow-ups, list memberships, and interaction
 * subjects with it; a purged contact or company its follow-ups, list memberships, and interaction
 * subjects (088's triggers already clear their links, activity, and comments); an interaction its
 * activity; a list its members (cascade). An interaction left with no subject stays (it belongs to its book).
 *
 * Needs 086, 088, 089, and 102.
 */
export const crmPurgeMigration: Migration = {
  id: 104,
  name: "crm_purge",
  up(db) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS deals_purge AFTER DELETE ON deals
      BEGIN
        DELETE FROM work_links WHERE (a_kind = 'deal' AND a_id = OLD.id) OR (b_kind = 'deal' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'deal' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'deal' AND item_id = OLD.id;
        DELETE FROM schedules WHERE owner_kind = 'deal' AND owner_id = OLD.id;
        DELETE FROM crm_followups WHERE subject_kind = 'deal' AND subject_id = OLD.id;
        DELETE FROM crm_list_members WHERE item_id = OLD.id;
        DELETE FROM interaction_subjects WHERE subject_kind = 'deal' AND subject_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS contacts_crm_purge AFTER DELETE ON contacts
      BEGIN
        DELETE FROM crm_followups WHERE subject_kind = 'contact' AND subject_id = OLD.id;
        DELETE FROM crm_list_members WHERE item_id = OLD.id;
        DELETE FROM interaction_subjects WHERE subject_kind = 'contact' AND subject_id = OLD.id;
        DELETE FROM schedules WHERE owner_kind = 'contact' AND owner_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS companies_crm_purge AFTER DELETE ON companies
      BEGIN
        DELETE FROM crm_followups WHERE subject_kind = 'company' AND subject_id = OLD.id;
        DELETE FROM crm_list_members WHERE item_id = OLD.id;
        DELETE FROM interaction_subjects WHERE subject_kind = 'company' AND subject_id = OLD.id;
        DELETE FROM schedules WHERE owner_kind = 'company' AND owner_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS crm_followups_purge AFTER DELETE ON crm_followups
      BEGIN
        DELETE FROM schedules WHERE owner_kind = 'crm_followup' AND owner_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS contact_books_crm_purge AFTER DELETE ON contact_books
      BEGIN
        DELETE FROM schedules WHERE owner_kind = 'contact_book' AND owner_id = OLD.id;
        DELETE FROM work_links WHERE (a_kind = 'contact_book' AND a_id = OLD.id) OR (b_kind = 'contact_book' AND b_id = OLD.id);
      END;
    `);
  }
};
