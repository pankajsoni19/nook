import { describe, expect, test } from "bun:test";
import { buildLanes, isLaneKey, laneKeyOf, MAX_COLUMN_LANES, normalizeCollapsedLanes, resolveLaneDrop, type LaneColumn } from "../shared/taskLanes";

/** Lanes across boards (lane VIEWS, D640–D644): merge, order, fallback, and where a drop goes. */

const col = (board: string, id: string, name: string, state: LaneColumn["state"], position: number, extra: Partial<LaneColumn> = {}): LaneColumn =>
  ({ id, board_id: board, name, state, position, wip_limit: null, card_count: 0, ...extra });

const alpha = [col("a", "a1", "Backlog", "todo", 0), col("a", "a2", "Doing", "doing", 1), col("a", "a3", "Review", "doing", 2), col("a", "a4", "Done", "done", 3)];
const beta = [col("b", "b1", "backlog", "todo", 0), col("b", "b2", "Doing", "doing", 1), col("b", "b3", "Réview", "done", 2), col("b", "b4", "Shipped", "done", 3)];

describe("buildLanes", () => {
  test("merges columns by folded name and state, splits one name in two states, and orders by state then median position", () => {
    const layout = buildLanes("columns", [...beta, ...alpha]);
    expect(layout.mode).toBe("columns");
    expect(layout.fallback).toBe(false);
    expect(layout.lanes.map((lane) => [lane.label, lane.state, lane.columns.map((column) => column.id)])).toEqual([
      ["Backlog", "todo", ["a1", "b1"]],
      ["Doing", "doing", ["a2", "b2"]],
      ["Review · In progress", "doing", ["a3"]],
      ["Réview · Done", "done", ["b3"]],
      ["Done", "done", ["a4"]],
      ["Shipped", "done", ["b4"]]
    ]);
    // Keys are folded (case and accents), so the client finds a card's lane from its column.
    expect(laneKeyOf("columns", { name: "BACKLOG", state: "todo" })).toBe(layout.lanes[0]!.key);
    expect(layout.lanes[2]!.key).toBe("c:doing:review");
    expect(layout.lanes[3]!.key).toBe("c:done:review");
  });

  test("a board that repeats a name keeps its first column in the lane", () => {
    const layout = buildLanes("columns", [col("a", "x1", "Doing", "doing", 0), col("a", "x2", "doing", "doing", 1)]);
    expect(layout.lanes).toHaveLength(1);
    expect(layout.lanes[0]!.columns.map((column) => column.id)).toEqual(["x1"]);
  });

  test("more than 20 merged lanes fall back to state lanes", () => {
    const many = Array.from({ length: MAX_COLUMN_LANES + 1 }, (_, index) => col(`b${index}`, `c${index}`, `Column ${index}`, "doing", 0));
    expect(buildLanes("columns", many.slice(0, MAX_COLUMN_LANES)).mode).toBe("columns");
    const layout = buildLanes("columns", many);
    expect(layout).toMatchObject({ mode: "state", fallback: true });
    expect(layout.lanes.map((lane) => [lane.key, lane.label, lane.columns.length])).toEqual([["s:todo", "To do", 0], ["s:doing", "In progress", 21], ["s:done", "Done", 0]]);
  });

  test("state lanes list each board's columns of that state in position order", () => {
    const layout = buildLanes("state", [...alpha, ...beta]);
    expect(layout.lanes.map((lane) => lane.columns.map((column) => column.id))).toEqual([["a1", "b1"], ["a2", "a3", "b2"], ["a4", "b3", "b4"]]);
  });
});

describe("resolveLaneDrop", () => {
  const layout = buildLanes("columns", [...alpha, ...beta.map((column) => column.id === "b2" ? { ...column, wip_limit: 2, card_count: 2 } : column)]);
  const lane = (label: string) => layout.lanes.find((item) => item.label === label)!;
  const cardA = { board_id: "a", column_id: "a1", column_name: "Backlog", column_state: "todo" as const };
  const cardB = { board_id: "b", column_id: "b1", column_name: "backlog", column_state: "todo" as const };

  test("goes to the card's own board's column of the lane", () => {
    expect(resolveLaneDrop(lane("Doing"), cardA, true)).toEqual({ columnId: "a2" });
    expect(resolveLaneDrop(lane("Review · In progress"), cardA, true)).toEqual({ columnId: "a3" });
  });

  test("refuses: no such column on the card's board, a full column, a board the viewer cannot edit, and the same lane", () => {
    expect(resolveLaneDrop(lane("Review · In progress"), cardB, true)).toEqual({ refusal: "NO_COLUMN" });
    expect(resolveLaneDrop(lane("Doing"), cardB, true)).toEqual({ refusal: "COLUMN_FULL" });
    expect(resolveLaneDrop(lane("Doing"), cardA, false)).toEqual({ refusal: "READ_ONLY" });
    expect(resolveLaneDrop(lane("Backlog"), cardA, true)).toEqual({ refusal: "SAME_LANE" });
  });

  test("a state lane goes to the first column of that state on the card's board", () => {
    const states = buildLanes("state", [...alpha, ...beta]);
    expect(resolveLaneDrop(states.lanes[1]!, cardB, true)).toEqual({ columnId: "b2" });
    expect(resolveLaneDrop(states.lanes[2]!, cardA, true)).toEqual({ columnId: "a4" });
    expect(resolveLaneDrop(states.lanes[0]!, cardA, true)).toEqual({ refusal: "SAME_LANE" });
    const noDone = buildLanes("state", alpha.filter((column) => column.state !== "done"));
    expect(resolveLaneDrop(noDone.lanes[2]!, cardA, true)).toEqual({ refusal: "NO_COLUMN" });
  });
});

describe("collapsed lane keys", () => {
  test("only well-formed keys, unique, at most 40, within 1 KiB", () => {
    expect(isLaneKey("s:todo")).toBe(true);
    expect(isLaneKey("s:later")).toBe(false);
    expect(isLaneKey("c:doing:review")).toBe(true);
    expect(isLaneKey("c:doing: ")).toBe(false);
    expect(isLaneKey("c:doing:a\u0000b")).toBe(false);
    expect(isLaneKey(7)).toBe(false);
    expect(normalizeCollapsedLanes(["s:done", "s:done", "x", "c:doing:review"])).toEqual(["s:done", "c:doing:review"]);
    const long = Array.from({ length: 60 }, (_, index) => `c:doing:${"x".repeat(30)}${index}`);
    const kept = normalizeCollapsedLanes(long);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(1024);
    expect(kept.length).toBeLessThan(40);
    expect(normalizeCollapsedLanes(Array.from({ length: 50 }, (_, index) => `c:todo:${index}`))).toHaveLength(40);
  });
});
