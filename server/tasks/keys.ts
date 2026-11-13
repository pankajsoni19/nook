import { db } from "../db";
import { readableCard } from "./access";
import { cardKey, normalizeBoardCode, parseCardKey, suggestBoardCode, uniqueBoardCode } from "../../shared/boardKeys";

/**
 * Board codes and card keys (lane KEYS, docs/plan/TASK_KEYS.md, D710–D716). Lookups here check no
 * access: callers resolve a key to a card id and then read the card as the caller, so a key whose
 * card the caller cannot read answers exactly like one that does not exist (T460).
 */

/** The board a code names now, or named before it changed (D714); binned boards included. */
export function boardIdForCode(code: string): string | null {
  const current = db.query("SELECT id FROM boards WHERE code = ? COLLATE NOCASE").get(code) as { id: string } | null;
  if (current) return current.id;
  const former = db.query("SELECT board_id FROM board_code_aliases WHERE code = ? COLLATE NOCASE").get(code) as { board_id: string } | null;
  return former?.board_id ?? null;
}

/**
 * The card a key names (any case), wherever the card is now, live or binned, or null: the card with
 * that number on the board the code names (now or formerly), else the card that had that number there
 * before it moved to another board (D715). Never checks access.
 */
export function cardIdForKey(key: string): string | null {
  const parsed = parseCardKey(key);
  if (!parsed) return null;
  const boardId = boardIdForCode(parsed.code);
  if (!boardId) return null;
  const card = db.query("SELECT id FROM cards WHERE board_id = ? AND number = ?").get(boardId, parsed.number) as { id: string } | null;
  if (card) return card.id;
  const moved = db.query("SELECT card_id FROM card_key_aliases WHERE board_id = ? AND number = ?").get(boardId, parsed.number) as { card_id: string } | null;
  return moved?.card_id ?? null;
}

/** A card's current key ("MYT-12"), or null for an unknown card. */
export function keyOfCard(cardId: string): string | null {
  const row = db.query("SELECT b.code, k.number FROM cards k JOIN boards b ON b.id = k.board_id WHERE k.id = ?").get(cardId) as { code: string | null; number: number | null } | null;
  return row ? cardKey(row.code, row.number) : null;
}

/**
 * Whether `code` is unavailable to `boardId` (D712): another board, live or in the Bin, has it now or
 * had it before (its former codes keep old links working, D714). A board may take back its own former code.
 */
export function boardCodeTaken(code: string, boardId: string | null = null): boolean {
  const current = db.query("SELECT id FROM boards WHERE code = ? COLLATE NOCASE").get(code) as { id: string } | null;
  if (current && current.id !== boardId) return true;
  const former = db.query("SELECT board_id FROM board_code_aliases WHERE code = ? COLLATE NOCASE").get(code) as { board_id: string } | null;
  return Boolean(former && former.board_id !== boardId);
}

/** A free code for a board name (D711): the name's suggestion, then MYT2, MYT3, … */
export function freeBoardCode(name: string, boardId: string | null = null): string {
  return uniqueBoardCode(suggestBoardCode(name), (code) => boardCodeTaken(code, boardId));
}

/**
 * Writes a board's new code and keeps the old one as an alias (D714); taking back a former code
 * drops that alias. The caller holds the board lock, runs this inside its transaction, and has
 * checked `normalizeBoardCode` and `boardCodeTaken`.
 */
export function writeBoardCode(boardId: string, code: string, timestamp: string) {
  const current = (db.query("SELECT code FROM boards WHERE id = ?").get(boardId) as { code: string | null } | null)?.code ?? null;
  if (current === code) return false;
  db.query("DELETE FROM board_code_aliases WHERE code = ? COLLATE NOCASE AND board_id = ?").run(code, boardId);
  if (current && current.toUpperCase() !== code.toUpperCase()) {
    db.query("INSERT OR IGNORE INTO board_code_aliases (code, board_id, created_at) VALUES (?, ?, ?)").run(current, boardId, timestamp);
  }
  db.query("UPDATE boards SET code = ?, updated_at = ? WHERE id = ?").run(code, timestamp, boardId);
  return true;
}

/** Takes the board's next card number (D713); the caller holds the board lock and a transaction. */
export function takeCardNumber(boardId: string): number {
  const row = db.query("UPDATE boards SET next_card_number = next_card_number + 1 WHERE id = ? RETURNING next_card_number - 1 AS number").get(boardId) as { number: number } | null;
  if (!row) throw new Error("Board not found while numbering a card");
  return row.number;
}

export { normalizeBoardCode };

/**
 * `GET /api/tasks/keys/:key` (D713, T460): the card a key names if the caller can read it now, with
 * its current key (`moved` when the key asked for is an old one: a former code, or a board the card
 * left). Null for a malformed, unknown, binned, or unreadable card alike.
 */
export function readableCardForKey(userId: string, key: string) {
  const cardId = cardIdForKey(key);
  const found = cardId ? readableCard(cardId, userId) : null;
  if (!found) return null;
  const current = keyOfCard(found.card.id);
  return { cardId: found.card.id, boardId: found.board.id, key: current, moved: current !== null && current !== key.trim().toUpperCase() };
}
