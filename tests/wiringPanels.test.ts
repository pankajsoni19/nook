import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { setMailTransportForTests } = await import("../server/mail");
const { createBooking } = await import("../server/bookings/service");
const { typeRow } = await import("../server/bookings/model");
const { bookingPrefillFrom, bookingPrefillUrl } = await import("../shared/bookings");

/**
 * W3-WIRE item panels (docs/plan/WORKSPACE_MODULES.md §C C8, C15, C20; D1056–D1058): time logged on a
 * goal, a contact, a company, a deal, and a booking (totals, worklog, the client project as default);
 * bookings listed on contact, company, and deal pages for readers of both the record and the booking;
 * the prefilled booking link; and Time's `time` progress source driving a Goals key result end to end.
 */

type Json = Record<string, any>;
const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = text ? JSON.parse(text) as Json : {}; } catch { json = { text }; }
  return { status: response.status, body: json };
};
const allDay = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [day, [{ from: "00:00", to: "24:00" }]]));
const startAt = (days: number, hour: number) => { const date = new Date(Date.now() + days * 86_400_000); date.setUTCHours(hour, 0, 0, 0); return date.toISOString(); };

let owner: Session;
let outsider: Session;
let bookId: string;
let contactId: string;
let companyId: string;
let dealId: string;
let bookingId: string;
let projectId: string;
let typeId: string;

beforeAll(async () => {
  setMailTransportForTests(async () => ({ id: crypto.randomUUID() }));
  owner = await createUser("Wire owner");
  outsider = await createUser("Wire outsider");
  bookId = (await api(owner, "POST", "/crm/books", { name: "Wire clients" })).body.book.id;
  companyId = (await api(owner, "POST", "/crm/companies", { bookId, name: "Globex", domain: "globex.example" })).body.company.id;
  const contact = await api(owner, "POST", "/crm/contacts", { bookId, name: "Hank Scorpio", email: "hank@globex.example", companyId });
  expect(contact.status).toBe(201);
  contactId = contact.body.contact.id;
  const deal = await api(owner, "POST", "/crm/deals", { bookId, title: "Globex rollout", value: 50000, currency: "USD", companyId, contactIds: [contactId] });
  expect(deal.status).toBe(201);
  dealId = deal.body.deal.id;
  const project = await api(owner, "POST", "/time/projects", { name: "Globex support", clientId: companyId });
  expect(project.status).toBe(201);
  projectId = project.body.project.id;
  await api(owner, "PUT", "/bookings/profile", { handle: `wire-${owner.userId.slice(0, 6)}`, tz: "UTC" });
  const schedules = await api(owner, "GET", "/bookings/schedules");
  await api(owner, "PUT", `/bookings/schedules/${schedules.body.schedules[0].id}`, { weekly: allDay, tz: "UTC" });
  const type = await api(owner, "POST", "/bookings/types", { title: "Wire call", durations: [30], minNotice: 0, maxDaysAhead: 60, slotInterval: 30, contactBookId: bookId, locationKind: "video_link", locationValue: "https://meet.example.test/wire" });
  expect(type.status).toBe(201);
  typeId = type.body.type.id;
  const created = createBooking({ type: typeRow(typeId)!, start: startAt(3, 10), durationMin: 30, booker: { name: "Hank Scorpio", email: "hank@globex.example", tz: "UTC" }, source: "internal", actorId: owner.userId });
  bookingId = created.booking.id;
  expect(created.booking.contact_id).toBe(contactId);
});

afterAll(() => setMailTransportForTests(null));

describe("time on CRM records, goals, and bookings (C15, D1056, D1057)", () => {
  test("logging on a contact goes to its company's client project; totals and the worklog show on each item", async () => {
    const before = await api(owner, "GET", `/time/targets/contact/${contactId}`);
    expect(before.status).toBe(200);
    expect(before.body.defaultProject).toEqual({ id: projectId, name: "Globex support" });
    expect(before.body.totalSeconds).toBe(0);
    const started = await api(owner, "POST", "/time/timer/start", { target: { kind: "deal", id: dealId } });
    expect(started.status).toBe(201);
    expect(started.body.entry.project?.id ?? started.body.entry.projectId).toBe(projectId);
    await api(owner, "POST", "/time/timer/stop", {});
    for (const [kind, id] of [["contact", contactId], ["company", companyId], ["booking", bookingId]] as const) {
      const logged = await api(owner, "POST", "/time/entries", { startedAt: new Date(Date.now() - 3_600_000).toISOString(), duration: 1800, description: `On the ${kind}`, target: { kind, id } });
      expect(logged.status).toBe(201);
      const read = await api(owner, "GET", `/time/targets/${kind}/${id}`);
      expect(read.body.totalSeconds).toBe(1800);
      expect(read.body.entries[0].description).toBe(`On the ${kind}`);
    }
    const goal = await api(owner, "POST", "/goals", { title: "Wire goal" });
    const onGoal = await api(owner, "POST", "/time/entries", { startedAt: new Date(Date.now() - 7_200_000).toISOString(), duration: 900, target: { kind: "goal", id: goal.body.goal.id } });
    expect(onGoal.status).toBe(201);
    expect((await api(owner, "GET", `/time/targets/goal/${goal.body.goal.id}`)).body.totalSeconds).toBe(900);
  });

  test("an outsider reads no time on a record they cannot open", async () => {
    expect((await api(outsider, "GET", `/time/targets/contact/${contactId}`)).status).toBe(404);
  });
});

describe("bookings on contact, company, and deal pages (C20, D1058)", () => {
  test("each record lists the booking; an outsider gets NOT_FOUND; other kinds are refused", async () => {
    for (const [kind, id] of [["contact", contactId], ["company", companyId], ["deal", dealId]] as const) {
      const listed = await api(owner, "GET", `/bookings/for/${kind}/${id}`);
      expect(listed.status).toBe(200);
      expect(listed.body.items.map((item: Json) => item.id)).toEqual([bookingId]);
    }
    expect((await api(outsider, "GET", `/bookings/for/contact/${contactId}`)).status).toBe(404);
    expect((await api(owner, "GET", `/bookings/for/goal/${contactId}`)).status).toBe(400);
  });

  test("a reader of the book who cannot read the booking sees none of it (T583)", async () => {
    const reader = await createUser("Wire book reader");
    db.query("INSERT INTO item_members (item_kind, item_id, user_id, level, created_at) VALUES ('contact_book', ?, ?, 'view', ?)").run(bookId, reader.userId, new Date().toISOString());
    db.query("UPDATE contact_books SET visibility = 'selected' WHERE id = ?").run(bookId);
    expect((await api(reader, "GET", `/crm/contacts/${contactId}`)).status).toBe(200);
    const listed = await api(reader, "GET", `/bookings/for/contact/${contactId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([]);
  });

  test("the prefilled link carries the name and email only; the page reads them back", () => {
    const url = bookingPrefillUrl("http://wire.localhost", "/p/book/a/b", { name: " Hank Scorpio ", email: "hank@globex.example" });
    expect(url).toBe("http://wire.localhost/p/book/a/b?name=Hank+Scorpio&email=hank%40globex.example");
    expect(bookingPrefillUrl("http://x", "/p/book/a/b", { name: "Ann", email: "not an email" })).toBe("http://x/p/book/a/b?name=Ann");
    expect(bookingPrefillUrl("http://x", "/p/book/a/b", null)).toBe("http://x/p/book/a/b");
    expect(bookingPrefillFrom("?name=Hank&email=hank%40globex.example&contact=123")).toEqual({ name: "Hank", email: "hank@globex.example" });
    expect(bookingPrefillFrom(`?name=${"x".repeat(300)}&email=bad`)).toEqual({ name: "x".repeat(120), email: "" });
  });

  test("migration 112 indexes bookings by contact", () => {
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'bookings_contact'").get()).not.toBeNull();
  });
});

describe("Time's progress source drives a Goals key result end to end (C8)", () => {
  test("a KR on the project's hours reads the hours logged, refreshed when the goal is read", async () => {
    const created = await api(owner, "POST", "/goals", { title: "Support hours", keyResults: [{ title: "Hours on Globex", metric: "number", targetValue: 10, source: { kind: "time", config: { projectId } } }] });
    expect(created.status).toBe(201);
    const kr = created.body.goal.keyResults[0];
    expect(kr.source.kind).toBe("time");
    const seconds = (db.query("SELECT COALESCE(SUM(duration_s), 0) AS s FROM time_entries WHERE project_id = ? AND ended_at IS NOT NULL").get(projectId) as { s: number }).s;
    expect(seconds).toBeGreaterThan(0);
    expect(kr.currentValue).toBeCloseTo(seconds / 3600, 3);
    // More time, then a read after the debounce: the KR follows.
    await api(owner, "POST", "/time/entries", { startedAt: new Date(Date.now() - 10_800_000).toISOString(), duration: 7200, projectId });
    db.query("UPDATE key_results SET auto_updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(kr.id);
    const read = await api(owner, "GET", `/goals/${created.body.goal.id}`);
    expect(read.body.goal.keyResults[0].currentValue).toBeCloseTo((seconds + 7200) / 3600, 3);
    expect(read.body.goal.progress).toBeGreaterThan(0);
    // The KR's owner who cannot read the project gets no value: an outsider cannot point a KR at it (T540).
    const refused = await api(outsider, "POST", "/goals", { title: "Sneaky", keyResults: [{ title: "Hours", source: { kind: "time", config: { projectId } } }] });
    expect(refused.status).toBe(400);
  });
});
