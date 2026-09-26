import { expect, test } from "bun:test";
import { formatRoute, parseRoute } from "../src/router";
import { cardCloseAction, createTasksEntryLog, fullPageAction, hasFromDialogHint, parentTasksRoute, tasksBackAction, tasksRoute, withFromDialogHint } from "../src/tasksRoute";
import { carriedTasksState, columnIndexFor, createTasksHistoryState, readTasksHistoryHint } from "../src/tasksNavigation";
import { DEFAULT_BOARD_QUERY } from "../src/tasks/boardUrl";

const boardId = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const otherBoard = "4f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const cardId = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";

test("Tasks URLs parse strictly and normalise", () => {
  expect(parseRoute("/tasks/")).toEqual(tasksRoute());
  expect(parseRoute(`/tasks/${boardId.toUpperCase()}`)).toEqual(tasksRoute(boardId));
  expect(parseRoute(`/tasks/${boardId}/card/${cardId.toUpperCase()}/`)).toEqual(tasksRoute(boardId, cardId));
  // A malformed board id opens the list; anything malformed after a valid board opens the board.
  expect(parseRoute("/tasks/not-a-board")).toEqual(tasksRoute());
  expect(parseRoute(`/tasks/${boardId}/card/nope`)).toEqual(tasksRoute(boardId));
  expect(parseRoute(`/tasks/${boardId}/cards/${cardId}`)).toEqual(tasksRoute(boardId));
  expect(parseRoute(`/tasks/${boardId}/card/${cardId}/extra`)).toEqual(tasksRoute(boardId));
  expect(parseRoute("/tasksx")).toEqual({ app: "home" });
  // A card never formats without its board.
  expect(tasksRoute(null, cardId)).toEqual(tasksRoute());
  expect(formatRoute({ app: "tasks", boardId: null, cardId })).toBe("/tasks");
  expect(formatRoute({ app: "tasks", boardId: "../x", cardId })).toBe("/tasks");
  expect(formatRoute({ app: "tasks", boardId, cardId: "javascript:x" })).toBe(`/tasks/${boardId}`);
});

test("Back steps card → board → list → Home", () => {
  expect(parentTasksRoute(tasksRoute(boardId, cardId))).toEqual(tasksRoute(boardId));
  expect(parentTasksRoute(tasksRoute(boardId))).toEqual(tasksRoute());
  expect(parentTasksRoute(tasksRoute())).toBeNull();
  // Entries this visit pushed are stepped back through, like the browser's Back.
  expect(tasksBackAction(tasksRoute(boardId, cardId), 3)).toEqual({ kind: "history" });
  // A deep link (depth 0) replaces its entry with the parent view and never leaves Nook.
  expect(tasksBackAction(tasksRoute(boardId, cardId), 0)).toEqual({ kind: "replace", route: tasksRoute(boardId) });
  expect(tasksBackAction(tasksRoute(boardId), 0)).toEqual({ kind: "replace", route: tasksRoute() });
  expect(tasksBackAction(tasksRoute(), 0)).toEqual({ kind: "home" });
});

test("the phone column hint round-trips, is bound to its user and board, and is clamped", () => {
  const state = createTasksHistoryState("user-1", { boardId, column: 2 }, { "mynotes.depth": 4, other: true });
  expect(readTasksHistoryHint(state, "user-1")).toEqual({ boardId, column: 2 });
  expect(readTasksHistoryHint(state, "user-2")).toBeNull();
  expect((state as unknown as Record<string, unknown>)["mynotes.depth"]).toBe(4);
  expect((state as unknown as Record<string, unknown>).other).toBe(true);
  expect(columnIndexFor(state, "user-1", boardId, 5)).toBe(2);
  // Fewer columns now (one was deleted): the last one is shown.
  expect(columnIndexFor(state, "user-1", boardId, 2)).toBe(1);
  expect(columnIndexFor(state, "user-1", otherBoard, 5)).toBe(0);
  expect(columnIndexFor(null, "user-1", boardId, 5)).toBe(0);
  expect(readTasksHistoryHint(createTasksHistoryState("user-1", { boardId, column: 99 }, null), "user-1")?.column).toBe(19);
  expect(readTasksHistoryHint(createTasksHistoryState("user-1", { boardId, column: -3 }, null), "user-1")?.column).toBe(0);
  for (const hint of [{ boardId, column: 1.5 }, { boardId, column: 20 }, { boardId, column: "1" }, { column: 1 }, null]) {
    expect(readTasksHistoryHint({ "mynotes.tasks-navigation": { version: 1, userId: "user-1", hint } }, "user-1")).toBeNull();
  }
  expect(readTasksHistoryHint({ "mynotes.tasks-navigation": { version: 2, userId: "user-1", hint: { boardId, column: 1 } } }, "user-1")).toBeNull();
});

test("a history write on the same board keeps the column hint, another board drops it", () => {
  const state = createTasksHistoryState("user-1", { boardId, column: 3 }, null);
  expect(readTasksHistoryHint(carriedTasksState("user-1", boardId, state), "user-1")).toEqual({ boardId, column: 3 });
  expect(carriedTasksState("user-1", otherBoard, state)).toBeNull();
  expect(carriedTasksState("user-1", null, state)).toBeNull();
  expect(carriedTasksState("user-2", boardId, state)).toBeNull();
});

test("/card/:k/full opens the card as a page and round-trips; malformed input falls back", () => {
  const full = tasksRoute(boardId, cardId, true);
  expect(full).toEqual({ app: "tasks", boardId, cardId, full: true });
  expect(formatRoute(full)).toBe(`/tasks/${boardId}/card/${cardId}/full`);
  expect(parseRoute(`/tasks/${boardId.toUpperCase()}/card/${cardId.toUpperCase()}/full/`)).toEqual(full);
  // The dialog route carries no full key at all (existing equality checks keep working).
  expect("full" in tasksRoute(boardId, cardId)).toBe(false);
  expect("full" in parseRoute(`/tasks/${boardId}/card/${cardId}`)).toBe(false);
  // Anything else after the card, or a bad card id, opens the board; a page needs a card.
  expect(parseRoute(`/tasks/${boardId}/card/${cardId}/page`)).toEqual(tasksRoute(boardId));
  expect(parseRoute(`/tasks/${boardId}/card/${cardId}/full/x`)).toEqual(tasksRoute(boardId));
  expect(parseRoute(`/tasks/${boardId}/card/nope/full`)).toEqual(tasksRoute(boardId));
  expect(parseRoute(`/tasks/${boardId}/full`)).toEqual(tasksRoute(boardId));
  expect(tasksRoute(boardId, null, true)).toEqual(tasksRoute(boardId));
  expect(tasksRoute(null, cardId, true)).toEqual(tasksRoute());
  expect(formatRoute({ app: "tasks", boardId, cardId: "javascript:x", full: true })).toBe(`/tasks/${boardId}`);
});

test("in-app Back from a deep-linked page steps page → dialog → board → list → Home without leaving Nook", () => {
  const full = tasksRoute(boardId, cardId, true);
  expect(parentTasksRoute(full)).toEqual(tasksRoute(boardId, cardId));
  expect(tasksBackAction(full, 0)).toEqual({ kind: "replace", route: tasksRoute(boardId, cardId) });
  expect(tasksBackAction(tasksRoute(boardId, cardId), 0)).toEqual({ kind: "replace", route: tasksRoute(boardId) });
  expect(tasksBackAction(full, 2)).toEqual({ kind: "history" });
});

test("Collapse and Close on the page step back with the Expand hint, and replace without it", () => {
  const full = tasksRoute(boardId, cardId, true);
  const hinted = withFromDialogHint({ "mynotes.depth": 2, other: 1 });
  expect(hasFromDialogHint(hinted)).toBe(true);
  expect((hinted as Record<string, unknown>).other).toBe(1);
  expect(hasFromDialogHint({ "mynotes.tasks.fromDialog": "yes" })).toBe(false);
  expect(hasFromDialogHint(null)).toBe(false);
  // Board (depth 0) → dialog (1) → Expand (2): Collapse is one back, Close two back.
  expect(fullPageAction("collapse", full, hinted, 2)).toEqual({ kind: "history", delta: -1 });
  expect(fullPageAction("close", full, hinted, 2)).toEqual({ kind: "history", delta: -2 });
  // A deep-linked dialog (depth 0) expanded to depth 1: Close cannot step two back, so it replaces.
  expect(fullPageAction("collapse", full, hinted, 1)).toEqual({ kind: "history", delta: -1 });
  expect(fullPageAction("close", full, hinted, 1)).toEqual({ kind: "replace", route: tasksRoute(boardId) });
  // No hint (a deep link to /full, or a page opened another way): replace, never leave Nook.
  expect(fullPageAction("collapse", full, { "mynotes.depth": 3 }, 3)).toEqual({ kind: "replace", route: tasksRoute(boardId, cardId) });
  expect(fullPageAction("close", full, null, 0)).toEqual({ kind: "replace", route: tasksRoute(boardId) });
});

test("closing a card steps back only onto an entry this Tasks visit saw; otherwise it replaces with the board (review L6c)", () => {
  const card = tasksRoute(boardId, cardId);
  const board = formatRoute(tasksRoute(boardId));
  // Opened from the board in this visit: Back parity.
  const log = createTasksEntryLog();
  log.note(3, board, false);
  log.note(4, formatRoute(card), true);
  expect(cardCloseAction(card, 4, log)).toEqual({ kind: "history" });
  // Opened from Notifications (another app's entry below), or after a reload: this visit never saw
  // the entry below, so history.back() would leave Tasks (and its Undo toast). Replace instead.
  const fromElsewhere = createTasksEntryLog();
  fromElsewhere.note(4, formatRoute(card), false);
  expect(cardCloseAction(card, 4, fromElsewhere)).toEqual({ kind: "replace", route: tasksRoute(boardId) });
  // A deep link at depth 0 replaces too, keeping the board's query.
  const query = { ...DEFAULT_BOARD_QUERY, view: "list" as const };
  const filtered = tasksRoute(boardId, cardId, false, query);
  expect(cardCloseAction(filtered, 0, log)).toEqual({ kind: "replace", route: tasksRoute(boardId, null, false, query) });
  // A write drops what the log knew above it (a push discards the forward entries).
  log.note(5, "/tasks/other", true);
  log.note(3, board, true);
  expect(log.urlAt(4)).toBeUndefined();
  expect(log.urlAt(5)).toBeUndefined();
  expect(log.urlAt(3)).toBe(board);
});
