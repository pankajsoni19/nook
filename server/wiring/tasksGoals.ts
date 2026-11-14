import { db } from "../db";
import { logger } from "../log";
import { onCardChange } from "../tasks/cardEvents";
import { refreshAutoKrs, type KrRow } from "../goals/service";
import { readableBoard } from "../tasks/access";

const slog = logger("wiring");

/**
 * Tasks → Goals auto-progress (docs/plan/WORKSPACE_MODULES.md §C C7, D1042): replaces the 5-minute
 * latency of Goals' sweep (D908) with the card-change hook (D1040), debounced. A change on a board marks
 * the key results whose `tasks` source can count that board's cards (scope board, sprint, tag, or epic
 * on it; a `view` or `filter` source, which can span boards, only when its KR's owner can read one of
 * the changed boards, since it counts cards as them); `CARD_GOAL_DEBOUNCE_MS` after the first change
 * they are recomputed in one batch (each source computes as the KR's owner, so access is Goals' own,
 * T540). A burst of moves recomputes once. The board-scoped ones are forced; the spanning ones keep
 * Goals' own debounce (D1059a), so busy boards do not recompute every view and filter KR each time.
 * The sweep stays as the fallback (missed events, a restart, sources other than tasks).
 */
export const CARD_GOAL_DEBOUNCE_MS = 5_000;
const MAX_PER_RUN = 200;

const pendingBoards = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Auto KRs of live goals whose tasks source counts cards of these boards (board, sprint, tag, epic). */
function scopedKrs(boardIds: readonly string[]): KrRow[] {
  return db.query(`SELECT k.* FROM key_results k JOIN goals g ON g.id = k.goal_id
    WHERE k.source_kind = 'tasks' AND g.deleted_at IS NULL AND g.state IN ('draft','active') AND (
      (json_extract(k.source_json, '$.scope') = 'board' AND json_extract(k.source_json, '$.id') IN (SELECT value FROM json_each($boards)))
      OR (json_extract(k.source_json, '$.scope') = 'sprint' AND json_extract(k.source_json, '$.id') IN (SELECT id FROM board_sprints WHERE board_id IN (SELECT value FROM json_each($boards))))
      OR (json_extract(k.source_json, '$.scope') = 'tag' AND json_extract(k.source_json, '$.id') IN (SELECT id FROM board_tags WHERE board_id IN (SELECT value FROM json_each($boards))))
      OR (json_extract(k.source_json, '$.scope') = 'epic' AND json_extract(k.source_json, '$.id') IN (SELECT id FROM cards WHERE board_id IN (SELECT value FROM json_each($boards))))
    ) ORDER BY k.auto_updated_at IS NOT NULL, k.auto_updated_at LIMIT ${MAX_PER_RUN}`).all({ boards: JSON.stringify(boardIds) }) as KrRow[];
}

/** View and filter KRs whose owner can read one of these boards (they count cards as their owner, D1059a). */
function spanningKrs(boardIds: readonly string[]): KrRow[] {
  const rows = db.query(`SELECT k.*, coalesce(k.owner_id, g.owner_id) AS counted_as FROM key_results k JOIN goals g ON g.id = k.goal_id
    WHERE k.source_kind = 'tasks' AND g.deleted_at IS NULL AND g.state IN ('draft','active') AND json_extract(k.source_json, '$.scope') IN ('view','filter')
    ORDER BY k.auto_updated_at IS NOT NULL, k.auto_updated_at`).all() as Array<KrRow & { counted_as: string }>;
  const reach = new Map<string, boolean>();
  const reaches = (userId: string) => {
    if (!reach.has(userId)) reach.set(userId, boardIds.some((boardId) => readableBoard(boardId, userId) !== null));
    return reach.get(userId)!;
  };
  const out: KrRow[] = [];
  for (const { counted_as: countedAs, ...row } of rows) {
    if (out.length >= MAX_PER_RUN) break;
    if (reaches(countedAs)) out.push(row as KrRow);
  }
  return out;
}

/** Auto KRs of live goals whose tasks source may count cards of these boards. */
export function krsForBoards(boardIds: readonly string[]): KrRow[] {
  if (!boardIds.length) return [];
  return [...scopedKrs(boardIds), ...spanningKrs(boardIds)];
}

/** Recomputes the KRs counting what changed on these boards now (the debounce timer, and tests). */
export async function refreshGoalsForBoards(boardIds: readonly string[], nowMs = Date.now()) {
  if (!boardIds.length) return 0;
  const scoped = scopedKrs(boardIds);
  const spanning = spanningKrs(boardIds);
  // Board-scoped KRs are recomputed now; spanning ones keep Goals' debounce (AUTO_DEBOUNCE_MS).
  return (scoped.length ? await refreshAutoKrs(scoped, { force: true, nowMs }) : 0) + (spanning.length ? await refreshAutoKrs(spanning, { nowMs }) : 0);
}

async function flush() {
  timer = null;
  const boards = [...pendingBoards];
  pendingBoards.clear();
  if (!boards.length) return;
  try { await refreshGoalsForBoards(boards); } catch (error) { slog.error("Goal progress from card changes failed", error); }
}

onCardChange((changes) => {
  for (const change of changes) pendingBoards.add(change.boardId);
  if (!timer) {
    timer = setTimeout(() => { void flush(); }, CARD_GOAL_DEBOUNCE_MS);
    (timer as { unref?: () => void }).unref?.();
  }
});

/** Tests: runs the pending recompute now. */
export async function flushGoalRecomputeForTests() {
  if (timer) clearTimeout(timer);
  await flush();
}
