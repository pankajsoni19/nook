import type { Migration } from "./types";

/**
 * Goals search and purge (lane GOALS, §D.3, §B.12, §B.13): `goals_fts` over goal titles, descriptions,
 * and key result titles (one row per goal, rowid-free: `goal_id` UNINDEXED, kept by the service), and
 * purge triggers so a purged goal or key result leaves no `work_links`, `item_activity`,
 * `item_comments`, member rows, group grants, key grants, schedules, or search rows behind.
 *
 * Needs 085, 086, 089, 096. Transactional; re-running changes nothing.
 */
export const goalsSearchMigration: Migration = {
  id: 97,
  name: "goals_search",
  up(db) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS goals_fts USING fts5(goal_id UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');

      CREATE TRIGGER IF NOT EXISTS goals_purge AFTER DELETE ON goals
      BEGIN
        DELETE FROM work_links WHERE (a_kind = 'goal' AND a_id = OLD.id) OR (b_kind = 'goal' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'goal' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'goal' AND item_id = OLD.id;
        DELETE FROM item_members WHERE item_kind = 'goal' AND item_id = OLD.id;
        DELETE FROM item_group_grants WHERE item_kind = 'goal' AND item_id = OLD.id;
        DELETE FROM api_key_grants WHERE resource_kind = 'goal' AND resource_id = OLD.id;
        DELETE FROM schedules WHERE owner_kind = 'goal' AND owner_id = OLD.id;
        DELETE FROM goals_fts WHERE goal_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS key_results_purge AFTER DELETE ON key_results
      BEGIN
        DELETE FROM work_links WHERE (a_kind = 'key_result' AND a_id = OLD.id) OR (b_kind = 'key_result' AND b_id = OLD.id);
        DELETE FROM item_activity WHERE item_kind = 'key_result' AND item_id = OLD.id;
        DELETE FROM item_comments WHERE item_kind = 'key_result' AND item_id = OLD.id;
      END;
    `);
  }
};
