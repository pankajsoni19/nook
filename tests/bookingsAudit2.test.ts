import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { errorCode, makeKey } from "./support/mcpClient";

const { resetPublicSlotCache } = await import("../server/bookings/publicRoutes");
const { pickRoundRobin } = await import("../server/bookings/availability");
const { approveBooking, bookingIcs, cancelBooking, createBooking, rescheduleBooking } = await import("../server/bookings/service");
const { bookingsInsights } = await import("../server/bookings/insights");
const { bookingsMailTemplates } = await import("../server/bookings/mail");
const { bookingRow, typeRow } = await import("../server/bookings/model");
const { keyedHash } = await import("../server/public/secret");
const { feedBusy } = await import("../server/bookings/feeds");

/**
 * Bookings, audit 2 (D1121–D1128): pending bookings have no calendar file (BK5), the ICS UID is not an
 * internal id (BK6), a reschedule keeps its length after the type's durations change (BK7), round robin
 * and Insights count a reschedule once (BK8), the booker cannot cancel after the start, and MCP
 * create_booking refuses a hidden type like the HTTP route, and feed all-day blocks follow the schedule zone.
 */

let host: Session;
let colleague: Session;

const json = async (response: Response) => { const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) as any : null }; };
const api = async (path: string, session: Session, method = "GET", body?: unknown) => json(await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, session));
const pub = async (path: string) => { const response = await fetch(`${origin}/api/public${path}`); return { status: response.status, text: await response.text() }; };
const allDay = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [day, [{ from: "00:00", to: "24:00" }]]));
const startAt = (days: number, hour: number) => { const date = new Date(Date.now() + days * 86_400_000); date.setUTCHours(hour, 0, 0, 0); return date.toISOString(); };
const booker = (email: string) => ({ name: "Bea Booker", email, tz: "UTC" });
const newType = async (session: Session, input: Record<string, unknown>) => {
  const created = await api("/bookings/types", session, "POST", { minNotice: 0, ...input });
  expect(created.status).toBe(201);
  return typeRow(created.body.type.id)!;
};

beforeAll(async () => {
  host = await createUser("Audit Host");
  colleague = await createUser("Audit Colleague");
  for (const session of [host, colleague]) {
    expect((await api("/bookings/profile", session)).status).toBe(200);
    const schedules = await api("/bookings/schedules", session);
    await api(`/bookings/schedules/${schedules.body.schedules[0].id}`, session, "PUT", { weekly: allDay, tz: "UTC" });
  }
});

describe("calendar files (BK5, BK6)", () => {
  test("a request awaiting approval has no ICS link or file; once confirmed it has both", async () => {
    const type = await newType(host, { title: "Approval call", confirm: "manual" });
    const created = createBooking({ type, start: startAt(4, 9), durationMin: 30, booker: booker("pending@example.org"), source: "public", actorId: null });
    expect(created.booking.status).toBe("pending");
    const path = `/bookings/manage/${created.manageToken}/ics`;
    expect((await pub(path)).status).toBe(404);
    const resolve = (kind: string, id: string) => (bookingsMailTemplates()[`bookings.${kind}`] as any).resolveExternal({ bookingId: id, manageUrl: `/p/book/manage/${created.manageToken}` }).data;
    expect(resolve("pending", created.booking.id).icsHref).toBeNull();
    approveBooking(created.booking, host.userId);
    const file = await pub(path);
    expect(file.status).toBe(200);
    expect(file.text).toContain("STATUS:CONFIRMED");
    expect(resolve("confirmed", created.booking.id).icsHref).toContain("/ics");
  });

  test("the UID is a keyed hash of the first booking, kept across a move, never the booking's id", async () => {
    const type = await newType(host, { title: "Uid call" });
    const first = createBooking({ type, start: startAt(5, 9), durationMin: 30, booker: booker("uid@example.org"), source: "public", actorId: null }).booking;
    const moved = rescheduleBooking(first, { start: startAt(5, 11), by: "booker", actorId: null }).booking;
    const uid = (ics: string) => /UID:([^\r\n]+)/.exec(ics.replace(/\r\n /g, ""))![1]!;
    const before = uid(bookingIcs(first));
    const after = bookingIcs(moved);
    expect(uid(after)).toBe(before);
    expect(after).toContain("SEQUENCE:1");
    expect(before).toBe(`${keyedHash("booking-ics", first.id).slice(0, 32)}@nook`);
    for (const ics of [bookingIcs(first), after]) for (const id of [first.id, moved.id, first.id.replace(/-/g, "")]) expect(ics).not.toContain(id);
  });
});

describe("reschedules (BK7, BK8)", () => {
  test("a booking keeps its length when the type's durations changed since", async () => {
    const type = await newType(host, { title: "Length call", durations: [30] });
    const created = createBooking({ type, start: startAt(6, 9), durationMin: 30, booker: booker("length@example.org"), source: "public", actorId: null });
    const patched = await api(`/bookings/types/${type.id}`, host, "PATCH", { durations: [45], expectedRevision: typeRow(type.id)!.revision });
    expect(patched.status).toBe(200);
    resetPublicSlotCache();
    const day = startAt(7, 0).slice(0, 10);
    const slots = await json(await fetch(`${origin}/api/public/bookings/manage/${created.manageToken}/slots?from=${day}&to=${startAt(8, 0).slice(0, 10)}&tz=UTC`));
    expect(slots.status).toBe(200);
    expect(slots.body.duration).toBe(30);
    expect(slots.body.days[day]).toContain(`${day}T10:00:00.000Z`);
    const moved = rescheduleBooking(bookingRow(created.booking.id)!, { start: `${day}T10:00:00.000Z`, by: "booker", actorId: null });
    expect(moved.booking.duration_min).toBe(30);
    // A new booking still needs one of the type's durations.
    expect(() => createBooking({ type: typeRow(type.id)!, start: `${day}T13:00:00.000Z`, durationMin: 30, booker: booker("length2@example.org"), source: "public", actorId: null })).toThrow("durations");
  });

  test("round robin load and Insights count a rescheduled booking once", async () => {
    const type = await newType(host, { title: "Rotation", assignment: "round_robin", hosts: [{ userId: host.userId, priority: 2 }, { userId: colleague.userId, priority: 1 }] });
    const mine = createBooking({ type, start: startAt(9, 9), durationMin: 30, booker: booker("rr1@example.org"), source: "internal", actorId: host.userId, hostId: host.userId }).booking;
    createBooking({ type, start: startAt(9, 10), durationMin: 30, booker: booker("rr2@example.org"), source: "internal", actorId: host.userId, hostId: colleague.userId });
    rescheduleBooking(mine, { start: startAt(9, 12), by: "host", actorId: host.userId });
    // One live booking each: the tie goes to the higher priority (the old row of the move is no load).
    expect(pickRoundRobin(typeRow(type.id)!, [host.userId, colleague.userId], Date.now())).toBe(host.userId);
    const insights = bookingsInsights(colleague.userId, { days: 30, tz: "UTC" });
    expect(insights.statusCounts).toEqual({ confirmed: 1 });
    const own = bookingsInsights(host.userId, { days: 30, tz: "UTC" });
    expect(own.statusCounts.cancelled ?? 0).toBe(0);
    expect(own.cancelRate).toBe(0);
    // A real cancellation still counts.
    const gone = createBooking({ type, start: startAt(10, 9), durationMin: 30, booker: booker("rr3@example.org"), source: "internal", actorId: host.userId, hostId: host.userId }).booking;
    cancelBooking(gone, "host", host.userId, null);
    expect(bookingsInsights(host.userId, { days: 30, tz: "UTC" }).statusCounts.cancelled).toBe(1);
  });
});

describe("minor fixes", () => {
  test("the booker cannot cancel a booking under way; the host can", async () => {
    const type = await newType(host, { title: "Started call", durations: [60], slotInterval: 30 });
    const nowMs = Date.now();
    const start = new Date(nowMs - 10 * 60_000);
    start.setUTCSeconds(0, 0);
    start.setUTCMinutes(start.getUTCMinutes() - (start.getUTCMinutes() % 30));
    const created = createBooking({ type, start: start.toISOString(), durationMin: 60, booker: booker("started@example.org"), source: "public", actorId: null, nowMs: start.getTime() - 60 * 60_000 });
    expect(() => cancelBooking(created.booking, "booker", null, null, nowMs)).toThrow("already started");
    const response = await json(await fetch(`${origin}/api/public/bookings/manage/${created.manageToken}`));
    expect(response.body.canCancel).toBe(false);
    expect(cancelBooking(created.booking, "host", host.userId, null, nowMs).status).toBe("cancelled");
  });

  test("an outside feed's all-day block covers its dates in the schedule's zone, like Nook all-day events", () => {
    const user = colleague.userId;
    // Cached with the profile zone (Tokyo): 5 March 00:00 JST to 6 March 00:00 JST, plus the dates.
    const stored = [[Date.parse("2026-03-04T15:00:00Z"), Date.parse("2026-03-05T15:00:00Z"), 1, "2026-03-05", "2026-03-06"], [Date.parse("2026-03-07T15:00:00Z"), Date.parse("2026-03-08T15:00:00Z"), 1]];
    db.query("INSERT INTO booking_feeds (id, user_id, label, url_ct, url_hint, busy_json, last_status, created_at) VALUES (?, ?, 'Test', 'x', 'x', ?, 'ok', ?)").run(crypto.randomUUID(), user, JSON.stringify(stored), new Date().toISOString());
    const from = Date.parse("2026-03-01T00:00:00Z");
    const to = Date.parse("2026-03-10T00:00:00Z");
    expect(feedBusy(user, from, to, true, "Europe/Berlin")).toEqual([
      { start: Date.parse("2026-03-04T23:00:00Z"), end: Date.parse("2026-03-05T23:00:00Z"), allDay: true },
      // A block cached before dates were kept stays as stored.
      { start: Date.parse("2026-03-07T15:00:00Z"), end: Date.parse("2026-03-08T15:00:00Z"), allDay: true }
    ]);
    expect(feedBusy(user, from, to, false, "Europe/Berlin")).toEqual([]);
    db.query("DELETE FROM booking_feeds WHERE user_id = ?").run(user);
  });

  test("a new profile and its working hours use the browser's zone, else a zone another module stored, else UTC (D1129)", async () => {
    const india = await createUser("Zone India");
    const first = await api("/bookings/profile?tz=Asia/Kolkata", india);
    expect(first.body.profile.tz).toBe("Asia/Kolkata");
    expect((await api("/bookings/schedules", india)).body.schedules[0].tz).toBe("Asia/Kolkata");
    // A later call with another zone does not move an existing profile.
    expect((await api("/bookings/profile?tz=Europe/Paris", india)).body.profile.tz).toBe("Asia/Kolkata");
    const berlin = await createUser("Zone Berlin");
    db.query("INSERT INTO time_user_settings (user_id, tz, updated_at) VALUES (?, 'Europe/Berlin', ?)").run(berlin.userId, new Date().toISOString());
    expect((await api("/bookings/schedules?tz=nowhere", berlin)).body.schedules[0].tz).toBe("Europe/Berlin");
    expect((await api("/bookings/profile", berlin)).body.profile.tz).toBe("Europe/Berlin");
    const plain = await createUser("Zone Plain");
    expect((await api("/bookings/profile", plain)).body.profile.tz).toBe("UTC");
  });

  test("MCP create_booking refuses a hidden type to anyone but its owner", async () => {
    const type = await newType(host, { title: "Hidden call" });
    db.query("UPDATE booking_types SET visibility = 'all_users', share_role = 'view', status = 'hidden' WHERE id = ?").run(type.id);
    const args = { typeId: type.id, start: startAt(11, 9), booker: { name: "M", email: "m@example.org" } };
    expect(await errorCode(makeKey(colleague, ["bookings:write"]), "create_booking", args)).toBe("NOT_FOUND");
    expect((await api("/bookings", colleague, "POST", { type: type.id, start: args.start, booker: { ...args.booker, tz: "UTC" } })).status).toBe(404);
  });
});
