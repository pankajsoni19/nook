import type { Migration } from "./types";

/**
 * Standups search (docs/plan/WORKSPACE_MODULES.md §B.12, §D.4): the text of named standup answers in
 * FTS5 (unicode61, diacritics removed, as `collection_row_fts`). One row per response, written by the
 * service on every answer and edit; anonymous answers are never indexed (D934). The search query
 * joins back to the round and the standup and applies the reader's access before LIMIT. A response's
 * row goes with it (trigger), and with its standup through the responses purge.
 */
export const checkinsFtsMigration: Migration = {
  id: 100,
  name: "checkins_fts",
  up(db) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS checkins_fts USING fts5(response_id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
      CREATE TRIGGER IF NOT EXISTS checkins_fts_response_purge AFTER DELETE ON responses WHEN OLD.host_kind = 'checkin'
      BEGIN
        DELETE FROM checkins_fts WHERE response_id = OLD.id;
      END;
    `);
  }
};
