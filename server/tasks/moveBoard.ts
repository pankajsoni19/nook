import { audit, db, now } from "../db";
import { parentRequired } from "../../shared/boardStructure";
import { boardStructure, liveChildCount } from "./hierarchy";
import { planInsert } from "./boardOrder";
import { tagIdsForCard, replaceCardTags } from "./tags";
import { keyOfCard, takeCardNumber } from "./keys";
import { activityValue, recordCardActivity, recordCardChange } from "./activity";
import {
  applyRenumber, cardDetail, liveCardsIn, listColumns, requireBoardAt, requireBoardColumn, requireBoardRoom, requireCardAt, requireColumnRoom, TaskError, withBoardLock
} from "./service";

export type MoveToBoardInput = { boardId: string; columnId?: string | null };

/**
 * Both boards' locks, always taken in id order, so two moves in opposite directions never wait on
 * each other (D716, T462).
 */
export function withBoardLocks<T>(boardIds: [string, string], operation: () => T | Promise<T>) {
  const [first, second] = [...boardIds].sort();
  return withBoardLock(first!, () => withBoardLock(second!, operation));
}

/** The column a move lands in by default: the destination's first column that is not done, else its first. */
export function defaultMoveColumn(boardId: string) {
  const columns = listColumns(boardId);
  return columns.find((column) => column.state !== "done") ?? columns[0] ?? null;
}

/**
 * Moves a card to another board (lane KEYS, D716): Can edit on both boards (404 for a board or card
 * the caller cannot read, 403 READ_ONLY below edit), at the bottom of `columnId` (default: the
 * destination's first column that is not done; 409 COLUMN_FULL at its WIP limit). What goes with it:
 *
 * - Comments, reactions, attachments, relations, assignees, flags, and the due date go with the card.
 *   Assignees who cannot open the destination stay and show as Former member (T93), as anywhere else.
 * - Tags are matched by name (without case) to the destination's tags; tags it has no tag of that
 *   name for are dropped and listed in `droppedTags`.
 * - The sprint is cleared (the backlog). The parent link is dropped (parents are on the same board,
 *   D133); the level is kept when the destination has it at or above its work level, else the card
 *   takes the destination's work level.
 * - A card with live sub-cards is refused (409 HAS_CHILDREN): sub-cards are never moved or orphaned
 *   behind the person's back. Sub-cards in the Bin are detached and restore detached (D130).
 * - The card gets the destination's next number; its old key keeps opening it (card_key_aliases, D715).
 *   The revision goes up by one, so an open copy elsewhere reloads.
 * - Its history (card_activity, keyed by card) goes with it: a `board_move` entry names both boards
 *   and keys, then one `tag_removed` entry per tag dropped. Earlier
 *   entries keep the old board's id in `board_id`; reads go by card only.
 */
export async function moveCardToBoard(userId: string, cardId: string, input: MoveToBoardInput) {
  const source = requireCardAt(cardId, userId, "edit").board;
  const targetId = input.boardId.toLowerCase();
  requireBoardAt(targetId, userId, "edit");
  if (targetId === source.id) throw new TaskError(400, "The card is already on this board; use Move to… for its column", "SAME_BOARD");
  return withBoardLocks([source.id, targetId], () => {
    const { board } = requireCardAt(cardId, userId, "edit");
    // It moved while this call waited for the locks: the locks held are not its board's.
    if (board.id !== source.id) throw new TaskError(409, "This card was moved meanwhile. Reload and try again.", "CARD_CHANGED", { card: cardDetail(cardId)! });
    const target = requireBoardAt(targetId, userId, "edit");
    const children = liveChildCount(cardId);
    if (children > 0) {
      throw new TaskError(409, `Move its ${children === 1 ? "sub-card" : `${children} sub-cards`} off it or to the Bin first; sub-cards stay on their board`, "HAS_CHILDREN", { childCount: children });
    }
    const column = input.columnId ? requireBoardColumn(target.id, input.columnId.toLowerCase()) : defaultMoveColumn(target.id);
    if (!column) throw new TaskError(409, "That board has no column", "NO_SUCH_COLUMN");
    requireColumnRoom(column);
    // It arrives as a live, unarchived card (an archived one comes back into view, D605).
    requireBoardRoom(target.id, { active: 1, total: 1 });
    const plan = planInsert(liveCardsIn(column.id), undefined)!;
    const structure = boardStructure(target.id);
    const current = db.query("SELECT level, number, parent_card_id FROM cards WHERE id = ?").get(cardId) as { level: number; number: number | null; parent_card_id: string | null };
    const level = current.level < structure.levels.length && !parentRequired(structure, current.level) ? current.level : structure.workLevel;
    // Tags by name (D716): the destination's tag of the same name, without case; the rest are dropped.
    const tagRows = db.query(`SELECT t.id, t.name, (SELECT d.id FROM board_tags d WHERE d.board_id = ? AND d.name = t.name COLLATE NOCASE) AS target_id
      FROM board_tags t WHERE t.id IN (SELECT value FROM json_each(?))`).all(target.id, JSON.stringify(tagIdsForCard(cardId))) as Array<{ id: string; name: string; target_id: string | null }>;
    const byId = new Map(tagRows.map((row) => [row.id, row]));
    const ordered = tagIdsForCard(cardId).map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const mappedTags = [...new Set(ordered.flatMap((row) => row.target_id ? [row.target_id] : []))];
    const droppedTags = ordered.filter((row) => !row.target_id).map((row) => row.name);
    const previousKey = keyOfCard(cardId);
    const detachedParent = current.parent_card_id !== null;
    db.transaction(() => {
      const timestamp = now();
      applyRenumber("cards", plan.renumbered);
      // Sub-cards in the Bin come back detached (D130); the trigger keeps a card with children on its board.
      db.query("UPDATE cards SET parent_card_id = NULL WHERE parent_card_id = ? AND deleted_at IS NOT NULL").run(cardId);
      if (current.number !== null) {
        db.query("INSERT OR REPLACE INTO card_key_aliases (board_id, number, card_id, created_at) VALUES (?, ?, ?, ?)").run(source.id, current.number, cardId, timestamp);
      }
      const number = takeCardNumber(target.id);
      db.query(`UPDATE cards SET board_id = $boardId, column_id = $columnId, position = $position, number = $number,
          parent_card_id = NULL, level = $level, sprint_id = NULL, archived_at = NULL,
          done_at = CASE WHEN $toDone THEN $timestamp ELSE NULL END,
          revision = revision + 1, updated_at = $timestamp
        WHERE id = $cardId AND deleted_at IS NULL`).run({
        boardId: target.id, columnId: column.id, position: plan.position, number, level, toDone: column.state === "done" ? 1 : 0, timestamp, cardId
      });
      // Its tags were the source board's; replace them with the destination's of the same names.
      db.query("DELETE FROM card_tags WHERE card_id = ?").run(cardId);
      replaceCardTags(cardId, mappedTags, timestamp);
      db.query("UPDATE boards SET updated_at = ? WHERE id IN (?, ?)").run(timestamp, source.id, target.id);
      // Card history (lane ACTIVITY), in the same transaction: the move, then each tag it lost (the parent and sprint it left stay implied, so no old-board name reaches readers of the new board).
      recordCardChange(cardId, target.id, userId, "board_move", activityValue.board(source.id, previousKey), activityValue.board(target.id, keyOfCard(cardId)), timestamp);
      for (const row of ordered) if (!row.target_id) recordCardActivity({ cardId, boardId: target.id, actorId: userId, kind: "tag_removed", payload: { item: { id: row.id, label: row.name } }, at: timestamp });
      audit(userId, null, "task.card_move_board", {
        cardId, fromBoardId: source.id, boardId: target.id, columnId: column.id, previousKey, key: keyOfCard(cardId),
        ...(droppedTags.length ? { tagsDropped: droppedTags.length } : {}),
        ...(detachedParent ? { parentDetached: true } : {})
      });
    })();
    return { card: cardDetail(cardId)!, fromBoardId: source.id, previousKey, droppedTags, ...(detachedParent ? { parentDetached: true } : {}) };
  });
}
