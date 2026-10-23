/**
 * Lanes for cross-board results (lane VIEWS, docs/plan/TASK_VIEWS.md D640–D644; grouped lanes, lane
 * VIEWS2, D650–D652). Pure and shared: the server builds the lane list for `POST /api/tasks/query
 * { lanes }`, and the client puts each loaded card in its lane and resolves a drop on the card's own
 * board with the same rules.
 *
 * - `columns` lanes merge the columns of every board with matches by (folded name, state): one name
 *   in two states is two lanes, labelled "Review · Done". They are ordered by state, then the median
 *   of each column's relative position on its board, then the name. Over `MAX_COLUMN_LANES` the
 *   results fall back to `state` lanes.
 * - `state` lanes are To do, In progress, Done; a drop goes to the first column of that state on the
 *   card's board.
 * - Grouped lanes (D650): `assignee` (one lane per person, a card with two people is in both), `tag`
 *   (tags merged by folded name across boards), `sprint` (sprints merged by folded name), each with a
 *   "none" lane; a drop changes that field (`resolveGroupDrop`). `due` (overdue, today, this week,
 *   later, none) and `board` are read only. Over `MAX_GROUP_LANES` they fall back to state lanes.
 */
import { foldText, TASK_STATES, type TaskState } from "./taskQuery";

export const LANE_MODES = ["columns", "state", "assignee", "tag", "sprint", "due", "board"] as const;
export type LaneMode = typeof LANE_MODES[number];
/** Lanes that group by a field rather than a column (D650). */
export const GROUP_LANE_MODES = ["assignee", "tag", "sprint", "due", "board"] as const;
export type GroupLaneMode = typeof GROUP_LANE_MODES[number];
/** Grouped lanes a drop cannot change: a due date is not a lane's to set, and a card stays on its board (D650). */
export const READ_ONLY_LANE_MODES: readonly LaneMode[] = ["due", "board"];
export const isLaneMode = (value: unknown): value is LaneMode => typeof value === "string" && (LANE_MODES as readonly string[]).includes(value);
export const isGroupLaneMode = (mode: LaneMode): mode is GroupLaneMode => (GROUP_LANE_MODES as readonly string[]).includes(mode);
export const MAX_COLUMN_LANES = 20;
/** Grouped lanes past this many (the "none" lane included) fall back to state lanes, as merged columns do (D650). */
export const MAX_GROUP_LANES = 20;
/** Collapsed lanes kept per person and view (task_view_prefs, D644). */
export const MAX_COLLAPSED_LANES = 40;
export const COLLAPSED_LANES_BYTES = 1024;

export const LANE_STATE_LABELS: Record<TaskState, string> = { todo: "To do", doing: "In progress", done: "Done" };

/** One board column as lanes see it. */
export type LaneColumn = { id: string; board_id: string; name: string; state: TaskState; position: number; wip_limit?: number | null; card_count?: number };

export type SprintState = "planned" | "active" | "closed";
/** A tag or sprint of one board behind a grouped lane (D650): where a drop on that board goes. */
export type LaneTarget = { id: string; board_id: string; name: string; color?: string; state?: SprintState };

export type QueryLane = {
  /**
   * `s:<state>`, `c:<state>:<folded name>`, `a:<user id>`, `t:<folded tag>`, `p:<folded sprint>`,
   * `d:<bucket>`, `b:<board id>`, or `none:a|t|p`; stable across reloads, so collapse can keep it.
   */
  key: string;
  label: string;
  /** Column and state lanes only. */
  state?: TaskState;
  /** The columns in this lane, at most one per board for `columns` lanes, in board then position order; [] for grouped lanes. */
  columns: LaneColumn[];
  /** Tag and sprint lanes: each board's tag or sprint of that name (one per board). */
  targets?: LaneTarget[];
  /** An assignee lane's person. */
  userId?: string;
  /** A tag lane's colour (the most common one). */
  color?: string;
  /** A sprint lane's most advanced state across its boards (active, then planned, then closed). */
  sprintState?: SprintState;
};

/** A board with matches, as grouped lanes and Add a card need it (D651, D654); `level` is the viewer's, added by the web route. */
export type LaneBoard = { id: string; name: string; work_level: number; sprints: boolean; level?: string };

export type LaneLayout = { mode: LaneMode; fallback: boolean; lanes: QueryLane[] };

/** The longest name a lane key holds: sprint names (80) are the longest of columns (60), tags (40), and sprints. */
const LANE_NAME_MAX = 80;

export const stateLaneKey = (state: TaskState) => `s:${state}`;
export const columnLaneKey = (name: string, state: TaskState) => `c:${state}:${foldText(name.trim())}`;
export const assigneeLaneKey = (userId: string) => `a:${userId.toLowerCase()}`;
export const tagLaneKey = (name: string) => `t:${foldText(name.trim())}`;
export const sprintLaneKey = (name: string) => `p:${foldText(name.trim())}`;
export const boardLaneKey = (boardId: string) => `b:${boardId.toLowerCase()}`;
export const DUE_BUCKETS = ["overdue", "today", "week", "later", "none"] as const;
export type DueBucket = typeof DUE_BUCKETS[number];
export const DUE_BUCKET_LABELS: Record<DueBucket, string> = { overdue: "Overdue", today: "Today", week: "This week", later: "Later", none: "No due date" };
export const dueLaneKey = (bucket: DueBucket) => `d:${bucket}`;
/** The "no assignee", "no tag", and "backlog" lanes (D650). */
export const NONE_LANE = { assignee: "none:a", tag: "none:t", sprint: "none:p" } as const;
export const NONE_LANE_LABELS = { assignee: "No assignee", tag: "No tag", sprint: "Backlog" } as const;
/** What each mode's lanes are called in a fallback notice and the lane picker. */
export const LANE_MODE_NOUNS: Record<LaneMode, string> = { columns: "columns", state: "states", assignee: "people", tag: "tags", sprint: "sprints", due: "due dates", board: "boards" };

/** The lane a card with this column belongs to (column and state lanes). */
export function laneKeyOf(mode: LaneMode, column: { name: string; state: TaskState }) {
  return mode === "state" ? stateLaneKey(column.state) : columnLaneKey(column.name, column.state);
}

/** The mode a lane key belongs to, from its prefix. */
export function laneModeOfKey(key: string): LaneMode | null {
  if (key.startsWith("s:")) return "state";
  if (key.startsWith("c:")) return "columns";
  if (key.startsWith("a:") || key === NONE_LANE.assignee) return "assignee";
  if (key.startsWith("t:") || key === NONE_LANE.tag) return "tag";
  if (key.startsWith("p:") || key === NONE_LANE.sprint) return "sprint";
  if (key.startsWith("d:")) return "due";
  if (key.startsWith("b:")) return "board";
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const namePart = (value: string) => value.trim().length > 0 && !/[\u0000-\u001F\u007F-\u009F]/.test(value);

/** Whether a stored collapsed-lane key is well formed (D644, D650). */
export function isLaneKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4 + 5 + LANE_NAME_MAX * 4) return false;
  if (/^s:(todo|doing|done)$/.test(value) || /^none:(a|t|p)$/.test(value) || /^d:(overdue|today|week|later|none)$/.test(value)) return true;
  if (/^(a|b):/.test(value)) return UUID.test(value.slice(2));
  const named = /^(t|p):(.+)$/.exec(value);
  if (named) return namePart(named[2]!);
  const match = /^c:(todo|doing|done):(.+)$/.exec(value);
  return match !== null && namePart(match[2]!);
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
  if (mode !== "columns") return { mode: "state", fallback: mode !== "state", lanes: stateLanesOf(ordered) };

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

/** The state lanes for these columns (also the fallback of every other mode). */
export function stateLanesOf(ordered: readonly LaneColumn[]): QueryLane[] {
  const sorted = [...ordered].sort((a, b) => (a.board_id < b.board_id ? -1 : a.board_id > b.board_id ? 1 : 0) || a.position - b.position || (a.id < b.id ? -1 : 1));
  return TASK_STATES.map((state) => ({ key: stateLaneKey(state), label: LANE_STATE_LABELS[state], state, columns: sorted.filter((column) => column.state === state) }));
}

export type DropRefusal = "NO_COLUMN" | "COLUMN_FULL" | "READ_ONLY" | "SAME_LANE" | "NO_TAG" | "NO_SPRINT" | "SPRINT_CLOSED" | "SPRINT_LEVEL" | "SPRINTS_OFF" | "LOCKED";

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

// ---------------------------------------------------------------------------
// Grouped lanes (lane VIEWS2, D650–D652).

/** A loaded card as lanes read it (cross-board results). */
export type LaneCard = {
  id: string; board_id: string; column_id: string; column_name: string; column_state: TaskState;
  assignees: ReadonlyArray<{ id: string }>; tags: ReadonlyArray<{ id: string; name: string }>;
  sprint_id?: string | null; sprint_name?: string | null; due_on: string | null; level?: number;
};

/** The due bucket of a date, as the server groups it (overdue, today, the next 6 days, later, none). */
export function dueBucketOf(dueOn: string | null, today: string, weekEnd: string): DueBucket {
  if (!dueOn) return "none";
  if (dueOn < today) return "overdue";
  if (dueOn === today) return "today";
  return dueOn <= weekEnd ? "week" : "later";
}

/**
 * Every lane a card is in (D650): one for columns, state, sprint, due, and board; one per person or
 * tag (or the "none" lane) for assignee and tag lanes. `dates` is the viewer's today and today + 6.
 */
export function cardLaneKeys(mode: LaneMode, card: LaneCard, dates: { today: string; weekEnd: string } = { today: "", weekEnd: "" }): string[] {
  switch (mode) {
    case "columns":
    case "state": return [laneKeyOf(mode, { name: card.column_name, state: card.column_state })];
    case "assignee": return card.assignees.length ? [...new Set(card.assignees.map((person) => assigneeLaneKey(person.id)))] : [NONE_LANE.assignee];
    case "tag": return card.tags.length ? [...new Set(card.tags.map((tag) => tagLaneKey(tag.name)))] : [NONE_LANE.tag];
    case "sprint": return [card.sprint_id && card.sprint_name ? sprintLaneKey(card.sprint_name) : NONE_LANE.sprint];
    case "due": return [dueLaneKey(dueBucketOf(card.due_on, dates.today, dates.weekEnd))];
    case "board": return [boardLaneKey(card.board_id)];
  }
}

/**
 * Assignee lanes (D650): one per person with matches, by name, then "No assignee" last (always
 * there, so a drop can clear the people).
 */
export function buildAssigneeLanes(people: ReadonlyArray<{ id: string; display_name: string }>): LaneLayout {
  if (people.length + 1 > MAX_GROUP_LANES) return { mode: "assignee", fallback: true, lanes: [] };
  const lanes: QueryLane[] = [...people]
    .sort((a, b) => a.display_name.localeCompare(b.display_name) || (a.id < b.id ? -1 : 1))
    .map((person) => ({ key: assigneeLaneKey(person.id), label: person.display_name, columns: [], userId: person.id.toLowerCase() }));
  lanes.push({ key: NONE_LANE.assignee, label: NONE_LANE_LABELS.assignee, columns: [] });
  return { mode: "assignee", fallback: false, lanes };
}

/**
 * Tag lanes (D650): the tags with matches, merged by folded name across boards, by name, then "No
 * tag" last. `tags` lists every tag of the boards with matches, with its count over the match, so a
 * lane knows each board's tag of that name (for a drop); a lane exists only for a name with matches.
 */
export function buildTagLanes(tags: ReadonlyArray<{ id: string; board_id: string; name: string; color: string; count: number }>): LaneLayout {
  const groups = new Map<string, { names: string[]; colors: string[]; count: number; targets: LaneTarget[] }>();
  for (const tag of [...tags].sort((a, b) => (a.board_id < b.board_id ? -1 : a.board_id > b.board_id ? 1 : 0) || (a.id < b.id ? -1 : 1))) {
    const key = tagLaneKey(tag.name);
    const group = groups.get(key) ?? { names: [], colors: [], count: 0, targets: [] };
    group.names.push(tag.name.trim());
    group.colors.push(tag.color);
    group.count += tag.count;
    if (!group.targets.some((item) => item.board_id === tag.board_id)) group.targets.push({ id: tag.id, board_id: tag.board_id, name: tag.name, color: tag.color });
    groups.set(key, group);
  }
  const used = [...groups.entries()].filter(([, group]) => group.count > 0);
  if (used.length + 1 > MAX_GROUP_LANES) return { mode: "tag", fallback: true, lanes: [] };
  const lanes: QueryLane[] = used
    .map(([key, group]) => ({ key, label: displayName(group.names), columns: [], targets: group.targets, color: displayName(group.colors) }))
    .sort((a, b) => a.label.localeCompare(b.label) || (a.key < b.key ? -1 : 1));
  lanes.push({ key: NONE_LANE.tag, label: NONE_LANE_LABELS.tag, columns: [] });
  return { mode: "tag", fallback: false, lanes };
}

const SPRINT_ORDER: Record<SprintState, number> = { active: 0, planned: 1, closed: 2 };

/**
 * Sprint lanes (D650): "Backlog" first, then sprints merged by folded name across boards: every open
 * (active or planned) sprint of the boards with matches, so cards can be planned into an empty one,
 * and completed sprints that still have matches. Ordered active, planned (by the board's order),
 * then completed.
 */
export function buildSprintLanes(sprints: ReadonlyArray<{ id: string; board_id: string; name: string; state: SprintState; position: number; count: number }>): LaneLayout {
  const groups = new Map<string, { names: string[]; state: SprintState; rank: number; targets: LaneTarget[] }>();
  for (const sprint of [...sprints].sort((a, b) => SPRINT_ORDER[a.state] - SPRINT_ORDER[b.state] || a.position - b.position || (a.id < b.id ? -1 : 1))) {
    if (sprint.state === "closed" && sprint.count === 0) continue;
    const key = sprintLaneKey(sprint.name);
    const group = groups.get(key) ?? { names: [], state: sprint.state, rank: sprint.position, targets: [] };
    group.names.push(sprint.name.trim());
    if (SPRINT_ORDER[sprint.state] < SPRINT_ORDER[group.state]) group.state = sprint.state;
    group.rank = Math.min(group.rank, sprint.position);
    // One sprint per board in a lane: the most advanced one of that name (active, then planned).
    if (!group.targets.some((item) => item.board_id === sprint.board_id)) group.targets.push({ id: sprint.id, board_id: sprint.board_id, name: sprint.name, state: sprint.state });
    groups.set(key, group);
  }
  if (groups.size + 1 > MAX_GROUP_LANES) return { mode: "sprint", fallback: true, lanes: [] };
  const lanes: QueryLane[] = [...groups.entries()]
    .sort(([keyA, a], [keyB, b]) => SPRINT_ORDER[a.state] - SPRINT_ORDER[b.state] || a.rank - b.rank || (keyA < keyB ? -1 : 1))
    .map(([key, group]) => ({ key, label: displayName(group.names), columns: [], targets: group.targets, sprintState: group.state }));
  return { mode: "sprint", fallback: false, lanes: [{ key: NONE_LANE.sprint, label: NONE_LANE_LABELS.sprint, columns: [] }, ...lanes] };
}

/** Due lanes (D650): always the five buckets, read only. */
export function buildDueLanes(): LaneLayout {
  return { mode: "due", fallback: false, lanes: DUE_BUCKETS.map((bucket) => ({ key: dueLaneKey(bucket), label: DUE_BUCKET_LABELS[bucket], columns: [] })) };
}

/** Board lanes (D650): one per board with matches, by name, read only. */
export function buildBoardLanes(boards: ReadonlyArray<{ id: string; name: string }>): LaneLayout {
  if (boards.length > MAX_GROUP_LANES) return { mode: "board", fallback: true, lanes: [] };
  const lanes = [...boards].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)).map((board) => ({ key: boardLaneKey(board.id), label: board.name, columns: [] }));
  return { mode: "board", fallback: false, lanes };
}

/** What a drop on a grouped lane changes on the card (D651): its people, its tags, or its sprint. */
export type GroupChange =
  | { field: "assignees"; assigneeIds: string[] }
  | { field: "tags"; tagIds: string[] }
  | { field: "sprint"; sprintId: string | null };

/**
 * Where a card dragged from lane `fromKey` and dropped on grouped `lane` goes (D651). Cards can have
 * several people and tags, so the source lane's person (or tag) is **replaced** by the target's; a
 * card with no one gets the target; a drop on "No assignee" ("No tag") clears them all, so the card
 * lands where it was dropped. A sprint lane plans the card in its own board's sprint of that name;
 * "Backlog" takes it out of its sprint. Refused: the viewer cannot edit the card's board, the board
 * has no such tag or open sprint, the sprint is completed, sprints are off on the board, the card is
 * not at its board's work level (subtasks follow their parent), or the lanes are due dates or boards.
 */
export function resolveGroupDrop(mode: GroupLaneMode, lane: QueryLane, card: LaneCard, canEdit: boolean, options: { fromKey?: string | null; board?: LaneBoard | null } = {}): GroupChange | { refusal: DropRefusal } {
  if (options.fromKey === lane.key) return { refusal: "SAME_LANE" };
  if (mode === "due" || mode === "board") return { refusal: "LOCKED" };
  if (!canEdit) return { refusal: "READ_ONLY" };
  if (mode === "assignee") {
    const current = card.assignees.map((person) => person.id.toLowerCase());
    if (lane.key === NONE_LANE.assignee) return current.length ? { field: "assignees", assigneeIds: [] } : { refusal: "SAME_LANE" };
    const target = lane.userId ?? lane.key.slice(2);
    const from = options.fromKey?.startsWith("a:") ? options.fromKey.slice(2) : null;
    const next = [...current.filter((id) => id !== from && id !== target), target];
    return sameSet(next, current) ? { refusal: "SAME_LANE" } : { field: "assignees", assigneeIds: next };
  }
  if (mode === "tag") {
    const current = card.tags.map((tag) => tag.id);
    if (lane.key === NONE_LANE.tag) return current.length ? { field: "tags", tagIds: [] } : { refusal: "SAME_LANE" };
    const target = lane.targets?.find((item) => item.board_id === card.board_id);
    if (!target) return { refusal: "NO_TAG" };
    const from = options.fromKey?.startsWith("t:") ? options.fromKey : null;
    const next = [...card.tags.filter((tag) => tag.id !== target.id && (from === null || tagLaneKey(tag.name) !== from)).map((tag) => tag.id), target.id];
    return sameSet(next, current) ? { refusal: "SAME_LANE" } : { field: "tags", tagIds: next };
  }
  const board = options.board;
  if (board && !board.sprints) return { refusal: "SPRINTS_OFF" };
  if (board && card.level !== undefined && card.level !== board.work_level) return { refusal: "SPRINT_LEVEL" };
  if (lane.key === NONE_LANE.sprint) return card.sprint_id ? { field: "sprint", sprintId: null } : { refusal: "SAME_LANE" };
  const target = lane.targets?.find((item) => item.board_id === card.board_id);
  if (!target) return { refusal: "NO_SPRINT" };
  if (target.state === "closed") return { refusal: "SPRINT_CLOSED" };
  return target.id === card.sprint_id ? { refusal: "SAME_LANE" } : { field: "sprint", sprintId: target.id };
}

const sameSet = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value) => right.includes(value));
