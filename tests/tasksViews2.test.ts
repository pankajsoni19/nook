import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { resetTaskQueryRateLimit } = await import("../server/tasks/queryRoutes");
const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests, mcpToolSpecs, toolVisible, loadLiveKey } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
type Grant = import("../server/keyGrants").Grant;

/**
 * Views slice 2 (lane VIEWS2, docs/plan/TASK_VIEWS.md D650–D660, T448–T450): grouped lanes and their
 * counts, prefs (grouped-lane trimming, My work's trimming, a board view's own collapse), the board's
 * "Show all levels" and collapsed swimlanes, pinned views, and MCP save_view.
 */

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}
async function board(owner: Session, name: string, template?: string) {
  const created = await call(owner, "POST", "/boards", { name, ...(template ? { template } : {}) });
  expect(created.status).toBe(201);
  return { id: created.body.board.id as string, columns: created.body.columns as Array<{ id: string; name: string; state: string }> };
}
async function card(owner: Session, boardId: string, columnId: string, title: string, extra: Record<string, unknown> = {}) {
  const created = await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title, ...extra });
  expect(created.status).toBe(201);
  return created.body.card as { id: string; revision: number };
}
async function tag(owner: Session, boardId: string, name: string) {
  return (await call(owner, "POST", `/boards/${boardId}/tags`, { name })).body.tag.id as string;
}
const share = (owner: Session, boardId: string, userIds: string[]) => call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds });
const setLevel = (boardId: string, userId: string, level: string) => db.query("UPDATE board_members SET level = ? WHERE board_id = ? AND user_id = ?").run(level, boardId, userId);

beforeEach(() => { resetTaskQueryRateLimit(); resetMcpLimits(); });

describe("grouped lanes (D650, D651)", () => {
  test("assignee lanes: one per person, a card with two people in both, No assignee last, counts over the whole match", async () => {
    const owner = await createUser("Views2 Group lanes owner");
    const mate = await createUser("Views2 Group lanes mate");
    const a = await board(owner, "Group A");
    const b = await board(owner, "Group B");
    await share(owner, a.id, [mate.userId]);
    await card(owner, a.id, a.columns[0]!.id, "Both", { assigneeIds: [owner.userId, mate.userId] });
    await card(owner, a.id, a.columns[0]!.id, "Mine", { assigneeIds: [owner.userId] });
    await card(owner, b.id, b.columns[0]!.id, "Nobody's");
    const result = await call(owner, "POST", "/query", { q: `board:${a.id},${b.id}`, lanes: "assignee", limit: 1 });
    expect(result.status).toBe(200);
    expect(result.body.lanes).toBe("assignee");
    const lanes = result.body.columns as Array<{ key: string; label: string; userId?: string; columns: unknown[] }>;
    expect(lanes.map((lane) => lane.label)).toEqual(["Views2 Group lanes mate", "Views2 Group lanes owner", "No assignee"]);
    expect(lanes.at(-1)!.key).toBe("none:a");
    expect(result.body.laneCounts).toEqual({ [`a:${mate.userId}`]: 1, [`a:${owner.userId}`]: 2, "none:a": 1 });
    // The boards with matches, with the viewer's level (Add a card offers the editable ones, D654).
    expect((result.body.laneBoards as Array<{ id: string; level: string; work_level: number; sprints: boolean }>).map((item) => [item.id, item.level])).toEqual([[a.id, "owner"], [b.id, "owner"]]);
  });

  test("tag lanes merge names across boards and know each board's tag; sprint lanes list open sprints first after Backlog", async () => {
    const owner = await createUser("Views2 Tag lanes owner");
    const a = await board(owner, "Tags A", "scrum");
    const b = await board(owner, "Tags B", "scrum");
    const urgentA = await tag(owner, a.id, "Urgent");
    const urgentB = await tag(owner, b.id, "urgent");
    await tag(owner, b.id, "Unused");
    await card(owner, a.id, a.columns[0]!.id, "A urgent", { tagIds: [urgentA] });
    await card(owner, b.id, b.columns[0]!.id, "B urgent", { tagIds: [urgentB] });
    await card(owner, b.id, b.columns[0]!.id, "B plain");
    const tags = await call(owner, "POST", "/query", { q: `board:${a.id},${b.id}`, lanes: "tag" });
    const tagLanes = tags.body.columns as Array<{ key: string; label: string; targets?: Array<{ id: string; board_id: string }> }>;
    expect(tagLanes.map((lane) => lane.key)).toEqual(["t:urgent", "none:t"]);
    expect(tagLanes[0]!.targets!.map((target) => target.id).sort()).toEqual([urgentA, urgentB].sort());
    expect(tags.body.laneCounts).toEqual({ "t:urgent": 2, "none:t": 1 });

    const sprints = await call(owner, "POST", "/query", { q: `board:${a.id},${b.id}`, lanes: "sprint" });
    const sprintLanes = sprints.body.columns as Array<{ key: string; label: string; targets?: Array<{ board_id: string }> }>;
    // The scrum template's first sprint is on both boards: one merged lane after Backlog, even with no cards in it.
    expect(sprintLanes.map((lane) => lane.key)).toEqual(["none:p", "p:sprint 1"]);
    expect(sprintLanes[1]!.targets!.length).toBe(2);
    expect((sprints.body.laneBoards as Array<{ sprints: boolean }>).every((item) => item.sprints)).toBe(true);
  });

  test("due and board lanes are always there, read-only groupings; too many tags fall back to state lanes", async () => {
    const owner = await createUser("Views2 Due lanes owner");
    const a = await board(owner, "Due A");
    const today = new Date().toISOString().slice(0, 10);
    await card(owner, a.id, a.columns[0]!.id, "Today", { dueOn: today });
    await card(owner, a.id, a.columns[0]!.id, "Undated");
    const due = await call(owner, "POST", "/query", { q: `board:${a.id}`, lanes: "due", tz: "UTC" });
    expect((due.body.columns as Array<{ key: string }>).map((lane) => lane.key)).toEqual(["d:overdue", "d:today", "d:week", "d:later", "d:none"]);
    expect(due.body.laneCounts).toMatchObject({ "d:today": 1, "d:none": 1 });
    const boards = await call(owner, "POST", "/query", { q: `board:${a.id}`, lanes: "board" });
    expect(boards.body.columns).toEqual([{ key: `b:${a.id}`, label: "Due A", columns: [] }]);

    // Twenty tags in use plus No tag is 21 lanes: state lanes instead (no extra users, which other suites count).
    const many = await board(owner, "Many tags");
    for (let index = 0; index < 20; index += 1) await card(owner, many.id, many.columns[0]!.id, `Tagged ${index}`, { tagIds: [await tag(owner, many.id, `Tag ${index}`)] });
    const fallback = await call(owner, "POST", "/query", { q: `board:${many.id}`, lanes: "tag" });
    expect(fallback.body.lanes).toBe("state");
    expect(fallback.body.lanesFallback).toBe(true);
    expect(Object.keys(fallback.body.laneCounts)).toEqual(["s:todo", "s:doing", "s:done"]);
    expect((await call(owner, "GET", `/views/${crypto.randomUUID()}/cards?lanes=rows`)).status).toBe(400);
  }, 30_000);
});

describe("collapsed lanes and a board view's own collapse (D644, D653, D657)", () => {
  test("grouped lanes that are gone are trimmed; My work trims against the filter it sends", async () => {
    const owner = await createUser("Views2 Trim owner");
    const a = await board(owner, "Trim A");
    const urgent = await tag(owner, a.id, "Urgent");
    await card(owner, a.id, a.columns[0]!.id, "Tagged", { tagIds: [urgent], assigneeIds: [owner.userId] });
    const view = (await call(owner, "POST", "/views", { name: "Trim", query: `board:${a.id},${crypto.randomUUID()}` })).body.view;
    const ghost = crypto.randomUUID();
    const saved = await call(owner, "PUT", `/views/${view.id}/prefs`, { collapsedLanes: ["t:urgent", "t:gone", `a:${owner.userId}`, `a:${ghost}`, "none:t", "d:today", "p:sprint 9"] });
    expect(saved.body.collapsedLanes).toEqual(["t:urgent", `a:${owner.userId}`, "none:t", "d:today"]);
    // My work: without q every well-formed key stays; with a filter that has assignee:me, lanes that are gone go.
    const loose = await call(owner, "PUT", "/views/my/prefs", { collapsedLanes: ["t:urgent", "t:gone"] });
    expect(loose.body.collapsedLanes).toEqual(["t:urgent", "t:gone"]);
    const trimmed = await call(owner, "PUT", "/views/my/prefs", { collapsedLanes: ["t:urgent", "t:gone"], q: "assignee:me state:todo,doing" });
    expect(trimmed.body.collapsedLanes).toEqual(["t:urgent"]);
    // A filter without assignee:me is not run (it would scan every board).
    expect((await call(owner, "PUT", "/views/my/prefs", { collapsedLanes: ["t:gone"], q: "state:todo" })).body.collapsedLanes).toEqual(["t:gone"]);
  });

  test("a board view keeps its own collapsed columns and rows only when asked; a cross-board view cannot", async () => {
    const owner = await createUser("Views2 Own collapse owner");
    const a = await board(owner, "Own collapse");
    const view = (await call(owner, "POST", "/views", { name: "On A", query: `board:${a.id} state:todo` })).body.view;
    const first = await call(owner, "GET", `/views/${view.id}/prefs`);
    expect(first.body).toEqual({ collapsedLanes: [], ownCollapse: false, collapsedColumnIds: [], collapsedRows: [] });
    const on = await call(owner, "PUT", `/views/${view.id}/prefs`, { ownCollapse: true, collapsedColumnIds: [a.columns[1]!.id, crypto.randomUUID()], collapsedRows: ["none:a", "bad"] });
    expect(on.body).toMatchObject({ ownCollapse: true, collapsedColumnIds: [a.columns[1]!.id], collapsedRows: ["none:a"] });
    // The board's own prefs are untouched.
    expect((await call(owner, "GET", `/boards/${a.id}`)).body.view.collapsedColumnIds).toEqual([]);
    const cross = (await call(owner, "POST", "/views", { name: "Across", query: "assignee:me" })).body.view;
    expect((await call(owner, "PUT", `/views/${cross.id}/prefs`, { ownCollapse: true })).body.code).toBe("NOT_A_BOARD_VIEW");
    expect((await call(owner, "PUT", `/views/${view.id}/prefs`, {})).status).toBe(400);
  });

  test("Show all levels and collapsed swimlanes are per person on the board (D656, D659)", async () => {
    const owner = await createUser("Views2 Levels owner");
    const reader = await createUser("Views2 Levels reader");
    const a = await board(owner, "Levels board");
    await share(owner, a.id, [reader.userId]);
    const parent = await card(owner, a.id, a.columns[0]!.id, "Parent");
    expect((await call(owner, "GET", `/boards/${a.id}`)).body.view).toMatchObject({ showAllLevels: null, collapsedRows: [] });
    const saved = await call(owner, "PUT", `/boards/${a.id}/view`, { showAllLevels: true, collapsedRows: [`k:${parent.id}`, `k:${crypto.randomUUID()}`, `a:${owner.userId}`, "none:k", "x"] });
    expect(saved.body.view).toMatchObject({ showAllLevels: true, collapsedRows: [`k:${parent.id}`, `a:${owner.userId}`, "none:k"] });
    expect((await call(owner, "GET", `/boards/${a.id}`)).body.view).toMatchObject({ showAllLevels: true });
    // Another reader keeps their own.
    expect((await call(reader, "GET", `/boards/${a.id}`)).body.view).toMatchObject({ showAllLevels: null, collapsedRows: [] });
    // Setting one field keeps the others.
    expect((await call(owner, "PUT", `/boards/${a.id}/view`, { showArchived: true })).body.view).toMatchObject({ showAllLevels: true, showArchived: true });
    expect((await call(owner, "PUT", `/boards/${a.id}/view`, { showAllLevels: "yes" })).status).toBe(400);
  });
});

describe("views pinned on a board (D658, T448)", () => {
  test("the owner or a manager pins a view they own; every reader of the board then reads it, listed first", async () => {
    const owner = await createUser("Views2 Pin owner");
    const manager = await createUser("Views2 Pin manager");
    const editor = await createUser("Views2 Pin editor");
    const outsider = await createUser("Views2 Pin outsider");
    const a = await board(owner, "Pin board");
    const other = await board(owner, "Pin other");
    await share(owner, a.id, [manager.userId, editor.userId]);
    setLevel(a.id, manager.userId, "manage");
    const mine = (await call(owner, "POST", "/views", { name: "Team todo", query: `board:${a.id} state:todo` })).body.view;
    const managers = (await call(manager, "POST", "/views", { name: "Managers' view", query: `board:${a.id}` })).body.view;
    const across = (await call(owner, "POST", "/views", { name: "Across", query: `board:${a.id},${other.id}` })).body.view;
    const editors = (await call(editor, "POST", "/views", { name: "Editor's", query: `board:${a.id}` })).body.view;

    // The editor reads nothing pinned yet, and cannot pin.
    expect((await call(editor, "GET", `/views/${mine.id}`)).status).toBe(404);
    expect((await call(editor, "PUT", `/boards/${a.id}/pins/${editors.id}`)).body.code).toBe("MANAGER_REQUIRED");
    // Only your own view, and only one on this board.
    expect((await call(owner, "PUT", `/boards/${a.id}/pins/${managers.id}`)).status).toBe(404);
    expect((await call(owner, "PUT", `/boards/${a.id}/pins/${across.id}`)).body.code).toBe("VIEW_NOT_ON_BOARD");
    expect((await call(owner, "PUT", `/boards/${other.id}/pins/${mine.id}`)).body.code).toBe("VIEW_NOT_ON_BOARD");

    const pinned = await call(owner, "PUT", `/boards/${a.id}/pins/${mine.id}`);
    expect(pinned.status).toBe(200);
    expect(pinned.body.pinned.map((view: { id: string }) => view.id)).toEqual([mine.id]);
    expect((await call(manager, "PUT", `/boards/${a.id}/pins/${managers.id}`)).status).toBe(200);
    // Pinning twice changes nothing.
    expect((await call(owner, "PUT", `/boards/${a.id}/pins/${mine.id}`)).body.pinned.map((view: { id: string }) => view.id)).toEqual([mine.id, managers.id]);

    const asEditor = await call(editor, "GET", `/boards/${a.id}/views`);
    expect(asEditor.body.pinned.map((view: { id: string }) => view.id)).toEqual([mine.id, managers.id]);
    expect(asEditor.body.views.map((view: { id: string }) => view.id)).toEqual([editors.id]);
    expect(asEditor.body.canPin).toBe(false);
    expect((await call(editor, "GET", `/views/${mine.id}`)).body.view).toMatchObject({ id: mine.id, is_owner: 0, board_id: a.id });
    expect((await call(editor, "GET", `/views/${mine.id}/cards`)).status).toBe(200);
    // Readers do not change it, and it is not in their shared lists.
    expect((await call(editor, "PATCH", `/views/${mine.id}`, { name: "Mine now", revision: mine.revision })).body.code).toBe("OWNER_ONLY");
    const lists = (await call(editor, "GET", "/views")).body;
    expect([...lists.shared, ...lists.everyone].some((view: { id: string }) => view.id === mine.id)).toBe(false);
    // Someone who cannot open the board reads nothing.
    expect((await call(outsider, "GET", `/views/${mine.id}`)).status).toBe(404);
    expect((await call(outsider, "GET", `/boards/${a.id}/views`)).status).toBe(404);

    // Audited.
    expect((db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ? AND event_type = 'task.view_pin'").get(owner.userId) as { count: number }).count).toBe(1);

    // Editing the filter off the board drops the pin; so does deleting the view.
    const moved = await call(manager, "PATCH", `/views/${managers.id}`, { query: `board:${a.id},${other.id}`, revision: managers.revision });
    expect(moved.status).toBe(200);
    expect((await call(editor, "GET", `/boards/${a.id}/views`)).body.pinned.map((view: { id: string }) => view.id)).toEqual([mine.id]);
    // The view's owner or a manager unpins; an editor does not.
    expect((await call(editor, "DELETE", `/boards/${a.id}/pins/${mine.id}`)).body.code).toBe("MANAGER_REQUIRED");
    expect((await call(manager, "DELETE", `/boards/${a.id}/pins/${mine.id}`)).status).toBe(200);
    expect((await call(editor, "GET", `/views/${mine.id}`)).status).toBe(404);
    await call(owner, "PUT", `/boards/${a.id}/pins/${mine.id}`);
    await call(owner, "DELETE", `/views/${mine.id}`);
    expect((db.query("SELECT COUNT(*) AS count FROM task_view_pins WHERE board_id = ?").get(a.id) as { count: number }).count).toBe(0);
  }, 20_000);
});

describe("MCP save_view (D660, T449)", () => {
  const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
  const on = (module: Grant["module"], permission: Grant["permission"], kind: NonNullable<Grant["resourceKind"]>, id: string): Grant => ({ module, permission, resourceKind: kind, resourceId: id });
  const key = (session: Session, grants: Grant[]) => createApiKey(session.userId, { name: "Views", surfaces: "both", grants, expiresInDays: 30 }).id;
  async function tool(keyId: string, name: string, args: Record<string, unknown> = {}) {
    const result = await invokeMcpToolForTests(name, args, keyId);
    return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
  }

  test("creates a private view and changes an owned one with a revision check; sharing stays in the app", async () => {
    const owner = await createUser("Views2 Save view owner");
    const other = await createUser("Views2 Save view other");
    const a = await board(owner, "Save view board");
    const writer = key(owner, [all("tasks", "write")]);
    const created = await tool(writer, "save_view", { name: "From an agent", filter: `board:${a.id} state:todo`, layout: "board", lanes: "assignee" });
    expect(created.isError).toBe(false);
    expect(created.value).toMatchObject({ created: true, view: { name: "From an agent", visibility: "private", board_id: a.id, layout: "board", lanes: "assignee", revision: 1 } });
    const viewId = created.value.view.id as string;
    expect((await call(owner, "GET", `/views/${viewId}`)).body.view.query).toBe(`board:${a.id} state:todo`);

    const renamed = await tool(writer, "save_view", { viewId, baseRevision: 1, name: "Renamed", filter: "state:doing assignee:me" });
    expect(renamed.value).toMatchObject({ created: false, view: { name: "Renamed", query: "state:doing assignee:me", board_id: null, revision: 2 } });
    expect((await tool(writer, "save_view", { viewId, baseRevision: 1, name: "Stale" })).value).toMatchObject({ code: "VIEW_CHANGED", currentRevision: 2 });
    expect((await tool(writer, "save_view", { viewId, name: "No revision" })).value.code).toBe("INVALID");
    expect((await tool(writer, "save_view", { name: "Bad", filter: "nope:x" })).value).toMatchObject({ code: "INVALID", reason: "FILTER_INVALID", position: 0 });
    expect((await tool(writer, "save_view", { filter: "state:todo" })).value.code).toBe("INVALID");
    expect((await tool(writer, "save_view", { name: "Has visibility", filter: "", visibility: "all_users" })).value.code).toBe("INVALID");
    // Someone else's view: shared with them, still owner-only; unshared, not found.
    await call(owner, "PUT", `/views/${viewId}/sharing`, { visibility: "selected", userIds: [other.userId] });
    const otherKey = key(other, [all("tasks", "write")]);
    expect((await tool(otherKey, "save_view", { viewId, baseRevision: 3, name: "Mine" })).value.code).toBe("OWNER_ONLY");
    expect((await tool(otherKey, "save_view", { viewId: crypto.randomUUID(), baseRevision: 1, name: "Missing" })).value.code).toBe("NOT_FOUND");
    // Audited as the app's own writes.
    expect((db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ? AND event_type IN ('task.view_create', 'task.view_update')").get(owner.userId) as { count: number }).count).toBeGreaterThanOrEqual(2);
  });

  test("a key limited to chosen items is never offered save_view (T449)", async () => {
    const owner = await createUser("Views2 Save view scoped");
    const a = await board(owner, "Scoped board");
    const view = (await call(owner, "POST", "/views", { name: "Scoped view", query: `board:${a.id}` })).body.view;
    const scoped = key(owner, [on("tasks", "write", "task_view", view.id)]);
    const live = loadLiveKey(scoped)!;
    const spec = mcpToolSpecs.find((item) => item.name === "save_view")!;
    expect(toolVisible(spec, live)).toBe(false);
    expect((await tool(scoped, "save_view", { viewId: view.id, baseRevision: view.revision, filter: "" })).isError).toBe(true);
    expect((await call(owner, "GET", `/views/${view.id}`)).body.view.query).toBe(`board:${a.id}`);
  });
});

describe("migration 078", () => {
  test("pins go with the view or the board; the new prefs columns are bounded", async () => {
    const owner = await createUser("Views2 Migration 078 owner");
    const a = await board(owner, "Migration 078 board");
    const view = (await call(owner, "POST", "/views", { name: "M78", query: `board:${a.id}` })).body.view;
    await call(owner, "PUT", `/boards/${a.id}/pins/${view.id}`);
    expect(() => db.query("UPDATE board_view_prefs SET collapsed_rows = ? WHERE board_id = ?").run(JSON.stringify(["x".repeat(1100)]), a.id)).not.toThrow();
    db.query("INSERT INTO board_view_prefs (board_id, user_id, updated_at) VALUES (?, ?, 'now') ON CONFLICT DO NOTHING").run(a.id, owner.userId);
    expect(() => db.query("UPDATE board_view_prefs SET collapsed_rows = ? WHERE board_id = ?").run(JSON.stringify(["x".repeat(1100)]), a.id)).toThrow();
    expect(() => db.query("UPDATE board_view_prefs SET show_all_levels = 2 WHERE board_id = ?").run(a.id)).toThrow();
    expect(() => db.query("INSERT INTO task_view_prefs (user_id, view_key, own_collapse, updated_at) VALUES (?, 'my', 2, 'now') ON CONFLICT DO NOTHING").run(owner.userId)).toThrow();
    db.query("DELETE FROM boards WHERE id = ?").run(a.id);
    expect((db.query("SELECT COUNT(*) AS count FROM task_view_pins WHERE view_id = ?").get(view.id) as { count: number }).count).toBe(0);
  });
});
