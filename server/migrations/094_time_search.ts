import type { Migration } from "./types";

/**
 * Time search and purge hygiene (lane TIME, docs/plan/WORKSPACE_MODULES.md §D.2, §B.12, §B.13):
 *
 * - `time_entry_fts`: entry descriptions (unicode61, diacritics removed, as `collection_row_fts`),
 *   kept by triggers; the search scope ANDs the entry visibility predicate in the query (T536).
 * - Purge triggers: a purged project takes its member rows, group grants, key grants, work links,
 *   item activity, and schedules with it (its entries stay, as personal entries, through the
 *   `ON DELETE SET NULL` key, T533); a deleted entry takes its work links and schedules (the long
 *   timer alert); a purged card clears the target of the entries that tracked it (they keep their
 *   time, their project, and their description).
 *
 * Needs 093. Transactional and filesystem-free; re-running changes nothing.
 */
export const timeSearchMigration: Migration = {
  id: 94,
  name: "time_search",
  up(db) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS time_entry_fts USING fts5(entry_id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
      INSERT INTO time_entry_fts (entry_id, body)
        SELECT id, description FROM time_entries WHERE description <> '' AND id NOT IN (SELECT entry_id FROM time_entry_fts);

      CREATE TRIGGER IF NOT EXISTS time_entries_fts_insert AFTER INSERT ON time_entries WHEN NEW.description <> ''
      BEGIN
        INSERT INTO time_entry_fts (entry_id, body) VALUES (NEW.id, NEW.description);
      END;
      CREATE TRIGGER IF NOT EXISTS time_entries_fts_update AFTER UPDATE OF description ON time_entries
      BEGIN
        DELETE FROM time_entry_fts WHERE entry_id = OLD.id;
        INSERT INTO time_entry_fts (entry_id, body) SELECT NEW.id, NEW.description WHERE NEW.description <> '';
      END;
      CREATE TRIGGER IF NOT EXISTS time_entries_purge AFTER DELETE ON time_entries
      BEGIN
        DELETE FROM time_entry_fts WHERE entry_id = OLD.id;
        DELETE FROM work_links WHERE (a_kind = 'time_entry' AND a_id = OLD.id) OR (b_kind = 'time_entry' AND b_id = OLD.id);
        DELETE FROM schedules WHERE owner_kind = 'time_entry' AND owner_id = OLD.id;
        DELETE FROM item_activity WHERE item_kind = 'time_entry' AND item_id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS time_projects_purge AFTER DELETE ON time_projects
      BEGIN
        DELETE FROM item_members WHERE item_kind = 'time_project' AND item_id = OLD.id;
        DELETE FROM item_group_grants WHERE item_kind = 'time_project' AND item_id = OLD.id;
        DELETE FROM api_key_grants WHERE resource_kind = 'time_project' AND resource_id = OLD.id;
        DELETE FROM work_links WHERE (a_kind = 'time_project' AND a_id = OLD.id) OR (b_kind = 'time_project' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'time_project' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'time_project' AND item_id = OLD.id;
        DELETE FROM schedules WHERE owner_kind = 'time_project' AND owner_id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS time_cards_purge AFTER DELETE ON cards
      BEGIN
        UPDATE time_entries SET target_kind = NULL, target_id = NULL WHERE target_kind = 'card' AND target_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS time_users_settings_purge AFTER DELETE ON users
      BEGIN
        DELETE FROM schedules WHERE owner_kind = 'time_user' AND owner_id = OLD.id;
      END;
    `);
  }
};
