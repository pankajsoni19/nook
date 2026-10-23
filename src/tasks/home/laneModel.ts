// Multi-board lanes on the client (lane VIEWS, docs/plan/TASK_VIEWS.md D640–D646). Pure: which lane
// each loaded card is in, where a drop goes and why it is refused, and the optimistic state after a
// move (the card, the lane counts, and the columns' live counts for WIP).
import { laneKeyOf, LANE_STATE_LABELS, resolveLaneDrop, type DropRefusal, type LaneColumn, type QueryLane } from "../../../shared/taskLanes";
import { columnFullMessage } from "../taskActions";
import type { BoardTag, CardSummary } from "../tasksApi";
import type { QueriedCard, QueryLanes, StatefulColumn } from "./homeApi";
import { columnStatuses, type ColumnStatus } from "../ColumnStatusIcon";

/** The lane a loaded card is in. */
export const cardLaneKey = (layout: Pick<QueryLanes, "lanes">, card: Pick<QueriedCard, "column_name" | "column_state">) =>
  laneKeyOf(layout.lanes, { name: card.column_name, state: card.column_state });

/** The loaded cards per lane, in the query's order. A card whose lane is not listed (a column added since) goes nowhere. */
export function cardsByLane(layout: QueryLanes, cards: readonly QueriedCard[]) {
  const lanes = new Map<string, QueriedCard[]>(layout.columns.map((lane) => [lane.key, []]));
  for (const card of cards) lanes.get(cardLaneKey(layout, card))?.push(card);
  return lanes;
}

export type LaneDrop = { columnId: string; column: LaneColumn } | { refusal: DropRefusal; message: string };

/** Where a card dropped on `lane` goes on its own board (D641, D642), or why it cannot, in words. */
export function laneDrop(lane: QueryLane, card: QueriedCard, canEdit: boolean): LaneDrop {
  const resolved = resolveLaneDrop(lane, card, canEdit);
  if ("columnId" in resolved) return { columnId: resolved.columnId, column: lane.columns.find((column) => column.id === resolved.columnId)! };
  return { refusal: resolved.refusal, message: refusalMessage(resolved.refusal, lane, card) };
}

const laneName = (lane: QueryLane) => lane.key.startsWith("s:") ? LANE_STATE_LABELS[lane.state] : lane.label.replace(/ · .*$/, "");

export function refusalMessage(refusal: DropRefusal, lane: QueryLane, card: Pick<QueriedCard, "board_id" | "board_name">) {
  switch (refusal) {
    case "NO_COLUMN": return lane.key.startsWith("s:")
      ? `${card.board_name} has no ${LANE_STATE_LABELS[lane.state].toLowerCase()} column`
      : `${card.board_name} has no ${laneName(lane)} column${lane.label.includes(" · ") ? ` that is ${LANE_STATE_LABELS[lane.state].toLowerCase()}` : ""}`;
    case "COLUMN_FULL": {
      const column = lane.columns.find((item) => item.board_id === card.board_id);
      return columnFullMessage(column?.name ?? laneName(lane), column?.wip_limit);
    }
    case "READ_ONLY": return `You can't move cards on ${card.board_name}`;
    case "SAME_LANE": return `Already in ${lane.label}`;
  }
}

/**
 * The state after moving `cardId` to `column` (optimistic, D641): the card takes the column's name
 * and state (and leaves any archive, as the server does), the lane counts move by one, and so do
 * the two columns' live counts that WIP checks read.
 */
export function withLaneMove<T extends { cards: QueriedCard[]; lanes?: QueryLanes }>(state: T, cardId: string, column: LaneColumn): T {
  const card = state.cards.find((item) => item.id === cardId);
  if (!card || !state.lanes) return state;
  const layout = state.lanes;
  const fromKey = cardLaneKey(layout, card);
  const moved: QueriedCard = { ...card, column_id: column.id, column_name: column.name, column_state: column.state, is_done: column.state === "done" ? 1 : 0, archived_at: null };
  const toKey = cardLaneKey(layout, moved);
  const laneCounts = { ...layout.laneCounts };
  if (fromKey !== toKey) {
    laneCounts[fromKey] = Math.max(0, (laneCounts[fromKey] ?? 1) - 1);
    laneCounts[toKey] = (laneCounts[toKey] ?? 0) + 1;
  }
  const columns = layout.columns.map((lane) => ({
    ...lane,
    columns: lane.columns.map((item) => item.id === column.id ? { ...item, card_count: (item.card_count ?? 0) + 1 }
      : item.id === card.column_id && !card.archived_at ? { ...item, card_count: Math.max(0, (item.card_count ?? 1) - 1) } : item)
  }));
  return { ...state, cards: state.cards.map((item) => item.id === cardId ? moved : item), lanes: { ...layout, laneCounts, columns } };
}

/** The lane card's face reads a board card; a cross-board card has its tags inline. */
export function faceOf(card: QueriedCard): { card: CardSummary; tags: BoardTag[] } {
  return {
    card: {
      id: card.id, board_id: card.board_id, column_id: card.column_id, position: card.position, title: card.title,
      has_description: card.description_excerpt ? 1 : 0, revision: card.revision, created_by: card.created_by, creator_name: card.creator_name,
      due_on: card.due_on, due_time: card.due_time, due_tz: card.due_tz, due_at: card.due_at, assignees: card.assignees,
      description_excerpt: card.description_excerpt, tag_ids: card.tags.map((tag) => tag.id), flags: card.flags as CardSummary["flags"],
      comment_count: 0, attachment_count: 0, archived_at: card.archived_at ?? null
    } as CardSummary,
    tags: card.tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })) as unknown as BoardTag[]
  };
}

/** The next lane left or right of `fromIndex` that takes the card, or null (Alt+←/→, D641). */
export function nextOpenLane(lanes: readonly QueryLane[], fromIndex: number, direction: -1 | 1, card: QueriedCard, canEdit: boolean) {
  for (let index = fromIndex + direction; index >= 0 && index < lanes.length; index += direction) {
    const drop = laneDrop(lanes[index]!, card, canEdit);
    if ("columnId" in drop) return { index, drop };
  }
  return null;
}

/** Each lane's status icon, as a board's columns get theirs (COLICON, D629): from its state and place. */
export function laneStatuses(lanes: readonly QueryLane[]): ColumnStatus[] {
  const statuses = columnStatuses(lanes.map((lane) => ({ id: lane.key, state: lane.state, is_done: lane.state === "done" ? 1 : 0 }) as unknown as StatefulColumn));
  return lanes.map((lane) => statuses.get(lane.key)!);
}
