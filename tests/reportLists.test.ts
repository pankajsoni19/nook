import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import { cpuMs, HEAVY_TEST_TIMEOUT_MS } from "./support/cpuTime";

const { reportTools } = await import("../server/reports/mcpTools");
const { visibleTools } = await import("../server/mcpTools");
const { NOOK_NEVER_TOOLS } = await import("../server/agents/nookBridge");
const { registeredMigrations, runMigrations } = await import("../server/migrations");
const { reportListsMigration } = await import("../server/migrations/068_report_lists");
const { reportListSql } = await import("../server/reports/service");
const { reportListsSql } = await import("../server/reports/lists");

/**
 * Report lists (report organization phase 3, migration 068, D550–D559, T415–T417): a list groups reports
 * without moving them, in its curators' order; a report sits in many lists. A list never grants access
 * (D487): its pages and counts go through readableReportSql, per viewer; only its curators learn how
 * many reports in it they can't open (never which). The owner renames, shares, and deletes (to their own
 * Bin); people at `edit` add, remove, and reorder; viewers read. MCP reads lists and adds to one; nothing
 * else (D180). At 300 lists and a 2,000-report list, the nav and a page stay under the list's budget
 * without full scans.
 */

const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}
async function role(label: string, value: "admin" | "member" | "viewer" | "guest") {
  const session = await createUser(label);
  db.query("UPDATE users SET role = ? WHERE id = ?").run(value, session.userId);
  return session;
}

const admin = await role("Lists admin", "admin");
const owner = await role("Lists owner", "member");
const curator = await role("Lists curator", "member");
const reader = await role("Lists reader", "member");
const viewer = await role("Lists viewer", "viewer");
const guest = await role("Lists guest", "guest");

const datasource = (await send(admin, "POST", "/reports/admin/datasources", { name: "Lists warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: [] })).body.datasource as Json;
const newReport = async (session: Session, title: string) => {
  const created = await send(session, "POST", "/reports", { title, datasourceId: datasource.id });
  expect(created.status).toBe(201);
  return created.body.report as Json;
};
const shareReport = async (session: Session, reportId: string, shares: Json[], visibility = "selected") => {
  expect((await send(session, "PUT", `/reports/${reportId}/sharing`, { visibility, shares })).status).toBe(200);
};
const newList = async (session: Session, name: string) => {
  const created = await send(session, "POST", "/reports/lists", { name });
  expect(created.status).toBe(201);
  return created.body.list as Json;
};
const add = (session: Session, listId: string, reportId: string) => send(session, "PUT", `/reports/lists/${listId}/items/${reportId}`);
const page = async (session: Session, listId: string, extra = "") => send(session, "GET", `/reports?list=${listId}${extra}`);
const titles = (body: Json) => (body.reports as Json[]).map((report) => report.title);
const navList = async (session: Session, listId: string) => ((await send(session, "GET", "/reports/lists")).body.lists as Json[]).find((list) => list.id === listId);

describe("migration 068 report_lists", () => {
  test("adds report_lists, report_list_items, and their sharing tables (STRICT, cascades); re-running changes nothing", () => {
    const at = "2026-10-22T00:00:00.000Z";
    const memory = new Database(":memory:", { strict: true });
    memory.exec("PRAGMA foreign_keys = ON");
    memory.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    for (const migration of registeredMigrations.filter((item) => item.id < 68)) {
      memory.transaction(() => {
        migration.up(memory);
        memory.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, at);
      })();
    }
    memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u2', 'b@example.test', 'B', 'x', ?, 'member')").run(at);
    memory.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES ('r1', 'u1', 'Weekly revenue', ?, ?)").run(at, at);
    runMigrations(memory);
    for (const table of ["report_lists", "report_list_items", "report_list_members", "report_list_group_shares"]) {
      expect(String((memory.query("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql: string }).sql)).toContain("STRICT");
    }
    memory.query("INSERT INTO report_lists (id, owner_id, name, created_at, updated_at) VALUES ('l1', 'u1', 'Board pack', ?, ?)").run(at, at);
    memory.query("INSERT INTO report_list_items (list_id, report_id, position, added_by, added_at) VALUES ('l1', 'r1', 0, 'u1', ?)").run(at);
    memory.query("INSERT INTO report_list_members (list_id, user_id, level, created_at) VALUES ('l1', 'u2', 'edit', ?)").run(at);
    expect(() => memory.query("INSERT INTO report_list_items (list_id, report_id, position, added_at) VALUES ('l1', 'r1', 1, ?)").run(at)).toThrow();
    expect(() => memory.query("INSERT INTO report_list_members (list_id, user_id, level, created_at) VALUES ('l1', 'u1', 'comment', ?)").run(at)).toThrow();
    expect(() => memory.query("INSERT INTO report_lists (id, owner_id, name, visibility, created_at, updated_at) VALUES ('l2', 'u1', 'x', 'public', ?, ?)").run(at, at)).toThrow();
    memory.query("DELETE FROM users WHERE id = 'u2'").run();
    expect(memory.query("SELECT COUNT(*) AS n FROM report_list_members").get()).toEqual({ n: 0 });
    memory.query("DELETE FROM reports WHERE id = 'r1'").run();
    expect(memory.query("SELECT COUNT(*) AS n FROM report_list_items").get()).toEqual({ n: 0 });
    reportListsMigration.up(memory);
    expect(memory.query("SELECT id FROM schema_migrations WHERE id = 68").get()).toEqual({ id: 68 });
  });
});

describe("lists", () => {
  test("members create, rename, and delete their lists (to their own Bin, D553); viewers read only; guests have none", async () => {
    const list = await newList(owner, "Board pack");
    expect(list).toMatchObject({ name: "Board pack", level: "owner", visibility: "private", count: 0, hidden: 0 });
    expect((await send(owner, "PATCH", `/reports/lists/${list.id}`, { name: "Board pack Q4" })).body.list.name).toBe("Board pack Q4");
    expect((await send(owner, "POST", "/reports/lists", { name: "  " })).status).toBe(400);
    expect((await send(viewer, "POST", "/reports/lists", { name: "Mine" })).status).toBe(403);
    expect((await send(guest, "GET", "/reports/lists")).status).toBe(404);
    // Someone else's private list: the same 404 as a missing one.
    expect((await send(reader, "GET", `/reports/lists/${list.id}`)).status).toBe(404);
    expect((await send(reader, "PATCH", `/reports/lists/${list.id}`, { name: "Taken" })).status).toBe(404);
    expect((await page(reader, list.id)).status).toBe(404);
    // To the owner's Bin; admins neither see nor restore it (unlike folders, D483).
    expect((await send(owner, "DELETE", `/reports/lists/${list.id}`)).status).toBe(200);
    expect((await send(owner, "GET", `/reports/lists/${list.id}`)).status).toBe(404);
    expect(((await send(admin, "GET", "/bin")).body.items as Json[]).some((item) => item.id === list.id)).toBe(false);
    expect((await send(admin, "POST", `/bin/report_list/${list.id}/restore`)).status).toBe(404);
    const bin = (await send(owner, "GET", "/bin")).body.items as Json[];
    expect(bin.find((item) => item.id === list.id)).toMatchObject({ type: "report_list", title: "Board pack Q4" });
    expect((await send(owner, "POST", `/bin/report_list/${list.id}/restore`)).status).toBe(200);
    expect((await send(owner, "GET", `/reports/lists/${list.id}`)).body.list.name).toBe("Board pack Q4");
    const audits = (db.query("SELECT event_type FROM audit_log WHERE actor_id = ? AND event_type LIKE 'reports.list.%' ORDER BY created_at").all(owner.userId) as Array<{ event_type: string }>).map((row) => row.event_type);
    expect(audits).toEqual(["reports.list.create", "reports.list.rename", "reports.list.bin", "reports.list.restore"]);
  });

  test("a list never grants access (D487, T414): each person sees only the reports they can open; counts are per viewer; only curators see how many they can't", async () => {
    const list = await newList(owner, "Shared pack");
    const open = await newReport(owner, "Open to everyone");
    const secret = await newReport(owner, "Owner only");
    const curatorsOwn = await newReport(curator, "Curator private");
    await shareReport(owner, open.id, [], "all_users");
    for (const report of [open, secret]) expect((await add(owner, list.id, report.id)).status).toBe(200);
    // Adding a report you can't open is the same 404 as a missing one: no title enters a list unseen.
    expect((await add(owner, list.id, curatorsOwn.id)).status).toBe(404);
    expect((await add(owner, list.id, crypto.randomUUID())).status).toBe(404);
    await send(owner, "PUT", `/reports/lists/${list.id}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: curator.userId, level: "edit" }, { kind: "user", id: reader.userId, level: "view" }] });
    expect((await add(curator, list.id, curatorsOwn.id)).body.added).toBe(true);
    expect((await add(reader, list.id, open.id)).status).toBe(403);
    // The owner sees two of three; the curator two of three (theirs and the open one); the reader one.
    expect(titles((await page(owner, list.id)).body)).toEqual(["Open to everyone", "Owner only"]);
    expect(titles((await page(curator, list.id)).body)).toEqual(["Open to everyone", "Curator private"]);
    expect(titles((await page(reader, list.id)).body)).toEqual(["Open to everyone"]);
    expect(await navList(owner, list.id)).toMatchObject({ count: 2, hidden: 1, level: "owner" });
    expect(await navList(curator, list.id)).toMatchObject({ count: 2, hidden: 1, level: "edit" });
    // A reader never learns that the list holds anything else (D552).
    expect(await navList(reader, list.id)).toMatchObject({ count: 1, hidden: null, level: "view" });
    expect(JSON.stringify((await page(reader, list.id)).body)).not.toContain("Owner only");
    // A binned report drops out for everyone and is not counted as hidden; access lost drops it from the reader's view.
    await send(owner, "DELETE", `/reports/${secret.id}`);
    expect(await navList(owner, list.id)).toMatchObject({ count: 1, hidden: 1 });
    await shareReport(owner, open.id, [], "private");
    expect(await navList(reader, list.id)).toMatchObject({ count: 0, hidden: null });
    expect(await navList(curator, list.id)).toMatchObject({ count: 1, hidden: 1 });
    // A guest shared in by id is refused; a viewer at edit is capped at view (D266).
    expect((await send(owner, "PUT", `/reports/lists/${list.id}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: guest.userId, level: "view" }] })).status).toBe(400);
    await send(owner, "PUT", `/reports/lists/${list.id}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: viewer.userId, level: "edit" }] });
    expect(await navList(viewer, list.id)).toMatchObject({ level: "view", hidden: null });
    expect((await send(curator, "GET", `/reports/lists/${list.id}`)).status).toBe(404);
    // Everyone on the team: every person sees it at view, never guests.
    await send(owner, "PUT", `/reports/lists/${list.id}/sharing`, { visibility: "all_users", shares: [] });
    expect(await navList(reader, list.id)).toMatchObject({ level: "view" });
    expect((await send(guest, "GET", `/reports?list=${list.id}`)).status).toBe(404);
    // Only the owner shares, renames, and deletes.
    expect((await send(reader, "GET", `/reports/lists/${list.id}/sharing`)).status).toBe(403);
    expect((await send(reader, "DELETE", `/reports/lists/${list.id}`)).status).toBe(403);
  });

  test("groups share a list at view or edit; a group share counts on the group's page", async () => {
    const list = await newList(owner, "Group pack");
    const groupId = crypto.randomUUID();
    const at = new Date().toISOString();
    db.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES (?, 'Lists finance', ?, ?)").run(groupId, at, at);
    db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(groupId, reader.userId, at);
    const report = await newReport(owner, "Group visible");
    await shareReport(owner, report.id, [{ kind: "group", id: groupId, level: "view" }]);
    await add(owner, list.id, report.id);
    expect((await send(owner, "PUT", `/reports/lists/${list.id}/sharing`, { visibility: "selected", shares: [{ kind: "group", id: groupId, level: "edit" }] })).status).toBe(200);
    expect(await navList(reader, list.id)).toMatchObject({ level: "edit", count: 1, hidden: 0 });
    expect((await send(owner, "GET", `/reports/lists/${list.id}/sharing`)).body.sharing.shares).toEqual([{ kind: "group", id: groupId, name: "Lists finance", level: "edit" }]);
    const { groupSharedCountSql } = await import("../server/team/groups");
    expect((db.query(`SELECT ${groupSharedCountSql("g")} AS n FROM user_groups g WHERE g.id = ?`).get(groupId) as { n: number }).n).toBe(2);
  });

  test("a report sits in many lists; the picker shows the lists the caller curates; curators reorder and remove", async () => {
    const first = await newList(curator, "First");
    const second = await newList(curator, "Second");
    const reports = [];
    for (const name of ["A", "B", "C", "D"]) reports.push(await newReport(curator, `Order ${name}`));
    for (const report of reports) await add(curator, first.id, report.id);
    await add(curator, second.id, reports[0]!.id);
    const choices = (await send(curator, "GET", `/reports/${reports[0]!.id}/lists`)).body.lists as Json[];
    expect(choices.filter((choice) => [first.id, second.id].includes(choice.id)).map((choice) => [choice.name, choice.contains])).toEqual([["First", true], ["Second", true]]);
    expect(((await send(curator, "GET", `/reports/${reports[1]!.id}/lists`)).body.lists as Json[]).find((choice) => choice.id === second.id)?.contains).toBe(false);
    // D before B; A after C; C to the end.
    expect((await send(curator, "PATCH", `/reports/lists/${first.id}/items/${reports[3]!.id}`, { beforeId: reports[1]!.id })).status).toBe(200);
    expect(titles((await page(curator, first.id)).body)).toEqual(["Order A", "Order D", "Order B", "Order C"]);
    await send(curator, "PATCH", `/reports/lists/${first.id}/items/${reports[0]!.id}`, { afterId: reports[2]!.id });
    expect(titles((await page(curator, first.id)).body)).toEqual(["Order D", "Order B", "Order C", "Order A"]);
    await send(curator, "PATCH", `/reports/lists/${first.id}/items/${reports[2]!.id}`, {});
    expect(titles((await page(curator, first.id)).body)).toEqual(["Order D", "Order B", "Order A", "Order C"]);
    expect((await send(curator, "PATCH", `/reports/lists/${first.id}/items/${reports[2]!.id}`, { beforeId: reports[0]!.id, afterId: reports[1]!.id })).status).toBe(400);
    expect((await send(curator, "DELETE", `/reports/lists/${first.id}/items/${reports[1]!.id}`)).body.removed).toBe(true);
    expect(titles((await page(curator, first.id)).body)).toEqual(["Order D", "Order A", "Order C"]);
    // Pages by cursor in the list's order.
    const one = await page(curator, first.id, "&limit=2");
    expect(titles(one.body)).toEqual(["Order D", "Order A"]);
    expect(titles((await page(curator, first.id, `&limit=2&cursor=${encodeURIComponent(one.body.nextCursor)}`)).body)).toEqual(["Order C"]);
    // Filters narrow a list too.
    expect(titles((await page(curator, first.id, "&q=order%20a")).body)).toEqual(["Order A"]);
  });

  test("a curator's reorder keeps the reports they can't open where they are (D555)", async () => {
    const list = await newList(owner, "Mixed");
    const shared = [await newReport(owner, "Mixed 1"), await newReport(owner, "Mixed 2")];
    const hidden = await newReport(owner, "Mixed hidden");
    for (const report of shared) await shareReport(owner, report.id, [{ kind: "user", id: curator.userId, level: "view" }]);
    for (const report of [shared[0]!, hidden, shared[1]!]) await add(owner, list.id, report.id);
    await send(owner, "PUT", `/reports/lists/${list.id}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: curator.userId, level: "edit" }] });
    // The curator can't move the report they can't open, nor anchor on it.
    expect((await send(curator, "PATCH", `/reports/lists/${list.id}/items/${hidden.id}`, {})).status).toBe(404);
    expect((await send(curator, "PATCH", `/reports/lists/${list.id}/items/${shared[0]!.id}`, { afterId: hidden.id })).status).toBe(404);
    await send(curator, "PATCH", `/reports/lists/${list.id}/items/${shared[1]!.id}`, { beforeId: shared[0]!.id });
    expect(titles((await page(owner, list.id)).body)).toEqual(["Mixed 2", "Mixed 1", "Mixed hidden"]);
    expect(titles((await page(curator, list.id)).body)).toEqual(["Mixed 2", "Mixed 1"]);
  });
});

describe("MCP", () => {
  test("list_report_lists and get_report_list (reports:read), add_report_to_list (reports:write, audited); never offered to agents; no removal over MCP", async () => {
    const tool = (name: string) => reportTools.find((item) => item.name === name)!;
    const mcpUser = await role("Lists MCP", "member");
    const key = { keyId: "k-lists", userId: mcpUser.userId, name: "k", scopes: ["reports:read" as const, "reports:write" as const] };
    expect([tool("list_report_lists").scopes, tool("get_report_list").scopes, tool("add_report_to_list").scopes, tool("add_report_to_list").buckets]).toEqual([["reports:read"], ["reports:read"], ["reports:write"], ["report_write"]]);
    expect(visibleTools({ ...key, scopes: ["reports:read"] }).map((item) => item.name)).not.toContain("add_report_to_list");
    for (const name of ["list_report_lists", "get_report_list", "add_report_to_list"]) expect([name, NOOK_NEVER_TOOLS.has(name)]).toEqual([name, true]);
    expect(reportTools.some((item) => /remove.*list|list.*(remove|delete|share)/.test(item.name))).toBe(false);
    const list = await newList(mcpUser, "MCP list");
    const report = await newReport(mcpUser, "MCP listed");
    const added = await tool("add_report_to_list").handler({ listId: list.id, reportId: report.id }, key) as Json;
    expect(added).toMatchObject({ added: true, list: { id: list.id, name: "MCP list", owner: "me", level: "owner", reports: 1, hidden: 0 } });
    const lists = await tool("list_report_lists").handler({}, key) as Json;
    // Their own first; a list the whole team sees comes after (at view, without a hidden count).
    expect(lists.lists[0]).toMatchObject({ name: "MCP list", owner: "me" });
    expect(lists.lists.filter((item: Json) => item.owner !== "me").every((item: Json) => item.level === "view" && item.hidden === undefined)).toBe(true);
    const got = await tool("get_report_list").handler({ listId: list.id }, key) as Json;
    expect(got.reports.map((item: Json) => item.title)).toEqual(["MCP listed"]);
    expect(got.list.url).toContain(`/reports/lists/${list.id}`);
    const others = await newReport(owner, "Not the key's either");
    await expect(Promise.resolve().then(() => tool("add_report_to_list").handler({ listId: list.id, reportId: others.id }, key))).rejects.toThrow();
    const ownersList = await newList(owner, "Owner's list");
    await expect(Promise.resolve().then(() => tool("get_report_list").handler({ listId: ownersList.id }, key))).rejects.toThrow(/not found/i);
    const audits = db.query("SELECT event_type FROM audit_log WHERE actor_id = ? AND metadata_json LIKE '%k-lists%'").all(mcpUser.userId) as Array<{ event_type: string }>;
    expect(audits.map((row) => row.event_type)).toEqual(["reports.list.add"]);
  });
});

describe("lists at scale", () => {
  test("a move across a 2,000-report list and an add at its end stay under 50 ms of CPU (D555)", async () => {
    const { moveInList, addToList } = await import("../server/reports/lists");
    const big = await role("Lists big", "member");
    const list = await newList(big, "Two thousand");
    const at = new Date().toISOString();
    const ids = Array.from({ length: 2001 }, () => crypto.randomUUID());
    db.transaction(() => {
      for (const [index, id] of ids.entries()) {
        db.query("INSERT INTO reports (id, owner_id, title, datasource_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, big.userId, `Big ${index}`, datasource.id, at, at);
        db.query("INSERT OR IGNORE INTO report_owners (report_id, user_id, created_at) VALUES (?, ?, ?)").run(id, big.userId, at);
        if (index < 2000) db.query("INSERT INTO report_list_items (list_id, report_id, position, added_at) VALUES (?, ?, ?, ?)").run(list.id, id, index, at);
      }
    })();
    const move = cpuMs(() => moveInList(big.userId, list.id, ids[1999]!, { beforeId: ids[0]! }));
    const append = cpuMs(() => addToList(big.userId, list.id, ids[2000]!));
    expect(titles((await page(big, list.id, "&limit=2")).body)).toEqual(["Big 1999", "Big 0"]);
    expect({ move: move < 50, append: append < 50 }).toEqual({ move: true, append: true });
    console.log(`[report lists at scale] CPU ms: move across 2,000 ${move.toFixed(2)}, add at the end ${append.toFixed(2)}`);
  }, HEAVY_TEST_TIMEOUT_MS);

  test("300 lists and a 2,000-report list: the nav and a list page in under 50 ms of CPU, without full scans", () => {
    const at = Date.parse("2026-10-22T00:00:00.000Z");
    const memory = new Database(":memory:", { strict: true });
    memory.exec("PRAGMA foreign_keys = ON");
    runMigrations(memory);
    const iso = (offset: number) => new Date(at - offset * 1000).toISOString();
    const users = Array.from({ length: 60 }, (_, index) => `user-${index}`);
    const groups = Array.from({ length: 50 }, (_, index) => `group-${index}`);
    memory.transaction(() => {
      for (const [index, id] of users.entries()) memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, 'x', ?, 'member')").run(id, `${id}@example.test`, `Person ${index}`, iso(0));
      memory.query("INSERT INTO report_datasources (id, name, kind, url, username, created_at, updated_at) VALUES ('ds', 'Warehouse', 'clickhouse', 'http://x', 'u', ?, ?)").run(iso(0), iso(0));
      for (const [index, id] of groups.entries()) {
        memory.query("INSERT INTO user_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, `Group ${index}`, iso(0), iso(0));
        for (let member = 0; member < 6; member += 1) memory.query("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(id, users[(index * 7 + member) % users.length]!, iso(0));
      }
      for (let index = 0; index < 2000; index += 1) {
        const ownerId = users[index % users.length]!;
        const visibility = index % 10 === 0 ? "all_users" : index % 3 === 0 ? "selected" : "private";
        memory.query("INSERT INTO reports (id, owner_id, title, datasource_id, status, visibility, created_at, updated_at) VALUES (?, ?, ?, 'ds', 'ready', ?, ?, ?)")
          .run(`report-${index}`, ownerId, `Report ${index} revenue`, visibility, iso(index), iso(index));
        if (visibility === "selected") memory.query("INSERT INTO report_group_shares (report_id, group_id, level, created_at) VALUES (?, ?, 'view', ?)").run(`report-${index}`, groups[index % groups.length]!, iso(0));
      }
      // 300 lists the viewer sees (their own, everyone's, a person share, a group share), 20 reports each; and one of 2,000.
      for (let index = 0; index < 300; index += 1) {
        const ownerId = index % 4 === 0 ? users[1]! : users[(index % (users.length - 2)) + 2]!;
        const visibility = index % 4 === 1 ? "all_users" : index % 4 === 0 ? "private" : "selected";
        memory.query("INSERT INTO report_lists (id, owner_id, name, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(`list-${index}`, ownerId, `List ${index}`, visibility, iso(0), iso(0));
        if (index % 4 === 2) memory.query("INSERT INTO report_list_members (list_id, user_id, level, created_at) VALUES (?, ?, 'edit', ?)").run(`list-${index}`, users[1]!, iso(0));
        if (index % 4 === 3) memory.query("INSERT INTO report_list_group_shares (list_id, group_id, level, created_at) VALUES (?, 'group-0', 'view', ?)").run(`list-${index}`, iso(0));
        const size = index === 0 ? 2000 : 20;
        for (let item = 0; item < size; item += 1) memory.query("INSERT INTO report_list_items (list_id, report_id, position, added_at) VALUES (?, ?, ?, ?)").run(`list-${index}`, `report-${(item * 7 + index) % 2000}`, item, iso(0));
      }
      // Other people's lists the viewer never sees.
      for (let index = 0; index < 1000; index += 1) memory.query("INSERT INTO report_lists (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(`other-${index}`, users[(index % 50) + 10]!, `Other ${index}`, iso(0), iso(0));
      memory.exec("ANALYZE");
    })();
    const userId = users[1]!;
    const measure = (sql: string, bind: Record<string, unknown>) => {
      const statement = memory.query(sql);
      statement.all(bind as never);
      const runs = Array.from({ length: 5 }, () => cpuMs(() => statement.all(bind as never))).sort((a, b) => a - b);
      const plan = (memory.query(`EXPLAIN QUERY PLAN ${sql}`).all(bind as never) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
      return { ms: runs[2]!, plan, rows: statement.all(bind as never).length };
    };
    const nav = measure(reportListsSql(), { userId });
    expect(nav.rows).toBe(300);
    expect(nav.plan).not.toMatch(/SCAN (l|report_lists|r|reports)(?! USING)/);
    const { sql, params } = reportListSql({ listId: "list-0" });
    const listPage = measure(sql, { ...params, userId, limit: 101 });
    expect(listPage.rows).toBeGreaterThan(0);
    expect(listPage.plan).toMatch(/report_list_items_order|sqlite_autoindex_report_list_items/);
    expect(listPage.plan).not.toMatch(/SCAN (r|reports)(?! USING)/);
    expect(listPage.plan).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
    const deep = reportListSql({ listId: "list-0", q: "revenue 19" });
    const filtered = measure(deep.sql, { ...deep.params, userId, limit: 101 });
    for (const [name, ms] of Object.entries({ nav: nav.ms, page: listPage.ms, filtered: filtered.ms })) expect({ name, ms: ms < 50 }).toEqual({ name, ms: true });
    console.log(`[report lists at scale] median CPU ms: nav (300 lists) ${nav.ms.toFixed(2)}, 2,000-report list page ${listPage.ms.toFixed(2)}, filtered ${filtered.ms.toFixed(2)}`);
  }, HEAVY_TEST_TIMEOUT_MS);
});
