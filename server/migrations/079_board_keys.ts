import { addColumn, type Migration } from "./types";
import { suggestBoardCode, uniqueBoardCode } from "../../shared/boardKeys";

/**
 * Board codes and card keys (lane KEYS, docs/plan/TASK_KEYS.md, D710–D716):
 *
 * - `boards.code`: the board's short code ("MYT"), 2–10 of A–Z and 0–9 starting with a letter, stored
 *   upper case and unique without case over every board that still exists, binned ones included (a
 *   restore never collides, D712). Existing boards get one from their name, de-duplicated in creation
 *   order (D711).
 * - `boards.next_card_number` and `cards.number`: each card's number on its board (MYT-12). Existing
 *   cards are numbered in creation order, binned ones included, so a restore keeps its key; a number is
 *   never reused on its board, even after a card is purged or moved away (D713). New cards take the next
 *   number in the insert trigger, so every path that creates a card (and every test fixture) numbers it.
 * - `board_code_aliases`: a board's former codes, so MYT-12 still opens after MYT becomes ROAD (D714).
 * - `card_key_aliases`: a card's numbers on boards it left (D715), so its old key still opens it.
 *
 * Needs 009 and 019. Transactional and filesystem-free; re-running changes nothing.
 */
export const boardKeysMigration: Migration = {
  id: 79,
  name: "board_keys",
  up(db) {
    addColumn(db, "boards", "code", "TEXT CHECK (code IS NULL OR (length(code) BETWEEN 2 AND 10 AND code GLOB '[A-Z]*' AND code NOT GLOB '*[^A-Z0-9]*'))");
    addColumn(db, "boards", "next_card_number", "INTEGER NOT NULL DEFAULT 1 CHECK (next_card_number >= 1)");
    addColumn(db, "cards", "number", "INTEGER CHECK (number IS NULL OR number >= 1)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS board_code_aliases (
        code TEXT PRIMARY KEY COLLATE NOCASE,
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_board_code_aliases_board ON board_code_aliases(board_id);
      CREATE TABLE IF NOT EXISTS card_key_aliases (
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        number INTEGER NOT NULL CHECK (number >= 1),
        card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (board_id, number));
      CREATE INDEX IF NOT EXISTS idx_card_key_aliases_card ON card_key_aliases(card_id);
    `);

    // Codes from names, oldest board first, unique without case (D711).
    const taken = new Set((db.query("SELECT code FROM boards WHERE code IS NOT NULL").all() as Array<{ code: string }>).map((row) => row.code.toUpperCase()));
    const setCode = db.query("UPDATE boards SET code = ? WHERE id = ?");
    for (const board of db.query("SELECT id, name FROM boards WHERE code IS NULL ORDER BY created_at, id").all() as Array<{ id: string; name: string }>) {
      const code = uniqueBoardCode(suggestBoardCode(board.name), (candidate) => taken.has(candidate));
      taken.add(code);
      setCode.run(code, board.id);
    }

    // Numbers in creation order per board, binned cards included (D713).
    db.exec(`
      UPDATE cards SET number = (SELECT x.rn FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY board_id ORDER BY created_at, id) AS rn FROM cards) x WHERE x.id = cards.id)
        WHERE number IS NULL;
      -- Never lowered: a re-run after a card was purged or moved away must not hand its number out again,
      -- nor a number a moved card left behind as an alias (D713, D715).
      UPDATE boards SET next_card_number = MAX(next_card_number,
        COALESCE((SELECT MAX(k.number) FROM cards k WHERE k.board_id = boards.id), 0) + 1,
        COALESCE((SELECT MAX(a.number) FROM card_key_aliases a WHERE a.board_id = boards.id), 0) + 1);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_code ON boards(code COLLATE NOCASE);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_board_number ON cards(board_id, number);

      -- Every new card takes its board's next number (D713). A card moved to another board is given
      -- its new number by the service, in the same transaction (D715).
      CREATE TRIGGER IF NOT EXISTS trg_cards_number AFTER INSERT ON cards WHEN NEW.number IS NULL
      BEGIN
        UPDATE cards SET number = (SELECT next_card_number FROM boards WHERE id = NEW.board_id) WHERE id = NEW.id;
        UPDATE boards SET next_card_number = next_card_number + 1 WHERE id = NEW.board_id;
      END;
    `);
  }
};
