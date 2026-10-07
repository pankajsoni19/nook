import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { safeNotificationPath } from "../src/notifications/notificationsApi";
import { activityLabel, feedCalendarPhrase, type AccessSummary, type ActivityEvent } from "../src/access/memberAccessApi";
import { FeedsAndRoutines } from "../src/access/FeedsAndRoutines";

/**
 * Bell deep links and the access page's feed and routine actions on the client (v0.32).
 */

const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
const A = id(1);
const B = id(2);

describe("bell deep links on the client (T68)", () => {
  test("every path the server builds opens as is; ids are lowercased", () => {
    const targets = [
      `/notes/${A}`, `/notes/folder/${A}`, `/files/${A}`, `/tasks/${A}`, `/tasks/${A}/card/${B}`, `/tasks/views/${A}`,
      `/collections/${A}`, `/collections/${A}/row/${B}`, `/calendar/event/${A}`, "/calendar", `/whiteboards/${A}`,
      `/vault/${A}`, "/vault", `/chat/${A}`, `/chat/new?agent=${A}`, "/chat", `/inbox/p/${A}`, `/inbox/history/p/${A}`, "/inbox", "/inbox/routines",
      "/settings/security", "/settings/keys", "/settings/access", "/settings/agents", `/settings/agents/${A}`, "/settings/knowledge", `/settings/knowledge/${A}`,
      "/notes", "/files", "/tasks", "/collections", "/notifications"
    ];
    for (const path of targets) expect(safeNotificationPath(path)).toBe(path);
    expect(safeNotificationPath(`/tasks/${A.toUpperCase()}/card/${B}`)).toBe(`/tasks/${A}/card/${B}`);
  });

  test("anything the router would not write opens the list", () => {
    for (const hostile of [
      "", "/", "https://evil.example/notes", "//evil.example/notes", "/\\evil.example", "javascript:alert(1)", `/notes/${A}#x`, `/notes/${A} `,
      `/notes/${A}?next=//evil`, "/notes/not-an-id", `/tasks/${A}/card/nope`, `/chat/new?agent=${A}&x=1`, "/settings/nope", `/settings/agents/${A}/x`,
      `/inbox/p/${A}/x`, "/unknown", `/${"a".repeat(300)}`, undefined, 42
    ]) expect({ hostile, path: safeNotificationPath(hostile) }).toEqual({ hostile, path: "/notifications" });
  });

  test("the service worker follows the same shapes (it cannot import the router)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8");
    const safePath = new Function("self", `${source};return safePath;`)({ addEventListener() {}, registration: {}, clients: {}, location: { origin: "https://nook.test" } }) as (href: unknown) => string;
    for (const path of [`/notes/${A}`, `/tasks/${A}/card/${B}`, `/inbox/p/${A}`, "/inbox/routines", "/settings/access", `/settings/agents/${A}`, `/chat/new?agent=${A}`, `/vault/${A}`, "/calendar"]) {
      expect(safePath(path)).toBe(path);
      expect(safeNotificationPath(path)).toBe(path);
    }
    for (const hostile of ["https://evil.example/", "//evil", `/notes/${A}?x=1`, "/settings/team", `/chat/new?agent=${A}&x`]) expect(safePath(hostile)).toBe("/notifications");
  });
});

const summary = (): Pick<AccessSummary, "feeds" | "routines"> => ({
  feeds: {
    live: 2, items: [
      { id: A, detail: "busy", prefix: "nookfeed_ab12", createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, calendar: { title: "Team calendar", titleHidden: false, owner: { displayName: "Ada" } } },
      { id: B, detail: "full", prefix: "nookfeed_cd34", createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, calendar: { title: "Calendar owned by Carol", titleHidden: true, owner: { displayName: "Carol" } } }
    ]
  },
  routines: {
    enabled: 1, items: [
      { id: A, name: "Morning triage", enabled: true, schedule: "Daily at 08:00", nextDueAt: null, lastRunAt: null, keyName: "laptop" },
      { id: B, name: "Weekly review", enabled: false, schedule: "Weekly on Monday at 09:00", nextDueAt: null, lastRunAt: null, keyName: null }
    ]
  }
});
const noop = () => undefined;
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);

describe("feed links and routines on the access pages", () => {
  test("admin page: Revoke on each feed, Pause on an enabled routine, never Resume", () => {
    const html = renderToStaticMarkup(<FeedsAndRoutines summary={summary()} mode="admin" onRevokeFeed={noop} onPauseRoutine={noop} />);
    expect(buttons(html)).toEqual(["Revoke", "Revoke", "Pause"]);
    expect(html).toContain("Team calendar");
    expect(html).toContain("Calendar owned by Carol");
    expect(html).toContain("ma-hidden-title");
    expect(html).toContain("Paused");
    expect(html).toContain("Only the owner can resume their routines.");
    // The confirms are the app's dialog: the buttons say so.
    expect(html.match(/aria-haspopup="dialog"/g)?.length).toBe(3);
    expect(html).not.toContain("Suggest");
  });

  test("My access: Resume a paused routine when the role may write; a viewer's stays disabled", () => {
    const writer = renderToStaticMarkup(<FeedsAndRoutines summary={summary()} mode="self" canResume onRevokeFeed={noop} onPauseRoutine={noop} onResumeRoutine={noop} />);
    expect(buttons(writer)).toEqual(["Revoke", "Revoke", "Pause", "Resume"]);
    expect(writer).not.toContain("Only the owner");
    // Pause and Resume are reversible: no dialog.
    expect(writer.match(/aria-haspopup="dialog"/g)?.length).toBe(2);
    const viewer = renderToStaticMarkup(<FeedsAndRoutines summary={summary()} mode="self" onRevokeFeed={noop} onPauseRoutine={noop} onResumeRoutine={noop} />);
    expect(viewer).toMatch(/<button[^>]*disabled=""[^>]*>Resume<\/button>/);
    expect(viewer).toContain("Your team role is read-only");
  });

  test("empty lists and older servers (counts only) render plainly", () => {
    const html = renderToStaticMarkup(<FeedsAndRoutines summary={{ feeds: { live: 0 }, routines: { enabled: 0 } }} mode="admin" onRevokeFeed={noop} onPauseRoutine={noop} />);
    expect(html).toContain("No live calendar feed links.");
    expect(html).toContain("No routines.");
    expect(buttons(html)).toEqual([]);
  });

  test("confirm copy and activity lines name a hidden calendar without its title", () => {
    expect(feedCalendarPhrase(summary().feeds.items![1]!)).toBe("a calendar owned by Carol");
    expect(feedCalendarPhrase(summary().feeds.items![0]!)).toBe("the calendar “Team calendar”");
    const event = (action: string, item: ActivityEvent["item"]): ActivityEvent => ({
      id: "e", action, via: "web", createdAt: "2026-10-01T00:00:00.000Z", actor: { id: "a", displayName: "Ann" }, target: { id: "b", displayName: "Bo" }, group: null, key: null, item, meta: { by: "admin" }
    });
    expect(activityLabel(event("access.feed_revoked", { kind: "calendar", title: "Calendar owned by Carol", titleHidden: true }))).toBe("Ann revoked Bo's calendar feed link for a calendar owned by Carol");
    expect(activityLabel(event("access.routine_paused", { kind: "routine", title: "A routine", titleHidden: true }))).toBe("Ann paused one of Bo's routines");
  });
});
