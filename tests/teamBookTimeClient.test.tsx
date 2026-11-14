/**
 * Team → "Book time with …" (D1250–D1253), rendered with happy-dom and mocked API answers: one
 * batched GET /api/bookings/bookable for the whole list; a button only for members who offer a type
 * (none on your own row, none for viewers); one type opens the booking sheet straight away, several
 * open a chooser first; the member's profile shows the full "Book time with <name>" button.
 */
import { describe, expect, test } from "bun:test";
import type { TeamMember } from "../src/team/teamApi";
import type { BookableType } from "../src/bookings/api";
import { installDom, mockApi, render, type ApiCall, type ApiRoutes } from "./support/dom";

installDom();

const { TeamSection } = await import("../src/team/TeamApp");
const { registerMemberAction, clearMemberActionsForTests } = await import("../src/ui/memberSlots");
const { bookTimeMemberAction } = await import("../src/bookings/TeamBookTime");

const ME = "11111111-1111-4111-8111-111111111111";
const ADA = "22222222-2222-4222-8222-222222222222";
const BO = "33333333-3333-4333-8333-333333333333";
const CY = "44444444-4444-4444-8444-444444444444";

const person = (id: string, displayName: string, overrides: Partial<TeamMember> = {}): TeamMember => ({
  id, displayName, role: "member", status: "active", createdAt: "2026-01-01T00:00:00.000Z", isYou: false, ...overrides
});
const type = (id: string, title: string, durations: number[]): BookableType => ({
  id, shortId: `k7f3q2ab${id.slice(-2)}`, title, description: "", durations, color: "#f6c453", locationKind: "video_link", confirm: "auto", assignment: "single", href: `/bookings/types/x-k7f3q2ab${id.slice(-2)}`
});
const members = [person(ME, "Me Myself", { isYou: true }), person(ADA, "Ada Lovelace"), person(BO, "Bo Diddley"), person(CY, "Cy Twombly")];
const offered = { [ADA]: [type("t01", "Intro call", [30])], [BO]: [type("t02", "Quick sync", [15]), type("t03", "Deep dive", [60, 90])] };

/** Routes by prefix (slots carry a query), recording calls. */
function routes(extra: Record<string, (call: ApiCall) => unknown> = {}): ApiRoutes {
  const table: Record<string, (call: ApiCall) => unknown> = {
    "GET /team": () => ({ me: { id: ME, role: "member" }, users: members }),
    "GET /bookings/bookable": () => ({ hosts: offered }),
    "GET /bookings/types/": (call) => call.path.includes("/form")
      ? { type: { ...type("t03", "Deep dive", [60, 90]), locationLabel: "Video call", location: "", needsLocation: false }, hosts: [{ id: BO, name: "Bo Diddley" }], questions: null }
      : { tz: "UTC", duration: 60, days: {} },
    ...extra
  };
  return new Proxy({}, {
    get: (_target, key: string) => {
      const [method, path] = key.split(" ");
      const match = Object.keys(table).find((entry) => { const [m, p] = entry.split(" "); return m === method && (path === p || path!.split("?")[0] === p || (p!.endsWith("/") && path!.startsWith(p!))); });
      return match ? table[match] : undefined;
    }
  }) as ApiRoutes;
}

async function openTeam(role: "member" | "viewer" = "member", userId: string | null = null) {
  return render(<TeamSection route={{ app: "team", userId }} role={role} navigate={() => undefined} flash={() => undefined} onLeave={() => undefined} guardLeave={(leave) => leave()} onKeyPendingChange={() => undefined} />);
}

const bookButton = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="Book time with ${name}"]`);

describe("Team: Book time with …", () => {
  test("one batched read; buttons only for members who offer a type; none on your own row", async () => {
    clearMemberActionsForTests();
    registerMemberAction({ ...bookTimeMemberAction, module: "bookings" });
    const api = mockApi(routes());
    const view = await openTeam();
    await view.waitFor(() => bookButton("Ada Lovelace"));
    expect(bookButton("Bo Diddley")).not.toBeNull();
    expect(bookButton("Cy Twombly")).toBeNull();
    expect(bookButton("Me Myself")).toBeNull();
    const reads = api.calls.filter((call) => call.path.startsWith("/bookings/bookable"));
    expect(reads.length).toBe(1);
    expect(reads[0]!.path).toContain(ADA);
    expect(reads[0]!.path).not.toContain(ME);
  });

  test("one type opens the sheet at once; several open a chooser first", async () => {
    clearMemberActionsForTests();
    registerMemberAction({ ...bookTimeMemberAction, module: "bookings" });
    mockApi(routes());
    const view = await openTeam();
    await view.click(await view.waitFor(() => bookButton("Ada Lovelace")));
    const sheet = await view.waitFor(() => document.querySelector('[role="dialog"]'));
    expect(sheet.textContent).toContain("Book time with Ada Lovelace");
    expect(sheet.textContent).toContain("Intro call");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await view.click(sheet.querySelector('button[aria-label="Close"]')!);
    await view.waitFor(() => !document.querySelector('[role="dialog"]'));

    await view.click(bookButton("Bo Diddley")!);
    const menu = await view.waitFor(() => document.querySelector('[role="menu"]'));
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    expect(items).toEqual(["Quick sync15 min", "Deep dive1 h / 1 h 30 min"]);
    await view.click(menu.querySelectorAll('[role="menuitem"]')[1]!);
    const second = await view.waitFor(() => document.querySelector('[role="dialog"]'));
    expect(second.textContent).toContain("Book time with Bo Diddley");
    expect(second.textContent).toContain("Deep dive");
    await view.waitFor(() => second.querySelector('[role="radiogroup"][aria-label="Length"]'));
  });

  test("the member's profile shows the full button", async () => {
    clearMemberActionsForTests();
    registerMemberAction({ ...bookTimeMemberAction, module: "bookings" });
    mockApi(routes({ [`GET /team/${ADA}`]: () => ({ member: { ...members[1], events: [], joinedWithInvite: null } }) }));
    const view = await openTeam("member", ADA);
    const pane = await view.waitFor(() => document.querySelector('[aria-label="Team member"] .team-detail-actions'));
    expect(pane.textContent).toContain("Book time with Ada Lovelace");
  });

  test("viewers see no button and make no read", async () => {
    clearMemberActionsForTests();
    registerMemberAction({ ...bookTimeMemberAction, module: "bookings" });
    const api = mockApi(routes());
    const view = await openTeam("viewer");
    await view.waitFor(() => document.querySelector(".team-list"));
    expect(bookButton("Ada Lovelace")).toBeNull();
    expect(api.calls.some((call) => call.path.startsWith("/bookings/bookable"))).toBe(false);
  });
});
