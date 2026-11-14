import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createUser, db, request, type Session } from "./support/harness";

const { crmTodayProvider } = await import("../server/crm/integrations");

/**
 * Audit 2 plan/docs gaps (docs/plan/WORKSPACE_MODULES.md §D.9, D1190–D1194): Today's Follow-ups link,
 * standup private answers (managers only), guests and the role-limited modules, and a settings row
 * for every notification topic the seven modules emit.
 */

type Json = Record<string, any>;
const api = async (session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? (method === "GET" ? {} : { body: "{}" }) : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = JSON.parse(text) as Json; } catch { json = { text }; }
  return { status: response.status, body: json, etag: response.headers.get("ETag") };
};
const share = async (owner: Session, kind: string, id: string, people: Array<{ id: string; level: string }>) => {
  const current = await api(owner, "GET", `/access/${kind}/${id}`);
  return api(owner, "PUT", `/access/${kind}/${id}`, { audience: "selected", people }, { "If-Match": current.etag! });
};

let owner: Session;
let editor: Session;
let guest: Session;

beforeAll(async () => {
  owner = await createUser("Gaps owner");
  editor = await createUser("Gaps editor");
  guest = await createUser("Gaps guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
});

describe("module links (D1190)", () => {
  test("Today's Follow-ups section opens the Follow-ups tab, which Contacts routes by path", () => {
    expect(crmTodayProvider.href).toBe("/contacts/followups");
  });
});

describe("standup private answers (D1191)", () => {
  test("only the owner or a manager turns private answers on or off; editors keep their other changes", async () => {
    const created = await api(owner, "POST", "/checkins", { template: "standup", name: "Private standup" });
    expect(created.status).toBe(201);
    const id = created.body.checkin.id as string;
    expect((await share(owner, "checkin", id, [{ id: editor.userId, level: "edit" }])).status).toBe(200);
    const refused = await api(editor, "PATCH", `/checkins/${id}`, { privateAnswers: true });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("READ_ONLY");
    // Sending the current value with other changes is not a change of who sees the answers.
    expect((await api(editor, "PATCH", `/checkins/${id}`, { privateAnswers: false, name: "Renamed standup" })).status).toBe(200);
    const on = await api(owner, "PATCH", `/checkins/${id}`, { privateAnswers: true });
    expect(on.status).toBe(200);
    expect(on.body.checkin.privateAnswers).toBe(true);
    expect((await api(editor, "PATCH", `/checkins/${id}`, { privateAnswers: false })).status).toBe(403);
    expect((await share(owner, "checkin", id, [{ id: editor.userId, level: "manage" }])).status).toBe(200);
    const off = await api(editor, "PATCH", `/checkins/${id}`, { privateAnswers: false });
    expect(off.status).toBe(200);
    expect(off.body.checkin.privateAnswers).toBe(false);
  });
});

describe("guests and role-limited modules (D1192)", () => {
  test("members get Time, Contacts, and Bookings; a guest gets Time only once on a time project", async () => {
    expect((await api(owner, "GET", "/auth/me")).body.features).toMatchObject({ time: true, crm: true, bookings: true });
    expect((await api(guest, "GET", "/auth/me")).body.features).toMatchObject({ time: false, crm: false, bookings: false });
    const project = await api(owner, "POST", "/time/projects", { name: "Contractor work", memberIds: [guest.userId] });
    expect(project.status).toBe(201);
    expect((await api(guest, "GET", "/auth/me")).body.features).toMatchObject({ time: true, crm: false, bookings: false });
    // The guest logs time there (D887), which is what the Time module is shown for.
    const logged = await api(guest, "POST", "/time/entries", { startedAt: new Date(Date.now() - 3_600_000).toISOString(), duration: 1800, projectId: project.body.project.id, description: "Contract hours" });
    expect(logged.status).toBe(201);
    // A binned project no longer counts.
    expect((await api(owner, "DELETE", `/time/projects/${project.body.project.id}`)).status).toBeLessThan(300);
    expect((await api(guest, "GET", "/auth/me")).body.features.time).toBe(false);
  });

  test("Contacts answers guests 404, like Bookings, even for a book shared with them", async () => {
    const book = await api(owner, "POST", "/crm/books", { name: "Shared with a guest" });
    expect(book.status).toBe(201);
    await share(owner, "contact_book", book.body.book.id, [{ id: guest.userId, level: "view" }]);
    for (const path of ["/crm/books", `/crm/contacts?book=${book.body.book.id}`, "/crm/followups"]) {
      const response = await api(guest, "GET", path);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("NOT_FOUND");
    }
    expect((await api(guest, "GET", "/bookings?view=upcoming")).status).toBe(404);
    expect((await api(owner, "GET", "/crm/books")).status).toBe(200);
  });
});

// ------------------------------------------------------------------ notification topics (D1193)

const MODULE_DIRS = { forms: "forms", time: "time", goals: "goals", checkins: "checkins", crm: "crm", bookings: "bookings", townhall: "townhall" } as const;
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
});

/** Topic literals the server passes to notify(): `topic: "…"` (ternaries included) and notifyHosts(…, "…"). */
export function emittedTopics(module: string): string[] {
  const found = new Set<string>();
  const literal = new RegExp(`"(${module}\\.[a-z_]+)"`, "g");
  for (const path of files(join(import.meta.dir, "..", "server", module))) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const at = line.indexOf("topic:");
      const hosts = line.indexOf("notifyHosts(");
      if (at < 0 && hosts < 0) continue;
      if (/cancelSchedules|upsertSchedule|audit\(|data\.topic/.test(line)) continue;
      for (const match of line.slice(at >= 0 ? at : hosts).matchAll(literal)) found.add(match[1]!);
    }
  }
  return [...found].sort();
}

describe("notification settings rows (D1193)", () => {
  test("every topic the seven modules emit has a row in its module's notificationTopics", async () => {
    for (const [id, dir] of Object.entries(MODULE_DIRS)) {
      const { module } = await import(`../src/${dir}/module`) as { module: { notificationTopics?: ReadonlyArray<{ id: string }> } };
      const rows = new Set((module.notificationTopics ?? []).map((topic) => topic.id));
      const emitted = emittedTopics(id);
      expect(emitted.length).toBeGreaterThan(0);
      expect({ module: id, missing: emitted.filter((topic) => !rows.has(topic)) }).toEqual({ module: id, missing: [] });
    }
  });

  test("the sweep sees the topics this audit added rows for", () => {
    expect(emittedTopics("crm")).toContain("crm.deal_lost");
    expect(emittedTopics("checkins")).toContain("checkins.nudge");
    expect(emittedTopics("forms")).toContain("forms.action");
    expect(emittedTopics("bookings")).toEqual(expect.arrayContaining(["bookings.cancelled", "bookings.rescheduled", "bookings.pending", "bookings.new"]));
  });
});
