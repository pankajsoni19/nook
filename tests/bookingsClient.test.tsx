import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { installDom, mockApi, render } from "./support/dom";
import { AvailabilityEditor, nextRange } from "../src/ui/schedule/AvailabilityEditor";
import { SlotPicker } from "../src/bookings/SlotPicker";
import BookingsApp from "../src/bookings/BookingsApp";
import BookingPublicPage from "../src/bookings/public/BookingPublicPage";
import { primeUnits } from "../src/ui/units";
import type { WeeklyRules } from "../shared/bookings";
import type { Booking } from "../src/bookings/api";

/** Bookings screens (§D.6 UI): the availability editor, the slot picker, the home list with approvals, and the public booking flow. */
installDom("http://nook.test/bookings");
primeUnits();

const booking = (over: Partial<Booking> = {}): Booking => ({
  id: "b1", shortId: "k7f3q2ab01", href: "/bookings/b/k7f3q2ab01", typeId: "t1", typeTitle: "Intro call", typeDeleted: false, color: "#f6c453", hostId: "u1", hostName: "Priya Shah",
  cohosts: [], start: "2030-03-04T09:00:00.000Z", end: "2030-03-04T09:30:00.000Z", durationMin: 30, bookerTz: "UTC", status: "confirmed", bookerName: "Ana Silva", bookerEmail: "ana@example.org",
  guests: [], locationKind: "video_link", location: "https://meet.example.test", contactId: null, cardId: null, eventId: null, rescheduledFromId: null, cancelReason: null, cancelledBy: null,
  source: "public", createdAt: "2030-03-01T00:00:00.000Z", revision: 1, ...over
});

describe("AvailabilityEditor", () => {
  test("next range, toggling a day, and copy to all days", async () => {
    expect(nextRange([])).toEqual({ from: "09:00", to: "17:00" });
    expect(nextRange([{ from: "09:00", to: "12:00" }])).toEqual({ from: "13:00", to: "14:00" });
    expect(nextRange([{ from: "09:00", to: "23:30" }])).toBeNull();
    let last: WeeklyRules = {};
    function Host() {
      const [weekly, setWeekly] = useState<WeeklyRules>({ mon: [{ from: "09:00", to: "12:00" }] });
      last = weekly;
      return <AvailabilityEditor weekly={weekly} onChange={setWeekly} />;
    }
    const view = await render(<Host />);
    const tuesday = view.container.querySelectorAll<HTMLInputElement>(".ui-availability-switch input")[1]!;
    await view.click(tuesday);
    expect(last.tue).toEqual([{ from: "09:00", to: "17:00" }]);
    await view.click(view.container.querySelector("[aria-label=\"Copy Monday's hours to every day\"]")!);
    expect(Object.keys(last).sort()).toEqual(["fri", "mon", "sat", "sun", "thu", "tue", "wed"]);
    expect(last.sun).toEqual([{ from: "09:00", to: "12:00" }]);
    await view.click(view.container.querySelector("[aria-label='Add hours on Monday']")!);
    expect(last.mon).toEqual([{ from: "09:00", to: "12:00" }, { from: "13:00", to: "14:00" }]);
  });
});

describe("SlotPicker", () => {
  test("marks days with times, lists the first day's times in the zone, and picks one", async () => {
    const picked: string[] = [];
    const view = await render(<SlotPicker tz="UTC" onTz={() => undefined} onPick={(iso) => picked.push(iso)}
      load={async () => ({ tz: "UTC", duration: 30, days: { "2030-03-05": ["2030-03-05T09:00:00.000Z", "2030-03-05T09:30:00.000Z"] } })} />);
    await view.waitFor(() => view.container.querySelector(".bk-slots-time"));
    expect(view.container.querySelectorAll(".bk-slots-time").length).toBe(2);
    await view.click(view.container.querySelectorAll(".bk-slots-time")[1]!);
    expect(picked).toEqual(["2030-03-05T09:30:00.000Z"]);
  });
});

describe("Bookings home", () => {
  test("requests first with Approve, then the day's bookings; Approve calls the API", async () => {
    const api = mockApi({
      "GET /bookings?view=upcoming": () => ({ items: [booking(), booking({ id: "b2", shortId: "k7f3q2ab02", status: "pending", bookerName: "Lena Fischer" })], nextCursor: null }),
      "GET /bookings?view=pending": () => ({ items: [booking({ id: "b2", shortId: "k7f3q2ab02", status: "pending", bookerName: "Lena Fischer" })], nextCursor: null }),
      "POST /bookings/b/b2/approve": () => ({ booking: booking({ id: "b2", status: "confirmed" }) })
    });
    const view = await render(<BookingsApp route={{ app: "bookings", path: [], search: "" }} userId="u1" displayName="Priya" role="member" navigate={() => undefined}
      onOpenPath={() => undefined} flash={() => undefined} onHome={() => undefined} onSettings={() => undefined} onSignOut={() => undefined} />);
    await view.waitFor(() => view.container.querySelector(".bk-row"));
    expect(view.container.textContent).toContain("Awaiting your approval");
    const rows = [...view.container.querySelectorAll(".bk-row")].map((row) => row.textContent);
    expect(rows[0]).toContain("Lena Fischer");
    expect(rows[1]).toContain("Ana Silva");
    await view.click(view.button("Approve")!);
    expect(api.calls.some((call) => call.method === "POST" && call.path === "/bookings/b/b2/approve")).toBe(true);
  });
  test("an empty Upcoming has one sentence and one action", async () => {
    mockApi({ "GET /bookings?view=upcoming": () => ({ items: [], nextCursor: null }), "GET /bookings?view=pending": () => ({ items: [], nextCursor: null }) });
    const view = await render(<BookingsApp route={{ app: "bookings", path: [], search: "" }} userId="u1" displayName="Priya" role="member" navigate={() => undefined}
      onOpenPath={() => undefined} flash={() => undefined} onHome={() => undefined} onSettings={() => undefined} onSignOut={() => undefined} />);
    await view.waitFor(() => view.container.querySelector(".ui-empty"));
    expect(view.container.textContent).toContain("No upcoming bookings");
    expect(view.button("Share a booking link")).not.toBeNull();
  });
});

describe("public booking page", () => {
  test("the profile lists the types; an unknown handle is the one 404 page", async () => {
    mockApi({ "GET /public/book/priya": () => ({ meta: { appName: "Nook", workspaceName: "Nook", logoUrl: null }, host: { name: "Priya Shah", welcome: "Hi", handle: "priya", tz: "UTC" },
      types: [{ slug: "intro-call", title: "Intro call", description: "", durations: [30], locationKind: "video_link", color: "#f6c453" }] }) });
    const view = await render(<BookingPublicPage path="/p/book/priya" search="" />);
    await view.waitFor(() => view.container.querySelector(".bk-pub-types a"));
    expect(view.container.querySelector(".bk-pub-types a")!.getAttribute("href")).toBe("/p/book/priya/intro-call");
    const missing = await render(<BookingPublicPage path="/p/book/nobody" search="" />);
    await missing.waitFor(() => missing.container.textContent?.includes("This link is not available"));
  });
  test("pick a time, give details (honeypot empty, nonce sent), and see the confirmation", async () => {
    mockApi({
      "GET /public/book/priya/intro-call": () => ({ meta: { appName: "Nook", workspaceName: "Nook", logoUrl: null, renderNonce: "v1.n.s" }, host: { name: "Priya Shah", welcome: "", handle: "priya", tz: "UTC" },
        type: { slug: "intro-call", title: "Intro call", description: "", durations: [30], locationKind: "video_link", color: "#f6c453", locationLabel: "Video call", location: "", needsLocation: false, confirm: "auto", assignment: "single" },
        questions: null, verifyEmail: false, mail: true })
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/slots?")) return Response.json({ tz: "UTC", durations: [30], duration: 30, days: { [`${new Date().toISOString().slice(0, 7)}-28`]: [`${new Date().toISOString().slice(0, 7)}-28T09:00:00.000Z`] } });
      if (url.endsWith("/bookings") && init?.method === "POST") return Response.json({ status: "confirmed", mailQueued: true, manageUrl: "/p/book/manage/TOKEN", booking: { typeTitle: "Intro call", hostName: "Priya Shah", start: "", end: "", tz: "UTC", when: "Tue 28, 09:00–09:30 (UTC)", location: "", locationKind: "video_link" } }, { status: 201 });
      return original(input, init);
    }) as typeof fetch;
    try {
      const view = await render(<BookingPublicPage path="/p/book/priya/intro-call" search="" />);
      await view.waitFor(() => view.container.querySelector(".bk-slots-time"));
      await view.click(view.container.querySelector(".bk-slots-time")!);
      const set = (selector: string, value: string) => { const input = view.container.querySelector<HTMLInputElement>(selector)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };
      set("input[autocomplete=name]", "Ana Silva");
      set("input[type=email]", "ana@example.org");
      await view.click(view.button("Confirm booking")!);
      await view.waitFor(() => view.container.textContent?.includes("You're booked"));
      expect(view.container.querySelector("a.bk-pub-link")!.getAttribute("href")).toBe("/p/book/manage/TOKEN");
    } finally {
      globalThis.fetch = original;
    }
  });
});
