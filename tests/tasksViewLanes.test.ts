import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { resetTaskQueryRateLimit } = await import("../server/tasks/queryRoutes");
const { createMcpApiKey } = await import("../server/mcp");
const { resetMcpLimits } = await import("../server/mcpRateLimit");

/**
 * Views that work like boards (lane VIEWS, docs/plan/TASK_VIEWS.md D635–D645, T442–T444):
 * board views (`board_id`), lanes and their true counts, collapsed-lane prefs (migration 077),
 * and MCP `list_views` / `move_card` by state or column name.
 */

type Column = { id: string; name: string; state: string; position: number };

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function board(owner: Session, name: string) {
  const created = await call(owner, "POST", "/boards", { name });
  return { id: created.body.board.id as string, columns: created.body.columns as Column[] };
}
async function card(owner: Session, columnId: string, boardId: string, title: string, extra: Record<string, unknown> = {}) {
  const created = await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title, ...extra });
  expect(created.status).toBe(201);
  return created.body.card.id as string;
}
async function addColumn(owner: Session, boardId: string, name: string, state?: string) {
  const added = await call(owner, "POST", `/boards/${boardId}/columns`, { name });
  if (state) await call(owner, "PATCH", `/columns/${added.body.column.id}`, { state });
  return added.body.column.id as string;
}

beforeEach(() => { resetTaskQueryRateLimit(); resetMcpLimits(); });

describe("board views (D635)", () => {
  test("a view on exactly one readable board carries board_id; anything else is null", async () => {
    const owner = await createUser("Board view owner");
    const reader = await createUser("Board view reader");
    const one = await board(owner, "Board view one");
    const two = await board(owner, "Board view two");
    const single = (await call(owner, "POST", "/views", { name: "On one", query: `board:${one.id} state:todo` })).body.view;
    expect(single.board_id).toBe(one.id);
    const cases = [`board:${one.id},${two.id}`, `board:${one.id} board:${two.id}`, `-board:${one.id} state:todo`, "assignee:me"];
    for (const query of cases) expect((await call(owner, "POST", "/views", { name: "Not one", query })).body.view.board_id).toBeNull();
    const listed = (await call(owner, "GET", "/views")).body.mine as Array<{ id: string; board_id: string | null }>;
    expect(listed.find((view) => view.id === single.id)?.board_id).toBe(one.id);
    // A reader who cannot read the board keeps the cross-board page: no board_id for them.
    await call(owner, "PUT", `/views/${single.id}/sharing`, { visibility: "selected", userIds: [reader.userId] });
    expect((await call(reader, "GET", `/views/${single.id}`)).body.view.board_id).toBeNull();
    await call(owner, "PUT", `/boards/${one.id}/sharing`, { visibility: "selected", userIds: [reader.userId] });
    expect((await call(reader, "GET", `/views/${single.id}`)).body.view.board_id).toBe(one.id);
    expect((await call(reader, "GET", "/views")).body.shared.find((view: { id: string }) => view.id === single.id).board_id).toBe(one.id);
  });

  test("the display keeps a lane mode; anything else is refused", async () => {
    const owner = await createUser("Lane display owner");
    const created = await call(owner, "POST", "/views", { name: "Lanes", query: "assignee:me", display: { layout: "board", lanes: "state" } });
    expect(created.body.view.display).toMatchObject({ layout: "board", lanes: "state" });
    expect((await call(owner, "POST", "/views", { name: "Bad", query: "assignee:me", display: { lanes: "rows" } })).status).toBe(400);
  });
});

describe("lanes (D640–D643)", () => {
  test("columns merge by name and state across the boards with matches, with true counts over the whole match", async () => {
    const owner = await createUser("Lanes owner");
    const a = await board(owner, "Lanes A");
    const b = await board(owner, "Lanes B");
    const empty = await board(owner, "Lanes empty");
    const reviewA = await addColumn(owner, a.id, "Review");
    const reviewB = await addColumn(owner, b.id, "review", "done");
    await addColumn(owner, empty.id, "Only here");
    for (let index = 0; index < 3; index += 1) await card(owner, a.columns[0]!.id, a.id, `A todo ${index}`);
    await card(owner, reviewA, a.id, "A review");
    await card(owner, reviewB, b.id, "B review");
    const q = `board:${a.id},${b.id},${empty.id}`;
    const result = await call(owner, "POST", "/query", { q, lanes: "columns", limit: 1 });
    expect(result.status).toBe(200);
    expect(result.body.cards).toHaveLength(1);
    expect(result.body.lanes).toBe("columns");
    expect(result.body.lanesFallback).toBeUndefined();
    // The empty board has no match, so its "Only here" column is no lane.
    expect((result.body.columns as Array<{ label: string }>).map((lane) => lane.label)).toEqual(["To do", "Doing", "Review · In progress", "Done", "review · Done"]);
    expect(result.body.laneCounts).toEqual({ "c:todo:to do": 3, "c:doing:doing": 0, "c:doing:review": 1, "c:done:done": 0, "c:done:review": 1 });
    const todo = result.body.columns[0];
    expect(todo.columns.map((column: { board_id: string }) => column.board_id).sort()).toEqual([a.id, b.id].sort());
    expect(todo.columns.find((column: { board_id: string }) => column.board_id === a.id)).toMatchObject({ card_count: 3, wip_limit: null });
    // Later pages carry no lanes; state lanes count by state.
    expect((await call(owner, "POST", "/query", { q, lanes: "columns", limit: 1, cursor: result.body.nextCursor })).body.columns).toBeUndefined();
    const states = await call(owner, "POST", "/query", { q, lanes: "state" });
    expect(states.body.laneCounts).toEqual({ "s:todo": 3, "s:doing": 1, "s:done": 1 });
  });

  test("pages hold up to 200 only with lanes; the view route takes lanes too", async () => {
    const owner = await createUser("Lanes limit");
    const a = await board(owner, "Lanes limit board");
    await card(owner, a.columns[0]!.id, a.id, "One");
    expect((await call(owner, "POST", "/query", { q: `board:${a.id}`, limit: 150 })).status).toBe(400);
    expect((await call(owner, "POST", "/query", { q: `board:${a.id}`, limit: 200, lanes: "state" })).status).toBe(200);
    expect((await call(owner, "POST", "/query", { q: `board:${a.id}`, limit: 201, lanes: "state" })).status).toBe(400);
    const view = (await call(owner, "POST", "/views", { name: "Limit", query: `board:${a.id},${crypto.randomUUID()}` })).body.view;
    expect((await call(owner, "GET", `/views/${view.id}/cards?tz=UTC&limit=150`)).status).toBe(400);
    const run = await call(owner, "GET", `/views/${view.id}/cards?tz=UTC&limit=150&lanes=columns`);
    expect(run.status).toBe(200);
    expect(run.body.laneCounts).toEqual({ "c:todo:to do": 1, "c:doing:doing": 0, "c:done:done": 0 });
    expect((await call(owner, "GET", `/views/${view.id}/cards?tz=UTC&lanes=rows`)).status).toBe(400);
  });

  test("more than 20 merged columns fall back to state lanes", async () => {
    const owner = await createUser("Lanes fallback");
    const boards = [await board(owner, "Fallback 1"), await board(owner, "Fallback 2")];
    for (const [index, item] of boards.entries()) {
      for (let column = 0; column < 10; column += 1) await addColumn(owner, item.id, `B${index} column ${column}`);
      await card(owner, item.columns[0]!.id, item.id, `Fallback card ${index}`);
    }
    const result = await call(owner, "POST", "/query", { q: `board:${boards.map((item) => item.id).join(",")}`, lanes: "columns" });
    expect(result.body).toMatchObject({ lanes: "state", lanesFallback: true, laneCounts: { "s:todo": 2, "s:doing": 0, "s:done": 0 } });
  });

  test("a key limited to chosen boards gets lanes only from them (T442)", async () => {
    const owner = await createUser("Lanes key owner");
    const stranger = await createUser("Lanes stranger");
    const mine = await board(owner, "Lanes visible");
    const theirs = await board(stranger, "Lanes hidden");
    await addColumn(stranger, theirs.id, "Secret column");
    await card(stranger, theirs.columns[0]!.id, theirs.id, "Hidden card");
    await card(owner, mine.columns[0]!.id, mine.id, "Visible card");
    const result = await call(owner, "POST", "/query", { q: `board:${mine.id},${theirs.id}`, lanes: "columns" });
    expect(JSON.stringify(result.body.columns)).not.toContain("Secret");
    expect(JSON.stringify(result.body.columns)).not.toContain(theirs.id);
  });
});

describe("collapsed lanes (D644, migration 077)", () => {
  test("a reader keeps their own; malformed and unknown lanes are trimmed; rows go with the view", async () => {
    const owner = await createUser("Prefs owner");
    const reader = await createUser("Prefs reader");
    const stranger = await createUser("Prefs stranger");
    const a = await board(owner, "Prefs board");
    const other = await board(owner, "Prefs other");
    await card(owner, a.columns[0]!.id, a.id, "Prefs card");
    const view = (await call(owner, "POST", "/views", { name: "Prefs", query: `board:${a.id},${other.id}` })).body.view;
    expect((await call(owner, "GET", `/views/${view.id}/prefs`)).body).toMatchObject({ collapsedLanes: [] });
    const saved = await call(owner, "PUT", `/views/${view.id}/prefs`, { collapsedLanes: ["c:done:done", "c:doing:no such lane", "s:done", "nonsense", "s:done"] });
    expect(saved.body).toMatchObject({ collapsedLanes: ["c:done:done", "s:done"] });
    expect((await call(owner, "GET", `/views/${view.id}/prefs`)).body).toMatchObject({ collapsedLanes: ["c:done:done", "s:done"] });
    // Per person: a reader of the view has their own; a stranger gets 404, like a missing view.
    await call(owner, "PUT", `/views/${view.id}/sharing`, { visibility: "selected", userIds: [reader.userId] });
    expect((await call(reader, "GET", `/views/${view.id}/prefs`)).body).toMatchObject({ collapsedLanes: [] });
    expect((await call(reader, "PUT", `/views/${view.id}/prefs`, { collapsedLanes: ["s:todo"] })).status).toBe(200);
    expect((await call(stranger, "PUT", `/views/${view.id}/prefs`, { collapsedLanes: ["s:todo"] })).status).toBe(404);
    expect((await call(stranger, "GET", `/views/${crypto.randomUUID()}/prefs`)).status).toBe(404);
    expect((await call(owner, "PUT", `/views/${view.id}/prefs`, { collapsedLanes: "s:todo" })).status).toBe(400);
    expect((await call(owner, "PUT", "/views/not-a-view/prefs", { collapsedLanes: [] })).status).toBe(400);
    // My work.
    expect((await call(stranger, "PUT", "/views/my/prefs", { collapsedLanes: ["s:done", "c:done:anything"] })).body).toMatchObject({ collapsedLanes: ["s:done", "c:done:anything"] });
    expect((await call(stranger, "GET", "/views/my/prefs")).body).toMatchObject({ collapsedLanes: ["s:done", "c:done:anything"] });
    // Not audited.
    expect((db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ?").get(stranger.userId) as { count: number }).count).toBe(0);
    // Deleted with the view, for everyone.
    expect((db.query("SELECT COUNT(*) AS count FROM task_view_prefs WHERE view_key = ?").get(view.id) as { count: number }).count).toBe(2);
    await call(owner, "DELETE", `/views/${view.id}`);
    expect((db.query("SELECT COUNT(*) AS count FROM task_view_prefs WHERE view_key = ?").get(view.id) as { count: number }).count).toBe(0);
    // The CHECK bounds the stored JSON whatever writes it.
    expect(() => db.query("INSERT INTO task_view_prefs (user_id, view_key, collapsed_lanes, updated_at) VALUES (?, 'my', ?, 'now') ON CONFLICT DO UPDATE SET collapsed_lanes = excluded.collapsed_lanes")
      .run(owner.userId, JSON.stringify(["x".repeat(1100)]))).toThrow();
  });
});

describe("moves across boards keep the board's rules (D641)", () => {
  test("view-level readers cannot move; a full column is 409; the done clock follows the move", async () => {
    const owner = await createUser("Drop owner");
    const viewer = await createUser("Drop viewer");
    const a = await board(owner, "Drop board");
    const cardId = await card(owner, a.columns[0]!.id, a.id, "Drop card");
    await call(owner, "PUT", `/boards/${a.id}/sharing`, { visibility: "selected", userIds: [viewer.userId] });
    db.query("UPDATE board_members SET level = 'view' WHERE board_id = ? AND user_id = ?").run(a.id, viewer.userId);
    const seen = await call(viewer, "POST", "/query", { q: `board:${a.id}`, lanes: "columns" });
    expect(seen.body.cards[0]).toMatchObject({ id: cardId, board_level: "view" });
    expect((await call(viewer, "POST", `/cards/${cardId}/move`, { columnId: a.columns[1]!.id, afterCardId: null })).status).toBe(403);
    await call(owner, "PATCH", `/columns/${a.columns[1]!.id}`, { wipLimit: 1 });
    await card(owner, a.columns[1]!.id, a.id, "Filler");
    expect((await call(owner, "POST", `/cards/${cardId}/move`, { columnId: a.columns[1]!.id, afterCardId: null })).body.code).toBe("COLUMN_FULL");
    const moved = await call(owner, "POST", `/cards/${cardId}/move`, { columnId: a.columns[2]!.id, afterCardId: null });
    expect(moved.status).toBe(200);
    expect(moved.body.card.done_at).toBeTruthy();
  });
});

describe("MCP (D645)", () => {
  type Key = { token: string };
  let rpcId = 0;
  async function tool(key: Key, name: string, args: Record<string, unknown>) {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } })
    });
    const text = await response.text();
    const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
    const body = JSON.parse(json) as { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: { message: string } };
    if (body.error) return { isError: true, value: { error: body.error.message } as Record<string, any> };
    const content = body.result!.content![0]!.text;
    let value: Record<string, any>;
    try { value = JSON.parse(content); } catch { value = { error: content }; }
    return { isError: body.result!.isError === true, value };
  }

  test("list_views names the board and lanes; move_card takes a state or a column name on the card's board", async () => {
    const owner = await createUser("MCP lanes owner");
    const a = await board(owner, "MCP lanes board");
    const review = await addColumn(owner, a.id, "Revïew");
    const cardId = await card(owner, a.columns[0]!.id, a.id, "MCP card");
    const view = (await call(owner, "POST", "/views", { name: "MCP board view", query: `board:${a.id}`, display: { lanes: "state" } })).body.view;
    const key = createMcpApiKey(owner.userId, "Lanes agent", ["tasks:read", "tasks:write"]);
    const listed = await tool(key, "list_views", {});
    expect(listed.value.views.find((item: { id: string }) => item.id === view.id)).toMatchObject({ board_id: a.id, lanes: "state" });

    let moved = await tool(key, "move_card", { cardId, columnName: "review" });
    expect(moved.isError).toBe(false);
    expect(moved.value.card.column_id).toBe(review);
    moved = await tool(key, "move_card", { cardId, state: "done", afterCardId: null });
    expect(moved.value.card.column_id).toBe(a.columns[2]!.id);
    moved = await tool(key, "move_card", { cardId, state: "todo", columnName: "Done" });
    expect(moved.isError).toBe(true);
    moved = await tool(key, "move_card", { cardId });
    expect(moved.isError).toBe(true);
    moved = await tool(key, "move_card", { cardId, columnName: "Nowhere" });
    expect(moved.isError).toBe(true);
    expect(moved.value).toMatchObject({ reason: "NO_SUCH_COLUMN" });
    // A card the key's owner cannot read is NOT_FOUND before any name is resolved.
    const stranger = await createUser("MCP lanes stranger");
    const theirs = await board(stranger, "MCP stranger board");
    const hidden = await card(stranger, theirs.columns[0]!.id, theirs.id, "Hidden");
    const refused = await tool(key, "move_card", { cardId: hidden, state: "done" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.value)).not.toContain(theirs.columns[2]!.id);
  });
});
