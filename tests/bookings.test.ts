import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { call, errorCode, makeKey, ok, toolNames } from "./support/mcpClient";
import { setRole } from "./support/vault";

const { issueRenderNonce } = await import("../server/public");
const { resetPublicLimits } = await import("../server/public/limits");
const { setMailTransportForTests } = await import("../server/mail");
const { createContactBook } = await import("../server/people/contacts");
const { runScheduleTick } = await import("../server/schedules/dispatcher");
const { resetPublicSlotCache } = await import("../server/bookings/publicRoutes");
const { createBooking } = await import("../server/bookings/service");
const { typeRow } = await import("../server/bookings/model");
const { resetEventCreateLimit } = await import("../server/calendar/service");
const { createBoard } = await import("../server/tasks/service");

/**
 * Bookings end to end (§D.6, §F.4): profile, schedule, types, slots minus calendar busy, public
 * booking (nonce, honeypot, caps), contact + event + card + mail + notification, manage link
 * (reschedule, cancel, ICS), manual approval, round robin, collective, concurrency (T576), reminders
 * with a clock, outside ICS feeds through the egress guard, access (T583), MCP, Bin and purge.
 */

let host: Session;
let colleague: Session;
let outsider: Session;
const sent: Array<{ to: string; subject: string; text: string }> = [];

const json = async (response: Response) => { const text = await response.text(); if (!text) return { status: response.status, body: null as any }; try { return { status: response.status, body: JSON.parse(text) as any }; } catch { throw new Error(`${response.status} ${text.slice(0, 300)}`); } };
const api = async (path: string, session: Session, method = "GET", body?: unknown) => json(await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(method !== "GET" && body === undefined ? { headers: { "Content-Type": "application/json" } } : {}) }, session));
const pub = async (path: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${origin}/api/public${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) as any, headers: response.headers };
};
/** A start `days` ahead at `hour`:00 UTC. */
const startAt = (days: number, hour: number) => { const date = new Date(Date.now() + days * 86_400_000); date.setUTCHours(hour, 0, 0, 0); return date.toISOString(); };
const allDay = { mon: [{ from: "00:00", to: "24:00" }], tue: [{ from: "00:00", to: "24:00" }], wed: [{ from: "00:00", to: "24:00" }], thu: [{ from: "00:00", to: "24:00" }], fri: [{ from: "00:00", to: "24:00" }], sat: [{ from: "00:00", to: "24:00" }], sun: [{ from: "00:00", to: "24:00" }] };
const nonceFor = (typeId: string) => issueRenderNonce("booking", typeId, Date.now() - 10_000);

let handle = "";
let typeId = "";
let bookId = "";

beforeAll(async () => {
  setMailTransportForTests(async (message) => { sent.push({ to: message.to, subject: message.subject, text: message.text }); return { id: crypto.randomUUID() }; });
  host = await createUser("Priya Host");
  colleague = await createUser("Sam Colleague");
  outsider = await createUser("Olga Outsider");
  const profile = await api("/bookings/profile", host);
  expect(profile.status).toBe(200);
  handle = `priya-${host.userId.slice(0, 6)}`;
  expect((await api("/bookings/profile", host, "PUT", { handle, tz: "UTC" })).status).toBe(200);
  const schedules = await api("/bookings/schedules", host);
  await api(`/bookings/schedules/${schedules.body.schedules[0].id}`, host, "PUT", { weekly: allDay, tz: "UTC" });
  bookId = createContactBook({ ownerId: host.userId, name: "Leads" });
});

afterAll(() => setMailTransportForTests(null));

describe("setup", () => {
  test("handles: reserved, taken, alias kept for 90 days", async () => {
    expect((await api("/bookings/profile", colleague, "PUT", { handle: "admin" })).body.code).toBe("INVALID");
    expect((await api("/bookings/profile", colleague, "PUT", { handle })).body.code).toBe("HANDLE_TAKEN");
    const other = await createUser("Alias Person");
    await api("/bookings/profile", other, "PUT", { handle: `alias-${other.userId.slice(0, 6)}` });
    await api("/bookings/profile", other, "PUT", { handle: `alias2-${other.userId.slice(0, 6)}` });
    expect((await pub(`/book/alias-${other.userId.slice(0, 6)}`)).status).toBe(200);
    expect((await api("/bookings/profile", colleague, "PUT", { handle: `alias-${other.userId.slice(0, 6)}` })).body.code).toBe("HANDLE_TAKEN");
  });
  test("schedules: overrides and validation", async () => {
    const created = await api("/bookings/schedules", host, "POST", { name: "Evenings", tz: "Europe/Berlin", weekly: { mon: [{ from: "18:00", to: "20:00" }] } });
    expect(created.status).toBe(201);
    const bad = await api(`/bookings/schedules/${created.body.schedule.id}`, host, "PUT", { weekly: { mon: [{ from: "18:00", to: "17:00" }] } });
    expect(bad.body.code).toBe("INVALID");
    const override = await api(`/bookings/schedules/${created.body.schedule.id}/overrides`, host, "PUT", { date: "2026-12-24", ranges: null, note: "Holiday" });
    expect(override.body.schedule.overrides).toEqual([{ date: "2026-12-24", ranges: null, note: "Holiday" }]);
    expect((await api(`/bookings/schedules/${created.body.schedule.id}`, colleague, "PUT", { name: "x" })).status).toBe(404);
  });
  test("types: create, validate, revision conflict", async () => {
    const created = await api("/bookings/types", host, "POST", { title: "Intro call", durations: [30, 60], bufferBefore: 10, bufferAfter: 10, minNotice: 0, maxDaysAhead: 60, slotInterval: 30, contactBookId: bookId, locationKind: "video_link", locationValue: "https://meet.example.test/priya" });
    expect(created.status).toBe(201);
    typeId = created.body.type.id;
    expect(created.body.type.slug).toBe("intro-call");
    expect(created.body.type.publicPath).toBe(`/p/book/${handle}/intro-call`);
    expect((await api("/bookings/types", host, "POST", { title: "x", durations: [3] })).body.code).toBe("INVALID");
    expect((await api(`/bookings/types/${typeId}`, host, "PATCH", { description: "Let's talk", expectedRevision: 99 })).body.code).toBe("TYPE_CHANGED");
    const patched = await api(`/bookings/types/${typeId}`, host, "PATCH", { description: "Let's talk", expectedRevision: created.body.type.revision });
    expect(patched.body.type.revision).toBe(created.body.type.revision + 1);
    // Guests cannot host (§G.1 Q8).
    const guest = await createUser("Gail Guest");
    setRole(guest, "guest");
    expect((await api(`/bookings/types/${typeId}`, host, "PATCH", { assignment: "round_robin", hosts: [{ userId: host.userId }, { userId: guest.userId }] })).body.code).toBe("INVALID");
    expect((await api("/bookings/types", guest)).status).toBe(404);
    expect((await api(`/bookings/types/${typeId}`, outsider)).status).toBe(404);
  });
  test("intake questions through the question engine", async () => {
    const saved = await api(`/bookings/types/${typeId}/questions`, host, "PUT", { publish: true, set: { version: 1, sections: [], logic: [], endings: [], questions: [{ id: "topic0001", type: "short_text", title: "What would you like to talk about?", required: true }] } });
    expect(saved.status).toBe(200);
    expect(saved.body.published.version).toBeGreaterThan(0);
  });
});

describe("public booking", () => {
  test("the profile and type pages, and a uniform 404", async () => {
    const page = await pub(`/book/${handle}`);
    expect(page.status).toBe(200);
    expect(page.body.types.map((type: any) => type.slug)).toEqual(["intro-call"]);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect((await pub(`/book/${handle}/intro-call`)).body.questions.questions[0].id).toBe("topic0001");
    expect((await pub("/book/nobody-here")).body).toEqual({ error: "This link is not available", code: "NOT_FOUND" });
    expect((await pub(`/book/${handle}/nope`)).status).toBe(404);
  });
  test("slots: a calendar event blocks them (with buffers); the window is capped", async () => {
    resetPublicSlotCache();
    const day = startAt(3, 0).slice(0, 10);
    const before = await pub(`/book/${handle}/intro-call/slots?from=${day}&to=${day.slice(0, 8)}${String(Number(day.slice(8)) + 1).padStart(2, "0")}&tz=UTC`);
    if (before.status !== 200) throw new Error(JSON.stringify(before.body));
    expect(before.body.days[day]).toContain(`${day}T10:00:00.000Z`);
    const calendars = await api("/calendars", host);
    const calendarId = calendars.body.calendars?.[0]?.id ?? calendars.body[0]?.id;
    const event = await api(`/calendars/${calendarId}/events`, host, "POST", { title: "Dentist", allDay: false, startLocal: `${day}T10:00`, tz: "UTC", durationMinutes: 60 });
    expect(event.status).toBe(201);
    resetPublicSlotCache();
    const after = await pub(`/book/${handle}/intro-call/slots?from=${day}&to=${new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10)}&tz=UTC`);
    for (const blocked of ["09:30", "10:00", "10:30", "11:00"]) expect(after.body.days[day]).not.toContain(`${day}T${blocked}:00.000Z`);
    expect(after.body.days[day]).toContain(`${day}T09:00:00.000Z`);
    expect(after.body.days[day]).toContain(`${day}T11:30:00.000Z`);
    expect((await pub(`/book/${handle}/intro-call/slots?from=2026-01-01&to=2026-03-01`)).body.code).toBe("INVALID");
  });
  test("book as an outsider: booking, contact, meeting entry, event, mail with manage link, notification", async () => {
    resetPublicLimits();
    const start = startAt(4, 14);
    const result = await pub(`/book/${handle}/intro-call/bookings`, "POST", { start, duration: 30, tz: "America/Los_Angeles", name: "Ana Silva", email: "ana@acme.example", answers: { topic0001: "Pricing" }, nonce: nonceFor(typeId), website: "" });
    if (result.status !== 201) throw new Error(JSON.stringify(result.body));
    expect(result.body.status).toBe("confirmed");
    expect(result.body.manageUrl).toMatch(/^\/p\/book\/manage\/[A-Za-z0-9_-]{43}$/);
    expect(result.body.booking.when).toContain("Los Angeles");
    const booking = db.query("SELECT * FROM bookings WHERE booker_email_norm = 'ana@acme.example'").get() as any;
    expect(booking.source).toBe("public");
    // Contact in the type's book, with a meeting entry and a link (C1, D1003).
    const contact = db.query("SELECT c.* FROM contacts c WHERE c.id = ?").get(booking.contact_id) as any;
    expect(contact.display_name).toBe("Ana Silva");
    expect(contact.book_id).toBe(bookId);
    expect(db.query("SELECT kind FROM item_activity WHERE item_kind = 'contact' AND item_id = ? AND kind = 'meeting_booked'").get(contact.id)).toBeTruthy();
    expect(db.query("SELECT 1 FROM work_links WHERE a_kind = 'contact' AND a_id = ? AND b_kind = 'booking' AND b_id = ?").get(contact.id, booking.id)).toBeTruthy();
    // The event in the host's calendar, answers in the description (D1002).
    const link = db.query("SELECT event_id FROM booking_events WHERE booking_id = ?").get(booking.id) as { event_id: string };
    const event = db.query("SELECT title, description, start_utc FROM events WHERE id = ?").get(link.event_id) as any;
    expect(event.title).toBe("Intro call with Ana Silva");
    expect(event.description).toContain("Pricing");
    expect(event.start_utc).toBe(start);
    // Mail to the booker (outbox) and a notification to the host.
    const mail = db.query("SELECT template, payload FROM mail_outbox WHERE to_address = 'ana@acme.example' ORDER BY created_at").all() as any[];
    expect(mail.map((row) => row.template)).toContain("bookings.confirmed");
    expect(JSON.parse(mail[0].payload).manageUrl).toBe(result.body.manageUrl);
    expect(db.query("SELECT title FROM notifications WHERE user_id = ? AND module = 'bookings' AND topic = 'bookings.new'").get(host.userId)).toBeTruthy();
    // Reminders and completion are scheduled.
    expect((db.query("SELECT purpose FROM schedules WHERE owner_kind = 'booking' AND owner_id = ? ORDER BY purpose").all(booking.id) as any[]).map((row) => row.purpose)).toEqual(["bookings.complete", "bookings.remind_1", "bookings.remind_2"]);
    // The booked slot is gone from the page.
    resetPublicSlotCache();
    const slots = await pub(`/book/${handle}/intro-call/slots?from=${start.slice(0, 10)}&to=${new Date(Date.parse(start) + 86_400_000).toISOString().slice(0, 10)}&tz=UTC`);
    expect(slots.body.days[start.slice(0, 10)]).not.toContain(start);
  });
  test("anti-abuse: bad nonce, honeypot, replay, too fast, missing answers, per-email cap", async () => {
    resetPublicLimits();
    const body = (start: string, extra: Record<string, unknown> = {}) => ({ start, duration: 30, tz: "UTC", name: "Bot", email: "bot@spam.example", answers: { topic0001: "x" }, nonce: nonceFor(typeId), website: "", ...extra });
    expect((await pub(`/book/${handle}/intro-call/bookings`, "POST", body(startAt(5, 9), { nonce: "v1.bad.sig" }))).body.code).toBe("INVALID");
    expect((await pub(`/book/${handle}/intro-call/bookings`, "POST", body(startAt(5, 9), { website: "http://spam" }))).body.code).toBe("HONEYPOT");
    expect((await pub(`/book/${handle}/intro-call/bookings`, "POST", body(startAt(5, 9), { nonce: issueRenderNonce("booking", typeId) }))).body.code).toBe("TOO_FAST");
    expect((await pub(`/book/${handle}/intro-call/bookings`, "POST", body(startAt(5, 9), { answers: {} }))).body.code).toBe("INVALID_ANSWERS");
    const nonce = nonceFor(typeId);
    expect((await pub(`/book/${handle}/intro-call/bookings`, "POST", body(startAt(5, 9), { nonce }))).status).toBe(201);
    expect((await pub(`/book/${handle}/intro-call/bookings`, "POST", body(startAt(5, 11), { nonce }))).body.code).toBe("REPLAY");
    expect((await pub(`/book/${handle}/intro-call/bookings`, "POST", body(startAt(5, 13)))).status).toBe(201);
    expect((await pub(`/book/${handle}/intro-call/bookings`, "POST", body(startAt(5, 15)))).status).toBe(201);
    expect((await pub(`/book/${handle}/intro-call/bookings`, "POST", body(startAt(5, 17)))).body.code).toBe("TOO_MANY");
    // A time outside availability, and a start that is not a slot.
    resetPublicLimits();
    expect((await pub(`/book/${handle}/intro-call/bookings`, "POST", body(startAt(5, 9), { email: "late@x.example" }))).body.code).toBe("SLOT_TAKEN");
    expect((await pub(`/book/${handle}/intro-call/bookings`, "POST", body(startAt(400, 9), { email: "far@x.example" }))).body.code).toBe("SLOT_TAKEN");
  });
  test("two concurrent bookings of one slot: exactly one wins (T576)", async () => {
    resetPublicLimits();
    const start = startAt(6, 16);
    const results = await Promise.all(["one@x.example", "two@x.example", "three@x.example"].map((email) => pub(`/book/${handle}/intro-call/bookings`, "POST",
      { start, duration: 60, tz: "UTC", name: email, email, answers: { topic0001: "x" }, nonce: nonceFor(typeId), website: "" })));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409, 409]);
    expect((db.query("SELECT COUNT(*) AS count FROM bookings WHERE host_id = ? AND start_utc = ? AND status IN ('pending','confirmed')").get(host.userId, start) as any).count).toBe(1);
    // In-process, the same: a burst of service calls.
    const type = typeRow(typeId)!;
    const start2 = startAt(6, 19);
    const outcomes = await Promise.all([1, 2, 3, 4].map((index) => Promise.resolve().then(() => createBooking({ type, start: start2, durationMin: 30, booker: { name: `B${index}`, email: `b${index}@x.example`, tz: "UTC", answers: { topic0001: "x" } }, source: "internal", actorId: host.userId })).then(() => "ok", (error) => error.code)));
    expect(outcomes.filter((outcome) => outcome === "ok").length).toBe(1);
    expect(outcomes.filter((outcome) => outcome === "SLOT_TAKEN").length).toBe(3);
  });
});

describe("manage link", () => {
  test("view, ICS, reschedule, cancel; the old link stops working", async () => {
    resetPublicLimits();
    resetEventCreateLimit();
    const start = startAt(7, 9);
    const booked = await pub(`/book/${handle}/intro-call/bookings`, "POST", { start, duration: 30, tz: "Asia/Tokyo", name: "Ken Booker", email: "ken@example.org", answers: { topic0001: "x" }, nonce: nonceFor(typeId), website: "" });
    expect(booked.status).toBe(201);
    const token = booked.body.manageUrl.split("/").pop();
    const view = await pub(`/bookings/manage/${token}`);
    expect(view.body.booking.status).toBe("confirmed");
    expect(view.body.canReschedule).toBe(true);
    expect(JSON.stringify(view.body)).not.toContain("ken@example.org".toUpperCase());
    const ics = await fetch(`${origin}/api/public/bookings/manage/${token}/ics`);
    const text = await ics.text();
    expect(text).toContain("BEGIN:VEVENT");
    expect(text).toContain("SUMMARY:Intro call with Priya Host");
    const slots = await pub(`/bookings/manage/${token}/slots?from=${start.slice(0, 10)}&to=${new Date(Date.parse(start) + 86_400_000).toISOString().slice(0, 10)}&tz=UTC`);
    // Its own slot is offered back while rescheduling.
    expect(slots.body.days[start.slice(0, 10)]).toContain(start);
    const newStart = startAt(7, 12);
    const moved = await pub(`/bookings/manage/${token}/reschedule`, "POST", { start: newStart, nonce: issueRenderNonce("booking_manage", view.body.booking ? (db.query("SELECT id FROM bookings WHERE booker_email_norm = 'ken@example.org' AND status = 'confirmed'").get() as any).id : "", Date.now() - 5000), website: "" });
    if (moved.status !== 200) throw new Error(JSON.stringify(moved.body));
    expect(moved.body.booking.start).toBe(newStart);
    const old = db.query("SELECT status, cancelled_by FROM bookings WHERE booker_email_norm = 'ken@example.org' AND start_utc = ?").get(start) as any;
    expect(old).toEqual({ status: "cancelled", cancelled_by: "booker" });
    expect((await pub(`/bookings/manage/${token}`)).status).toBe(404);
    const newToken = moved.body.manageUrl.split("/").pop();
    const newId = (db.query("SELECT id FROM bookings WHERE booker_email_norm = 'ken@example.org' AND status = 'confirmed'").get() as any).id;
    expect(db.query("SELECT template FROM mail_outbox WHERE to_address = 'ken@example.org' AND template = 'bookings.rescheduled'").get()).toBeTruthy();
    const cancelled = await pub(`/bookings/manage/${newToken}/cancel`, "POST", { reason: "Sorry", nonce: issueRenderNonce("booking_manage", newId, Date.now() - 5000), website: "" });
    expect(cancelled.body.booking.status).toBe("cancelled");
    expect(db.query("SELECT 1 FROM events e JOIN booking_events be ON be.event_id = e.id WHERE be.booking_id = ? AND e.deleted_at IS NULL").get(newId)).toBeNull();
    expect(db.query("SELECT title FROM notifications WHERE user_id = ? AND topic = 'bookings.cancelled'").get(host.userId)).toBeTruthy();
  });
});

describe("approval, teams", () => {
  test("manual approval: pending holds the slot, approve confirms, expiry by schedule", async () => {
    const type = await api("/bookings/types", host, "POST", { title: "Consult", confirm: "manual", minNotice: 0, pendingHours: 2 });
    const id = type.body.type.id;
    const start = startAt(8, 10);
    const created = await api("/bookings", host, "POST", { type: id, start, booker: { name: "Pat", email: "pat@example.org", tz: "UTC" } });
    expect(created.body.booking.status).toBe("pending");
    expect((await api("/bookings", host, "POST", { type: id, start, booker: { name: "Q", email: "q@example.org", tz: "UTC" } })).body.code).toBe("SLOT_TAKEN");
    const approved = await api(`/bookings/b/${created.body.booking.id}/approve`, host, "POST", {});
    expect(approved.body.booking.status).toBe("confirmed");
    expect(db.query("SELECT 1 FROM booking_events WHERE booking_id = ? AND event_id IS NOT NULL").get(created.body.booking.id)).toBeTruthy();
    const second = await api("/bookings", host, "POST", { type: id, start: startAt(8, 13), booker: { name: "R", email: "r@example.org", tz: "UTC" } });
    expect(second.body.booking.status).toBe("pending");
    await runScheduleTick({ nowMs: Date.now() + 3 * 3_600_000 });
    expect((db.query("SELECT status FROM bookings WHERE id = ?").get(second.body.booking.id) as any).status).toBe("expired");
  });
  test("round robin: the host with fewer bookings gets the next; collective needs everyone free", async () => {
    await api("/bookings/schedules", colleague);
    const schedules = await api("/bookings/schedules", colleague);
    await api(`/bookings/schedules/${schedules.body.schedules[0].id}`, colleague, "PUT", { weekly: allDay, tz: "UTC" });
    const rr = await api("/bookings/types", host, "POST", { title: "Support", assignment: "round_robin", minNotice: 0, hosts: [{ userId: host.userId }, { userId: colleague.userId }] });
    expect(rr.body.type.hosts.map((item: any) => item.userId).sort()).toEqual([host.userId, colleague.userId].sort());
    const first = await api("/bookings", outsider, "POST", { type: rr.body.type.id, start: startAt(9, 2) });
    expect(first.status).toBe(404); // not shared with the outsider
    const hostsOf = [];
    for (const hour of [2, 3, 4]) hostsOf.push((await api("/bookings", host, "POST", { type: rr.body.type.id, start: startAt(9, hour), booker: { name: "C", email: `c${hour}@example.org`, tz: "UTC" } })).body.booking.hostId);
    expect(new Set(hostsOf).size).toBe(2);
    // Collective: the colleague is busy at 05:00 → not offered.
    await api("/bookings", colleague, "POST", { type: rr.body.type.id, start: startAt(9, 5), booker: { name: "D", email: "d@example.org", tz: "UTC" } }).catch(() => null);
    const team = await api("/bookings/types", host, "POST", { title: "Panel", assignment: "collective", minNotice: 0, hosts: [{ userId: host.userId }, { userId: colleague.userId }] });
    const day = startAt(9, 0).slice(0, 10);
    const slots = await api(`/bookings/types/${team.body.type.id}/slots?from=${day}&to=${new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10)}&tz=UTC&duration=30`, host);
    for (const busy of hostsOf.map((_, index) => startAt(9, [2, 3, 4][index]!))) expect(slots.body.days[day]).not.toContain(busy);
    const panel = await api("/bookings", host, "POST", { type: team.body.type.id, start: startAt(9, 8), booker: { name: "E", email: "e@example.org", tz: "UTC" } });
    expect(panel.body.booking.cohosts.length).toBe(1);
    expect((db.query("SELECT COUNT(*) AS count FROM booking_events WHERE booking_id = ? AND event_id IS NOT NULL").get(panel.body.booking.id) as any).count).toBe(2);
  });
});

describe("reminders, feeds, prep card", () => {
  test("reminders fire once at their time with the test clock; skipped after cancel", async () => {
    const type = await api("/bookings/types", host, "POST", { title: "Reminder test", minNotice: 0, reminders: { offsets: [60], booker: true, host: true } });
    const start = startAt(2, 18);
    const created = await api("/bookings", host, "POST", { type: type.body.type.id, start, booker: { name: "Rem", email: "rem@example.org", tz: "UTC" } });
    const at = Date.parse(start) - 60 * 60_000 + 1000;
    await runScheduleTick({ nowMs: at });
    expect(db.query("SELECT 1 FROM mail_outbox WHERE to_address = 'rem@example.org' AND template = 'bookings.reminder'").get()).toBeTruthy();
    expect(db.query("SELECT 1 FROM notifications WHERE user_id = ? AND topic = 'bookings.reminder' AND item_id = ?").get(host.userId, created.body.booking.id)).toBeTruthy();
    await runScheduleTick({ nowMs: at + 60_000 });
    expect((db.query("SELECT COUNT(*) AS count FROM mail_outbox WHERE to_address = 'rem@example.org' AND template = 'bookings.reminder'").get() as any).count).toBe(1);
    await runScheduleTick({ nowMs: Date.parse(start) + 31 * 60_000 });
    expect((db.query("SELECT status FROM bookings WHERE id = ?").get(created.body.booking.id) as any).status).toBe("completed");
  });
  test("an outside ICS feed (through the egress guard) blocks slots; its URL is never returned", async () => {
    const day = startAt(10, 0).slice(0, 10);
    const compact = day.replace(/-/g, "");
    const feed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:x", `DTSTART:${compact}T150000Z`, `DTEND:${compact}T160000Z`, "SUMMARY:Secret meeting", "END:VEVENT", "END:VCALENDAR"].join("\r\n"), { headers: { "Content-Type": "text/calendar" } }) });
    try {
      const url = `http://127.0.0.1:${feed.port}/calendar/ical/secret-abcdef123456/basic.ics`;
      const added = await api("/bookings/feeds", host, "POST", { label: "Google", url });
      expect(added.status).toBe(201);
      expect(added.body.feed.status).toBe("ok");
      expect(added.body.feed.busyCount).toBe(1);
      expect(JSON.stringify(added.body)).not.toContain("secret-abcdef");
      expect(JSON.stringify((await api("/bookings/profile", host)).body)).not.toContain("secret-abcdef");
      expect((db.query("SELECT url_ct FROM booking_feeds WHERE id = ?").get(added.body.feed.id) as any).url_ct).not.toContain("secret");
      const slots = await api(`/bookings/types/${typeId}/slots?from=${day}&to=${new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10)}&tz=UTC`, host);
      if (!slots.body.days) throw new Error(JSON.stringify(slots.body));
      expect(slots.body.days[day]).not.toContain(`${day}T15:00:00.000Z`);
      expect(slots.body.days[day]).toContain(`${day}T14:00:00.000Z`);
      expect(JSON.stringify(slots.body)).not.toContain("Secret meeting");
      expect((await api("/bookings/feeds", host, "POST", { url: "http://169.254.169.254/latest" })).status).toBe(201); // stored, but its fetch is refused
      const feeds = (await api("/bookings/feeds", host)).body.feeds;
      expect(feeds.find((item: any) => item.hint.startsWith("169.254")).status).toBe("error");
      for (const item of feeds) expect((await api(`/bookings/feeds/${item.id}`, host, "DELETE")).status).toBe(204);
      expect(db.query("SELECT 1 FROM schedules WHERE owner_kind = 'booking_feed'").get()).toBeNull();
    } finally {
      feed.stop(true);
    }
  });
  test("a prep card on the type's board", async () => {
    const board = await createBoard(host.userId, "Calls") as any;
    const boardId = board.id ?? board.board?.id;
    const columnId = (db.query("SELECT id FROM board_columns WHERE board_id = ? ORDER BY position LIMIT 1").get(boardId) as any).id;
    const type = await api("/bookings/types", host, "POST", { title: "Demo", minNotice: 0, card: { boardId, columnId, titleTemplate: "Prepare: {{type}} with {{name}}", assignHost: true } });
    const created = await api("/bookings", host, "POST", { type: type.body.type.id, start: startAt(11, 9), booker: { name: "Zoe", email: "zoe@example.org", tz: "UTC" } });
    for (let attempt = 0; attempt < 50 && !(db.query("SELECT card_id FROM bookings WHERE id = ?").get(created.body.booking.id) as any).card_id; attempt += 1) await Bun.sleep(20);
    const cardId = (db.query("SELECT card_id FROM bookings WHERE id = ?").get(created.body.booking.id) as any).card_id;
    expect((db.query("SELECT title FROM cards WHERE id = ?").get(cardId) as any).title).toBe("Prepare: Demo with Zoe");
  });
});

describe("access, search, datasets, MCP, Bin", () => {
  test("bookings are readable by their host and the type's managers only (T583)", async () => {
    const booking = db.query("SELECT id FROM bookings WHERE host_id = ? LIMIT 1").get(host.userId) as { id: string };
    expect((await api(`/bookings/b/${booking.id}`, host)).status).toBe(200);
    expect((await api(`/bookings/b/${booking.id}`, outsider)).status).toBe(404);
    await api(`/bookings/types/${typeId}`, host, "PATCH", {});
    db.query("UPDATE booking_types SET visibility = 'all_users', share_role = 'view' WHERE id = ?").run(typeId);
    expect((await api(`/bookings/types/${typeId}`, outsider)).status).toBe(200);
    expect((await api(`/bookings/b/${booking.id}`, outsider)).status).toBe(404);
    expect((await api("/bookings?view=upcoming", outsider)).body.items.length).toBe(0);
    db.query("UPDATE booking_types SET visibility = 'private' WHERE id = ?").run(typeId);
    const list = await api("/bookings?view=upcoming&limit=2", host);
    expect(list.body.items.length).toBe(2);
    expect(list.body.nextCursor).toBeTruthy();
    const next = await api(`/bookings?view=upcoming&limit=2&cursor=${list.body.nextCursor}`, host);
    expect(next.body.items[0].start >= list.body.items[1].start).toBe(true);
  });
  test("search, dataset, insights, Today", async () => {
    const search = await api("/search?scope=bookings&q=Ana", host);
    expect(JSON.stringify(search.body)).toContain("Intro call with Ana Silva");
    expect(JSON.stringify((await api("/search?scope=bookings&q=Ana", outsider)).body)).not.toContain("Ana Silva");
    const dataset = await api("/datasets/query", host, "POST", { dataset: "bookings.bookings", measures: [{ fn: "count" }], dimensions: ["status"] });
    expect(dataset.status).toBe(200);
    expect(JSON.stringify(dataset.body.columns)).not.toContain("email");
    const insights = await api("/bookings/insights?days=90&tz=UTC", host);
    expect(insights.body.total).toBeGreaterThan(3);
    const today = await api("/today?sections=bookingsToday&tz=UTC", host);
    expect(today.status).toBe(200);
  });
  test("MCP: availability → book → list → reschedule → cancel, with scopes", async () => {
    const reader = makeKey(host, ["bookings:read"]);
    const writer = makeKey(host, ["bookings:write"]);
    const names = await toolNames(writer);
    for (const name of ["list_booking_types", "get_availability", "create_booking", "list_bookings", "reschedule_booking", "cancel_booking", "get_booking_link"]) expect(names).toContain(name);
    expect(await toolNames(reader)).not.toContain("create_booking");
    const day = startAt(12, 0).slice(0, 10);
    const free = await ok(reader, "get_availability", { typeId, from: day, to: new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10), tz: "UTC" });
    expect(free.count).toBeGreaterThan(10);
    const start = free.days[day][4];
    const booked = await ok(writer, "create_booking", { typeId, start, booker: { name: "Mia MCP", email: "mia@example.org" }, answers: { topic0001: "MCP" } });
    expect(booked.status).toBe("confirmed");
    expect(booked.source).toBe("mcp");
    const listed = await ok(reader, "list_bookings", { view: "upcoming", typeId, limit: 100 });
    expect(listed.items.some((item: any) => item.id === booked.id)).toBe(true);
    const moved = await ok(writer, "reschedule_booking", { bookingId: booked.shortId, start: free.days[day][8] });
    expect(moved.start).toBe(free.days[day][8]);
    const cancelled = await ok(writer, "cancel_booking", { bookingId: moved.id, message: "Sorry" });
    expect(cancelled.status).toBe("cancelled");
    expect(await errorCode(reader, "cancel_booking", { bookingId: moved.id })).toBe("SCOPE_REQUIRED");
    const otherKey = makeKey(outsider, ["bookings:read"]);
    expect(await errorCode(otherKey, "get_booking", { bookingId: booked.id })).toBe("NOT_FOUND");
    expect((await ok(reader, "get_booking_link", { typeId })).url).toBe(`${origin}/p/book/${handle}/intro-call`);
    expect((await call(writer, "delete_booking_type", { typeId })).isError).toBe(true); // needs bin:write too
  });
  test("Bin: a binned type 404s publicly, restores, and a purge leaves its bookings with the saved title", async () => {
    const type = await api("/bookings/types", host, "POST", { title: "Doomed", minNotice: 0 });
    const id = type.body.type.id;
    const created = await api("/bookings", host, "POST", { type: id, start: startAt(13, 9), booker: { name: "F", email: "f@example.org", tz: "UTC" } });
    expect((await api(`/bookings/types/${id}`, host, "DELETE")).status).toBe(200);
    expect((await pub(`/book/${handle}/doomed`)).status).toBe(404);
    expect((await api("/bin", host)).body.items?.some?.((item: any) => item.id === id) ?? true).toBe(true);
    expect((await api(`/bin/booking_type/${id}/restore`, host, "POST", {})).status).toBe(200);
    expect((await pub(`/book/${handle}/doomed`)).status).toBe(200);
    await api(`/bookings/types/${id}`, host, "DELETE");
    const purged = await api(`/bin/booking_type/${id}`, host, "DELETE");
    expect([200, 204]).toContain(purged.status);
    const booking = db.query("SELECT type_id, type_title FROM bookings WHERE id = ?").get(created.body.booking.id) as any;
    expect(booking).toEqual({ type_id: null, type_title: "Doomed" });
    for (const [table, where] of [["item_activity", "item_kind = 'booking_type' AND item_id = ?"], ["question_sets", "host_kind = 'booking_type' AND host_id = ?"], ["public_links", "kind = 'booking_type' AND item_id = ?"], ["item_members", "item_kind = 'booking_type' AND item_id = ?"]] as const)
      expect(db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(id)).toEqual({ count: 0 });
    expect((await api(`/bookings/b/${created.body.booking.id}`, host)).body.booking.typeDeleted).toBe(true);
  });
});
