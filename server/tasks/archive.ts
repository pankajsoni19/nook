import { audit, db } from "../db";
import { listColumns, requireCardAt, requireReadableBoard, withBoardLock, cardDetail } from "./service";

/**
 * Auto-archived cards and each person's view of a board (lane TASKS, migration 074, D602–D609).
 *
 * - The hourly sweep archives live cards that have sat in a done column for the board's
 *   `auto_archive_days` (D604). Archiving only sets `cards.archived_at`: the card stays live, keeps
 *   its column, position, sprint, and relations, and is never deleted (D605).
 * - Restoring (`POST /cards/:k/unarchive`, or moving the card to another column) clears it; in a done
 *   column the done clock starts again, so the next sweep does not take it straight back.
 * - `board_view_prefs` keeps one reader's collapsed columns and whether they show archived cards
 *   (D602, D606). It is view state: it changes nothing for anyone else.
 */

export const AUTO_ARCHIVE_DEFAULT_DAYS = 30;
export const AUTO_ARCHIVE_MAX_DAYS = 365;
/** Cards archived per statement; the sweep loops until a batch comes back short. */
export const AUTO_ARCHIVE_BATCH = 500;

export type BoardViewPrefs = { collapsedColumnIds: string[]; showArchived: boolean };

const NO_PREFS: BoardViewPrefs = { collapsedColumnIds: [], showArchived: false };

/** The viewer's view of the board; ids of columns deleted since are left out. Call after the read check. */
export function readViewPrefs(boardId: string, userId: string): BoardViewPrefs {
  const row = db.query("SELECT collapsed_columns, show_archived FROM board_view_prefs WHERE board_id = ? AND user_id = ?").get(boardId, userId) as { collapsed_columns: string; show_archived: number } | null;
  if (!row) return { ...NO_PREFS };
  let stored: unknown = [];
  try { stored = JSON.parse(row.collapsed_columns); } catch { /* the CHECK keeps it valid JSON */ }
  const columns = new Set(listColumns(boardId).map((column) => column.id));
  const collapsedColumnIds = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string" && columns.has(id)) : [];
  return { collapsedColumnIds, showArchived: row.show_archived === 1 };
}

/**
 * `PUT /boards/:b/view` (any reader, D602): replaces the fields sent. Collapsed ids that are not
 * columns of this board are dropped (a column deleted meanwhile), so no id says whether a column
 * exists elsewhere. Not audited: it is one person's view, like a sort order.
 */
export function writeViewPrefs(userId: string, boardId: string, input: { collapsedColumnIds?: string[]; showArchived?: boolean }) {
  requireReadableBoard(boardId, userId);
  const current = readViewPrefs(boardId, userId);
  const columns = listColumns(boardId);
  const wanted = input.collapsedColumnIds === undefined ? null : new Set(input.collapsedColumnIds.map((id) => id.toLowerCase()));
  // Board order, so the stored JSON is canonical.
  const collapsedColumnIds = wanted ? columns.filter((column) => wanted.has(column.id)).map((column) => column.id) : current.collapsedColumnIds;
  const showArchived = input.showArchived ?? current.showArchived;
  db.query(`INSERT INTO board_view_prefs (board_id, user_id, collapsed_columns, show_archived, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (board_id, user_id) DO UPDATE SET collapsed_columns = excluded.collapsed_columns, show_archived = excluded.show_archived, updated_at = excluded.updated_at`)
    .run(boardId, userId, JSON.stringify(collapsedColumnIds), showArchived ? 1 : 0, new Date().toISOString());
  return { view: { collapsedColumnIds, showArchived } satisfies BoardViewPrefs };
}

/**
 * `POST /cards/:k/unarchive` (edit, D605): puts an archived card back on the board where it is. In a
 * done column its done clock restarts now. A card that is not archived is a no-op (200, unchanged).
 */
export async function unarchiveCard(userId: string, cardId: string) {
  const { board } = requireCardAt(cardId, userId, "edit");
  return withBoardLock(board.id, () => {
    const { card } = requireCardAt(cardId, userId, "edit");
    if (card.archived_at) {
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
