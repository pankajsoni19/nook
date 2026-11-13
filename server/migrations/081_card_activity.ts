import type { Migration } from "./types";

/**
 * Card activity history (lane ACTIVITY, D740–D746): `card_activity`, one row per recorded change to a
 * card (shared/cardActivity.ts lists the kinds), shown interleaved with the card's comments.
 *
 * - `card_id` cascades: purging a card (Bin, board purge) deletes its history with it (D744).
 * - `board_id` is the card's board when the event happened, kept as plain text (no foreign key), so a
 *   card that later moves to another board keeps its history whatever happens to the old board.
 * - `actor_id` is null for Nook itself (the auto-archive sweep) and after the account is deleted;
 *   `actor_label` keeps the name shown then. `via` says where a change came from besides the web app
 *   (mcp, rest, agent, proposal, system).
 * - `kind` is free text (no CHECK list), so a new kind needs no migration (D741); `payload` is a small
 *   JSON object with display snapshots (ids plus labels), at most 4 KiB.
 * - `(card_id, created_at, id)` serves the keyset pages in both orders and the coalescing lookup.
 *
 * Needs 001 and 009. Transactional and filesystem-free; re-running changes nothing.
 */
export const cardActivityMigration: Migration = {
  id: 81,
  name: "card_activity",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS card_activity (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        board_id TEXT NOT NULL,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        actor_label TEXT NOT NULL DEFAULT '' CHECK (length(actor_label) <= 200),
        via TEXT CHECK (via IS NULL OR via IN ('mcp', 'rest', 'agent', 'proposal', 'system')),
        kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
        payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND json_type(payload) = 'object' AND length(payload) <= 4096),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_card_activity_card ON card_activity(card_id, created_at, id);
    `);
  }
};
