/**
 * Swimlanes (lane VIEWS2, docs/plan/TASK_VIEWS.md D655–D656, D664–D665). Pure and shared: the board
 * (and a board view) can split its columns into rows by assignee or by parent (an epic, or whatever
 * the level above is called); a cross-board view's lanes can split into rows by assignee or by
 * board. Each person keeps the rows they collapsed (`board_view_prefs`, or `task_view_prefs`).
 *
 * Row keys: `a:<user id>` and `none:a` (assignee rows), `k:<card id>` and `none:k` (parent rows),
 * `b:<board id>` (board rows).
 */

/** `parent` is for one board (its levels), `board` for cross-board views (D665). */
export const SWIMLANE_MODES = ["assignee", "parent", "board"] as const;
export type SwimlaneMode = typeof SWIMLANE_MODES[number];
export const isSwimlaneMode = (value: unknown): value is SwimlaneMode => typeof value === "string" && (SWIMLANE_MODES as readonly string[]).includes(value);

export const MAX_COLLAPSED_ROWS = 40;
export const COLLAPSED_ROWS_BYTES = 1024;
export const NONE_ROW = { assignee: "none:a", parent: "none:k", board: "none:b" } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const assigneeRowKey = (userId: string) => `a:${userId.toLowerCase()}`;
export const parentRowKey = (cardId: string) => `k:${cardId.toLowerCase()}`;
export const boardRowKey = (boardId: string) => `b:${boardId.toLowerCase()}`;

/** Whether a stored collapsed-row key is well formed. */
export function isRowKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === NONE_ROW.assignee || value === NONE_ROW.parent) return true;
  return /^(a|k|b):/.test(value) && UUID.test(value.slice(2));
}

/** Collapsed rows as stored: well formed, unique, at most 40, within 1 KiB of JSON. */
export function normalizeCollapsedRows(values: readonly unknown[]): string[] {
  const kept: string[] = [];
  for (const value of values) {
    if (!isRowKey(value) || kept.includes(value)) continue;
    if (kept.length >= MAX_COLLAPSED_ROWS) break;
    if (JSON.stringify([...kept, value]).length > COLLAPSED_ROWS_BYTES) break;
    kept.push(value);
  }
  return kept;
}

export type SwimCard = {
  id: string; board_id?: string; board_name?: string; parent_card_id?: string | null;
  assignees?: ReadonlyArray<{ id: string; display_name: string }>; column_id: string; position: number;
};
export type SwimParent = { id: string; title: string; column_id: string; position: number };
export type Swimlane = { key: string; label: string; userId?: string; parentId?: string; boardId?: string; cardIds: string[] };

/**
 * The rows for these cards (D655, D665): by assignee, one row per person on any card (a card with
 * two people is in both rows), by name, then "No assignee"; by parent, one row per parent in board
 * order (column order, then position), then "No parent"; by board, one row per board, by name.
 * `columnOrder` is the board's column ids left to right; `parents` resolves a parent id to its card
 * (any level); a parent not loaded reads "Parent".
 */
export function buildSwimlanes(mode: SwimlaneMode, cards: readonly SwimCard[], options: { columnOrder?: readonly string[]; parents?: ReadonlyMap<string, SwimParent>; noneLabel?: string } = {}): Swimlane[] {
  const rows = new Map<string, Swimlane>();
  const parents = options.parents ?? new Map<string, SwimParent>();
  const none: Swimlane = { key: NONE_ROW[mode], label: options.noneLabel ?? (mode === "assignee" ? "No assignee" : "No parent"), cardIds: [] };
  for (const card of cards) {
    if (mode === "assignee") {
      const people = card.assignees ?? [];
      if (!people.length) none.cardIds.push(card.id);
      for (const person of people) {
        const key = assigneeRowKey(person.id);
        const row = rows.get(key) ?? { key, label: person.display_name, userId: person.id.toLowerCase(), cardIds: [] };
        if (!row.cardIds.includes(card.id)) row.cardIds.push(card.id);
        rows.set(key, row);
      }
    } else if (mode === "board") {
      const key = boardRowKey(card.board_id ?? "");
      const row = rows.get(key) ?? { key, label: card.board_name ?? "Board", boardId: card.board_id, cardIds: [] };
      row.cardIds.push(card.id);
      rows.set(key, row);
    } else if (card.parent_card_id) {
      const key = parentRowKey(card.parent_card_id);
      const row = rows.get(key) ?? { key, label: parents.get(card.parent_card_id)?.title ?? "Parent", parentId: card.parent_card_id.toLowerCase(), cardIds: [] };
      row.cardIds.push(card.id);
      rows.set(key, row);
    } else none.cardIds.push(card.id);
  }
  const columnIndex = new Map((options.columnOrder ?? []).map((id, index) => [id, index]));
  const ordered = [...rows.values()].sort((a, b) => {
    if (mode !== "parent") return a.label.localeCompare(b.label) || (a.key < b.key ? -1 : 1);
    const left = parents.get(a.parentId!);
    const right = parents.get(b.parentId!);
    return (columnIndex.get(left?.column_id ?? "") ?? 999) - (columnIndex.get(right?.column_id ?? "") ?? 999) || (left?.position ?? 0) - (right?.position ?? 0) || (a.key < b.key ? -1 : 1);
  });
  return mode === "board" ? ordered : [...ordered, none];
}

/**
 * What a card dragged from row `fromKey` to row `to` changes (D656): assignee rows replace the source
 * row's person with the target's (cards keep their other people; "No assignee" clears them); parent
 * rows set the parent ("No parent" detaches). Board rows cannot change: a card stays on its board
 * (`{ refused: "BOARD" }`, D665). Null when nothing changes.
 */
export function swimlaneChange(mode: SwimlaneMode, fromKey: string, to: Swimlane, card: { assignees?: ReadonlyArray<{ id: string }>; parent_card_id?: string | null }):
  { assigneeIds: string[] } | { parentId: string | null } | { refused: "BOARD" } | null {
  if (fromKey === to.key) return null;
  if (mode === "board") return { refused: "BOARD" };
  if (mode === "parent") {
    const parentId = to.key === NONE_ROW.parent ? null : to.parentId!;
    return (card.parent_card_id ?? null) === parentId ? null : { parentId };
  }
  const current = (card.assignees ?? []).map((person) => person.id.toLowerCase());
  if (to.key === NONE_ROW.assignee) return current.length ? { assigneeIds: [] } : null;
  const from = fromKey.startsWith("a:") ? fromKey.slice(2) : null;
  const next = [...current.filter((id) => id !== from && id !== to.userId), to.userId!];
  return next.length === current.length && next.every((id) => current.includes(id)) ? null : { assigneeIds: next };
}
