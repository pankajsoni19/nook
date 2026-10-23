/**
 * Lanes for cross-board results (lane VIEWS, docs/plan/TASK_VIEWS.md D640–D644). Pure and shared:
 * the server builds the lane list for `POST /api/tasks/query { lanes }`, and the client puts each
 * loaded card in its lane and resolves a drop on the card's own board with the same rules.
 *
 * - `columns` lanes merge the columns of every board with matches by (folded name, state): one name
 *   in two states is two lanes, labelled "Review · Done". They are ordered by state, then the median
 *   of each column's relative position on its board, then the name. Over `MAX_COLUMN_LANES` the
 *   results fall back to `state` lanes.
 * - `state` lanes are To do, In progress, Done; a drop goes to the first column of that state on the
 *   card's board.
 */
import { foldText, TASK_STATES, type TaskState } from "./taskQuery";

export const LANE_MODES = ["columns", "state"] as const;
export type LaneMode = typeof LANE_MODES[number];
export const MAX_COLUMN_LANES = 20;
/** Collapsed lanes kept per person and view (task_view_prefs, D644). */
export const MAX_COLLAPSED_LANES = 40;
export const COLLAPSED_LANES_BYTES = 1024;

export const LANE_STATE_LABELS: Record<TaskState, string> = { todo: "To do", doing: "In progress", done: "Done" };

/** One board column as lanes see it. */
export type LaneColumn = { id: string; board_id: string; name: string; state: TaskState; position: number; wip_limit?: number | null; card_count?: number };

export type QueryLane = {
  /** `s:<state>` or `c:<state>:<folded name>`; stable across reloads, so collapse can keep it. */
  key: string;
  label: string;
  state: TaskState;
  /** The columns in this lane, at most one per board for `columns` lanes, in board then position order. */
  columns: LaneColumn[];
};

export type LaneLayout = { mode: LaneMode; fallback: boolean; lanes: QueryLane[] };

const COLUMN_NAME_MAX = 60;

export const stateLaneKey = (state: TaskState) => `s:${state}`;
export const columnLaneKey = (name: string, state: TaskState) => `c:${state}:${foldText(name.trim())}`;

/** The lane a card with this column belongs to. */
export function laneKeyOf(mode: LaneMode, column: { name: string; state: TaskState }) {
  return mode === "state" ? stateLaneKey(column.state) : columnLaneKey(column.name, column.state);
}

/** Whether a stored collapsed-lane key is well formed (D644). */
export function isLaneKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4 + 5 + COLUMN_NAME_MAX * 4) return false;
  if (/^s:(todo|doing|done)$/.test(value)) return true;
  const match = /^c:(todo|doing|done):(.+)$/.exec(value);
  return match !== null && match[2]!.trim().length > 0 && !/[\u0000-\u001F\u007F-\u009F]/.test(match[2]!);
}

/** A list of collapsed lanes as stored: well formed, unique, at most 40, and within 1 KiB of JSON. */
export function normalizeCollapsedLanes(values: readonly unknown[]): string[] {
  const kept: string[] = [];
  for (const value of values) {
    if (!isLaneKey(value) || kept.includes(value)) continue;
    if (kept.length >= MAX_COLLAPSED_LANES) break;
    if (JSON.stringify([...kept, value]).length > COLLAPSED_LANES_BYTES) break;
    kept.push(value);
  }
  return kept;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * The lanes for the columns of the boards with matches (D640, D642). `columns` lists every column of
 * those boards (any order); with more than `MAX_COLUMN_LANES` merged lanes the layout falls back to
 * state lanes (`fallback: true`).
 */
export function buildLanes(mode: LaneMode, columns: readonly LaneColumn[]): LaneLayout {
  const byBoard = new Map<string, LaneColumn[]>();
  for (const column of columns) byBoard.set(column.board_id, [...(byBoard.get(column.board_id) ?? []), column]);
  const relative = new Map<string, number>();
  for (const list of byBoard.values()) {
    const ordered = [...list].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
    ordered.forEach((column, index) => relative.set(column.id, ordered.length > 1 ? index / (ordered.length - 1) : 0));
  }
  const ordered = [...columns].sort((a, b) => (a.board_id < b.board_id ? -1 : a.board_id > b.board_id ? 1 : 0) || a.position - b.position || (a.id < b.id ? -1 : 1));
  if (mode === "state") return { mode, fallback: false, lanes: stateLanesOf(ordered) };

  const groups = new Map<string, { key: string; state: TaskState; names: string[]; columns: LaneColumn[] }>();
  for (const column of ordered) {
    const key = columnLaneKey(column.name, column.state);
    const group = groups.get(key) ?? { key, state: column.state, names: [], columns: [] };
    group.names.push(column.name.trim());
    // One column per board in a lane: the first by position (a board may repeat a name).
    if (!group.columns.some((item) => item.board_id === column.board_id)) group.columns.push(column);
    groups.set(key, group);
  }
  if (groups.size > MAX_COLUMN_LANES) return { mode: "state", fallback: true, lanes: stateLanesOf(ordered) };
  const statesPerName = new Map<string, Set<TaskState>>();
  for (const group of groups.values()) {
    const name = group.key.slice(group.key.indexOf(":", 2) + 1);
    statesPerName.set(name, new Set([...(statesPerName.get(name) ?? []), group.state]));
  }
  const lanes = [...groups.values()].map((group) => {
    const folded = group.key.slice(group.key.indexOf(":", 2) + 1);
    const label = displayName(group.names);
    return {
      lane: { key: group.key, label: statesPerName.get(folded)!.size > 1 ? `${label} · ${LANE_STATE_LABELS[group.state]}` : label, state: group.state, columns: group.columns },
      rank: median(group.columns.map((column) => relative.get(column.id) ?? 0)),
      folded
    };
  });
  lanes.sort((a, b) => TASK_STATES.indexOf(a.lane.state) - TASK_STATES.indexOf(b.lane.state) || a.rank - b.rank || a.folded.localeCompare(b.folded));
  return { mode, fallback: false, lanes: lanes.map((item) => item.lane) };
}

/** The most common spelling of a merged name, then the first in board order. */
function displayName(names: readonly string[]) {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  let best = names[0] ?? "";
  for (const [name, count] of counts) if (count > (counts.get(best) ?? 0)) best = name;
  return best;
}

function stateLanesOf(ordered: readonly LaneColumn[]): QueryLane[] {
  return TASK_STATES.map((state) => ({ key: stateLaneKey(state), label: LANE_STATE_LABELS[state], state, columns: ordered.filter((column) => column.state === state) }));
}

export type DropRefusal = "NO_COLUMN" | "COLUMN_FULL" | "READ_ONLY" | "SAME_LANE";

/**
 * Where a card dropped on `lane` goes on its own board (D641, D642): the lane's column on that
 * board, or a refusal. `canEdit` is the viewer's level on the card's board.
 */
export function resolveLaneDrop(lane: QueryLane, card: { board_id: string; column_id: string; column_name: string; column_state: TaskState }, canEdit: boolean): { columnId: string } | { refusal: DropRefusal } {
  if (laneKeyOf(lane.key.startsWith("s:") ? "state" : "columns", { name: card.column_name, state: card.column_state }) === lane.key) return { refusal: "SAME_LANE" };
  if (!canEdit) return { refusal: "READ_ONLY" };
  const target = lane.columns.find((column) => column.board_id === card.board_id);
  if (!target) return { refusal: "NO_COLUMN" };
  if (target.wip_limit !== null && target.wip_limit !== undefined && (target.card_count ?? 0) >= target.wip_limit) return { refusal: "COLUMN_FULL" };
  return { columnId: target.id };
}
