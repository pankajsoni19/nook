// Card hierarchy on a loaded board (research 2026-09-26 D121–D128, §7): which cards the columns show,
// roll-ups, parents, children, and the checklist moves. Pure, so it can be unit tested. The board
// payload carries every live card at every level, so all of this is derived from it.
import { canHaveChildren, FLAT_STRUCTURE, HIERARCHY_LIMITS, levelName, type BoardStructure } from "../../shared/boardStructure";
import { byPosition } from "./boardOrder";
import type { BoardColumn, BoardSummary, CardSummary } from "./tasksApi";

export type Rollup = { done: number; total: number };
type HierarchyCard = Pick<CardSummary, "id" | "title" | "column_id" | "position"> & { parent_card_id?: string | null; level?: number };

export const structureOf = (board: Pick<BoardSummary, "structure"> | null | undefined): BoardStructure => board?.structure ?? FLAT_STRUCTURE;
export const levelOf = (card: { level?: number }) => card.level ?? 0;
export const hasLevels = (structure: BoardStructure) => structure.levels.length > 1;

/** Live direct children per parent, and those in a done column (D125, the same rule as the server's roll-up). */
export function rollupMap(cards: readonly HierarchyCard[], columns: readonly Pick<BoardColumn, "id" | "is_done">[]) {
  const done = new Set(columns.filter((column) => column.is_done === 1).map((column) => column.id));
  const map = new Map<string, Rollup>();
  for (const card of cards) {
    if (!card.parent_card_id) continue;
    const entry = map.get(card.parent_card_id) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (done.has(card.column_id)) entry.done += 1;
    map.set(card.parent_card_id, entry);
  }
  return map;
}

/**
 * The cards the columns show by default (D126): the work level; below it only cards without a
 * parent on the board (nested ones appear inside their parent); above it (epics) only with "Show
 * all levels". A flat board, "Show all levels", and a filtered board show every card.
 */
export function visibleOnBoard<T extends HierarchyCard>(cards: readonly T[], structure: BoardStructure, showAll: boolean): T[] {
  if (showAll || !hasLevels(structure)) return [...cards];
  const ids = new Set(cards.map((card) => card.id));
  return cards.filter((card) => {
    const level = levelOf(card);
    if (level === structure.workLevel) return true;
    if (level < structure.workLevel) return false;
    return !card.parent_card_id || !ids.has(card.parent_card_id);
  });
}

export type HiddenLevel = { level: number; count: number };

/**
 * The cards of a column's lane that the column does not show (D126), counted by level: `above`
 * the work level (epics, shown with "Show all levels" or in Table and List) and `below` it
 * (subtasks inside their parents). Levels top first.
 */
export function hiddenLevels(lane: readonly HierarchyCard[], shown: readonly HierarchyCard[], structure: BoardStructure) {
  const shownIds = new Set(shown.map((card) => card.id));
  const counts = new Map<number, number>();
  for (const card of lane) if (!shownIds.has(card.id)) counts.set(levelOf(card), (counts.get(levelOf(card)) ?? 0) + 1);
  const entries = [...counts].sort((a, b) => a[0] - b[0]).map(([level, count]) => ({ level, count }));
  return { above: entries.filter((entry) => entry.level < structure.workLevel), below: entries.filter((entry) => entry.level > structure.workLevel) };
}

/** "1 epic", "2 stories": a count with the level's name, lower case. */
export function levelCountPhrase(structure: BoardStructure, level: number, count: number) {
  const entry = structure.levels[level];
  const name = entry ? (count === 1 ? entry.name : entry.plural) : count === 1 ? "card" : "cards";
  return `${count} ${name.toLowerCase()}`;
}

const joinAnd = (parts: string[]) => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
const hiddenTotal = (entries: readonly HiddenLevel[]) => entries.reduce((sum, entry) => sum + entry.count, 0);
const levelPhrases = (structure: BoardStructure, entries: readonly HiddenLevel[]) => joinAnd(entries.map((entry) => levelCountPhrase(structure, entry.level, entry.count)));

/** The column's "1 epic not shown" note, or null when no card above the work level is hidden. */
export function hiddenAboveNote(structure: BoardStructure, above: readonly HiddenLevel[]) {
  return above.length ? `${levelPhrases(structure, above)} not shown` : null;
}

/**
 * Why an empty column has cards, by level: "2 epics are shown in Table and List views",
 * "3 subtasks sit inside their parents", or both. Null when nothing is hidden.
 */
export function hiddenColumnHint(structure: BoardStructure, hidden: { above: readonly HiddenLevel[]; below: readonly HiddenLevel[] }) {
  const parts: string[] = [];
  if (hidden.above.length) parts.push(`${levelPhrases(structure, hidden.above)} ${hiddenTotal(hidden.above) === 1 ? "is" : "are"} shown in Table and List views`);
  if (hidden.below.length) {
    const phrase = levelPhrases(structure, hidden.below);
    parts.push(hiddenTotal(hidden.below) === 1 ? `${phrase} sits inside its parent` : `${phrase} sit inside their parents`);
  }
  if (!parts.length) return null;
  const sentence = parts.join("; ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The card's live children in checklist order: column position, then card position (§13 Q6). */
export function childrenOf<T extends HierarchyCard>(cards: readonly T[], columns: readonly BoardColumn[], cardId: string): T[] {
  const index = new Map([...columns].sort(byPosition).map((column, at) => [column.id, at]));
  return cards.filter((card) => card.parent_card_id === cardId)
    .sort((a, b) => ((index.get(a.column_id) ?? Infinity) - (index.get(b.column_id) ?? Infinity)) || a.position - b.position || (a.id < b.id ? -1 : 1));
}

/** Root first, at most two (the breadcrumb). */
export function ancestorsOf<T extends HierarchyCard>(cards: readonly T[], cardId: string): T[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const chain: T[] = [];
  let current = byId.get(cardId);
  for (let step = 0; step < 2 && current?.parent_card_id; step += 1) {
    const parent = byId.get(current.parent_card_id);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

/** Cards that can be `card`'s parent at `level` (default: its own): one level up, never itself. */
export function parentCandidates<T extends HierarchyCard>(cards: readonly T[], card: HierarchyCard, level = levelOf(card)): T[] {
  if (level === 0) return [];
  return cards.filter((candidate) => candidate.id !== card.id && levelOf(candidate) === level - 1)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || (a.id < b.id ? -1 : 1));
}

/** Whether dropping `dragged` onto `target` makes it a child (D128): the target is one level up, not its parent yet, and has room. */
export function canNest(cards: readonly HierarchyCard[], draggedId: string, targetId: string, rollups: Map<string, Rollup>) {
  if (draggedId === targetId) return false;
  const dragged = cards.find((card) => card.id === draggedId);
  const target = cards.find((card) => card.id === targetId);
  if (!dragged || !target || levelOf(target) !== levelOf(dragged) - 1 || dragged.parent_card_id === target.id) return false;
  return (rollups.get(target.id)?.total ?? 0) < HIERARCHY_LIMITS.childrenPerCard;
}

/** Where a checked subtask goes (D127): the board's first done column; unchecked, the first open one. Null without a done column. */
export function checklistColumn(columns: readonly BoardColumn[], done: boolean) {
  const ordered = [...columns].sort(byPosition);
  if (!ordered.some((column) => column.is_done === 1)) return null;
  return (done ? ordered.find((column) => column.is_done === 1) : ordered.find((column) => column.is_done !== 1))?.id ?? null;
}

/** The column a new subtask starts in: the first open column, else the first. */
export const newChildColumn = (columns: readonly BoardColumn[]) => {
  const ordered = [...columns].sort(byPosition);
  return (ordered.find((column) => column.is_done !== 1) ?? ordered[0])?.id ?? null;
};

/** "2 of 5 subtasks done" for screen readers; "Stories 2/5" for the section. */
export function rollupSentence(rollup: Rollup, structure: BoardStructure, level: number) {
  const plural = (structure.levels[level + 1]?.plural ?? "Subtasks").toLowerCase();
  return `${rollup.done} of ${rollup.total} ${plural} done`;
}

/** The eyebrow's level name on a board with levels ("Story"), or null on a flat board. */
export const levelEyebrow = (structure: BoardStructure, level: number) => hasLevels(structure) ? levelName(structure, level) : null;

export { canHaveChildren };
