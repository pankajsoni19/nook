import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { call as mcpCall } from "./support/mcpClient";
import { registeredMigrations } from "../server/migrations";

const { createApiKey } = await import("../server/apiKeys");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { runDatasetQuery } = await import("../server/datasets/registry");
const { refreshGoalSources } = await import("../server/goals/service");
const { todayTotals } = await import("../server/time/reports");

/**
 * Audit 2 fixes for Time and Goals (D1140–D1148): budget alerts once per crossing, hidden projects on
 * shared worklogs, start_timer's reach, approvals totals by local day, today's upper bound, a chosen-
 * project key's item totals; carried-over goals counted once, closing on fresh numbers, and new goals
 * in the current period.
 */

type Json = Record<string, any>;
async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { text }; }
  return { status: response.status, body: json, text };
}
const time = (session: Session, method: string, path: string, body?: unknown) => call(session, method, `/time${path}`, body);
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

let owner: Session;
let reader: Session;
beforeAll(async () => {
  owner = await createUser("Audit2 time owner");
  reader = await createUser("Audit2 card reader");
});

describe("migration 120", () => {
  test("adds time_projects.budget_alerted and re-runs without change", () => {
    const sqlite = new Database(":memory:", { strict: true });
    for (const migration of registeredMigrations.filter((item) => item.id <= 120)) sqlite.transaction(() => migration.up(sqlite))();
    const again = registeredMigrations.find((item) => item.id === 120)!;
    sqlite.transaction(() => again.up(sqlite))();
    const columns = (sqlite.query("PRAGMA table_info(time_projects)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain("budget_alerted");
  });
});

describe("budget alerts (TG2, D1142)", () => {
  test("fire once per crossing, even after the alert is read; a changed budget alerts afresh", async () => {
    const project = (await time(owner, "POST", "/projects", { name: "Budget once", budget: { kind: "hours", value: 1 } })).body.project.id as string;
    const count = () => (db.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND topic = 'time.budget' AND item_id = ?").get(owner.userId, project) as Json).n as number;
    const log = (hours: number, seconds: number) => time(owner, "POST", "/entries", { startedAt: hoursAgo(hours), duration: seconds, projectId: project });
    expect((await log(10, 3000)).status).toBe(201); // 83%: the 80% alert
    expect(count()).toBe(1);
    db.query("UPDATE notifications SET read_at = ? WHERE user_id = ?").run(new Date().toISOString(), owner.userId);
    await log(9, 60);
    await log(8, 60);
    expect(count()).toBe(1);
    await log(7, 600); // over 100%
    expect(count()).toBe(2);
    db.query("UPDATE notifications SET read_at = ? WHERE user_id = ?").run(new Date().toISOString(), owner.userId);
    await log(6, 60);
    expect(count()).toBe(2);
    expect((await time(owner, "PATCH", `/projects/${project}`, { budget: { kind: "hours", value: 2 } })).status).toBe(200);
    await log(5, 2000); // 5840 s of 7200: 81% of the new budget
    expect(count()).toBe(3);
  });
});

describe("a project the viewer cannot open (TG4, D1143)", () => {
  let cardId: string;
  beforeAll(async () => {
    const board = await call(owner, "POST", "/tasks/boards", { name: "Audit2 shared board" });
    const boardId = board.body.board.id as string;
    expect((await call(owner, "PUT", `/tasks/boards/${boardId}/sharing`, { visibility: "selected", userIds: [reader.userId] })).status).toBe(200);
    cardId = (await call(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId: board.body.columns[0].id, title: "Shared card" })).body.card.id;
    const secret = (await time(owner, "POST", "/projects", { name: "Secret merger", newClient: "Hushhush Ltd", color: "red" })).body.project.id as string;
    expect((await time(owner, "POST", "/entries", { startedAt: hoursAgo(30), duration: 1800, projectId: secret, target: { kind: "card", id: cardId }, description: "Worklog" })).status).toBe(201);
  });

  test("the card's Time section shows the time without the project's name, color, or client", async () => {
    const body = await time(reader, "GET", `/targets/card/${cardId}`);
    expect(body.status).toBe(200);
    expect(body.body.entries).toHaveLength(1);
    expect(body.body.entries[0].project).toMatchObject({ name: "A project you can't open", color: "slate", client: null });
    expect(body.text).not.toContain("Secret merger");
    expect(body.text).not.toContain("Hushhush");
    const mine = await time(owner, "GET", `/targets/card/${cardId}`);
    expect(mine.body.entries[0].project).toMatchObject({ name: "Secret merger", client: "Hushhush Ltd" });
  });

  test("summaries, the CSV, and the dataset hide it too", async () => {
    for (const groupBy of ["project", "client"]) {
      const summary = await time(reader, "GET", `/summary?user=all&target=card:${cardId}&groupBy=${groupBy}`);
      expect(summary.status).toBe(200);
      expect(summary.body.totals.seconds).toBe(1800);
      expect(summary.text).not.toContain("Secret merger");
      expect(summary.text).not.toContain("Hushhush");
    }
    const csv = await time(reader, "GET", `/export.csv?user=all&target=card:${cardId}`);
    expect(csv.text).toContain("A project you can't open");
    expect(csv.text).not.toContain("Secret merger");
    expect(csv.text).not.toContain("Hushhush");
    const result = runDatasetQuery({ dataset: "time.entries", measures: [{ fn: "sum", column: "seconds" }], dimensions: ["project", "client", "project_id"], filters: [{ column: "target_id", op: "eq", value: cardId }] }, { userId: reader.userId, role: "member" });
    expect(result.rows).toEqual([["A project you can't open", "No client", null, 1800]]);
    // The project's own people still see it (the predicate is built per query, not at module load).
    const asOwner = runDatasetQuery({ dataset: "time.entries", measures: [{ fn: "sum", column: "seconds" }], dimensions: ["project", "client"], filters: [{ column: "target_id", op: "eq", value: cardId }] }, { userId: owner.userId, role: "member" });
    expect(asOwner.rows).toEqual([["Secret merger", "Hushhush Ltd", 1800]]);
  });
});

describe("money in the time.entries dataset (D1150)", () => {
  test("a project's manager sees amounts of a member's entries; the member sees only their own", async () => {
    const manager = await createUser("Audit2 money manager");
    const member = await createUser("Audit2 money member");
    const other = await createUser("Audit2 money other");
    const project = (await time(manager, "POST", "/projects", { name: "Billed project", rateMinor: 12000, currency: "EUR", memberIds: [member.userId, other.userId] })).body.project.id as string;
    expect((await time(member, "POST", "/entries", { startedAt: hoursAgo(50), duration: 1800, projectId: project, billable: true })).status).toBe(201);
    expect((await time(other, "POST", "/entries", { startedAt: hoursAgo(51), duration: 3600, projectId: project, billable: true })).status).toBe(201);
    const query = (viewer: Session) => runDatasetQuery({ dataset: "time.entries", measures: [{ fn: "sum", column: "amount_minor" }], dimensions: ["person", "currency"], filters: [{ column: "project_id", op: "eq", value: project }], sort: [{ column: "person", dir: "asc" }] }, { userId: viewer.userId, role: "member" }).rows;
    expect(query(manager)).toEqual([["Audit2 money member", "EUR", 6000], ["Audit2 money other", "EUR", 12000]]);
    expect(query(member)).toEqual([["Audit2 money member", "EUR", 6000], ["Audit2 money other", null, null]]);
  });
});

describe("MCP with a key over one project (TG5, D1144, D1147)", () => {
  test("start_timer refuses to stop a timer running on a project the key cannot reach", async () => {
    resetMcpLimits();
    const reached = (await time(owner, "POST", "/projects", { name: "Key project" })).body.project.id as string;
    const other = (await time(owner, "POST", "/projects", { name: "Out of reach" })).body.project.id as string;
    const running = await time(owner, "POST", "/timer/start", { projectId: other, description: "Private work" });
    expect(running.status).toBeLessThan(300);
    const created = createApiKey(owner.userId, { name: "One project", surfaces: "both", expiresInDays: 30, grants: [{ module: "time", permission: "write", resourceKind: "time_project", resourceId: reached }] });
    const key = { id: created.id, token: created.token, userId: owner.userId };
    const outcome = await mcpCall(key, "start_timer", { projectId: reached, description: "Via key" });
    expect(outcome.isError).toBe(true);
    const row = db.query("SELECT project_id, ended_at FROM time_entries WHERE user_id = ? AND ended_at IS NULL").get(owner.userId) as Json;
    expect(row).toEqual({ project_id: other, ended_at: null });
    await time(owner, "POST", "/timer/stop", {});
    expect((await mcpCall(key, "start_timer", { projectId: reached, description: "Via key" })).isError).toBe(false);
    await time(owner, "POST", "/timer/stop", {});
  });

  test("get_time_for_item totals only the projects the key reaches", async () => {
    resetMcpLimits();
    const board = await call(owner, "POST", "/tasks/boards", { name: "Audit2 key board" });
    const card = (await call(owner, "POST", `/tasks/boards/${board.body.board.id}/cards`, { columnId: board.body.columns[0].id, title: "Key card" })).body.card.id as string;
    const reached = (await time(owner, "POST", "/projects", { name: "Reached for totals" })).body.project.id as string;
    const other = (await time(owner, "POST", "/projects", { name: "Hidden from key" })).body.project.id as string;
    await time(owner, "POST", "/entries", { startedAt: hoursAgo(40), duration: 600, projectId: reached, target: { kind: "card", id: card } });
    await time(owner, "POST", "/entries", { startedAt: hoursAgo(41), duration: 3000, projectId: other, target: { kind: "card", id: card } });
    const created = createApiKey(owner.userId, { name: "Totals key", surfaces: "both", expiresInDays: 30, grants: [{ module: "time", permission: "read", resourceKind: "time_project", resourceId: reached }] });
    const key = { id: created.id, token: created.token, userId: owner.userId };
    const outcome = await mcpCall(key, "get_time_for_item", { target: `card:${card}` });
    expect(outcome.isError).toBe(false);
    expect(outcome.value.totalSeconds).toBe(600);
    expect(outcome.value.mySeconds).toBe(600);
    expect(outcome.value.byPerson).toEqual([expect.objectContaining({ seconds: 600 })]);
    expect(outcome.value.entries).toHaveLength(1);
  });
});

describe("approvals and today (TG7, D1146, D1147)", () => {
  test("a week's total counts its entries by their local day, as approving locks them", async () => {
    const user = await createUser("Audit2 Auckland");
    const project = (await time(user, "POST", "/projects", { name: "Auckland week" })).body.project.id as string;
    const tz = "Pacific/Auckland";
    // Monday 2026-11-02 08:00 in Auckland is Sunday 19:00 UTC; Monday 2026-11-09 09:00 there is still Sunday in UTC.
    expect((await time(user, "POST", "/entries", { startedAt: "2026-11-01T19:00:00.000Z", duration: 3600, projectId: project, tz })).status).toBe(201);
    expect((await time(user, "POST", "/entries", { startedAt: "2026-11-08T20:00:00.000Z", duration: 1200, projectId: project, tz })).status).toBe(201);
    expect((await time(user, "POST", "/approvals", { projectId: project, weekStart: "2026-11-02" })).status).toBe(201);
    const mine = await time(user, "GET", "/approvals?mine=1");
    expect(mine.body.approvals.find((row: Json) => row.weekStart === "2026-11-02").seconds).toBe(3600);
  });

  test("time logged ahead for tomorrow is not today's", async () => {
    const user = await createUser("Audit2 today");
    const before = todayTotals(user.userId, "UTC");
    expect((await time(user, "POST", "/entries", { startedAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), duration: 900 })).status).toBe(201);
    expect(todayTotals(user.userId, "UTC")).toEqual(before);
  });
});

describe("goals (TG3, TG6, D1145, D1146, D1148)", () => {
  const goals = (session: Session, method: string, path: string, body?: unknown) => call(session, method, path, body);
  let q1: string;
  let q2: string;
  beforeAll(async () => {
    q1 = (await goals(owner, "POST", "/goal-periods", { name: "Audit Q1", startsOn: "2026-01-01", endsOn: "2026-03-31" })).body.period.id;
    q2 = (await goals(owner, "POST", "/goal-periods", { name: "Audit Q2", startsOn: "2026-04-01", endsOn: "2026-06-30" })).body.period.id;
  });
  const progressOf = (id: string) => (db.query("SELECT progress FROM goals WHERE id = ?").get(id) as Json).progress as number;

  test("a goal carried over counts once in its parent's roll-up", async () => {
    const parent = (await goals(owner, "POST", "/goals", { title: "Carry parent", progressMode: "children" })).body.goal.id as string;
    const a = (await goals(owner, "POST", "/goals", { title: "Carry A", parentId: parent, periodId: q1, progressMode: "manual" })).body.goal.id as string;
    const b = (await goals(owner, "POST", "/goals", { title: "Carry B", parentId: parent, periodId: q1, progressMode: "manual" })).body.goal.id as string;
    await goals(owner, "PATCH", `/goals/${a}`, { progress: 1 });
    await goals(owner, "PATCH", `/goals/${b}`, { progress: 0.2 });
    expect(progressOf(parent)).toBeCloseTo(0.6, 6);
    const closed = await goals(owner, "POST", `/goals/${b}/close`, { state: "carried_over", carryOver: { periodId: q2 } });
    expect(closed.status).toBe(200);
    expect(progressOf(parent)).toBeCloseTo(0.6, 6);
    // The copy moves on: the parent follows it, not the closed original.
    await goals(owner, "PATCH", `/goals/${closed.body.carriedOver.id}`, { progress: 0.8 });
    expect(progressOf(parent)).toBeCloseTo(0.9, 6);
  });

  async function autoGoal(title: string, periodId: string) {
    const created = await call(owner, "POST", "/tasks/boards", { name: `${title} board` });
    const boardId = created.body.board.id as string;
    const columns = created.body.columns as Array<{ id: string; is_done: number }>;
    const done = columns.find((column) => column.is_done === 1)!.id;
    const first = (await call(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId: columns[0]!.id, title: "One" })).body.card.id as string;
    const second = (await call(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId: columns[0]!.id, title: "Two" })).body.card.id as string;
    await call(owner, "POST", `/tasks/cards/${first}/move`, { columnId: done, afterCardId: null });
    const goal = await goals(owner, "POST", "/goals", { title, periodId, keyResults: [{ title: "Cards done", metric: "percent", targetValue: 100, source: { kind: "tasks", config: { scope: "board", id: boardId, measure: "cards" } } }] });
    const goalId = goal.body.goal.id as string;
    await refreshGoalSources(goalId, { force: true });
    expect(progressOf(goalId)).toBeCloseTo(0.5, 6);
    // Inside the debounce: a page view now would not recompute it.
    await call(owner, "POST", `/tasks/cards/${second}/move`, { columnId: done, afterCardId: null });
    return goalId;
  }

  test("closing a goal snapshots fresh auto progress", async () => {
    const goalId = await autoGoal("Fresh close", q1);
    const closed = await goals(owner, "POST", `/goals/${goalId}/close`, { state: "achieved" });
    expect(closed.status).toBe(200);
    expect(closed.body.goal.finalProgress).toBeCloseTo(1, 6);
  });

  test("closing a period scores goals on fresh auto progress", async () => {
    const period = (await goals(owner, "POST", "/goal-periods", { name: "Audit close period", startsOn: "2025-01-01", endsOn: "2025-03-31" })).body.period.id as string;
    const goalId = await autoGoal("Fresh period", period);
    const closed = await goals(owner, "POST", `/goal-periods/${period}/close`, {});
    expect(closed.status).toBe(200);
    expect(closed.body.closed).toMatchObject({ achieved: 1, missed: 0 });
    expect((db.query("SELECT state, final_progress FROM goals WHERE id = ?").get(goalId) as Json)).toEqual({ state: "achieved", final_progress: 1 });
  });

  test("MCP create_goal puts a goal without a period in the current one; null keeps none", async () => {
    resetMcpLimits();
    const today = new Date().toISOString().slice(0, 10);
    const current = (await goals(owner, "POST", "/goal-periods", { name: "Audit now", startsOn: today, endsOn: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) })).body.period.id as string;
    const created = createApiKey(owner.userId, { name: "Goals key", surfaces: "both", expiresInDays: 30, grants: [{ module: "goals", permission: "write" }] });
    const key = { id: created.id, token: created.token, userId: owner.userId };
    const defaulted = await mcpCall(key, "create_goal", { title: "Defaulted goal" });
    expect(defaulted.isError).toBe(false);
    expect((db.query("SELECT period_id FROM goals WHERE title = 'Defaulted goal'").get() as Json).period_id).toBe(current);
    expect((await mcpCall(key, "create_goal", { title: "No period goal", periodId: null })).isError).toBe(false);
    expect((db.query("SELECT period_id FROM goals WHERE title = 'No period goal'").get() as Json).period_id).toBeNull();
  });
});
