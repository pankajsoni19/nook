import { describe, expect, test } from "bun:test";
import {
  buildAssigneeLanes, buildLanes, buildSprintLanes, buildTagLanes, cardLaneKeys, dueBucketOf, isLaneKey, laneModeOfKey, MAX_GROUP_LANES, NONE_LANE, resolveGroupDrop, type LaneCard
} from "../shared/taskLanes";
import { buildSwimlanes, isRowKey, normalizeCollapsedRows, NONE_ROW, swimlaneChange } from "../shared/swimlanes";

/** Grouped lanes and swimlanes (lane VIEWS2, D650–D656): keys, merge, order, and what a drop changes. */

const me = "11111111-1111-4111-8111-111111111111";
const you = "22222222-2222-4222-8222-222222222222";
const card = (extra: Partial<LaneCard> = {}): LaneCard => ({
  id: "k1", board_id: "b1", column_id: "c1", column_name: "To do", column_state: "todo", assignees: [], tags: [], sprint_id: null, sprint_name: null, due_on: null, level: 0, ...extra
});

describe("lane keys", () => {
  test("every mode's keys are well formed, and a key names its mode", () => {
    for (const key of [`a:${me}`, `b:${you}`, "t:urgent", "p:sprint 1", "d:week", "none:a", "none:t", "none:p", "s:done", "c:doing:review"]) {
      expect(isLaneKey(key)).toBe(true);
    }
    for (const key of ["a:me", "b:", "t:", "t: ", "d:soon", "none:x", "x:y", `a:${me}x`]) expect(isLaneKey(key)).toBe(false);
    expect([`a:${me}`, "none:t", "p:x", "d:none", `b:${me}`, "s:todo", "c:todo:x"].map(laneModeOfKey)).toEqual(["assignee", "tag", "sprint", "due", "board", "state", "columns"]);
  });

  test("a card is in one lane per person or tag, else the none lane; due buckets match the server's", () => {
    const both = card({ assignees: [{ id: me }, { id: you.toUpperCase() }], tags: [{ id: "t1", name: "Urgent" }, { id: "t2", name: "ÜRGENT" }] });
    expect(cardLaneKeys("assignee", both)).toEqual([`a:${me}`, `a:${you}`]);
    expect(cardLaneKeys("tag", both)).toEqual(["t:urgent"]);
    expect(cardLaneKeys("assignee", card())).toEqual([NONE_LANE.assignee]);
    expect(cardLaneKeys("sprint", card({ sprint_id: "s1", sprint_name: "Sprint 1" }))).toEqual(["p:sprint 1"]);
    expect(cardLaneKeys("sprint", card())).toEqual([NONE_LANE.sprint]);
    expect(cardLaneKeys("board", card())).toEqual(["b:b1"]);
    const dates = { today: "2026-10-23", weekEnd: "2026-10-29" };
    expect(["2026-10-22", "2026-10-23", "2026-10-29", "2026-10-30", null].map((due) => dueBucketOf(due, dates.today, dates.weekEnd))).toEqual(["overdue", "today", "week", "later", "none"]);
    expect(cardLaneKeys("due", card({ due_on: "2026-10-24" }), dates)).toEqual(["d:week"]);
  });
});

describe("building grouped lanes", () => {
  test("people by name with No assignee last; tags merged by folded name with each board's tag; too many fall back", () => {
    expect(buildAssigneeLanes([{ id: you, display_name: "Zed" }, { id: me, display_name: "Asha" }]).lanes.map((lane) => lane.label)).toEqual(["Asha", "Zed", "No assignee"]);
    const tags = buildTagLanes([
      { id: "t1", board_id: "b1", name: "Urgent", color: "red", count: 2 },
      { id: "t2", board_id: "b2", name: "urgent", color: "red", count: 0 },
      { id: "t3", board_id: "b2", name: "Unused", color: "blue", count: 0 }
    ]);
    expect(tags.lanes.map((lane) => [lane.key, lane.label, lane.targets?.map((target) => target.id)])).toEqual([["t:urgent", "Urgent", ["t1", "t2"]], ["none:t", "No tag", undefined]]);
    const many = Array.from({ length: MAX_GROUP_LANES }, (_, index) => ({ id: `${index}`.padStart(8, "0") + me.slice(8), display_name: `P${index}` }));
    expect(buildAssigneeLanes(many).fallback).toBe(true);
    expect(buildLanes("assignee", [{ id: "c", board_id: "b", name: "Doing", state: "doing", position: 0 }])).toMatchObject({ mode: "state", fallback: true });
  });

  test("sprints: Backlog first, then active, planned in board order; completed only with matches", () => {
    const layout = buildSprintLanes([
      { id: "s3", board_id: "b1", name: "Sprint 3", state: "planned", position: 3, count: 0 },
      { id: "s1", board_id: "b1", name: "Sprint 1", state: "closed", position: 1, count: 0 },
      { id: "s0", board_id: "b1", name: "Sprint 0", state: "closed", position: 0, count: 4 },
      { id: "s2", board_id: "b1", name: "Sprint 2", state: "active", position: 2, count: 1 },
      { id: "x2", board_id: "b2", name: "sprint 2", state: "planned", position: 1, count: 0 }
    ]);
    expect(layout.lanes.map((lane) => [lane.key, lane.sprintState ?? null])).toEqual([["none:p", null], ["p:sprint 2", "active"], ["p:sprint 3", "planned"], ["p:sprint 0", "closed"]]);
    expect(layout.lanes[1]!.targets!.map((target) => target.id)).toEqual(["s2", "x2"]);
  });
});

describe("a drop on a grouped lane (D651)", () => {
  const assigneeLane = (id: string) => ({ key: `a:${id}`, label: id, columns: [], userId: id });
  test("people: the source lane's person is replaced; No assignee clears; nothing changes is the same lane", () => {
    const shared = card({ assignees: [{ id: me }, { id: you }] });
    const third = "33333333-3333-4333-8333-333333333333";
    expect(resolveGroupDrop("assignee", assigneeLane(third), shared, true, { fromKey: `a:${me}` })).toEqual({ field: "assignees", assigneeIds: [you, third] });
    expect(resolveGroupDrop("assignee", assigneeLane(you), shared, true, { fromKey: `a:${me}` })).toEqual({ field: "assignees", assigneeIds: [you] });
    expect(resolveGroupDrop("assignee", assigneeLane(me), card(), true, { fromKey: NONE_LANE.assignee })).toEqual({ field: "assignees", assigneeIds: [me] });
    expect(resolveGroupDrop("assignee", { key: NONE_LANE.assignee, label: "No assignee", columns: [] }, shared, true, { fromKey: `a:${me}` })).toEqual({ field: "assignees", assigneeIds: [] });
    expect(resolveGroupDrop("assignee", assigneeLane(me), shared, true, { fromKey: `a:${me}` })).toEqual({ refusal: "SAME_LANE" });
    expect(resolveGroupDrop("assignee", assigneeLane(third), shared, false, { fromKey: `a:${me}` })).toEqual({ refusal: "READ_ONLY" });
  });

  test("tags: the board's tag of that name, or a refusal; sprints: open, at the work level, sprints on", () => {
    const tagLane = { key: "t:review", label: "Review", columns: [], targets: [{ id: "tr", board_id: "b1", name: "Review" }] };
    const tagged = card({ tags: [{ id: "tu", name: "Urgent" }, { id: "tx", name: "Other" }] });
    expect(resolveGroupDrop("tag", tagLane, tagged, true, { fromKey: "t:urgent" })).toEqual({ field: "tags", tagIds: ["tx", "tr"] });
    expect(resolveGroupDrop("tag", tagLane, card({ board_id: "b2" }), true, { fromKey: NONE_LANE.tag })).toEqual({ refusal: "NO_TAG" });
    expect(resolveGroupDrop("tag", { key: NONE_LANE.tag, label: "No tag", columns: [] }, tagged, true, { fromKey: "t:urgent" })).toEqual({ field: "tags", tagIds: [] });

    const sprintLane = { key: "p:sprint 2", label: "Sprint 2", columns: [], targets: [{ id: "s2", board_id: "b1", name: "Sprint 2", state: "planned" as const }] };
    const boardOn = { id: "b1", name: "B", work_level: 0, sprints: true };
    expect(resolveGroupDrop("sprint", sprintLane, card(), true, { fromKey: NONE_LANE.sprint, board: boardOn })).toEqual({ field: "sprint", sprintId: "s2" });
    expect(resolveGroupDrop("sprint", sprintLane, card({ level: 1 }), true, { board: boardOn })).toEqual({ refusal: "SPRINT_LEVEL" });
    expect(resolveGroupDrop("sprint", sprintLane, card(), true, { board: { ...boardOn, sprints: false } })).toEqual({ refusal: "SPRINTS_OFF" });
    expect(resolveGroupDrop("sprint", { ...sprintLane, targets: [{ ...sprintLane.targets[0]!, state: "closed" as const }] }, card(), true, { board: boardOn })).toEqual({ refusal: "SPRINT_CLOSED" });
    expect(resolveGroupDrop("sprint", { key: NONE_LANE.sprint, label: "Backlog", columns: [] }, card({ sprint_id: "s2", sprint_name: "Sprint 2" }), true, { board: boardOn })).toEqual({ field: "sprint", sprintId: null });
    expect(resolveGroupDrop("due", { key: "d:today", label: "Today", columns: [] }, card(), true)).toEqual({ refusal: "LOCKED" });
  });
});

describe("swimlanes (D655, D656)", () => {
  const parents = new Map([["p2", { id: "p2", title: "Epic two", column_id: "c2", position: 1 }], ["p1", { id: "p1", title: "Epic one", column_id: "c1", position: 5 }]]);
  test("rows by person (a card in each of its people's rows) or by parent in board order, with the none row last", () => {
    const cards = [
      { id: "k1", column_id: "c1", position: 1, assignees: [{ id: me, display_name: "Zed" }, { id: you, display_name: "Asha" }], parent_card_id: "p2" },
      { id: "k2", column_id: "c1", position: 2, assignees: [], parent_card_id: "p1" },
      { id: "k3", column_id: "c2", position: 1, assignees: [{ id: me, display_name: "Zed" }], parent_card_id: null }
    ];
    expect(buildSwimlanes("assignee", cards, { columnOrder: ["c1", "c2"], parents }).map((row) => [row.label, row.cardIds])).toEqual([["Asha", ["k1"]], ["Zed", ["k1", "k3"]], ["No assignee", ["k2"]]]);
    expect(buildSwimlanes("parent", cards, { columnOrder: ["c1", "c2"], parents }).map((row) => [row.key, row.label, row.cardIds])).toEqual([["k:p1", "Epic one", ["k2"]], ["k:p2", "Epic two", ["k1"]], [NONE_ROW.parent, "No parent", ["k3"]]]);
  });

  test("a drag across rows replaces the row's person or sets the parent; keys are bounded", () => {
    const row = (key: string, extra: Record<string, string> = {}) => ({ key, label: key, cardIds: [], ...extra });
    expect(swimlaneChange("assignee", `a:${me}`, row(`a:${you}`, { userId: you }), { assignees: [{ id: me }] })).toEqual({ assigneeIds: [you] });
    expect(swimlaneChange("assignee", `a:${me}`, row(NONE_ROW.assignee), { assignees: [{ id: me }] })).toEqual({ assigneeIds: [] });
    expect(swimlaneChange("assignee", `a:${me}`, row(`a:${me}`, { userId: me }), { assignees: [{ id: me }] })).toBeNull();
    expect(swimlaneChange("parent", "k:p1", row("k:p2", { parentId: "p2" }), { parent_card_id: "p1" })).toEqual({ parentId: "p2" });
    expect(swimlaneChange("parent", "k:p1", row(NONE_ROW.parent), { parent_card_id: "p1" })).toEqual({ parentId: null });
    expect(isRowKey(`k:${me}`) && isRowKey("none:a") && !isRowKey("k:x") && !isRowKey("t:x")).toBe(true);
    expect(normalizeCollapsedRows([...Array.from({ length: 50 }, () => `a:${me}`), "bad", `k:${you}`])).toEqual([`a:${me}`, `k:${you}`]);
  });
});
