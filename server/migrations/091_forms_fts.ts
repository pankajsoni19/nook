import type { Migration } from "./types";

/**
 * Search over forms (docs/plan/WORKSPACE_MODULES.md §B.12, §D.1, T519): titles, descriptions, and
 * question titles (never answers). The forms service keeps one row per form (`indexForm`); a purged
 * form's row goes with it (trigger). unicode61 with diacritics removed, as collection_row_fts.
 */
export const formsFtsMigration: Migration = {
  id: 91,
  name: "forms_fts",
  up(db) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS forms_fts USING fts5(form_id UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
      CREATE TRIGGER IF NOT EXISTS forms_fts_purge AFTER DELETE ON forms
      BEGIN
        DELETE FROM forms_fts WHERE form_id = OLD.id;
      END;
      INSERT INTO forms_fts (form_id, title, body) SELECT f.id, f.title, f.description_md FROM forms f WHERE NOT EXISTS (SELECT 1 FROM forms_fts x WHERE x.form_id = f.id);
    `);
  }
};
