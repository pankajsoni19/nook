import { audit, db } from "../db";
import { normalizeCollapsedRows } from "../../shared/swimlanes";
import { listColumns, requireBoardRoom, requireCardAt, requireReadableBoard, withBoardLock, cardDetail } from "./service";

/**
 * Auto-archived cards and each person's view of a board (lane TASKS, migration 074, D602–D609).
 *
 * - The hourly sweep archives live cards that have sat in a done column for the board's
 *   `auto_archive_days` (D604). Archiving only sets `cards.archived_at`: the card stays live, keeps
 *   its column, position, sprint, and relations, and is never deleted (D605).
 * - Restoring (`POST /cards/:k/unarchive`, or moving the card to another column) clears it; in a done
 *   column the done clock starts again, so the next sweep does not take it straight back.
 * - `board_view_prefs` keeps one reader's collapsed columns and whether they show archived cards
 *   (D602, D606), and (migration 078) "Show all levels" and their collapsed swimlanes (D656, D659).
 *   It is view state: it changes nothing for anyone else.
 */

export const AUTO_ARCHIVE_DEFAULT_DAYS = 30;
export const AUTO_ARCHIVE_MAX_DAYS = 365;
/** Cards archived per statement; the sweep loops until a batch comes back short. */
export const AUTO_ARCHIVE_BATCH = 500;

export type BoardViewPrefs = {
  collapsedColumnIds: string[];
  showArchived: boolean;
  /** "Show all levels on the board" (D659): null until the person chooses (the app then carries an older per-device choice over once). */
  showAllLevels: boolean | null;
  /** The swimlanes they collapsed (D656), row keys (`a:<user>`, `k:<card>`, `none:a`, `none:k`). */
  collapsedRows: string[];
};

const NO_PREFS: BoardViewPrefs = { collapsedColumnIds: [], showArchived: false, showAllLevels: null, collapsedRows: [] };

export const parsedList = (text: string) => {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return []; // the CHECK keeps it valid JSON
  }
};

/** The viewer's view of the board; ids of columns deleted since are left out. Call after the read check. */
export function readViewPrefs(boardId: string, userId: string): BoardViewPrefs {
  const row = db.query("SELECT collapsed_columns, show_archived, show_all_levels, collapsed_rows FROM board_view_prefs WHERE board_id = ? AND user_id = ?").get(boardId, userId) as
    { collapsed_columns: string; show_archived: number; show_all_levels: number | null; collapsed_rows: string } | null;
  if (!row) return { ...NO_PREFS };
  return {
    collapsedColumnIds: boardColumnIds(boardId, parsedList(row.collapsed_columns)),
    showArchived: row.show_archived === 1,
    showAllLevels: row.show_all_levels === null ? null : row.show_all_levels === 1,
    collapsedRows: normalizeCollapsedRows(parsedList(row.collapsed_rows))
  };
}

/** The ids that are columns of this board, in board order (canonical JSON). */
export function boardColumnIds(boardId: string, ids: readonly unknown[]) {
  const wanted = new Set(ids.filter((id): id is string => typeof id === "string").map((id) => id.toLowerCase()));
  return listColumns(boardId).filter((column) => wanted.has(column.id)).map((column) => column.id);
}

/**
 * Collapsed swimlanes as stored (D656): well formed and bounded; a parent row stays only while its
 * card is a live card of this board, so no key says whether a card exists elsewhere.
 */
export function boardRowKeys(boardId: string, keys: readonly unknown[]) {
  const rows = normalizeCollapsedRows(keys);
  const cardIds = rows.filter((key) => key.startsWith("k:")).map((key) => key.slice(2));
  const live = cardIds.length ? new Set((db.query("SELECT id FROM cards WHERE board_id = ? AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))")
    .all(boardId, JSON.stringify(cardIds)) as Array<{ id: string }>).map((row) => row.id)) : new Set<string>();
  return rows.filter((key) => !key.startsWith("k:") || live.has(key.slice(2)));
}

/**
 * `PUT /boards/:b/view` (any reader, D602): replaces the fields sent. Collapsed ids that are not
 * columns of this board are dropped (a column deleted meanwhile), so no id says whether a column
 * exists elsewhere. Not audited: it is one person's view, like a sort order.
 */
export function writeViewPrefs(userId: string, boardId: string, input: { collapsedColumnIds?: string[]; showArchived?: boolean; showAllLevels?: boolean; collapsedRows?: string[] }) {
  requireReadableBoard(boardId, userId);
  const current = readViewPrefs(boardId, userId);
  const next: BoardViewPrefs = {
    collapsedColumnIds: input.collapsedColumnIds === undefined ? current.collapsedColumnIds : boardColumnIds(boardId, input.collapsedColumnIds),
    showArchived: input.showArchived ?? current.showArchived,
    showAllLevels: input.showAllLevels ?? current.showAllLevels,
    collapsedRows: input.collapsedRows === undefined ? current.collapsedRows : boardRowKeys(boardId, input.collapsedRows)
  };
  db.query(`INSERT INTO board_view_prefs (board_id, user_id, collapsed_columns, show_archived, show_all_levels, collapsed_rows, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (board_id, user_id) DO UPDATE SET collapsed_columns = excluded.collapsed_columns, show_archived = excluded.show_archived,
      show_all_levels = excluded.show_all_levels, collapsed_rows = excluded.collapsed_rows, updated_at = excluded.updated_at`)
    .run(boardId, userId, JSON.stringify(next.collapsedColumnIds), next.showArchived ? 1 : 0, next.showAllLevels === null ? null : next.showAllLevels ? 1 : 0,
      JSON.stringify(next.collapsedRows), new Date().toISOString());
  return { view: next };
}

/**
 * `POST /cards/:k/archive` (edit, D610): archives a card by hand, in any column. Like the sweep it
 * only sets `archived_at`: the card stays live where it is. Archiving an archived card is a no-op.
 */
export async function archiveCard(userId: string, cardId: string) {
  const { board } = requireCardAt(cardId, userId, "edit");
  return withBoardLock(board.id, () => {
    const { card } = requireCardAt(cardId, userId, "edit");
    if (!card.archived_at) {
      db.transaction(() => {
        const timestamp = new Date().toISOString();
        db.query("UPDATE cards SET archived_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(timestamp, timestamp, cardId);
        db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, board.id);
        audit(userId, null, "task.card_archive", { boardId: board.id, cardId });
      })();
    }
    return { card: cardDetail(cardId)! };
  });
}

/**
 * `POST /cards/:k/unarchive` (edit, D605): puts an archived card back on the board where it is. In a
 * done column its done clock restarts now. A card that is not archived is a no-op (200, unchanged).
 * Archived cards do not count toward the board's card cap (D632), so a board already at the cap
 * refuses it with 409 LIMIT_REACHED and the cap's message.
 */
export async function unarchiveCard(userId: string, cardId: string) {
  const { board } = requireCardAt(cardId, userId, "edit");
  return withBoardLock(board.id, () => {
    const { card } = requireCardAt(cardId, userId, "edit");
    if (card.archived_at) {
      requireBoardRoom(board.id, { active: 1, total: 0 });
      db.transaction(() => {
        const timestamp = new Date().toISOString();
        db.query(`UPDATE cards SET archived_at = NULL, updated_at = $timestamp,
            done_at = CASE WHEN (SELECT state FROM board_columns WHERE id = cards.column_id) = 'done' THEN $timestamp ELSE NULL END
          WHERE id = $cardId AND deleted_at IS NULL`).run({ timestamp, cardId });
        db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(timestamp, board.id);
        audit(userId, null, "task.card_unarchive", { boardId: board.id, cardId });
      })();
    }
    return { card: cardDetail(cardId)! };
  });
}

/**
 * One sweep tick (D604): archives live cards in a done column of a live board with auto-archive on,
 * whose `done_at` is at least the board's days before `nowMs`. Batched by AUTO_ARCHIVE_BATCH; each
 * batch is one transaction that re-checks every condition in its UPDATE, so a card moved out (or
 * restored) between the pick and the write is left alone. Audited per board as the system
 * (`task.cards_auto_archived`, actor null) with the count and the days. Returns the cards archived.
 */
export function sweepAutoArchive(nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const due = `k.deleted_at IS NULL AND k.archived_at IS NULL AND k.done_at IS NOT NULL
    AND b.deleted_at IS NULL AND b.auto_archive_days IS NOT NULL AND c.state = 'done'
    AND k.done_at <= strftime('%Y-%m-%dT%H:%M:%fZ', $now, '-' || b.auto_archive_days || ' days')`;
  const pick = db.query(`SELECT k.id, k.board_id, b.auto_archive_days AS days FROM cards k
    JOIN board_columns c ON c.id = k.column_id JOIN boards b ON b.id = k.board_id
    WHERE ${due} ORDER BY k.done_at, k.id LIMIT $limit`);
  const archive = db.query(`UPDATE cards SET archived_at = $now WHERE id = $id AND EXISTS (
    SELECT 1 FROM cards k JOIN board_columns c ON c.id = k.column_id JOIN boards b ON b.id = k.board_id WHERE k.id = $id AND ${due})`);
  let total = 0;
  for (;;) {
    const rows = pick.all({ now, limit: AUTO_ARCHIVE_BATCH }) as Array<{ id: string; board_id: string; days: number }>;
    if (!rows.length) break;
    const archived = db.transaction(() => {
      const perBoard = new Map<string, { count: number; days: number }>();
      for (const row of rows) {
        if (archive.run({ now, id: row.id }).changes !== 1) continue;
        const entry = perBoard.get(row.board_id) ?? { count: 0, days: row.days };
        entry.count += 1;
        perBoard.set(row.board_id, entry);
      }
      let count = 0;
      for (const [boardId, entry] of perBoard) {
        audit(null, null, "task.cards_auto_archived", { boardId, count: entry.count, days: entry.days });
        count += entry.count;
      }
      return count;
    })();
    total += archived;
    // A short batch, or one where nothing changed (every pick moved meanwhile), ends the tick.
    if (rows.length < AUTO_ARCHIVE_BATCH || archived === 0) break;
  }
  return total;
}
