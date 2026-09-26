import { describe, expect, test } from "bun:test";
import { PRESETS } from "../shared/boardStructure";
import { parse } from "../shared/taskQuery";
import { applyBoardQuery, boardData, FILTER_FIELDS, treeRows, type BoardContext } from "../src/tasks/boardQuery";
import { formatBoardSearch, parseBoardSearch } from "../src/tasks/boardUrl";
import { binConfirmMessage } from "../src/tasks/taskActions";
import { cardFaceLabel } from "../src/tasks/CardFace";
import { ancestorsOf, canNest, checklistColumn, childrenOf, hiddenAboveNote, hiddenColumnHint, hiddenLevels, newChildColumn, parentCandidates, rollupMap, visibleOnBoard } from "../src/tasks/hierarchyModel";
import { structurePreview } from "../src/tasks/BoardSettingsSheet";
import { createBody, emptyDraft } from "../src/tasks/composerDraft";
import type { BoardColumn, CardSummary } from "../src/tasks/tasksApi";

/** The board's hierarchy on the client (research 2026-09-26 §7, D125–D128): pure helpers and the views' tree and grouping. */

const epics = PRESETS.epic_story_subtask.structure;
const column = (id: string, position: number, isDone = false): BoardColumn => ({ id, board_id: "b", name: id, position, is_done: isDone ? 1 : 0, created_at: "", updated_at: "" });
const columns = [column("done", 3072, true), column("todo", 1024), column("doing", 2048)];
function card(id: string, level: number, parent: string | null, columnId = "todo", position = 1): CardSummary {
  return {
    id, board_id: "b", column_id: columnId, position, title: id, has_description: 0, revision: 1, created_by: null, creator_name: null, due_on: null,
    assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
    level, parent_card_id: parent
  };
}
const cards = [
  card("epic", 0, null),
  card("storyA", 1, "epic", "doing", 1),
  card("storyB", 1, "epic", "todo", 2),
  card("orphan", 1, null, "todo", 3),
  card("subA1", 2, "storyA", "done", 1),
  card("subA2", 2, "storyA", "todo", 4),
  card("loose", 2, null, "todo", 5)
];
const ids = (list: ReadonlyArray<{ id: string }>) => list.map((item) => item.id);

describe("hierarchy model", () => {
  test("columns show the work level and loose lower cards; Show all levels and flat boards show everything (D126)", () => {
    expect(ids(visibleOnBoard(cards, epics, false))).toEqual(["storyA", "storyB", "orphan", "loose"]);
    expect(visibleOnBoard(cards, epics, true)).toHaveLength(7);
    expect(visibleOnBoard(cards, PRESETS.flat.structure, false)).toHaveLength(7);
    const tasks = PRESETS.task_subtask.structure;
    expect(ids(visibleOnBoard([card("t", 0, null), card("s", 1, "t"), card("s2", 1, null)], tasks, false))).toEqual(["t", "s2"]);
  });

  test("a column names the levels it hides: epics above the work level, subtasks inside parents (QA FAIL-2)", () => {
    const todo = cards.filter((item) => item.column_id === "todo");
    const shown = visibleOnBoard(cards, epics, false).filter((item) => item.column_id === "todo");
    const hidden = hiddenLevels(todo, shown, epics);
    expect(hidden).toEqual({ above: [{ level: 0, count: 1 }], below: [{ level: 2, count: 1 }] });
    expect(hiddenAboveNote(epics, hidden.above)).toBe("1 epic not shown");
    expect(hiddenColumnHint(epics, hidden)).toBe("1 epic is shown in Table and List views; 1 subtask sits inside its parent");
    // A parentless new epic alone in a column: the hint no longer says it sits inside a parent.
    const lone = [card("e1", 0, null), card("e2", 0, null)];
    const alone = hiddenLevels(lone, visibleOnBoard(lone, epics, false), epics);
    expect(hiddenAboveNote(epics, alone.above)).toBe("2 epics not shown");
    expect(hiddenColumnHint(epics, alone)).toBe("2 epics are shown in Table and List views");
    const subs = [card("s1", 2, "storyA"), card("s2", 2, "storyA"), card("storyA", 1, null)];
    const nested = hiddenLevels(subs, visibleOnBoard(subs, epics, false), epics);
    expect(hiddenAboveNote(epics, nested.above)).toBeNull();
    expect(hiddenColumnHint(epics, nested)).toBe("2 subtasks sit inside their parents");
    expect(hiddenColumnHint(epics, hiddenLevels(todo, todo, epics))).toBeNull();
  });

  test("roll-ups count live direct children and those in a done column", () => {
    const rollups = rollupMap(cards, columns);
    expect(rollups.get("epic")).toEqual({ done: 0, total: 2 });
    expect(rollups.get("storyA")).toEqual({ done: 1, total: 2 });
    expect(rollups.get("orphan")).toBeUndefined();
  });

  test("children in checklist order, ancestors root first, parent candidates one level up", () => {
    expect(ids(childrenOf(cards, columns, "storyA"))).toEqual(["subA2", "subA1"]);
    expect(ids(childrenOf(cards, columns, "epic"))).toEqual(["storyB", "storyA"]);
    expect(ids(ancestorsOf(cards, "subA1"))).toEqual(["epic", "storyA"]);
    expect(ancestorsOf(cards, "epic")).toEqual([]);
    expect(ids(parentCandidates(cards, cards.find((item) => item.id === "subA1")!))).toEqual(["orphan", "storyA", "storyB"]);
    expect(parentCandidates(cards, cards[0]!)).toEqual([]);
    expect(ids(parentCandidates(cards, cards.find((item) => item.id === "orphan")!, 2))).toEqual(["orphan", "storyA", "storyB"].filter((id) => id !== "orphan"));
  });

  test("nesting by drag: only onto a card one level up that is not already the parent and has room (D128)", () => {
    const rollups = rollupMap(cards, columns);
    expect(canNest(cards, "orphan", "epic", rollups)).toBe(true);
    expect(canNest(cards, "storyA", "epic", rollups)).toBe(false);
    expect(canNest(cards, "orphan", "storyB", rollups)).toBe(false);
    expect(canNest(cards, "loose", "storyB", rollups)).toBe(true);
    expect(canNest(cards, "epic", "epic", rollups)).toBe(false);
    expect(canNest(cards, "loose", "storyB", new Map([["storyB", { done: 0, total: 100 }]]))).toBe(false);
  });

  test("the checkbox targets the first done column and back to the first open one; no done column, no checkbox (D127)", () => {
    expect(checklistColumn(columns, true)).toBe("done");
    expect(checklistColumn(columns, false)).toBe("todo");
    expect(checklistColumn([column("a", 1), column("b", 2)], true)).toBeNull();
    expect(newChildColumn(columns)).toBe("todo");
  });

  test("card face label, bin confirm, composer body, and the structure preview name the hierarchy", () => {
    const face = cardFaceLabel({ card: cards[1]!, tags: [], done: false, today: "2026-09-26", parentTitle: "epic", rollup: { done: 1, total: 2 }, childLabel: "subtasks" });
    expect(face).toBe("storyA, in epic, 1 of 2 subtasks done");
    expect(binConfirmMessage("card", "Epic", 7)).toBe("Move “Epic” and the 7 cards under it to the Bin? You can restore them together for 30 days.");
    expect(binConfirmMessage("card", "Task")).toBe("Move “Task” to the Bin? You can restore it for 30 days.");
    expect(createBody(emptyDraft("todo", { parentId: "storyA", level: 2 }), "Sub")).toEqual({ columnId: "todo", title: "Sub", parentId: "storyA", level: 2 });
    expect(createBody(emptyDraft("todo"), "Plain")).toEqual({ columnId: "todo", title: "Plain" });
    expect(structurePreview(epics)).toBe("Columns show Stories. Subtasks appear inside their story. Epics show as a chip on each story.");
  });
});

describe("views: tree, parent grouping, and hierarchy filters", () => {
  const data = boardData({ columns, cards, board: { structure: epics } });
  const context: BoardContext = { userId: "me", today: "2026-09-26", now: Date.parse("2026-09-26T12:00:00.000Z"), timeZone: "UTC" };

  test("boardData recounts roll-ups and carries the structure", () => {
    expect(data.structure).toEqual(epics);
    expect(data.cards.find((item) => item.id === "storyA")).toMatchObject({ child_count: 2, done_child_count: 1 });
  });

  test("the table tree puts children under their parent and collapses", () => {
    const rows = treeRows(data.cards);
    expect(rows.map((row) => `${"-".repeat(row.depth)}${row.card.id}`)).toEqual(["epic", "-storyA", "--subA1", "--subA2", "-storyB", "orphan", "loose"]);
    expect(rows[0]!.childCount).toBe(2);
    expect(treeRows(data.cards, new Set(["storyA"])).map((row) => row.card.id)).toEqual(["epic", "storyA", "storyB", "orphan", "loose"]);
    // A parent filtered out leaves its children as roots.
    expect(treeRows(data.cards.filter((item) => item.id !== "epic")).filter((row) => row.depth === 0).map((row) => row.card.id)).toEqual(["storyA", "storyB", "orphan", "loose"]);
  });

  test("group by parent, in board order, with no parent last; the URL keeps group=parent", () => {
    const result = applyBoardQuery(data, { view: "list", group: "parent", sort: null, filter: { terms: [] } }, context);
    expect(result.groups!.map((group) => [group.label, group.items.map((item) => item.card.id)])).toEqual([
      ["epic", ["storyB", "storyA"]], ["storyA", ["subA2", "subA1"]], ["No parent", ["epic", "orphan", "loose"]]
    ]);
    const query = parseBoardSearch("?view=list&group=parent");
    expect(query.group).toBe("parent");
    expect(formatBoardSearch(query)).toContain("group=parent");
  });

  test("level, parent, and has:subtasks filter the loaded board; the fields show only on boards with levels", () => {
    const run = (text: string) => {
      const parsed = parse(text, { boardScoped: true });
      if (!parsed.ok) throw new Error(parsed.error.message);
      return applyBoardQuery(data, { view: "table", group: null, sort: null, filter: parsed.query }, context).cards.map((item) => item.id).sort();
    };
    expect(run("level:work")).toEqual(["orphan", "storyA", "storyB"]);
    expect(run("parent:none level:2")).toEqual(["loose"]);
    expect(run("has:subtasks")).toEqual(["epic", "storyA"]);
    expect(run("-has:subtasks level:1")).toEqual(["orphan", "storyB"]);
    expect(FILTER_FIELDS.level!.available!(data)).toBe(true);
    expect(FILTER_FIELDS.level!.available!(boardData({ columns, cards: [] }))).toBe(false);
    expect(FILTER_FIELDS.level!.optionsFor(data, context).map((option) => option.label)).toEqual(["Work level (Story)", "Epic", "Story", "Subtask"]);
  });
});
