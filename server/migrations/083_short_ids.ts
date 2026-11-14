import { addColumn, type Migration } from "./types";
import { newShortId, SHORT_ID_ALPHABET } from "../../shared/friendlyUrls";

/** The tables whose rows get a friendly URL by short id (docs/plan/FRIENDLY_URLS.md, D771, D777). */
export const SHORT_ID_TABLES = ["notes", "documents", "collections", "reports"] as const;

/**
 * SQL for a fresh short id: a digit, then nine base36 characters, each from SQLite's random()
 * (D771). Built from `||` terms rather than a subquery, so every row a statement touches gets its own.
 */
export const shortIdSql = (() => {
  const char = (alphabet: string) => `substr('${alphabet}', ((random() & 9223372036854775807) % ${alphabet.length}) + 1, 1)`;
  return [char(SHORT_ID_ALPHABET.slice(0, 10)), ...Array.from({ length: 9 }, () => char(SHORT_ID_ALPHABET))].join(" || ");
})();

/**
 * Friendly URLs (D770–D789): `short_id` on notes, documents (Files and whiteboards), collections, and
 * reports, the authoritative part of /notes/<folder>/<title>-<shortid> and the like.
 *
 * - Existing rows are backfilled from a CSPRNG (shared/friendlyUrls.ts newShortId), binned rows
 *   included, so a Bin restore keeps its links; duplicates are redrawn before writing.
 * - A unique index per table (`idx_<table>_short_id`); NULL is allowed by the column for the window
 *   between the INSERT and its trigger only.
 * - An AFTER INSERT trigger gives every new row one, so every creation path (and every test fixture)
 *   has a short id without code changes. A collision with the unique index fails that insert (one in
 *   ~10^15 per pair; the caller sees the usual 500 and a retry draws a new id).
 *
 * Needs 001, 006, 012, and 050. Transactional and filesystem-free; re-running changes nothing.
 */
export const shortIdsMigration: Migration = {
  id: 83,
  name: "short_ids",
  up(db) {
    for (const table of SHORT_ID_TABLES) {
      // Tests that build an older shape apply every migration but one; a table that is not there yet is skipped.
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
      addColumn(db, table, "short_id", "TEXT CHECK (short_id IS NULL OR (length(short_id) = 10 AND short_id GLOB '[0-9]*' AND short_id NOT GLOB '*[^0-9a-z]*'))");
      const taken = new Set((db.query(`SELECT short_id FROM ${table} WHERE short_id IS NOT NULL`).all() as Array<{ short_id: string }>).map((row) => row.short_id));
      const write = db.query(`UPDATE ${table} SET short_id = ? WHERE id = ?`);
      for (const row of db.query(`SELECT id FROM ${table} WHERE short_id IS NULL ORDER BY created_at, id`).all() as Array<{ id: string }>) {
        let shortId = newShortId();
        while (taken.has(shortId)) shortId = newShortId();
        taken.add(shortId);
        write.run(shortId, row.id);
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_short_id ON ${table}(short_id);
        CREATE TRIGGER IF NOT EXISTS trg_${table}_short_id AFTER INSERT ON ${table} WHEN NEW.short_id IS NULL
        BEGIN
          UPDATE ${table} SET short_id = ${shortIdSql} WHERE id = NEW.id;
        END;
      `);
    }
  }
};
