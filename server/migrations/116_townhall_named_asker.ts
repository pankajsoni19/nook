import type { Migration } from "./types";

/**
 * Townhall: a named question no longer carries the person's session asker hash (D1101, T620). That
 * hash was the one their anonymous questions in the same session carry, and a named row stores the
 * author id, so the two together named the anonymous asker. New named questions store a hash salted
 * with the question id (server/townhall/service.ts); existing named rows get a random value, since the
 * public participant behind a hash cannot be recomputed. Members keep "mine" on their named questions
 * (it follows `author_id`); a public participant loses withdraw on a named question asked before this
 * migration. Anonymous rows are unchanged. Transactional (it runs once).
 */
export const townhallNamedAskerMigration: Migration = {
  id: 116,
  name: "townhall_named_asker",
  up(db) {
    db.exec("UPDATE townhall_questions SET asker_hash = lower(hex(randomblob(32))) WHERE anonymous = 0");
  }
};
