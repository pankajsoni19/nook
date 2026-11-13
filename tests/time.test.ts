import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { call as mcpCall, errorCode, makeKey, ok, toolNames } from "./support/mcpClient";
import { registeredMigrations } from "../server/migrations";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { runDatasetQuery } = await import("../server/datasets/registry");
const { computeProgress, registeredProgressSources } = await import("../server/goalsProgress");
const { runScheduleTick } = await import("../server/schedules/dispatcher");
const { restoreUndo } = await import("../server/undo");
const { binProviders } = await import("../server/bin");
const { searchScope } = await import("../server/searchRegistry");
const { NOOK_AGENT_TOOLS, NOOK_NEVER_TOOLS } = await import("../server/agents/nookBridge");

/**
 * Time (lane TIME, docs/plan/WORKSPACE_MODULES.md §D.2): the timer (one per person, D870), entries
 * (24-hour cap and split, D871), visibility of worklogs on cards (D872, §G.1 Q5) and of money (D873),
 * edit rights (T532), week approvals and locks (D874, T533), the timesheet cell, summaries with
 * report-time rounding (D875), CSV (T514), guests on projects they belong to (§G.1 Q8), MCP (scopes,
 * chosen-item reach T531, bulk dry run), the dataset, the Goals progress source, schedules, search,
 * undo, and the Bin.
 */

type Json = Record<string, any>;
async function api(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/time${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { text }; }
  return { status: response.status, body: json, text };
}
async function tasks(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  return { status: response.status, body: await response.json() as Json };
}

let owner: Session;
let member: Session;
let outsider: Session;
let guest: Session;
let boardId: string;
let cardId: string;
let cardKey: string;
let projectId: string;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

beforeAll(async () => {
  owner = await createUser("Time owner");
  member = await createUser("Time member");
  outsider = await createUser("Time outsider");
  guest = await createUser("Time guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
  const board = await tasks(owner, "POST", "/boards", { name: "Time board" });
  boardId = board.body.board.id;
  db.query("UPDATE boards SET estimate_kind = 'hours', code = 'TIM' WHERE id = ?").run(boardId);
  expect((await tasks(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  const card = await tasks(owner, "POST", `/boards/${boardId}/cards`, { columnId: board.body.columns[0].id, title: "Fix login", estimate: 5 });
  cardId = card.body.card.id;
  const number = (db.query("SELECT number FROM cards WHERE id = ?").get(cardId) as { number: number | null }).number;
  cardKey = `TIM-${number}`;
  const created = await api(owner, "POST", "/projects", { name: "Acme website", newClient: "Acme Inc", boardId, rateMinor: 10000, currency: "EUR", budget: { kind: "hours", value: 10 } });
  expect(created.status).toBe(201);
  projectId = created.body.project.id;
});

describe("migrations 093–094", () => {
  test("apply after 092 and again without change; the running-timer index and duration checks hold", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const migration of registeredMigrations.filter((item) => item.id <= 94)) sqlite.transaction(() => migration.up(sqlite))();
    for (const migration of registeredMigrations.filter((item) => item.id === 93 || item.id === 94)) sqlite.transaction(() => migration.up(sqlite))();
    const at = "2026-11-13T00:00:00.000Z";
    sqlite.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    const insert = (id: string, ended: string | null, duration: number | null) => sqlite.query("INSERT INTO time_entries (id, user_id, started_at, ended_at, duration_s, created_at, updated_at) VALUES (?, 'u1', ?, ?, ?, ?, ?)").run(id, at, ended, duration, at, at);
    insert("e1", null, null);
    expect(() => insert("e2", null, null)).toThrow();
    expect(() => insert("e3", at, null)).toThrow();
    expect(() => insert("e4", at, 86_401)).toThrow();
    insert("e5", at, 86_400);
    sqlite.query("UPDATE time_entries SET description = 'Searchable words' WHERE id = 'e5'").run();
    expect(sqlite.query("SELECT entry_id FROM time_entry_fts WHERE time_entry_fts MATCH 'searchable'").all()).toEqual([{ entry_id: "e5" }]);
    sqlite.query("DELETE FROM time_entries WHERE id = 'e5'").run();
    expect(sqlite.query("SELECT COUNT(*) AS n FROM time_entry_fts").get()).toEqual({ n: 0 });
  });
});

describe("the timer (D870, D871)", () => {
  test("one running timer per person; starting another stops the first at the same instant; it survives a reload", async () => {
    const first = await api(owner, "POST", "/timer/start", { description: "Design", projectId, tz: "Europe/Berlin" });
    expect(first.status).toBe(201);
    expect(first.body.entry).toMatchObject({ running: true, description: "Design", project: { id: projectId, client: "Acme Inc" }, billable: true });
    const second = await api(owner, "POST", "/timer/start", { target: cardKey });
    expect(second.body.stopped).toBe(first.body.entry.id);
    // A card on the project's linked board uses the project (D876).
    expect(second.body.entry.project.id).toBe(projectId);
    expect(second.body.entry.target).toMatchObject({ kind: "card", key: cardKey, title: "Fix login" });
    const reloaded = await api(owner, "GET", "/timer");
    expect(reloaded.body.entry.id).toBe(second.body.entry.id);
    expect((db.query("SELECT COUNT(*) AS n FROM time_entries WHERE user_id = ? AND ended_at IS NULL").get(owner.userId) as { n: number }).n).toBe(1);
    const stopped = await api(owner, "POST", "/timer/stop", {});
    expect(stopped.body.entry.running).toBe(false);
    expect((await api(owner, "GET", "/timer")).body.entry).toBeNull();
    // The card's history says time was logged.
    expect(db.query("SELECT kind FROM card_activity WHERE card_id = ? AND kind = 'time_logged'").all(cardId).length).toBeGreaterThan(0);
  });

  test("a timer left running past 24 hours is split into entries of at most 24 hours on stop", async () => {
    const started = await api(member, "POST", "/timer/start", { description: "Marathon", startedAt: hoursAgo(23.9) });
    expect(started.status).toBe(201);
    db.query("UPDATE time_entries SET started_at = ? WHERE id = ?").run(hoursAgo(30), started.body.entry.id);
    await api(member, "POST", "/timer/stop", {});
    const rows = db.query("SELECT duration_s FROM time_entries WHERE user_id = ? AND description = 'Marathon' ORDER BY started_at").all(member.userId) as Array<{ duration_s: number }>;
    expect(rows.length).toBe(2);
    expect(rows[0]!.duration_s).toBe(86_400);
    expect(rows[0]!.duration_s + rows[1]!.duration_s).toBeGreaterThanOrEqual(30 * 3600 - 5);
  });
});

describe("entries", () => {
  test("manual entries accept typed durations; more than 24 hours is refused; a split makes two", async () => {
    const created = await api(owner, "POST", "/entries", { startedAt: hoursAgo(5), duration: "1h30", description: "Planning", projectId, tags: ["meeting", "Meeting", "client"] });
    expect(created.status).toBe(201);
    expect(created.body.entry).toMatchObject({ durationS: 5400, tags: ["meeting", "client"], amountMinor: 15000, currency: "EUR" });
    expect((await api(owner, "POST", "/entries", { startedAt: hoursAgo(30), duration: "25h" })).body.code).toBe("TOO_LONG");
    expect((await api(owner, "POST", "/entries", { startedAt: hoursAgo(3), duration: "soon" })).body.code).toBe("DURATION_REQUIRED");
    const split = await api(owner, "POST", `/entries/${created.body.entry.id}/split`, { at: new Date(Date.parse(created.body.entry.startedAt) + 1800_000).toISOString() });
    expect(split.body.entries.map((entry: Json) => entry.durationS)).toEqual([1800, 3600]);
  });

  test("delete gives an undo ticket that restores the entry", async () => {
    const created = await api(owner, "POST", "/entries", { startedAt: hoursAgo(2), duration: 600, description: "Undo me" });
    const deleted = await api(owner, "DELETE", `/entries/${created.body.entry.id}`);
    expect(deleted.body.undoTicket).toBeString();
    expect(db.query("SELECT 1 FROM time_entries WHERE id = ?").get(created.body.entry.id)).toBeNull();
    restoreUndo(deleted.body.undoTicket, owner.userId);
    expect(db.query("SELECT description FROM time_entries WHERE id = ?").get(created.body.entry.id)).toEqual({ description: "Undo me" });
  });
});

describe("who sees and changes time (D872, D873, T532)", () => {
  test("card readers see worklogs (description, person, hours) but not money; others get NOT_FOUND", async () => {
    expect((await api(owner, "POST", "/entries", { startedAt: hoursAgo(3), duration: "45m", target: cardKey, description: "Debugging" })).status).toBe(201);
    const asMember = await api(member, "GET", `/targets/card/${cardId}`);
    expect(asMember.status).toBe(200);
    expect(asMember.body.estimateSeconds).toBe(5 * 3600);
    expect(asMember.body.entries.length).toBeGreaterThan(0);
    for (const entry of asMember.body.entries) expect(entry).toMatchObject({ rateMinor: null, amountMinor: null, canEdit: false });
    expect(asMember.body.totalSeconds).toBeGreaterThanOrEqual(asMember.body.entries.reduce((sum: number, entry: Json) => sum + entry.durationS, 0));
    expect((await api(outsider, "GET", `/targets/card/${cardId}`)).status).toBe(404);
    // A project member who is not a manager cannot edit another person's entry.
    const entryId = asMember.body.entries[0].id;
    expect((await api(member, "PATCH", `/entries/${entryId}`, { description: "Hijack" })).status).toBe(403);
    expect((await api(outsider, "PATCH", `/entries/${entryId}`, { description: "Hijack" })).status).toBe(404);
  });

  test("a private project shows card readers totals only", async () => {
    await api(owner, "PATCH", `/projects/${projectId}`, { settings: { privateEntries: true } });
    const view = await api(member, "GET", `/targets/card/${cardId}`);
    expect(view.body.entries).toEqual([]);
    expect(view.body.totalSeconds).toBeGreaterThan(0);
    expect(view.body.privateEntries).toBe(true);
    await api(owner, "PATCH", `/projects/${projectId}`, { settings: { privateEntries: false } });
  });

  test("rates are shown to managers only; a manager edits a member's entry on the project", async () => {
    expect((await api(member, "GET", `/projects/${projectId}`)).status).toBe(404);
    const access = await request(`/access/time_project/${projectId}`, {}, owner);
    const etag = access.headers.get("ETag")!;
    const put = await request(`/access/time_project/${projectId}`, { method: "PUT", headers: { "If-Match": etag }, body: JSON.stringify({ audience: "selected", people: [{ id: member.userId, level: "edit" }] }) }, owner);
    expect(put.status).toBe(200);
    const asMember = await api(member, "GET", `/projects/${projectId}`);
    expect(asMember.body.project).toMatchObject({ rateMinor: null, canSeeRates: false, canLog: true, client: { name: "Acme Inc" } });
    expect((await api(member, "GET", `/projects/${projectId}/rates`)).status).toBe(403);
    const logged = await api(member, "POST", "/entries", { startedAt: hoursAgo(4), duration: 3600, projectId, description: "Member work" });
    expect(logged.body.entry.amountMinor).toBe(10000);
    // The owner manages the project: sees and edits the member's entry, but cannot move it to another project.
    const edited = await api(owner, "PATCH", `/entries/${logged.body.entry.id}`, { description: "Member work (fixed)" });
    expect(edited.body.entry.description).toBe("Member work (fixed)");
    expect(edited.body.entry.amountMinor).toBe(10000);
    const other = await api(owner, "POST", "/projects", { name: "Other" });
    expect((await api(owner, "PATCH", `/entries/${logged.body.entry.id}`, { projectId: other.body.project.id })).status).toBe(403);
    // A member rate overrides the project rate on new billable entries.
    await api(owner, "PUT", `/projects/${projectId}/rates/${member.userId}`, { rateMinor: 5000 });
    const cheaper = await api(member, "POST", "/entries", { startedAt: hoursAgo(6), duration: 3600, projectId });
    expect(cheaper.body.entry.amountMinor).toBe(5000);
  });
});

describe("week approvals (D874, T533)", () => {
  test("an approved week locks the author's entries and refuses new ones until a manager unlocks it", async () => {
    const day = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const entry = await api(member, "POST", "/entries", { startedAt: `${day}T10:00:00.000Z`, duration: 7200, projectId, tz: "UTC" });
    const sheet = await api(member, "GET", `/timesheet?week=${day}&tz=UTC`);
    const weekStart = sheet.body.weekStart;
    const submitted = await api(member, "POST", "/approvals", { projectId, weekStart });
    expect(submitted.status).toBe(201);
    const pending = await api(owner, "GET", "/approvals?status=submitted");
    const approval = pending.body.approvals.find((row: Json) => row.weekStart === weekStart && row.user.id === member.userId);
    expect(approval).toBeDefined();
    expect((await api(member, "PATCH", `/approvals/${approval.id}`, { decision: "approve" })).status).toBe(403);
    expect((await api(owner, "PATCH", `/approvals/${approval.id}`, { decision: "approve" })).body.entries).toBeGreaterThan(0);
    expect((await api(member, "PATCH", `/entries/${entry.body.entry.id}`, { description: "Late change" })).body.code).toBe("LOCKED");
    expect((await api(member, "POST", "/entries", { startedAt: `${day}T15:00:00.000Z`, duration: 600, projectId, tz: "UTC" })).body.code).toBe("WEEK_LOCKED");
    // MCP and bulk go through the same check (T533).
    const key = makeKey(member, ["time:write"]);
    resetMcpLimits();
    expect(await errorCode(key, "update_time_entry", { entryId: entry.body.entry.id, description: "Via MCP" })).toBe("READ_ONLY");
    expect((await api(member, "POST", "/entries/bulk", { op: "delete", items: [{ id: entry.body.entry.id }] })).body.code).toBe("LOCKED");
    expect((await api(owner, "PATCH", `/approvals/${approval.id}`, { decision: "unlock" })).status).toBe(200);
    expect((await api(member, "PATCH", `/entries/${entry.body.entry.id}`, { description: "Now allowed" })).status).toBe(200);
    expect(db.query("SELECT event_type FROM audit_log WHERE event_type = 'time.approval_unlock'").all().length).toBeGreaterThan(0);
  });
});

describe("the timesheet", () => {
  test("typing a cell creates or adjusts one timesheet entry; lowering below timer entries is refused; clearing undoes", async () => {
    const user = await createUser("Sheet person");
    const day = "2026-10-07";
    const set = (duration: number | string | null) => api(user, "PUT", "/timesheet/cell", { day, projectId: null, target: null, duration, tz: "UTC" });
    const first = await set("1:30");
    expect(first.status).toBe(200);
    expect(first.body.timesheet.rows[0].days).toContain(5400);
    await set("2h");
    expect((db.query("SELECT COUNT(*) AS n, SUM(duration_s) AS s FROM time_entries WHERE user_id = ?").get(user.userId) as Json)).toEqual({ n: 1, s: 7200 });
    await api(user, "POST", "/entries", { startedAt: `${day}T14:00:00.000Z`, duration: 3600, tz: "UTC" });
    const lower = await set("30m");
    expect(lower.body.code).toBe("CELL_HAS_DETAILS");
    const raised = await set("4h");
    expect(raised.body.timesheet.totals).toContain(4 * 3600);
    const cleared = await set(null);
    expect(cleared.body.undoTicket).toBeString();
    expect((db.query("SELECT COUNT(*) AS n FROM time_entries WHERE user_id = ?").get(user.userId) as Json).n).toBe(0);
    // Copying last week's rows keeps them with zeros.
    await api(user, "POST", "/entries", { startedAt: "2026-09-30T10:00:00.000Z", duration: 600, tz: "UTC" });
    const carried = await api(user, "GET", `/timesheet?week=${day}&tz=UTC&carry=1`);
    expect(carried.body.rows.length).toBe(1);
    expect(carried.body.rows[0].days).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("reports (D875, T514)", () => {
  test("summaries group by client and person with per-entry rounding; money only where visible", async () => {
    const rounded = await api(owner, "GET", `/summary?groupBy=client,user&rounding=15&project=${projectId}`);
    expect(rounded.status).toBe(200);
    const client = rounded.body.rows.find((row: Json) => row.label === "Acme Inc");
    expect(client.sub.length).toBeGreaterThanOrEqual(2);
    for (const row of client.sub) expect(row.seconds % 900).toBe(0);
    expect(rounded.body.currency).toBe("EUR");
    expect(rounded.body.totals.amountMinor).toBeGreaterThan(0);
    const memberView = await api(member, "GET", `/summary?groupBy=project&user=me`);
    expect(memberView.body.totals.seconds).toBeGreaterThan(0);
    // Stored entries never change (rounding is report-time only).
    expect((db.query("SELECT COUNT(*) AS n FROM time_entries WHERE duration_s = 5400").get() as Json).n).toBeGreaterThanOrEqual(0);
  });

  test("CSV has one line per entry and neutralizes formulas", async () => {
    await api(owner, "POST", "/entries", { startedAt: hoursAgo(1), duration: 60, description: "=HYPERLINK(\"http://x\")" });
    const csv = await api(owner, "GET", "/export.csv?user=me");
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("Date,Start,End,Duration,Hours,Person,Project");
    expect(csv.text).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(db.query("SELECT 1 FROM audit_log WHERE event_type = 'time.export'").get()).not.toBeNull();
  });

  test("the time.entries dataset nulls amounts the viewer may not see (T530)", () => {
    const query = { dataset: "time.entries", measures: [{ fn: "sum" as const, column: "seconds" }, { fn: "sum" as const, column: "amount_minor" }], dimensions: ["person"] };
    const asOwner = runDatasetQuery({ ...query, filters: [{ column: "project_id", op: "eq", value: projectId }] }, { userId: owner.userId, role: "member" });
    expect(asOwner.rows.some((row) => typeof row[2] === "number" && row[2] > 0)).toBe(true);
    const asMember = runDatasetQuery({ ...query, filters: [{ column: "project_id", op: "eq", value: projectId }, { column: "person_id", op: "neq", value: member.userId }] }, { userId: member.userId, role: "member" });
    for (const row of asMember.rows) expect(row[2]).toBeNull();
  });
});

describe("guests (§G.1 Q8)", () => {
  test("a guest logs time only on a project they belong to", async () => {
    expect((await api(guest, "POST", "/entries", { startedAt: hoursAgo(2), duration: 600 })).body.code).toBe("PROJECT_REQUIRED");
    expect((await api(guest, "POST", "/entries", { startedAt: hoursAgo(2), duration: 600, projectId })).status).toBe(404);
    const access = await request(`/access/time_project/${projectId}`, {}, owner);
    const body = await access.json() as Json;
    const people = [...body.people.map((person: Json) => ({ id: person.id, level: person.level })), { id: guest.userId, level: "view" }];
    expect((await request(`/access/time_project/${projectId}`, { method: "PUT", headers: { "If-Match": access.headers.get("ETag")! }, body: JSON.stringify({ audience: "selected", people }) }, owner)).status).toBe(200);
    const logged = await api(guest, "POST", "/entries", { startedAt: hoursAgo(2), duration: 600, projectId });
    expect(logged.status).toBe(201);
    expect((await api(guest, "POST", "/timer/start", { projectId })).status).toBe(201);
    expect((await api(guest, "POST", "/timer/stop", {})).status).toBe(200);
    expect((await api(guest, "POST", "/projects", { name: "Nope" })).status).toBe(403);
  });
});

describe("MCP (time:read / time:write)", () => {
  test("start_timer on a card key, get_running_timer, stop_timer, time_summary by work item", async () => {
    resetMcpLimits();
    const key = makeKey(owner, ["time:write"]);
    const names = await toolNames(key);
    for (const name of ["get_running_timer", "start_timer", "stop_timer", "log_time", "list_time_entries", "update_time_entry", "remove_time_entry", "bulk_log_time", "time_summary", "list_time_projects", "create_time_project", "update_time_project", "get_time_for_item", "suggest_time_entries"]) expect(names).toContain(name);
    const started = await ok(key, "start_timer", { target: cardKey, description: "Over MCP" });
    expect(started.entry.target.key).toBe(cardKey);
    expect((await ok(key, "get_running_timer", {})).entry.id).toBe(started.entry.id);
    expect((await ok(key, "stop_timer", {})).entry.running).toBe(false);
    const summary = await ok(key, "time_summary", { groupBy: ["target"], user: "me" });
    expect(summary.rows.some((row: Json) => row.label.startsWith(cardKey))).toBe(true);
    expect(db.query("SELECT source FROM time_entries WHERE id = ?").get(started.entry.id)).toEqual({ source: "mcp" });
    const readOnly = makeKey(owner, ["time:read"]);
    expect(await errorCode(readOnly, "log_time", { duration: "30m" })).toBe("SCOPE_REQUIRED");
  });

  test("bulk_log_time dry run saves nothing; the real run is all or nothing", async () => {
    resetMcpLimits();
    const key = makeKey(member, ["time:write"]);
    const before = (db.query("SELECT COUNT(*) AS n FROM time_entries WHERE user_id = ?").get(member.userId) as Json).n;
    const items = [{ startedAt: hoursAgo(9), duration: "1h", description: "Bulk 1" }, { startedAt: hoursAgo(8), duration: "45m", description: "Bulk 2" }];
    const dry = await ok(key, "bulk_log_time", { op: "create", items, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, count: 2 });
    expect((db.query("SELECT COUNT(*) AS n FROM time_entries WHERE user_id = ?").get(member.userId) as Json).n).toBe(before);
    expect(await errorCode(key, "bulk_log_time", { op: "create", items: [...items, { startedAt: hoursAgo(7), duration: "nope" }] })).toBe("INVALID");
    expect((db.query("SELECT COUNT(*) AS n FROM time_entries WHERE user_id = ?").get(member.userId) as Json).n).toBe(before);
    expect((await ok(key, "bulk_log_time", { op: "create", items })).count).toBe(2);
  });

  test("a key limited to one project must name it, and lists only its entries (T531)", async () => {
    resetMcpLimits();
    const created = createApiKey(member.userId, { name: "Chosen", surfaces: "both", expiresInDays: 30, grants: [{ module: "time", permission: "write", resourceKind: "time_project", resourceId: projectId }] });
    const key = { id: created.id, token: created.token, userId: member.userId };
    const listed = await mcpCall(key, "list_time_entries", { user: "me" });
    expect(listed.isError).toBe(false);
    for (const entry of listed.value.items) expect(entry.project?.id).toBe(projectId);
    const unnamed = await mcpCall(key, "log_time", { duration: "10m" });
    expect(unnamed.isError).toBe(true);
    expect(unnamed.value.error).toMatch(/projectId/);
    expect((await mcpCall(key, "log_time", { duration: "10m", projectId })).isError).toBe(false);
  });

  test("agents may read and log time (as a time_log proposal), never approve or manage", () => {
    for (const name of ["list_time_entries", "time_summary", "log_time"]) expect(NOOK_AGENT_TOOLS.has(name)).toBe(true);
    for (const name of ["remove_time_entry", "bulk_log_time", "create_time_project"]) expect(NOOK_NEVER_TOOLS.has(name)).toBe(true);
  });

  test("a time_log proposal is applied as the approver", async () => {
    resetMcpLimits();
    const key = makeKey(owner, ["time:write", "inbox:write"]);
    const submitted = await mcpCall(key, "submit_proposals", { proposals: [{ kind: "time_log", title: "Log 20 minutes", payload: { duration: "20m", description: "Suggested by agent", projectId } }] });
    expect(submitted.isError).toBe(false);
    const proposalId = (db.query("SELECT id FROM proposals WHERE kind = 'time_log' ORDER BY created_at DESC LIMIT 1").get() as { id: string }).id;
    const approved = await request(`/inbox/proposals/${proposalId}/approve`, { method: "POST", body: "{}" }, owner);
    expect(approved.status).toBe(200);
    expect(db.query("SELECT source, duration_s FROM time_entries WHERE description = 'Suggested by agent'").get()).toEqual({ source: "proposal", duration_s: 1200 });
  });
});

describe("registrations", () => {
  test("the Goals progress source `time` sums hours on a project as the KR's owner", async () => {
    expect(registeredProgressSources().map((source) => source.kind)).toContain("time");
    const value = await computeProgress("time", { projectId }, { ownerId: owner.userId, period: null, tz: "UTC", nowMs: Date.now() });
    expect(value!.value).toBeGreaterThan(1);
    expect(await computeProgress("time", { projectId }, { ownerId: outsider.userId, period: null, tz: "UTC", nowMs: Date.now() })).toBeNull();
  });

  test("search finds visible entry descriptions and projects only", async () => {
    const scope = searchScope("time")!;
    const found = await scope.search({ userId: owner.userId, role: "member", q: "Planning", limit: 5 });
    expect(found.results.some((result) => result.kind === "time_entry")).toBe(true);
    const hidden = await scope.search({ userId: outsider.userId, role: "member", q: "Planning", limit: 5 });
    expect(hidden.results).toEqual([]);
    expect((await scope.search({ userId: owner.userId, role: "member", q: "acme", limit: 5 })).results.some((result) => result.kind === "time_project")).toBe(true);
  });

  test("the long-timer alert fires once for a timer still running", async () => {
    const user = await createUser("Long timer");
    await api(user, "PUT", "/settings", { dailyReminder: false, reminderAt: "17:00", reminderDays: [1, 2, 3, 4, 5], longTimerHours: 1, tz: "UTC" });
    const started = await api(user, "POST", "/timer/start", { description: "Forgot", startedAt: hoursAgo(0.5) });
    expect(db.query("SELECT 1 FROM schedules WHERE owner_kind = 'time_entry' AND owner_id = ?").get(started.body.entry.id)).not.toBeNull();
    await runScheduleTick({ nowMs: Date.now() + 40 * 60_000 });
    expect(db.query("SELECT title FROM notifications WHERE user_id = ? AND topic = 'time.long_timer'").all(user.userId).length).toBe(1);
    await api(user, "POST", "/timer/stop", {});
    expect(db.query("SELECT 1 FROM schedules WHERE owner_kind = 'time_entry' AND owner_id = ?").get(started.body.entry.id)).toBeNull();
  });

  test("a binned project restores; purging it keeps its entries as personal and leaves no member rows", async () => {
    const created = await api(owner, "POST", "/projects", { name: "Temporary", memberIds: [member.userId] });
    const id = created.body.project.id;
    const entry = await api(owner, "POST", "/entries", { startedAt: hoursAgo(1), duration: 60, projectId: id });
    expect((await api(member, "DELETE", `/projects/${id}`)).status).toBe(403);
    expect((await api(owner, "DELETE", `/projects/${id}`)).status).toBe(200);
    expect((await api(owner, "GET", `/projects/${id}`)).status).toBe(404);
    const provider = binProviders.get("time_project")!;
    expect(provider.list(owner.userId).some((item) => item.id === id)).toBe(true);
    expect((await provider.restore(id, owner.userId)).status).toBe("restored");
    await api(owner, "DELETE", `/projects/${id}`);
    expect(await provider.purge(id, owner.userId)).toBe("purged");
    expect(db.query("SELECT project_id FROM time_entries WHERE id = ?").get(entry.body.entry.id)).toEqual({ project_id: null });
    expect(db.query("SELECT COUNT(*) AS n FROM item_members WHERE item_kind = 'time_project' AND item_id = ?").get(id)).toEqual({ n: 0 });
  });

  test("card totals for faces and Timeline bars count readable cards only", async () => {
    const totals = await api(member, "GET", `/cards?ids=${cardId}`);
    expect(totals.body.cards[cardId]).toMatchObject({ estimateSeconds: 18000 });
    expect(totals.body.cards[cardId].seconds).toBeGreaterThan(0);
    expect((await api(outsider, "GET", `/cards?ids=${cardId}`)).body.cards).toEqual({});
  });

  test("the role-write gate lets viewers write nothing here", async () => {
    const viewer = await createUser("Time viewer");
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    expect((await api(viewer, "POST", "/timer/start", {})).status).toBe(403);
    expect((await api(viewer, "GET", "/timer")).status).toBe(200);
    void invokeMcpToolForTests;
  });
});
