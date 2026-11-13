import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { registeredMigrations } from "../server/migrations";
import { cardEstimatesMigration } from "../server/migrations/082_card_estimates";

const { createMcpApiKey } = await import("../server/mcp");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resetTaskQueryRateLimit } = await import("../server/tasks/queryRoutes");

/** Lane ESTIMATES (docs/plan/TASK_ESTIMATES.md, D750–D757): board estimate settings and card estimates over REST, MCP, and the query. */

type Column = { id: string; name: string; state: string };

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columns = created.body.columns as [Column, Column, Column];
  expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  return { owner, member, boardId, todo: columns[0], done: columns[2] };
}

async function addCard(session: Session, boardId: string, columnId: string, title: string, extra: Record<string, unknown> = {}) {
  return call(session, "POST", `/boards/${boardId}/cards`, { columnId, title, ...extra });
}

const stored = (cardId: string) => (db.query("SELECT estimate FROM cards WHERE id = ?").get(cardId) as { estimate: number | null }).estimate;
const estimateAudits = (boardId: string) => (db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'task.board_estimates' ORDER BY rowid").all() as Array<{ metadata_json: string }>)
  .map((row) => JSON.parse(row.metadata_json) as Record<string, unknown>).filter((row) => row.boardId === boardId);

describe("migration 082 card_estimates", () => {
  test("adds the board settings (off, Fibonacci) and the card column with its range check, once", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const migration of registeredMigrations.filter((item) => item.id < 82)) sqlite.transaction(() => migration.up(sqlite))();
    const at = "2026-11-13T00:00:00.000Z";
    sqlite.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    sqlite.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b1', 'u1', 'Old board', ?, ?)").run(at, at);
    sqlite.query("INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES ('c1', 'b1', 'To do', 1024, ?, ?)").run(at, at);
    sqlite.query("INSERT INTO cards (id, board_id, column_id, position, title, created_at, updated_at) VALUES ('k1', 'b1', 'c1', 1024, 'Old card', ?, ?)").run(at, at);
    sqlite.transaction(() => cardEstimatesMigration.up(sqlite))();
    sqlite.transaction(() => cardEstimatesMigration.up(sqlite))();
    expect(sqlite.query("SELECT estimate_kind, estimate_scale FROM boards WHERE id = 'b1'").get()).toEqual({ estimate_kind: "none", estimate_scale: "fibonacci" });
    expect(sqlite.query("SELECT estimate FROM cards WHERE id = 'k1'").get()).toEqual({ estimate: null });
    const setCard = (value: number | null) => sqlite.query("UPDATE cards SET estimate = ? WHERE id = 'k1'").run(value);
    setCard(1.5);
    setCard(999);
    setCard(0);
    expect(() => setCard(-1)).toThrow();
    expect(() => setCard(1000)).toThrow();
    expect(() => sqlite.query("UPDATE boards SET estimate_kind = 'days' WHERE id = 'b1'").run()).toThrow();
    expect(() => sqlite.query("UPDATE boards SET estimate_scale = 'tshirt' WHERE id = 'b1'").run()).toThrow();
    sqlite.query("UPDATE boards SET estimate_kind = 'hours', estimate_scale = 'free' WHERE id = 'b1'").run();
  });
});

describe("board estimate settings (D750–D752)", () => {
  test("off by default; the owner or a manager sets them, a member cannot; changes are audited", async () => {
    const { owner, member, boardId } = await setup("Settings");
    const board = (await call(owner, "GET", `/boards/${boardId}`)).body.board;
    expect(board).toMatchObject({ estimate_kind: "none", estimate_scale: "fibonacci" });
    expect((await call(owner, "GET", "/boards")).body.boards.find((item: { id: string }) => item.id === boardId)).toMatchObject({ estimate_kind: "none" });

    expect((await call(member, "PATCH", `/boards/${boardId}`, { estimateKind: "points" })).body).toMatchObject({ code: "MANAGER_REQUIRED" });
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "days" })).status).toBe(400);
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { estimateScale: "tshirt" })).status).toBe(400);

    const saved = await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "points" });
    expect(saved.status).toBe(200);
    expect(saved.body.board).toMatchObject({ estimate_kind: "points", estimate_scale: "fibonacci" });
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { estimateScale: "free" })).body.board).toMatchObject({ estimate_kind: "points", estimate_scale: "free" });
    // The same settings again change nothing and add no audit row.
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "points", estimateScale: "free" })).status).toBe(200);
    expect(estimateAudits(boardId)).toEqual([
      { boardId, kind: "points", scale: "fibonacci", kindBefore: "none", scaleBefore: "fibonacci", estimatedCards: 0 },
      { boardId, kind: "points", scale: "free", kindBefore: "points", scaleBefore: "fibonacci", estimatedCards: 0 }
    ]);
  });
});

describe("card estimates (D753)", () => {
  test("refused while estimates are off, except clearing", async () => {
    const { owner, boardId, todo } = await setup("Off");
    const refused = await addCard(owner, boardId, todo.id, "Sized", { estimate: 3 });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "ESTIMATES_OFF" });
    // Nothing was written (the card was refused whole).
    expect((db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ? AND title = 'Sized'").get(boardId) as { count: number }).count).toBe(0);
    const card = (await addCard(owner, boardId, todo.id, "Plain", { estimate: null })).body.card;
    expect(card.estimate).toBeNull();
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { estimate: 2, revision: card.revision })).body).toMatchObject({ code: "ESTIMATES_OFF" });
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { estimate: null, revision: card.revision })).status).toBe(200);
  });

  test("Fibonacci points: on the scale only; free points and hours take numbers in range with two decimals", async () => {
    const { owner, member, boardId, todo } = await setup("Scale");
    await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "points" });
    for (const value of [4, 34, 2.5]) {
      const refused = await addCard(member, boardId, todo.id, `Off scale ${value}`, { estimate: value });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: "ESTIMATE_INVALID" });
      expect(refused.body.error).toContain("Fibonacci");
    }
    const five = (await addCard(member, boardId, todo.id, "Five", { estimate: 5 })).body.card;
    expect(five.estimate).toBe(5);
    expect(stored(five.id)).toBe(5);
    const zero = (await addCard(member, boardId, todo.id, "Zero", { estimate: 0 })).body.card;
    expect(zero.estimate).toBe(0);

    await call(owner, "PATCH", `/boards/${boardId}`, { estimateScale: "free" });
    expect((await addCard(member, boardId, todo.id, "Four", { estimate: 4 })).body.card.estimate).toBe(4);
    expect((await addCard(member, boardId, todo.id, "Half", { estimate: 0.5 })).body.card.estimate).toBe(0.5);

    await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "hours" });
    expect((await addCard(member, boardId, todo.id, "Hour and a half", { estimate: 1.5 })).body.card.estimate).toBe(1.5);
    expect((await addCard(member, boardId, todo.id, "Quarter", { estimate: 0.25 })).body.card.estimate).toBe(0.25);
    for (const value of [-1, 999.5, 1000, 1.125]) {
      const refused = await addCard(member, boardId, todo.id, `Bad ${value}`, { estimate: value });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: "ESTIMATE_INVALID" });
    }
    expect((await addCard(member, boardId, todo.id, "Max", { estimate: 999 })).body.card.estimate).toBe(999);
    // Not a number at all is the schema's 400.
    expect((await addCard(member, boardId, todo.id, "Text", { estimate: "3" })).status).toBe(400);
  });

  test("round trip: create, read, patch (one revision), clear; board, card, and Bin-free reads agree", async () => {
    const { owner, member, boardId, todo } = await setup("Trip");
    await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "points" });
    const card = (await addCard(member, boardId, todo.id, "Sized", { estimate: 3 })).body.card;
    expect((await call(member, "GET", `/cards/${card.id}`)).body.card.estimate).toBe(3);
    expect((await call(member, "GET", `/boards/${boardId}`)).body.cards.find((item: { id: string }) => item.id === card.id).estimate).toBe(3);
    const patched = await call(member, "PATCH", `/cards/${card.id}`, { estimate: 8, revision: card.revision });
    expect(patched.status).toBe(200);
    expect(patched.body.card).toMatchObject({ estimate: 8, revision: card.revision + 1 });
    // A stale revision is CARD_CHANGED, as for any field.
    expect((await call(member, "PATCH", `/cards/${card.id}`, { estimate: 13, revision: card.revision })).body).toMatchObject({ code: "CARD_CHANGED" });
    // Leaving estimate out keeps it.
    const renamed = await call(member, "PATCH", `/cards/${card.id}`, { title: "Sized again", revision: card.revision + 1 });
    expect(renamed.body.card.estimate).toBe(8);
    const cleared = await call(member, "PATCH", `/cards/${card.id}`, { estimate: null, revision: card.revision + 2 });
    expect(cleared.body.card.estimate).toBeNull();
    expect(stored(card.id)).toBeNull();
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'task.card_update' AND metadata_json LIKE ? ORDER BY rowid DESC LIMIT 1").get(`%${card.id}%`) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ estimate: null });
  });

  test("changing the kind keeps stored values: off hides them, on shows them, points to hours keeps the number", async () => {
    const { owner, boardId, todo } = await setup("Kind");
    await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "points", estimateScale: "free" });
    const card = (await addCard(owner, boardId, todo.id, "Kept", { estimate: 4 })).body.card;

    await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "none" });
    expect((await call(owner, "GET", `/cards/${card.id}`)).body.card.estimate).toBeNull();
    // The board payload sends `estimate` only when set (the D113 trim), so it is left out here.
    expect((await call(owner, "GET", `/boards/${boardId}`)).body.cards[0].estimate).toBeUndefined();
    expect(stored(card.id)).toBe(4);
    expect(estimateAudits(boardId).at(-1)).toMatchObject({ kind: "none", kindBefore: "points", estimatedCards: 1 });

    await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "hours" });
    expect((await call(owner, "GET", `/cards/${card.id}`)).body.card.estimate).toBe(4);

    // Back to Fibonacci points: 4 is off the scale but kept until someone picks a new value.
    await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "points", estimateScale: "fibonacci" });
    const read = (await call(owner, "GET", `/cards/${card.id}`)).body.card;
    expect(read.estimate).toBe(4);
    // Another field's change does not trip over the kept value.
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { title: "Kept still", revision: read.revision })).status).toBe(200);
  });
});

describe("estimates over MCP and the query (D755, D756)", () => {
  beforeEach(() => {
    resetMcpLimits();
    resetTaskQueryRateLimit();
  });

  async function tool(token: string, name: string, args: Record<string, unknown>) {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    });
    const text = await response.text();
    const json = text.trimStart().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
    const body = JSON.parse(json) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: body.result.isError === true, value: JSON.parse(body.result.content[0]!.text) as Record<string, any> };
  }

  test("create_card, update_card, list_cards, and get_card carry the estimate and the board's settings", async () => {
    const { owner, boardId, todo } = await setup("Mcp");
    const key = createMcpApiKey(owner.userId, "Estimates agent", ["tasks:read", "tasks:write"]);
    const off = await tool(key.token, "create_card", { boardId, columnId: todo.id, title: "Too early", estimate: 3 });
    expect(off.isError).toBe(true);
    expect(off.value).toMatchObject({ code: "INVALID", reason: "ESTIMATES_OFF" });

    await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "points" });
    const made = await tool(key.token, "create_card", { boardId, columnId: todo.id, title: "Sized", estimate: 5 });
    expect(made.isError).toBe(false);
    expect(made.value.card.estimate).toBe(5);
    const bad = await tool(key.token, "update_card", { cardId: made.value.card.id, baseRevision: made.value.card.revision, estimate: 4 });
    expect(bad.value).toMatchObject({ code: "INVALID", reason: "ESTIMATE_INVALID" });
    const updated = await tool(key.token, "update_card", { cardId: made.value.card.id, baseRevision: made.value.card.revision, estimate: 13 });
    expect(updated.value.card.estimate).toBe(13);

    const listed = await tool(key.token, "list_cards", { boardId });
    expect(listed.value.board.estimates).toEqual({ kind: "points", scale: "fibonacci" });
    expect(listed.value.cards.find((card: { id: string }) => card.id === made.value.card.id).estimate).toBe(13);
    const read = await tool(key.token, "get_card", { cardId: made.value.card.id });
    expect(read.value.card).toMatchObject({ estimate: 13, estimate_kind: "points" });
  });

  test("has:estimate matches cards with an estimate on boards with estimates on; results carry it", async () => {
    const { owner, boardId, todo } = await setup("Query");
    await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "hours" });
    await addCard(owner, boardId, todo.id, "Timed", { estimate: 2 });
    await addCard(owner, boardId, todo.id, "Untimed");
    const titles = async (q: string) => ((await call(owner, "POST", "/query", { q })).body.cards as Array<{ title: string; board_id: string }>)
      .filter((card) => card.board_id === boardId).map((card) => card.title).sort();
    expect(await titles(`board:${boardId} has:estimate`)).toEqual(["Timed"]);
    expect(await titles(`board:${boardId} -has:estimate`)).toEqual(["Untimed"]);
    const result = (await call(owner, "POST", "/query", { q: `board:${boardId} has:estimate` })).body.cards[0];
    expect(result).toMatchObject({ estimate: 2, estimate_kind: "hours" });
    // Off hides the values from the filter too.
    await call(owner, "PATCH", `/boards/${boardId}`, { estimateKind: "none" });
    expect(await titles(`board:${boardId} has:estimate`)).toEqual([]);
  });
});
