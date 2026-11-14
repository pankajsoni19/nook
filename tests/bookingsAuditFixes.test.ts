import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { resetPublicSlotCache } = await import("../server/bookings/publicRoutes");
const { hostPlans } = await import("../server/bookings/availability");
const { typeRow } = await import("../server/bookings/model");

/**
 * Bookings audit fixes: a secret link pauses with its owner (D1029, T589).
 */

let host: Session;
let typeId = "";
let linkPath = "";

const json = async (response: Response) => { const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) as any : null }; };
const api = async (path: string, session: Session, method = "GET", body?: unknown) => json(await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, session));
const pub = async (path: string) => json(await fetch(`${origin}/api/public${path}`));
const allDay = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [day, [{ from: "00:00", to: "24:00" }]]));

beforeAll(async () => {
  host = await createUser("Link Host");
  expect((await api("/bookings/profile", host)).status).toBe(200);
  const schedules = await api("/bookings/schedules", host);
  await api(`/bookings/schedules/${schedules.body.schedules[0].id}`, host, "PUT", { weekly: allDay, tz: "UTC" });
  const type = await api("/bookings/types", host, "POST", { title: "Private chat", minNotice: 0 });
  expect(type.status).toBe(201);
  typeId = type.body.type.id;
  const link = await api(`/bookings/types/${typeId}/secret-links`, host, "POST", {});
  expect(link.status).toBe(201);
  linkPath = link.body.link.path.replace("/p/book/link/", "/book/link/");
});

describe("secret booking links follow the owner and profile (D1029, T589)", () => {
  test("a disabled profile 404s the link like the handle page", async () => {
    expect((await pub(linkPath)).status).toBe(200);
    expect((await api("/bookings/profile", host, "PUT", { enabled: false })).status).toBe(200);
    const off = await pub(linkPath);
    expect(off).toEqual({ status: 404, body: { error: "This link is not available", code: "NOT_FOUND" } });
    resetPublicSlotCache();
    expect((await pub(`${linkPath}/slots`)).status).toBe(404);
    expect((await api("/bookings/profile", host, "PUT", { enabled: true })).status).toBe(200);
    expect((await pub(linkPath)).status).toBe(200);
  });

  test("a blocked owner: the link 404s and the type has no hosts; an unblock resumes it", async () => {
    db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), host.userId);
    try {
      expect((await pub(linkPath)).status).toBe(404);
      expect(hostPlans(typeRow(typeId)!)).toEqual([]);
    } finally {
      db.query("UPDATE users SET disabled_at = NULL WHERE id = ?").run(host.userId);
    }
    expect((await pub(linkPath)).status).toBe(200);
    expect(hostPlans(typeRow(typeId)!).map((plan) => plan.userId)).toEqual([host.userId]);
  });
});
