import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { registeredMigrations } from "../server/migrations";
import { cardStartDatesMigration } from "../server/migrations/080_card_start_dates";
import { resolveStart, startAfterDue, startAt } from "../server/tasks/dueTime";
import { format, matchesQuery, parse } from "../shared/taskQuery";

const { resetTaskQueryRateLimit } = await import("../server/tasks/queryRoutes");
const { createMcpApiKey } = await import("../server/mcp");
const { invokeMcpToolForTests } = await import("../server/mcpTools");

/** Card start dates (D720–D722, migration 080): schema, the start-before-due rule, the API, MCP, and `start:`. */

beforeEach(() => resetTaskQueryRateLimit());

const noStart = { start_on: null, start_time: null, start_tz: null };
const noDue = { due_on: null, due_time: null, due_tz: null };

describe("migration 080 card_start_dates", () => {
  test("adds the start columns with the due columns' CHECKs, once", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const migration of registeredMigrations.filter((item) => item.id < 80)) sqlite.transaction(() => migration.up(sqlite))();
    sqlite.transaction(() => cardStartDatesMigration.up(sqlite))();
    sqlite.transaction(() => cardStartDatesMigration.up(sqlite))();
    const columns = (sqlite.query("PRAGMA table_info(cards)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["start_on", "start_time", "start_tz"]));
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_cards_start'").get()).toEqual({ name: "idx_cards_start" });

    const at = "2026-11-13T00:00:00.000Z";
    sqlite.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    sqlite.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b1', 'u1', 'B', ?, ?)").run(at, at);
    sqlite.query("INSERT INTO board_columns (id, board_id, name, position, created_at, updated_at) VALUES ('c1', 'b1', 'To do', 1024, ?, ?)").run(at, at);
    let n = 0;
    const insert = (startOn: string | null, startTime: string | null, startTz: string | null) => sqlite.query(`INSERT INTO cards
      (id, board_id, column_id, position, title, start_on, start_time, start_tz, created_by, created_at, updated_at) VALUES (?, 'b1', 'c1', ?, 'Card', ?, ?, ?, 'u1', ?, ?)`)
      .run(`k${++n}`, n, startOn, startTime, startTz, at, at);
    insert(null, null, null);
    insert("2026-11-12", null, null);
    insert("2026-11-12", "09:30", "Europe/Berlin");
    expect(() => insert("12/11/2026", null, null)).toThrow();
    expect(() => insert("2026-11-12", "09:30", null)).toThrow();
    expect(() => insert("2026-11-12", null, "UTC")).toThrow();
    expect(() => insert(null, "09:30", "UTC")).toThrow();
    expect(() => insert("2026-11-12", "24:00", "UTC")).toThrow();
    expect(() => insert("2026-11-12", "09:30", "x".repeat(65))).toThrow();
  });
});

describe("the start rules (resolveStart, startAfterDue)", () => {
  test("a start time needs a date and a zone; only the date keeps the time; clearing the date clears the time", () => {
    const timed = { start_on: "2026-11-12", start_time: "09:00", start_tz: "Europe/Berlin" };
    expect(resolveStart(noStart, { startOn: "2026-11-12", startTime: "09:00", startTz: "Europe/Berlin" })).toEqual({ value: timed, timeChange: "set" });
    expect(resolveStart(timed, { startOn: "2026-11-14" })).toEqual({ value: { ...timed, start_on: "2026-11-14" }, timeChange: null });
    expect(resolveStart(timed, { startTime: null })).toEqual({ value: { ...timed, start_time: null, start_tz: null }, timeChange: "cleared" });
    expect(resolveStart(timed, { startOn: null })).toEqual({ value: noStart, timeChange: "cleared" });
    expect(resolveStart(noStart, { startTime: "09:00", startTz: "UTC" })).toEqual({ error: "A start time needs a start date" });
    expect(resolveStart(noStart, { startOn: "2026-11-12", startTime: "09:00" })).toEqual({ error: "A start time needs a time zone (startTz)" });
    expect(resolveStart(timed, { startTz: "UTC" })).toEqual({ error: "Send startTz together with startTime" });
    expect(startAt(timed)).toBe("2026-11-12T08:00:00.000Z");
    expect(startAt({ ...timed, start_time: null, start_tz: null })).toBeNull();
  });

  test("dates compare as civil dates; a date-only side is its whole day", () => {
    const due = { due_on: "2026-11-15", due_time: null, due_tz: null };
    expect(startAfterDue({ ...noStart, start_on: "2026-11-12" }, due)).toBe(false);
    expect(startAfterDue({ ...noStart, start_on: "2026-11-15" }, due)).toBe(false);
    expect(startAfterDue({ ...noStart, start_on: "2026-11-16" }, due)).toBe(true);
    // Either side unset never conflicts.
    expect(startAfterDue({ ...noStart, start_on: "2026-11-16" }, noDue)).toBe(false);
    expect(startAfterDue(noStart, due)).toBe(false);
    // A timed start on a date-only due day is fine at any time; a date-only start on a timed due day too.
    expect(startAfterDue({ start_on: "2026-11-15", start_time: "23:59", start_tz: "UTC" }, due)).toBe(false);
    expect(startAfterDue({ ...noStart, start_on: "2026-11-15" }, { due_on: "2026-11-15", due_time: "00:00", due_tz: "UTC" })).toBe(false);
    expect(startAfterDue({ ...noStart, start_on: "2026-11-16" }, { due_on: "2026-11-15", due_time: "23:00", due_tz: "UTC" })).toBe(true);
  });

  test("both timed: the instants compare, across zones", () => {
    const due = { due_on: "2026-11-15", due_time: "17:00", due_tz: "Europe/Berlin" }; // 16:00Z
    expect(startAfterDue({ start_on: "2026-11-15", start_time: "16:59", start_tz: "Europe/Berlin" }, due)).toBe(false);
    expect(startAfterDue({ start_on: "2026-11-15", start_time: "17:00", start_tz: "Europe/Berlin" }, due)).toBe(false);
    expect(startAfterDue({ start_on: "2026-11-15", start_time: "17:01", start_tz: "Europe/Berlin" }, due)).toBe(true);
    // 11:30 in New York is 16:30Z: after the Berlin 17:00 (16:00Z), though the wall time is earlier.
    expect(startAfterDue({ start_on: "2026-11-15", start_time: "11:30", start_tz: "America/New_York" }, due)).toBe(true);
    // 10:30 in New York is 15:30Z: before.
    expect(startAfterDue({ start_on: "2026-11-15", start_time: "10:30", start_tz: "America/New_York" }, due)).toBe(false);
    // A civil date after the due date can still be earlier as an instant (Kiritimati is UTC+14).
    expect(startAfterDue({ start_on: "2026-11-16", start_time: "01:00", start_tz: "Pacific/Kiritimati" }, due)).toBe(false);
  });
});

type Column = { id: string };

async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  return { owner, boardId: created.body.board.id as string, columns: created.body.columns as [Column, Column, Column] };
}

describe("card start dates over the API (D720, D721)", () => {
  test("create and patch round-trip the start; the board payload and audit carry it", async () => {
    const { owner, boardId, columns } = await setup("Start api");
    const created = await call(owner, "POST", `/boards/${boardId}/cards`, {
      columnId: columns[0].id, title: "Ranged", startOn: "2026-11-12", startTime: "09:00", startTz: "Europe/Berlin", dueOn: "2026-11-15"
    });
    expect(created.status).toBe(201);
    expect(created.body.card).toMatchObject({ start_on: "2026-11-12", start_time: "09:00", start_tz: "Europe/Berlin", start_at: "2026-11-12T08:00:00.000Z", due_on: "2026-11-15", due_at: null });
    const cardId = created.body.card.id as string;

    let patched = await call(owner, "PATCH", `/cards/${cardId}`, { startOn: "2026-11-13", revision: 1 });
    expect(patched.status).toBe(200);
    // Only the date moved: the wall time and zone stay (D115's rule, for the start).
    expect(patched.body.card).toMatchObject({ start_on: "2026-11-13", start_time: "09:00", start_tz: "Europe/Berlin", revision: 2 });
    patched = await call(owner, "PATCH", `/cards/${cardId}`, { startTime: null, revision: 2 });
    expect(patched.body.card).toMatchObject({ start_on: "2026-11-13", start_time: null, start_tz: null, start_at: null });
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'task.card_update' ORDER BY rowid DESC LIMIT 1").get(owner.userId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ startTime: "cleared" });

    const board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.cards.find((card: { id: string }) => card.id === cardId)).toMatchObject({ start_on: "2026-11-13", start_time: null, due_on: "2026-11-15" });
    expect((await call(owner, "GET", `/cards/${cardId}`)).body.card).toMatchObject({ start_on: "2026-11-13" });

    patched = await call(owner, "PATCH", `/cards/${cardId}`, { startOn: null, revision: 3 });
    expect(patched.body.card).toMatchObject({ start_on: null, start_time: null, start_tz: null, start_at: null, due_on: "2026-11-15" });
  });

  test("a start after the due date is refused with START_AFTER_DUE, from either side", async () => {
    const { owner, boardId, columns } = await setup("Start order");
    const refused = await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Backwards", startOn: "2026-11-16", dueOn: "2026-11-15" });
    expect(refused).toMatchObject({ status: 400, body: { code: "START_AFTER_DUE" } });
    const card = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title: "Ranged", startOn: "2026-11-12", dueOn: "2026-11-15" })).body.card as { id: string };
    // Moving the start past the due date, or the due date before the start, is refused and changes nothing.
    expect(await call(owner, "PATCH", `/cards/${card.id}`, { startOn: "2026-11-16", revision: 1 })).toMatchObject({ status: 400, body: { code: "START_AFTER_DUE" } });
    expect(await call(owner, "PATCH", `/cards/${card.id}`, { dueOn: "2026-11-11", revision: 1 })).toMatchObject({ status: 400, body: { code: "START_AFTER_DUE" } });
    // Both moving together is checked as saved.
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { startOn: "2026-11-20", dueOn: "2026-11-22", revision: 1 })).status).toBe(200);
    // Same day, both timed: the instants decide, across zones.
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { startOn: "2026-11-22", startTime: "10:30", startTz: "America/New_York", dueTime: "17:00", dueTz: "Europe/Berlin", revision: 2 })).status).toBe(200);
    expect(await call(owner, "PATCH", `/cards/${card.id}`, { startTime: "11:30", startTz: "America/New_York", revision: 3 })).toMatchObject({ status: 400, body: { code: "START_AFTER_DUE" } });
    // Clearing the due date lifts the rule; a start alone is fine.
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { dueOn: null, revision: 3 })).body.card).toMatchObject({ start_on: "2026-11-22", due_on: null });
    // Shapes are the due fields' (a time needs its zone).
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { startTime: "25:00", startTz: "UTC", revision: 4 })).status).toBe(400);
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { startOn: "2026-02-30", revision: 4 })).status).toBe(400);
    expect((await call(owner, "PATCH", `/cards/${card.id}`, { startTime: "09:00", revision: 4 })).status).toBe(400);
  });

  test("MCP create_card and update_card take the start; list_cards returns it; the order rule is INVALID with the reason", async () => {
    const { owner, boardId, columns } = await setup("Start mcp");
    const key = createMcpApiKey(owner.userId, "Start agent", ["tasks:read", "tasks:write"]);
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await invokeMcpToolForTests(name, args, key.id);
      return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
    };
    const created = (await tool("create_card", { boardId, columnId: columns[0].id, title: "Agent card", startOn: "2026-11-12", dueOn: "2026-11-15" })).value as { card: { id: string; revision: number } };
    const updated = await tool("update_card", { cardId: created.card.id, baseRevision: created.card.revision, startOn: "2026-11-13", startTime: "08:00", startTz: "UTC" });
    expect(updated.value).toMatchObject({ card: { start_on: "2026-11-13", start_time: "08:00", start_tz: "UTC", start_at: "2026-11-13T08:00:00.000Z" } });
    const listed = (await tool("list_cards", { boardId })).value as { cards: Array<Record<string, unknown>> };
    expect(listed.cards.find((card) => card.id === created.card.id)).toMatchObject({ start_on: "2026-11-13", start_time: "08:00", due_on: "2026-11-15" });
    const refused = await tool("update_card", { cardId: created.card.id, baseRevision: 2, startOn: "2026-11-20" });
    expect(refused).toMatchObject({ isError: true, value: { code: "INVALID", reason: "START_AFTER_DUE" } });
  });
});

describe("start: in the task query (D722)", () => {
  test("parses, formats, and matches in memory like due:", () => {
    const parsed = parse("start:<2026-11-14,none start:WEEK");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(format(parsed.query)).toBe("start:none,<2026-11-14 start:week");
    expect(parse("start:overdue")).toMatchObject({ ok: false, error: { code: "FILTER_INVALID" } });
    const context = { userId: "u1", today: "2026-11-13" };
    const card = (start_on: string | null) => ({ id: "k", column_id: "c", title: "T", tag_ids: [], flags: [], assignees: [], due_on: null, start_on });
    const run = (q: string, start: string | null) => {
      const result = parse(q);
      return result.ok && matchesQuery(card(start), result.query, context);
    };
    expect(run("start:today", "2026-11-13")).toBe(true);
    expect(run("start:week", "2026-11-19")).toBe(true);
    expect(run("start:week", "2026-11-20")).toBe(false);
    expect(run("start:<2026-11-13", "2026-11-12")).toBe(true);
    expect(run("start:>2026-11-13", "2026-11-12")).toBe(false);
    expect(run("start:none", null)).toBe(true);
    expect(run("-start:none", null)).toBe(false);
  });

  test("POST /api/tasks/query filters and sorts by start", async () => {
    const { owner, boardId, columns } = await setup("Start query");
    const make = (title: string, extra: Record<string, unknown>) => call(owner, "POST", `/boards/${boardId}/cards`, { columnId: columns[0].id, title, ...extra });
    await make("Early", { startOn: "2026-11-01" });
    await make("Timed", { startOn: "2026-11-05", startTime: "08:00", startTz: "UTC" });
    await make("Dated", { startOn: "2026-11-05" });
    await make("Unstarted", {});
    const query = (q: string, sort?: string) => call(owner, "POST", "/query", { q: `board:${boardId} ${q}`, tz: "UTC", ...(sort ? { sort } : {}) });
    const titles = (result: { body: Record<string, any> }) => (result.body.cards as Array<{ title: string }>).map((card) => card.title);
    expect(titles(await query("start:<2026-11-05")).sort()).toEqual(["Early"]);
    expect(titles(await query("start:2026-11-05")).sort()).toEqual(["Dated", "Timed"]);
    expect(titles(await query("start:none"))).toEqual(["Unstarted"]);
    expect(titles(await query("-start:none")).sort()).toEqual(["Dated", "Early", "Timed"]);
    // Earliest first, timed before date-only that day, unstarted last.
    expect(titles(await query("", "start"))).toEqual(["Early", "Timed", "Dated", "Unstarted"]);
    const shaped = (await query("start:2026-11-05")).body.cards.find((card: { title: string }) => card.title === "Timed");
    expect(shaped).toMatchObject({ start_on: "2026-11-05", start_time: "08:00", start_tz: "UTC", start_at: "2026-11-05T08:00:00.000Z" });
  });
});
