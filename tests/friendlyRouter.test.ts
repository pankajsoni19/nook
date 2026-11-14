import { afterEach, describe, expect, test } from "bun:test";
import { formatRoute, parseRoute, sameRoute, type Route } from "../src/router";
import { boardIdForCode, cardForKey, clearRouteNames, nameBoard, nameCard, nameDocuments, nameItems, withoutRouteNames } from "../src/routeNames";
import { nameNotes, resolveNotesRoute, notesRoute } from "../src/notesRoute";
import { parentTasksRoute, tasksRoute } from "../src/tasksRoute";
import { safeNotificationPath } from "../src/notifications/notificationsApi";
import { canonicalizeLocation } from "../src/friendlyLinks";
import { withBoardQuery, DEFAULT_BOARD_QUERY } from "../src/tasks/boardUrl";

/**
 * Friendly URLs in the app's router (docs/plan/FRIENDLY_URLS.md, D773–D781): every new URL shape
 * formats from ids once the tab knows the names and parses back to the same route; a stale slug, a
 * missing folder, a UUID link, an old card key, and a former board code all read as the item and
 * format as the current URL; a URL the tab cannot name yet is a pending link that formats unchanged.
 */

const note = "0b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f70";
const folder = "1b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f71";
const file = "2b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f72";
const whiteboard = "3b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f73";
const collection = "4b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f74";
const report = "5b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f75";
const board = "6b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f76";
const card = "7b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f77";
const otherBoard = "8b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f78";
const view = "9b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f79";
const row = "ab8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f7a";

afterEach(() => clearRouteNames());

const flush = () => new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
/** Format, parse back, and check the route survives the round trip. */
function roundTrip(route: Route, url: string) {
  expect(formatRoute(route)).toBe(url);
  const parsed = parseRoute(url);
  expect(sameRoute(parsed, route)).toBe(true);
  return parsed;
}

describe("notes (D776)", () => {
  test("/notes/<folder>/<title>-<shortid>; a stale slug, a wrong folder, no folder, and the UUID all open the note", () => {
    expect(formatRoute(notesRoute("all", note))).toBe(`/notes/${note}`);
    nameNotes([{ id: folder, name: "Engineering" }], [{ id: note, short_id: "3f9x2ab01k", title: "Release checklist", folder_id: folder }]);
    roundTrip(notesRoute("all", note), "/notes/engineering/release-checklist-3f9x2ab01k");
    for (const url of ["/notes/old-folder/old-title-3f9x2ab01k", "/notes/release-checklist-3f9x2ab01k", "/notes/3f9x2ab01k", `/notes/${note}`, "/notes/Engineering/Release-Checklist-3F9X2AB01K", "/notes/folder/release-checklist-3f9x2ab01k"]) {
      expect(parseRoute(url)).toEqual({ app: "notes", folder: "all", noteId: note });
    }
    // The folder list and Shared keep their URLs.
    roundTrip(notesRoute(folder, null), `/notes/folder/${folder}`);
    roundTrip(notesRoute("shared", null), "/notes/shared");
    // A rename (of the note or its folder) changes the URL; the short id stays.
    nameNotes([{ id: folder, name: "Platform" }], [{ id: note, short_id: "3f9x2ab01k", title: "Launch checklist v2", folder_id: folder }]);
    expect(formatRoute(notesRoute("all", note))).toBe("/notes/platform/launch-checklist-v2-3f9x2ab01k");
    // No folder (or one the reader cannot see), and a title that slugs to nothing.
    nameNotes([], [{ id: note, short_id: "3f9x2ab01k", title: "日本語", folder_id: null }]);
    roundTrip(notesRoute("all", note), "/notes/untitled-3f9x2ab01k");
  });

  test("a short id the tab cannot name is pending; Notes finds it in the loaded list, or says Note not found", () => {
    const route = parseRoute("/notes/engineering/release-checklist-3f9x2ab01k");
    expect(route).toEqual({ app: "notes", folder: "all", noteId: null, pending: { kind: "note", ref: "3f9x2ab01k", url: "/notes/engineering/release-checklist-3f9x2ab01k" } });
    expect(formatRoute(route)).toBe("/notes/engineering/release-checklist-3f9x2ab01k");
    const data = { folders: [{ id: folder }], notes: [{ id: note, folder_id: folder, is_owner: 1, short_id: "3f9x2ab01k" }] };
    const context = { snapshot: null, lastFolder: "all" as const };
    expect(resolveNotesRoute(route as ReturnType<typeof notesRoute>, data, context)).toEqual({ folder, noteId: note, missing: null });
    // Unreadable is not in the list: exactly "not found", like an unknown id (T490).
    expect(resolveNotesRoute(parseRoute("/notes/x-9zzzzzzzzz") as ReturnType<typeof notesRoute>, data, context)).toEqual({ folder: "all", noteId: null, missing: "note" });
  });
});

describe("files, whiteboards, collections, reports (D777–D779)", () => {
  test("each formats by slug and short id and parses back; stale slugs and UUIDs still open the item", () => {
    nameDocuments([{ id: file, short_id: "1aaaaaaaaa", name: "Q3 report.pdf", kind: "file" }, { id: whiteboard, short_id: "2bbbbbbbbb", name: "Launch map.excalidraw", kind: "whiteboard" }]);
    nameItems("collection", [{ id: collection, short_id: "3ccccccccc", name: "Hiring pipeline" }]);
    nameItems("report", [{ id: report, shortId: "4ddddddddd", title: "Weekly signups" }]);
    roundTrip({ app: "files", folder: "all", documentId: file }, "/files/q3-report-pdf-1aaaaaaaaa");
    roundTrip({ app: "whiteboards", folder: "all", boardId: whiteboard }, "/whiteboards/launch-map-2bbbbbbbbb");
    roundTrip({ app: "collections", collectionId: collection, viewId: null, rowId: null }, "/collections/hiring-pipeline-3ccccccccc");
    roundTrip({ app: "collections", collectionId: collection, viewId: view, rowId: null }, `/collections/hiring-pipeline-3ccccccccc/view/${view}`);
    roundTrip({ app: "collections", collectionId: collection, viewId: null, rowId: row }, `/collections/hiring-pipeline-3ccccccccc/row/${row}`);
    roundTrip({ app: "reports", reportId: report }, "/reports/weekly-signups-4ddddddddd");
    roundTrip({ app: "reports", reportId: report, params: { period: ["7d"] } }, "/reports/weekly-signups-4ddddddddd?p.period=7d");
    expect(parseRoute("/files/old-name-1aaaaaaaaa")).toEqual({ app: "files", folder: "all", documentId: file });
    expect(parseRoute(`/whiteboards/${whiteboard}`)).toEqual({ app: "whiteboards", folder: "all", boardId: whiteboard });
    expect(parseRoute("/collections/x-3ccccccccc/row/" + row)).toEqual({ app: "collections", collectionId: collection, viewId: null, rowId: row });
    // The lists keep their URLs; a word is never an item.
    expect(parseRoute("/reports/favorites")).toEqual({ app: "reports", reportId: null, folder: "favorites" });
    expect(parseRoute("/reports/unfiled")).toEqual({ app: "reports", reportId: null, folder: "unfiled" });
    expect(parseRoute("/files/shared")).toEqual({ app: "files", folder: "shared", documentId: null });
    // Not named yet: pending, formatted unchanged.
    for (const [url, app, kind] of [["/files/a-9aaaaaaaaa", "files", "file"], ["/whiteboards/a-9aaaaaaaaa", "whiteboards", "whiteboard"], ["/collections/a-9aaaaaaaaa/row/" + row, "collections", "collection"], ["/reports/a-9aaaaaaaaa?p.x=1", "reports", "report"]] as const) {
      const route = parseRoute(url);
      expect(route.app).toBe(app);
      expect("pending" in route && route.pending).toEqual({ kind, ref: "9aaaaaaaaa", url });
      expect(formatRoute(route)).toBe(url);
    }
  });
});

describe("tasks (D781)", () => {
  test("boards by code, cards by key (dialog, page, under a saved view), with the board's query; UUID links canonicalize", () => {
    const table = withBoardQuery(DEFAULT_BOARD_QUERY, { view: "table" });
    expect(formatRoute(tasksRoute(board, card))).toBe(`/tasks/${board}/card/${card}`);
    nameBoard(board, "KAN");
    nameCard(card, "KAN-1", board);
    roundTrip(tasksRoute(board), "/tasks/KAN");
    roundTrip(tasksRoute(board, null, false, table), "/tasks/KAN?view=table");
    roundTrip({ ...tasksRoute(board), sprints: true }, "/tasks/KAN/sprints");
    roundTrip(tasksRoute(board, card), "/tasks/KAN-1");
    roundTrip(tasksRoute(board, card, true), "/tasks/KAN-1/full");
    roundTrip(tasksRoute(board, card, false, table), "/tasks/KAN-1?view=table");
    roundTrip(tasksRoute(board, null, false, null, { viewId: view }), `/tasks/KAN/views/${view}`);
    roundTrip(tasksRoute(board, card, false, null, { viewId: view }), `/tasks/KAN/views/${view}/card/KAN-1`);
    // Old long links, lower-case keys and codes, and a board's UUID read as the same routes.
    expect(sameRoute(parseRoute(`/tasks/${board}/card/${card}`), tasksRoute(board, card))).toBe(true);
    expect(formatRoute(parseRoute(`/tasks/${board}/card/${card}/full`))).toBe("/tasks/KAN-1/full");
    expect(formatRoute(parseRoute("/tasks/kan-1"))).toBe("/tasks/KAN-1");
    expect(formatRoute(parseRoute("/tasks/kan"))).toBe("/tasks/KAN");
    expect(formatRoute(parseRoute(`/tasks/${board}`))).toBe("/tasks/KAN");
    // The home segments keep their words (lower case); a code is matched without case otherwise.
    expect(parseRoute("/tasks/my")).toMatchObject({ home: { section: "my" } });
    expect(parseRoute("/tasks/views")).toMatchObject({ home: { section: "views" } });
  });

  test("a moved card's old key and a board's former code open the current ones", () => {
    nameCard(card, "KAN-1", board);
    // The card moved: its new key is current, the old one an alias (D715).
    nameCard(card, "OPS-3", otherBoard);
    nameCard(card, "KAN-1", otherBoard, { alias: true });
    expect(cardForKey("KAN-1")).toEqual({ cardId: card, boardId: otherBoard });
    expect(formatRoute(parseRoute("/tasks/KAN-1"))).toBe("/tasks/OPS-3");
    // The board's code changed (D714).
    nameBoard(board, "ROAD");
    nameBoard(board, "KAN", { alias: true });
    expect(boardIdForCode("kan")).toBe(board);
    expect(formatRoute(parseRoute("/tasks/KAN/sprints"))).toBe("/tasks/ROAD/sprints");
  });

  test("a code or key the tab cannot name is pending (upper-case key in its URL); Back from it is the board list", () => {
    const keyed = parseRoute("/tasks/kan-7/full?view=table");
    expect(keyed).toEqual({ app: "tasks", boardId: null, cardId: null, pending: { kind: "card", ref: "KAN-7", url: "/tasks/KAN-7/full?view=table" } });
    const coded = parseRoute("/tasks/OPS/views/" + view);
    expect(coded).toEqual({ app: "tasks", boardId: null, cardId: null, pending: { kind: "board", ref: "OPS", url: `/tasks/OPS/views/${view}` } });
    expect(formatRoute(coded)).toBe(`/tasks/OPS/views/${view}`);
    expect(parentTasksRoute(coded as ReturnType<typeof tasksRoute>)).toEqual(tasksRoute());
    // A known board with an unknown card key under a saved view is pending on the card.
    nameBoard(board, "KAN");
    expect(parseRoute(`/tasks/KAN/views/${view}/card/KAN-9`)).toMatchObject({ pending: { kind: "card", ref: "KAN-9" } });
    // Malformed: the board list, as before.
    for (const url of ["/tasks/K", "/tasks/1AB", "/tasks/KAN-012", "/tasks/KAN-1/extra"]) expect(parseRoute(url)).toEqual({ app: "tasks", boardId: null, cardId: null });
  });
});

describe("checks and the address bar (D774)", () => {
  test("a notification's href passes as written, UUID or friendly, whatever the tab knows", () => {
    nameBoard(board, "KAN");
    nameCard(card, "KAN-1", board);
    expect(safeNotificationPath(`/tasks/${board}/card/${card}`)).toBe(`/tasks/${board}/card/${card}`);
    expect(safeNotificationPath("/tasks/KAN-1")).toBe("/tasks/KAN-1");
    expect(safeNotificationPath("/notes/eng/release-3f9x2ab01k")).toBe("/notes/eng/release-3f9x2ab01k");
    expect(safeNotificationPath("/notes/eng/release")).toBe("/notifications");
    expect(withoutRouteNames(() => formatRoute(tasksRoute(board, card)))).toBe(`/tasks/${board}/card/${card}`);
  });

  test("the canonicalizer replaces the entry in place, keeping its state, once the names are known", async () => {
    const calls: Array<{ state: unknown; url: string }> = [];
    const saved = (globalThis as { window?: unknown }).window;
    const fake = {
      location: { pathname: `/tasks/${board}/card/${card}`, search: "?view=table", hash: "" },
      history: { state: { depth: 3 }, replaceState(state: unknown, _title: string, url: string) { calls.push({ state, url }); } }
    };
    (globalThis as { window?: unknown }).window = fake;
    try {
      canonicalizeLocation();
      expect(calls).toEqual([]);
      nameBoard(board, "KAN");
      nameCard(card, "KAN-1", board);
      canonicalizeLocation();
      expect(calls).toEqual([{ state: { depth: 3 }, url: "/tasks/KAN-1?view=table" }]);
      // A notes URL keeps a query it does not own, and the fragment.
      nameNotes([], [{ id: note, short_id: "3f9x2ab01k", title: "Plan", folder_id: null }]);
      fake.location = { pathname: "/notes/stale-3f9x2ab01k", search: "?x=1", hash: "#h" };
      canonicalizeLocation();
      expect(calls[1]).toEqual({ state: { depth: 3 }, url: "/notes/plan-3f9x2ab01k?x=1#h" });
      // Pending or other apps: untouched.
      fake.location = { pathname: "/notes/a-9zzzzzzzzz", search: "", hash: "" };
      canonicalizeLocation();
      fake.location = { pathname: "/settings/mcp", search: "", hash: "" };
      canonicalizeLocation();
      expect(calls.length).toBe(2);
    } finally {
      (globalThis as { window?: unknown }).window = saved;
    }
    await flush();
  });
});
