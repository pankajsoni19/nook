import { describe, expect, test } from "bun:test";
import { act, createRef, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAssigneeLanes, buildDueLanes, buildTagLanes, type LaneBoard } from "../shared/taskLanes";
import { format, parse } from "../shared/taskQuery";
import { DEFAULT_BOARD_QUERY, formatBoardSearch, parseBoardSearch, withBoardQuery } from "../src/tasks/boardUrl";
import { widenToBoards } from "../src/tasks/views/boardViewModel";
import { cardsByLane, changeMessage, laneAddTargets, laneDrop, lanesAcceptDrops, withGroupChange } from "../src/tasks/home/laneModel";
import { formatViewSearch, homeLanes, parseMyWorkSearch, parseViewSearch, viewHomeQuery } from "../src/tasks/home/homeUrl";
import { QueryLanes } from "../src/tasks/home/QueryLanes";
import { BoardSwimlanes } from "../src/tasks/BoardSwimlanes";
import { installDom, mockApi, render } from "./support/dom";
import { readLocalShowAll, useBoardHierarchy } from "../src/tasks/useBoardHierarchy";
import { clearCardQueryCache, useCardQuery } from "../src/tasks/home/useCardQuery";
import type { QueriedCard, QueryLanes as LaneLayout } from "../src/tasks/home/homeApi";
import type { BoardColumn, BoardDetail, CardSummary } from "../src/tasks/tasksApi";

/** Views slice 2 on the client (lane VIEWS2, docs/plan/TASK_VIEWS.md D650–D661). */

installDom("http://nook.test/tasks");
const ME = "11111111-1111-4111-8111-111111111111";
const YOU = "22222222-2222-4222-8222-222222222222";
const BA = "33333333-3333-4333-8333-333333333333";
const BB = "44444444-4444-4444-8444-444444444444";
const card = (id: string, extra: Partial<QueriedCard> = {}): QueriedCard => ({
  id, board_id: BA, board_name: "Alpha", column_id: "c1", column_name: "To do", column_state: "todo", is_done: 0, position: 1, title: `Card ${id}`,
  description_excerpt: "", revision: 1, created_by: null, creator_name: null, due_on: null, due_time: null, due_tz: null, due_at: null,
  assignees: [], tags: [], flags: [], created_at: "", updated_at: "", board_level: "edit", level: 0, sprint_id: null, sprint_name: null, ...extra
});
const person = (id: string, name: string) => ({ id, display_name: name, can_read: 1 as const });
const boards: LaneBoard[] = [{ id: BA, name: "Alpha", work_level: 0, sprints: true, level: "edit" }, { id: BB, name: "Beta", work_level: 0, sprints: false, level: "view" }];

describe("grouped lanes on the client (D650–D652)", () => {
  const cards = [card("k1", { assignees: [person(ME, "Asha"), person(YOU, "Ben")] }), card("k2", { assignees: [person(YOU, "Ben")] }), card("k3", { board_id: BB, board_name: "Beta", board_level: "view" })];
  const built = buildAssigneeLanes([{ id: ME, display_name: "Asha" }, { id: YOU, display_name: "Ben" }]);
  const layout: LaneLayout = { lanes: "assignee", columns: built.lanes, laneCounts: { [`a:${ME}`]: 1, [`a:${YOU}`]: 2, "none:a": 1 }, laneBoards: boards };
  const lane = (key: string) => layout.columns.find((item) => item.key === key)!;

  test("a card with two people is in both lanes; a drop replaces the source lane's person and moves the counts", () => {
    expect([...cardsByLane(layout, cards).entries()].map(([key, items]) => [key, items.map((item) => item.id)])).toEqual([[`a:${ME}`, ["k1"]], [`a:${YOU}`, ["k1", "k2"]], ["none:a", ["k3"]]]);
    const drop = laneDrop(layout, lane("none:a"), cards[1]!, true, `a:${YOU}`);
    expect(drop).toEqual({ kind: "group", change: { field: "assignees", assigneeIds: [] } });
    const moved = withGroupChange({ cards, lanes: layout }, "k2", { field: "assignees", assigneeIds: [ME] });
    expect(moved.cards.find((item) => item.id === "k2")!.assignees).toEqual([{ id: ME, display_name: "Asha", can_read: 1 }]);
    expect(moved.lanes!.laneCounts).toEqual({ [`a:${ME}`]: 2, [`a:${YOU}`]: 1, "none:a": 1 });
    expect(laneDrop(layout, lane(`a:${ME}`), cards[2]!, false, "none:a")).toMatchObject({ refusal: "READ_ONLY", message: "You can't change cards on Beta" });
    expect(changeMessage({ field: "assignees", assigneeIds: [ME] }, lane(`a:${ME}`))).toBe("Assigned to Asha");
  });

  test("Add a card offers the boards the viewer can edit that have a place for it (D654)", () => {
    expect(laneAddTargets(layout, lane(`a:${YOU}`), false)).toEqual([{ board: boards[0]!, columnId: null, assignee: { id: YOU, display_name: "Ben" } }]);
    expect(laneAddTargets(layout, lane(`a:${YOU}`), true)).toEqual([]);
    const tags = buildTagLanes([{ id: "t1", board_id: BA, name: "Urgent", color: "red", count: 1 }]);
    const tagLayout: LaneLayout = { lanes: "tag", columns: tags.lanes, laneCounts: {}, laneBoards: boards };
    expect(laneAddTargets(tagLayout, tags.lanes[0]!, false)).toEqual([{ board: boards[0]!, columnId: null, tagId: "t1" }]);
    const due: LaneLayout = { lanes: "due", columns: buildDueLanes().lanes, laneCounts: {}, laneBoards: boards };
    expect(laneAddTargets(due, due.columns[0]!, false)).toEqual([]);
    expect(lanesAcceptDrops(due)).toBe(false);
  });

  test("renders a lane per person with the card in each, Add a card where it can go, and read-only due lanes", () => {
    const noop = () => undefined;
    const props = { cards, today: "2026-10-23", collapsed: new Set<string>(), onToggleCollapsed: noop, onOpenCard: noop, onMoveCard: noop, onDropCard: noop, onRefused: noop, phone: false };
    const html = renderToStaticMarkup(<QueryLanes {...props} layout={layout} onAddCard={noop} canAddCard={(item) => laneAddTargets(layout, item, false).length > 0} />);
    expect(html.match(/data-card-id="k1"/g)!.length).toBe(2);
    expect(html).toContain('aria-label="Add a card to Ben"');
    expect(html).toContain("task-lane-mark");
    expect(html).toMatch(/data-card-id="k2" draggable="true"/);
    const due: LaneLayout = { lanes: "due", columns: buildDueLanes().lanes, laneCounts: { "d:none": 3 }, laneBoards: boards };
    const dueHtml = renderToStaticMarkup(<QueryLanes {...props} layout={due} />);
    expect(dueHtml).not.toContain('draggable="true"');
    expect(dueHtml).toContain(">No due date</h2>");
    const fallback = renderToStaticMarkup(<QueryLanes {...props} layout={{ ...layout, lanes: "state", lanesFallback: true, columns: [] }} />);
    expect(fallback).toContain("more than 20 different");
  });

  test("lanes=<mode> round-trips in the home URL and the saved display", () => {
    expect(homeLanes(parseMyWorkSearch("?layout=board&lanes=sprint"))).toBe("sprint");
    expect(homeLanes(parseMyWorkSearch("?layout=board&lanes=nonsense"))).toBe("columns");
    const view = parseViewSearch(`?layout=board&group=none&sort=due&lanes=tag&q=board:${BA}`)!;
    expect(formatViewSearch(view)).toBe(`?layout=board&group=none&sort=due&lanes=tag&q=board:${BA}`);
    expect(homeLanes(viewHomeQuery({ query: "", display: { layout: "board", group: "none", sort: "due", lanes: "assignee" } }))).toBe("assignee");
  });
});

describe("Show all levels on the server (D659) and a refresh after a failed move (D652)", () => {
  test("an older per-device choice is sent once when the server has none, then removed", async () => {
    const api = mockApi({ [`PUT /tasks/boards/${BA}/view`]: (call) => ({ view: { collapsedColumnIds: [], showArchived: false, showAllLevels: (call.body as { showAllLevels: boolean }).showAllLevels, collapsedRows: [] } }) });
    window.localStorage.setItem(`nook.tasks.showAllLevels.${BA}`, "1");
    const detail = { board: { id: BA, structure: undefined }, columns: [], cards: [], view: { collapsedColumnIds: [], showArchived: false, showAllLevels: null, collapsedRows: [] } } as unknown as BoardDetail;
    let shown: boolean | null = null;
    function Probe() {
      const [state, setState] = useState<BoardDetail | null>(detail);
      const ref = useRef(state);
      const hierarchy = useBoardHierarchy({ detail: state, detailRef: ref, setDetail: setState, move: async () => undefined, notify: Object.assign(() => undefined, { success: () => undefined, info: () => undefined, warning: () => undefined, error: () => undefined }) as never, load: async () => undefined, onOpenCard: () => undefined, openComposer: () => undefined });
      shown = hierarchy.showAll;
      return null;
    }
    const view = await render(<Probe />);
    await view.waitFor(() => api.calls.some((call) => call.method === "PUT"));
    await view.waitFor(() => window.localStorage.getItem(`nook.tasks.showAllLevels.${BA}`) === null);
    expect(api.calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([{ showAllLevels: true }]);
    expect(shown).toBe(true);
    expect(readLocalShowAll(BA)).toBeNull();
  });

  test("refresh fetches as many cards as are loaded, behind what is on screen", async () => {
    const page = (titles: string[]) => ({ query: "assignee:me", cards: titles.map((title) => card(title)), nextCursor: null, total: titles.length });
    clearCardQueryCache();
    let answer = page(["a", "b"]);
    const api = mockApi({ "POST /tasks/query": () => answer });
    let result: ReturnType<typeof useCardQuery> | null = null;
    const source = { kind: "query" as const, request: { q: "assignee:me", sort: "due" as const, group: "none" as const, tz: "UTC" } };
    function Probe() {
      result = useCardQuery(source);
      return <p>{result.status}:{result.cards.map((item) => item.id).join(",")}</p>;
    }
    const view = await render(<Probe />);
    await view.waitFor(() => view.container.textContent === "ready:a,b");
    answer = page(["a", "c"]);
    await act(async () => { await result!.refresh(); });
    await view.waitFor(() => view.container.textContent === "ready:a,c");
    expect(api.calls.map((call) => (call.body as { limit: number }).limit)).toEqual([50, 50]);
  });
});

describe("swimlanes (D655, D656) and the Board field (D661)", () => {
  const columns: BoardColumn[] = [
    { id: "c1", board_id: BA, name: "To do", position: 1, is_done: 0, wip_limit: null, created_at: "", updated_at: "" },
    { id: "c2", board_id: BA, name: "Done", position: 2, is_done: 1, wip_limit: 1, created_at: "", updated_at: "" }
  ];
  const summary = (id: string, extra: Partial<CardSummary>) => ({ id, board_id: BA, column_id: "c1", position: 1, title: `Card ${id}`, revision: 1, assignees: [], tag_ids: [], flags: [], ...extra }) as unknown as CardSummary;
  const cards = [summary("k1", { assignees: [person(ME, "Asha")] }), summary("k2", { column_id: "c2", assignees: [person(ME, "Asha"), person(YOU, "Ben")] }), summary("k3", {})];

  test("rows by person across the columns, a collapsed row and column, and the phone pages", () => {
    const noop = () => undefined;
    const props = { mode: "assignee" as const, columns, statuses: new Map(), cards, allCards: cards, tags: [], today: "2026-10-23", noneLabel: "No assignee",
      onToggleColumn: noop, onToggleRow: noop, readOnly: false, trackRef: createRef<HTMLDivElement>(), onTrackScroll: noop, canEnter: () => true, onDrop: noop, onKeyMove: noop, onOpenCard: noop, onCardMenu: noop };
    const html = renderToStaticMarkup(<BoardSwimlanes {...props} phone={false} collapsedColumns={new Set(["c2"])} collapsedRows={new Set([`a:${YOU}`])} />);
    expect(html).toContain(`data-row-key="a:${ME}"`);
    expect(html).toContain('class="task-swim-row collapsed"');
    expect(html).toContain('aria-label="Expand Done, ');
    expect(html).toContain('class="task-swim-cell collapsed"');
    expect(html.match(/data-card-id="k1"/g)!.length).toBe(1);
    expect(html).toContain(">No assignee</span>");
    const phone = renderToStaticMarkup(<BoardSwimlanes {...props} phone collapsedColumns={new Set()} collapsedRows={new Set()} />);
    expect(phone).toContain("task-swim-page");
    expect(phone).not.toContain('draggable="true"');
  });

  test("swim= round-trips (none only matters in a board view); the Board field widens to more boards", () => {
    expect(parseBoardSearch("?swim=parent").swim).toBe("parent");
    expect(parseBoardSearch("?swim=rows").swim).toBeNull();
    expect(formatBoardSearch(withBoardQuery(DEFAULT_BOARD_QUERY, { swim: "assignee" }))).toBe("?swim=assignee");
    expect(formatBoardSearch(withBoardQuery(DEFAULT_BOARD_QUERY, { swim: "none" }))).toBe("?swim=none");
    const filter = (text: string) => (parse(text, { lenient: true }) as { ok: true; query: Parameters<typeof format>[0] }).query;
    const widened = widenToBoards(filter(`board:${BB} state:todo column:55555555-5555-4555-8555-555555555555`), BA)!;
    expect(format(widened.filter)).toBe(format(filter(`board:${BA},${BB} state:todo`)));
    expect(widened.droppedColumns).toBe(true);
    expect(widenToBoards(filter(`board:${BA} state:todo`), BA)).toBeNull();
    expect(widenToBoards(filter("state:todo"), BA)).toBeNull();
  });
});
