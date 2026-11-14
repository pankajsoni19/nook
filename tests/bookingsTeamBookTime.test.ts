import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { errorCode, makeKey, ok, toolNames } from "./support/mcpClient";

const { typeRow, bookingRow } = await import("../server/bookings/model");
const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { BOOKING_AGENT_TOOLS } = await import("../server/bookings/mcpTools");

/**
 * "Book time with …" (D1250–D1253): GET /api/bookings/bookable answers, in one read, which
 * colleagues offer the viewer a bookable type (active; readable, or open on a public page; single or
 * collective; never the viewer's own); the in-app sheet's form; booking a colleague's public type as
 * yourself through POST /api/bookings; and MCP `list_bookable_types`.
 */

let ana: Session;
let bo: Session;
let cy: Session;
let me: Session;

const json = async (response: Response) => { const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) as any : null }; };
const api = async (path: string, session: Session, method = "GET", body?: unknown) => json(await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(method !== "GET" && body === undefined ? { headers: { "Content-Type": "application/json" } } : {}) }, session));
const allDay = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [day, [{ from: "00:00", to: "24:00" }]]));
const startAt = (days: number, hour: number) => { const date = new Date(Date.now() + days * 86_400_000); date.setUTCHours(hour, 0, 0, 0); return date.toISOString(); };
const newType = async (session: Session, input: Record<string, unknown>) => {
  const created = await api("/bookings/types", session, "POST", { minNotice: 0, ...input });
  expect(created.status).toBe(201);
  return typeRow(created.body.type.id)!;
};
const setPolicy = (on: boolean) => db.query("INSERT INTO team_settings (key, value_json, updated_at) VALUES ('public_booking_pages', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
  .run(on ? "true" : "false", new Date().toISOString());
const bookable = async (session: Session, users?: Session[]) => {
  const result = await api(`/bookings/bookable${users ? `?users=${users.map((user) => user.userId).join(",")}` : ""}`, session);
  expect(result.status).toBe(200);
  return result.body.hosts as Record<string, Array<{ id: string; title: string; durations: number[] }>>;
};
const titles = (hosts: Record<string, Array<{ title: string }>>, session: Session) => (hosts[session.userId] ?? []).map((type) => type.title);

beforeAll(async () => {
  ana = await createUser("Ana Host");
  bo = await createUser("Bo Host");
  cy = await createUser("Cy Host");
  me = await createUser("Me Booker");
  for (const session of [ana, bo, cy, me]) {
    expect((await api("/bookings/profile", session)).status).toBe(200);
    const schedules = await api("/bookings/schedules", session);
    await api(`/bookings/schedules/${schedules.body.schedules[0].id}`, session, "PUT", { weekly: allDay, tz: "UTC" });
  }
  setPolicy(true);
});

describe("GET /api/bookings/bookable", () => {
  test("lists each colleague's bookable types; hidden, binned, round robin, private non-public, and your own stay out", async () => {
    await newType(ana, { title: "Ana intro", durations: [15, 30] });
    const hidden = await newType(ana, { title: "Ana hidden" });
    db.query("UPDATE booking_types SET status = 'hidden', visibility = 'all_users', share_role = 'view' WHERE id = ?").run(hidden.id);
    const binned = await newType(ana, { title: "Ana binned" });
    expect((await api(`/bookings/types/${binned.id}`, ana, "DELETE")).status).toBe(200);
    await newType(ana, { title: "Ana private", public: false });
    const shared = await newType(ana, { title: "Ana shared", public: false });
    db.query("UPDATE booking_types SET visibility = 'all_users', share_role = 'view' WHERE id = ?").run(shared.id);
    await newType(ana, { title: "Ana and Bo round robin", assignment: "round_robin", hosts: [{ userId: ana.userId }, { userId: bo.userId }] });
    await newType(ana, { title: "Ana and Bo together", assignment: "collective", hosts: [{ userId: ana.userId }, { userId: bo.userId }] });
    await newType(me, { title: "My own" });
    await newType(cy, { title: "Cy with me", assignment: "collective", hosts: [{ userId: cy.userId }, { userId: me.userId }] });

    const hosts = await bookable(me);
    expect(titles(hosts, ana).sort()).toEqual(["Ana and Bo together", "Ana intro", "Ana shared"]);
    expect(titles(hosts, bo)).toEqual(["Ana and Bo together"]);
    expect(hosts[me.userId]).toBeUndefined();
    expect(hosts[cy.userId]).toBeUndefined();
    expect(hosts[ana.userId]!.find((type) => type.title === "Ana intro")!.durations).toEqual([15, 30]);
    // Ana sees Bo's share of the collective type? No: she hosts it herself.
    expect(titles(await bookable(ana), bo)).not.toContain("Ana and Bo together");
  });

  test("users narrows the answer; a viewer gets nothing; a guest 404s", async () => {
    const narrowed = await bookable(me, [bo]);
    expect(Object.keys(narrowed)).toEqual([bo.userId]);
    expect(Object.keys(await bookable(me, []))).toEqual([]);
    const viewer = await createUser("Viewer Booker");
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
    expect(await bookable(viewer)).toEqual({});
    const guest = await createUser("Guest Booker");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    expect((await api("/bookings/bookable", guest)).status).toBe(404);
  });

  test("a public type counts only while its page is open: workspace policy, the owner's profile, an active owner", async () => {
    setPolicy(false);
    expect(titles(await bookable(me), ana).sort()).toEqual(["Ana shared"]);
    setPolicy(true);
    db.query("UPDATE booking_profiles SET enabled = 0 WHERE user_id = ?").run(ana.userId);
    expect(titles(await bookable(me), ana).sort()).toEqual(["Ana shared"]);
    db.query("UPDATE booking_profiles SET enabled = 1 WHERE user_id = ?").run(ana.userId);
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), bo.userId);
    expect((await bookable(me))[bo.userId]).toBeUndefined();
    db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(bo.userId);
  });

  test("one batched read for a whole list: a hundred ids in one request", async () => {
    const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
    const result = await api(`/bookings/bookable?users=${[...ids, ana.userId].join(",")}`, me);
    expect(result.status).toBe(200);
    expect(Object.keys(result.body.hosts)).toEqual([ana.userId]);
    const tooMany = Array.from({ length: 501 }, (_, index) => (0x10000000 + index).toString(16));
    expect((await api(`/bookings/bookable?users=${tooMany.join(",")}`, me)).status).toBe(400);
  });
});

describe("booking a colleague in the app", () => {
  test("the sheet's form gives the place and the published questions; a private non-public type is NOT_FOUND", async () => {
    const type = await newType(ana, { title: "Ana asks", locationKind: "ask" });
    const set = { version: 1, sections: [], logic: [], endings: [], questions: [{ id: "topic0001", type: "short_text", title: "What about?", required: true }] };
    const saved = await api(`/bookings/types/${type.id}/questions`, ana, "PUT", { set, publish: true });
    expect(saved.status).toBe(200);
    const form = await api(`/bookings/types/${type.id}/form`, me);
    expect(form.status).toBe(200);
    expect(form.body.type.needsLocation).toBe(true);
    expect(form.body.questions.questions.map((question: { id: string }) => question.id)).toEqual(["topic0001"]);
    expect(form.body.hosts).toEqual([{ id: ana.userId, name: "Ana Host" }]);
    const hiddenAway = (await newType(ana, { title: "Ana nope", public: false })).id;
    expect((await api(`/bookings/types/${hiddenAway}/form`, me)).status).toBe(404);
    expect((await api(`/bookings/types/${hiddenAway}/slots`, me)).status).toBe(404);
  });

  test("a member books a colleague's public type as themselves: zone, place, guests, answers; they read it as the booker", async () => {
    const type = typeRow((await bookable(me))[ana.userId]!.find((item) => item.title === "Ana asks")!.id)!;
    const slots = await api(`/bookings/types/${type.id}/slots?tz=Europe/Berlin`, me);
    expect(slots.status).toBe(200);
    const start = startAt(3, 10);
    const missing = await api("/bookings", me, "POST", { type: type.id, start, duration: 30, tz: "Europe/Berlin", location: "Room 4", answers: {} });
    expect(missing.status).toBe(400);
    const created = await api("/bookings", me, "POST", { type: type.id, start, duration: 30, tz: "Europe/Berlin", location: "Room 4", guests: ["pal@example.org"], answers: { topic0001: "Roadmap" } });
    expect(created.status).toBe(201);
    const row = bookingRow(created.body.booking.id)!;
    expect(row.source).toBe("internal");
    expect(row.created_by).toBe(me.userId);
    expect(row.host_id).toBe(ana.userId);
    expect(row.booker_tz).toBe("Europe/Berlin");
    expect(row.location_resolved).toBe("Room 4");
    expect(JSON.parse(row.guests_json)).toEqual(["pal@example.org"]);
    expect((await api(`/bookings/b/${row.id}`, me)).status).toBe(200);
    const taken = await api("/bookings", me, "POST", { type: type.id, start, duration: 30, tz: "UTC", location: "Room 4", answers: { topic0001: "Again" } });
    expect(taken.status).toBe(409);
  });

  test("a hidden colleague's type still books only for its owner", async () => {
    const type = await newType(ana, { title: "Ana hidden two" });
    db.query("UPDATE booking_types SET status = 'hidden', visibility = 'all_users', share_role = 'view' WHERE id = ?").run(type.id);
    expect((await api("/bookings", me, "POST", { type: type.id, start: startAt(4, 9), tz: "UTC" })).status).toBe(404);
    expect((await api(`/bookings/types/${type.id}/form`, me)).status).toBe(404);
    // Its readers keep the slot preview (the type editor's).
    expect((await api(`/bookings/types/${type.id}/slots`, me)).status).toBe(200);
  });
});

describe("MCP list_bookable_types", () => {
  test("listed for bookings:read, allowed for agents, and grouped by host", async () => {
    const key = makeKey(me, ["bookings:read"]);
    expect(await toolNames(key)).toContain("list_bookable_types");
    expect(BOOKING_AGENT_TOOLS.allowed).toContain("list_bookable_types");
    expect("list_bookable_types").not.toMatch(/delete|remove/);
    const result = await ok(key, "list_bookable_types", { hostIds: [ana.userId, bo.userId] });
    const byHost = Object.fromEntries((result.hosts as Array<{ userId: string; name: string; types: Array<{ title: string; url: string }> }>).map((host) => [host.userId, host]));
    expect(byHost[ana.userId]!.name).toBe("Ana Host");
    expect(byHost[ana.userId]!.types.map((type) => type.title)).toContain("Ana intro");
    expect(byHost[ana.userId]!.types[0]!.url).toContain("/bookings/types/");
    expect(byHost[bo.userId]!.types.map((type) => type.title)).toEqual(["Ana and Bo together"]);
  });

  test("a key over chosen types sees only those; create_booking books a colleague's public type", async () => {
    const shared = typeRow((await bookable(me))[ana.userId]!.find((item) => item.title === "Ana shared")!.id)!;
    const chosen = createApiKey(me.userId, { name: "One type", surfaces: "both", grants: [{ module: "bookings", permission: "read", resourceKind: "booking_type", resourceId: shared.id }], expiresInDays: 30 });
    const listed = JSON.parse((await invokeMcpToolForTests("list_bookable_types", {}, chosen.id) as { content: Array<{ text: string }> }).content[0]!.text);
    expect((listed.hosts as Array<{ types: Array<{ id: string }> }>).flatMap((host) => host.types.map((type) => type.id))).toEqual([shared.id]);
    const writer = makeKey(me, ["bookings:write"]);
    const publicType = (await bookable(me))[ana.userId]!.find((item) => item.title === "Ana intro")!;
    const booked = await ok(writer, "create_booking", { typeId: publicType.id, start: startAt(5, 9) });
    expect(booked.hostId).toBe(ana.userId);
    const privateType = (await newType(ana, { title: "Ana closed", public: false })).id;
    expect(await errorCode(writer, "create_booking", { typeId: privateType, start: startAt(5, 11) })).toBe("NOT_FOUND");
  });
});
