import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardTimeline } from "../src/tasks/BoardTimeline";
import { VIEW_CHOICES } from "../src/tasks/BoardViewSwitch";
import { boardData, type BoardCard } from "../src/tasks/boardQuery";
import { formatBoardSearch, parseBoardSearch } from "../src/tasks/boardUrl";
import { boardLayoutOf, displayLayoutOf, homeLayoutOf } from "../src/tasks/views/boardViewModel";
import {
  barGeometry, barLabel, barOf, clampDelta, createChange, DAY_WIDTH, dayAtOffset, dayWidthFor, dragChange, durationLabel, extendRange, headerRows,
  initialRange, keyboardDrag, MAX_RANGE_DAYS, mondayOf, offscreenSide, OPEN_BAR_DAYS, pixelsToDays, previewBar, rangeHolding, rowWindow, timelineRows,
  visibleTitle, weekdayOf, zoomStep, type TimelineBar
} from "../src/tasks/timelinePlacement";
import type { CardSummary } from "../src/tasks/tasksApi";

// Board timeline (docs/plan/TASK_VIEWS.md §Timeline, D760–D769): placement math and a render.
const todo = "aaaaaaaa-0000-4000-8000-000000000001";
const doing = "aaaaaaaa-0000-4000-8000-000000000002";
const done = "aaaaaaaa-0000-4000-8000-000000000003";
const card = (id: string, change: Record<string, unknown> = {}) => ({
  id, board_id: "b", column_id: todo, position: 1, title: id, has_description: 0, revision: 1, created_by: "u", creator_name: "Me",
  due_on: null, assignees: [], assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0,
  created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-02T00:00:00.000Z", ...change
}) as CardSummary;
const zone = "UTC";

test("bars: a range from start to due, a milestone on the due day, an open bar from a start, none without dates", () => {
  expect(barOf(card("r", { start_on: "2026-11-10", due_on: "2026-11-12" }), zone)).toEqual({ kind: "range", start: "2026-11-10", end: "2026-11-12" });
  expect(barOf(card("m", { due_on: "2026-11-12" }), zone)).toEqual({ kind: "milestone", start: "2026-11-12", end: "2026-11-12" });
  expect(barOf(card("o", { start_on: "2026-11-10" }), zone)).toEqual({ kind: "open", start: "2026-11-10", end: null });
  expect(barOf(card("n"), zone)).toBeNull();
  // A stored start after the due day (an older row) draws from the due day.
  expect(barOf(card("x", { start_on: "2026-11-14", due_on: "2026-11-12" }), zone)).toEqual({ kind: "range", start: "2026-11-12", end: "2026-11-12" });
});

test("timed starts and dues sit on the viewer's local day", () => {
  // 23:30 on 6 March at UTC+14 is 09:30 UTC; 21:30 on 5 March at UTC−12.
  const timed = card("t", { due_on: "2026-03-06", due_time: "23:30", due_tz: "Pacific/Kiritimati", due_at: "2026-03-06T09:30:00.000Z",
    start_on: "2026-03-04", start_time: "23:30", start_tz: "Pacific/Kiritimati", start_at: "2026-03-04T09:30:00.000Z" });
  expect(barOf(timed, "Etc/GMT+12")).toEqual({ kind: "range", start: "2026-03-03", end: "2026-03-05" });
  expect(barOf(timed, "Pacific/Kiritimati")).toEqual({ kind: "range", start: "2026-03-04", end: "2026-03-06" });
});

test("durations and labels", () => {
  expect(durationLabel({ kind: "range", start: "2026-11-10", end: "2026-11-12" })).toBe("3 days");
  expect(durationLabel({ kind: "milestone", start: "2026-11-12", end: "2026-11-12" })).toBe("1 day");
  expect(durationLabel({ kind: "open", start: "2026-11-12", end: null })).toBe("Open");
  expect(durationLabel(null)).toBe("");
  expect(barLabel({ kind: "range", start: "2026-11-10", end: "2026-11-12" })).toBe("Nov 10 → Nov 12 · 3 days");
  expect(barLabel({ kind: "milestone", start: "2026-11-12", end: "2026-11-12" })).toBe("Due Nov 12");
  expect(barLabel({ kind: "open", start: "2026-11-12", end: null })).toBe("From Nov 12");
});

test("ranges start on a Monday, grow at either edge, and stay bounded", () => {
  expect(weekdayOf("2026-11-13")).toBe(5);
  expect(mondayOf("2026-11-13")).toBe("2026-11-09");
  expect(mondayOf("2026-11-09")).toBe("2026-11-09");
  const range = initialRange("2026-11-13", "month");
  expect(weekdayOf(range.from)).toBe(1);
  expect(range.from <= "2026-10-02").toBe(true);
  const before = extendRange(range, "before", 84);
  expect(before.added).toBe(84);
  expect(weekdayOf(before.range.from)).toBe(1);
  expect(before.range.days).toBe(range.days + 84);
  const after = extendRange(range, "after", 84);
  expect(after.range.from).toBe(range.from);
  expect(after.range.days).toBe(range.days + 84);
  expect(extendRange({ from: range.from, days: MAX_RANGE_DAYS }, "after", 84)).toEqual({ range: { from: range.from, days: MAX_RANGE_DAYS }, added: 0 });
  // Holding a far day grows the range toward it (on a Monday at the left).
  const held = rangeHolding(range, "2026-01-05", 14);
  expect(held.added).toBeGreaterThan(0);
  expect(weekdayOf(held.range.from)).toBe(1);
  expect(held.range.from <= "2025-12-22").toBe(true);
  expect(rangeHolding(range, "2026-11-13", 7)).toEqual({ range, added: 0 });
  const later = rangeHolding(range, "2027-06-01", 10);
  expect(later.range.from).toBe(range.from);
  expect(later.added).toBe(0);
});

test("geometry: pixels per day by zoom, clipping at the range's edges, nothing outside it", () => {
  const range = { from: "2026-11-02", days: 28 };
  expect(barGeometry({ kind: "range", start: "2026-11-04", end: "2026-11-06" }, range, DAY_WIDTH.month)).toEqual({ left: 2 * 34, width: 3 * 34, clippedStart: false, clippedEnd: false });
  expect(barGeometry({ kind: "range", start: "2026-11-04", end: "2026-11-06" }, range, DAY_WIDTH.week).left).toBe(2 * 64);
  expect(barGeometry({ kind: "range", start: "2026-11-04", end: "2026-11-06" }, range, DAY_WIDTH.quarter).width).toBe(3 * 13);
  expect(barGeometry({ kind: "range", start: "2026-10-20", end: "2026-11-03" }, range, 10)).toEqual({ left: 0, width: 20, clippedStart: true, clippedEnd: false });
  expect(barGeometry({ kind: "range", start: "2026-11-28", end: "2026-12-10" }, range, 10)).toEqual({ left: 260, width: 20, clippedStart: false, clippedEnd: true });
  expect(barGeometry({ kind: "milestone", start: "2026-12-10", end: "2026-12-10" }, range, 10)).toBeNull();
  expect(barGeometry({ kind: "open", start: "2026-11-02", end: null }, range, 10)).toEqual({ left: 0, width: OPEN_BAR_DAYS * 10, clippedStart: false, clippedEnd: false });
  expect(DAY_WIDTH.week > DAY_WIDTH.month && DAY_WIDTH.month > DAY_WIDTH.quarter).toBe(true);
  expect(dayWidthFor("month", true)).toBeLessThan(dayWidthFor("month", false));
});

test("off-screen sides, pixel snapping, and the day under the pointer", () => {
  const bar: TimelineBar = { kind: "range", start: "2026-11-04", end: "2026-11-06" };
  expect(offscreenSide(bar, "2026-11-07", "2026-11-30")).toBe("before");
  expect(offscreenSide(bar, "2026-10-01", "2026-11-03")).toBe("after");
  expect(offscreenSide(bar, "2026-11-06", "2026-11-30")).toBeNull();
  expect(offscreenSide({ kind: "open", start: "2026-11-01", end: null }, "2026-11-04", "2026-11-30")).toBeNull();
  expect(pixelsToDays(16, 34)).toBe(0);
  expect(pixelsToDays(18, 34)).toBe(1);
  expect(pixelsToDays(-52, 34)).toBe(-2);
  expect(pixelsToDays(-10, 34)).toBe(0);
  const range = { from: "2026-11-02", days: 28 };
  expect(dayAtOffset(range, 0, 34)).toBe("2026-11-02");
  expect(dayAtOffset(range, 35, 34)).toBe("2026-11-03");
  expect(dayAtOffset(range, -50, 34)).toBe("2026-11-02");
  expect(dayAtOffset(range, 99_999, 34)).toBe("2026-11-29");
});

test("drags move civil dates by whole days and clamp so the start never passes the due day", () => {
  const ranged = card("r", { start_on: "2026-11-10", due_on: "2026-11-12" });
  const bar = barOf(ranged, zone)!;
  expect(dragChange(ranged, bar, "move", 3)).toEqual({ startOn: "2026-11-13", dueOn: "2026-11-15" });
  expect(dragChange(ranged, bar, "move", 0)).toBeNull();
  expect(dragChange(ranged, bar, "start", -2)).toEqual({ startOn: "2026-11-08" });
  // Past the due day: clamped to it.
  expect(clampDelta(bar, "start", 9)).toBe(2);
  expect(dragChange(ranged, bar, "start", 9)).toEqual({ startOn: "2026-11-12" });
  expect(dragChange(ranged, bar, "end", -9)).toEqual({ dueOn: "2026-11-10" });
  expect(dragChange(ranged, bar, "end", 4)).toEqual({ dueOn: "2026-11-16" });
  expect(previewBar(bar, "start", 9)).toEqual({ kind: "range", start: "2026-11-12", end: "2026-11-12" });
  expect(previewBar(bar, "end", -9)).toEqual({ kind: "range", start: "2026-11-10", end: "2026-11-10" });

  // A milestone moves its due; its start handle adds a start before it (never after).
  const milestone = card("m", { due_on: "2026-11-12" });
  const point = barOf(milestone, zone)!;
  expect(dragChange(milestone, point, "move", -1)).toEqual({ dueOn: "2026-11-11" });
  expect(dragChange(milestone, point, "start", -3)).toEqual({ startOn: "2026-11-09" });
  expect(dragChange(milestone, point, "start", 2)).toBeNull();
  expect(previewBar(point, "start", -3)).toEqual({ kind: "range", start: "2026-11-09", end: "2026-11-12" });

  // An open bar moves its start; its end handle sets a due date where it lands.
  const open = card("o", { start_on: "2026-11-10" });
  const openBar = barOf(open, zone)!;
  expect(dragChange(open, openBar, "move", 2)).toEqual({ startOn: "2026-11-12" });
  expect(dragChange(open, openBar, "end", 0)).toEqual({ dueOn: "2026-11-14" });
  expect(dragChange(open, openBar, "end", -10)).toEqual({ dueOn: "2026-11-10" });

  // A timed card shifts its civil dates; times and zones are the server's to keep.
  const timed = card("t", { due_on: "2026-03-06", due_time: "23:30", due_tz: "Pacific/Kiritimati", due_at: "2026-03-06T09:30:00.000Z" });
  expect(dragChange(timed, barOf(timed, "Etc/GMT+12")!, "move", 1)).toEqual({ dueOn: "2026-03-07" });
});

test("scheduling an empty row, keys, zoom steps, and rows", () => {
  expect(createChange("2026-11-12", "2026-11-09")).toEqual({ startOn: "2026-11-09", dueOn: "2026-11-12" });
  expect(createChange("2026-11-12", "2026-11-12")).toEqual({ startOn: "2026-11-12", dueOn: "2026-11-12" });
  expect(keyboardDrag("ArrowRight", false)).toEqual({ mode: "move", delta: 1 });
  expect(keyboardDrag("ArrowLeft", true)).toEqual({ mode: "end", delta: -1 });
  expect(keyboardDrag("ArrowUp", false)).toBeNull();
  expect(zoomStep("month", -1)).toBe("week");
  expect(zoomStep("week", -1)).toBe("week");
  expect(zoomStep("month", 1)).toBe("quarter");
  expect(zoomStep("quarter", 1)).toBe("quarter");
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];
  expect(timelineRows(cards, null, new Set()).map((row) => row.key)).toEqual(["a", "b", "c"]);
  const groups = [{ key: "x", label: "X", items: [{ card: cards[0]! }, { card: cards[1]! }] }, { key: "y", label: "Y", items: [{ card: cards[1]! }] }];
  expect(timelineRows(cards, groups, new Set(["y"])).map((row) => row.key)).toEqual(["group:x", "x:a", "x:b", "group:y"]);
  expect(rowWindow(0, 400, 40, 1000)).toEqual({ first: 0, last: 16 });
  expect(rowWindow(4000, 400, 40, 1000)).toEqual({ first: 94, last: 116 });
  expect(rowWindow(0, 400, 40, 0)).toEqual({ first: 0, last: -1 });
});

test("headers: months over days with weekday initials, or weeks at Quarter, built only for the window", () => {
  const range = { from: "2026-10-26", days: 70 };
  const month = headerRows(range, "month", "2026-11-13", 0, 13);
  expect(month.top.map((span) => [span.label, span.start, span.days])).toEqual([["Oct 2026", 0, 6], ["Nov 2026", 6, 30]]);
  expect(month.bottom).toHaveLength(14);
  expect(month.bottom[0]).toMatchObject({ label: "26", sub: "M", weekend: false });
  expect(month.bottom[5]).toMatchObject({ label: "31", sub: "S", weekend: true });
  const today = headerRows(range, "week", "2026-11-13", 15, 20).bottom.find((tick) => tick.today);
  expect(today?.key).toBe("2026-11-13");
  expect(headerRows(range, "week", "2026-11-13", 0, 3).top[0]!.label).toBe("October 2026");
  const quarter = headerRows(range, "quarter", "2026-11-13", 0, 69);
  expect(quarter.bottom.map((tick) => tick.key).slice(0, 3)).toEqual(["2026-10-26", "2026-11-02", "2026-11-09"]);
  expect(quarter.bottom.every((tick) => tick.days <= 7)).toBe(true);
  expect(quarter.bottom.find((tick) => tick.today)?.key).toBe("2026-11-09");
  expect(visibleTitle("2026-11-02", "2026-11-28")).toBe("November 2026");
  expect(visibleTitle("2026-11-20", "2026-12-28")).toBe("Nov – Dec 2026");
  expect(visibleTitle("2026-12-20", "2027-01-08")).toBe("Dec 2026 – Jan 2027");
});

test("the timeline is a board view in the URL, the switch, and saved views", () => {
  expect(VIEW_CHOICES.map((choice) => choice.id)).toContain("timeline");
  expect(parseBoardSearch("?view=timeline&zoom=week")).toMatchObject({ view: "timeline", zoom: "week" });
  expect(parseBoardSearch("?view=timeline&zoom=month").zoom).toBeNull();
  expect(parseBoardSearch("?view=timeline&zoom=decade").zoom).toBeNull();
  expect(formatBoardSearch(parseBoardSearch("?zoom=quarter&view=timeline&group=assignee"))).toBe("?view=timeline&group=assignee&zoom=quarter");
  expect(boardLayoutOf({ layout: "timeline" })).toBe("timeline");
  expect(displayLayoutOf("timeline", "list")).toBe("timeline");
  expect(displayLayoutOf("calendar", "timeline")).toBe("timeline");
  expect(homeLayoutOf("timeline")).toBe("list");
});

const board = boardData({
  columns: [
    { id: todo, board_id: "b", name: "To do", position: 1, is_done: 0, state: "todo", created_at: "", updated_at: "" },
    { id: doing, board_id: "b", name: "Doing", position: 2, is_done: 0, state: "doing", created_at: "", updated_at: "" },
    { id: done, board_id: "b", name: "Done", position: 3, is_done: 1, state: "done", created_at: "", updated_at: "" }
  ] as never,
  cards: [
    card("Launch <b>brief</b>", { start_on: "2026-11-10", due_on: "2026-11-14" }),
    card("Press kit", { due_on: "2026-11-18" }),
    card("Localise", { start_on: "2026-11-12", column_id: doing }),
    card("Someday"),
    card("Shipped", { start_on: "2026-11-01", due_on: "2026-11-05", column_id: done })
  ]
});
const render = (props: Partial<Parameters<typeof BoardTimeline>[0]> = {}) => renderToStaticMarkup(<BoardTimeline board={board} cards={board.cards as BoardCard[]} groups={null} group={null}
  scale="month" today="2026-11-13" viewerZone={zone} onGroup={() => undefined} onScale={() => undefined} onOpenCard={() => undefined} onChangeDates={() => undefined}
  onAddCard={() => undefined} filtered={false} {...props} />);

test("the timeline renders rows, bars by kind and state, durations, zoom, and Add a card; read-only has no handles", () => {
  const html = render();
  expect(html).toContain('role="radiogroup" aria-label="Zoom"');
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain("Launch &lt;b&gt;brief&lt;/b&gt;");
  expect(html).not.toContain("<b>brief</b>");
  expect(html).toContain("task-tl-bar range status-todo");
  expect(html).toContain("task-tl-bar milestone status-todo");
  expect(html).toContain("task-tl-bar open status-doing");
  expect(html).toContain("status-done");
  expect(html).toContain("5 days");
  expect(html).toContain("Open");
  expect(html).toContain("Add a card");
  expect(html).toContain("task-tl-today-col");
  expect(html).toContain('data-open-card="Someday"');
  // Handles and the "+" ghost need a fine pointer and edit rights (server render: a fine pointer).
  expect(html).toContain("task-tl-handle start");
  expect(html).toContain("task-tl-ghost");
  const readOnly = render({ readOnly: true, onAddCard: undefined });
  expect(readOnly).not.toContain("task-tl-handle");
  expect(readOnly).not.toContain("task-tl-ghost");
  expect(readOnly).not.toContain("Add a card");
  expect(readOnly).toContain('aria-roledescription="Bar"');
  expect(render({ cards: [], filtered: true })).toContain("No cards match these filters.");
});

test("grouped rows have collapsible headers with counts", () => {
  const groups = [{ key: todo, label: "To do", items: [{ card: board.cards[0]!, also: [] }, { card: board.cards[1]!, also: [] }] }];
  const html = render({ groups, group: "column" });
  expect(html).toContain("task-tl-group-row");
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain(">To do<");
  expect(html).toContain("Group: Column");
});
