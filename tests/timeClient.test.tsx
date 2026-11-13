import { describe, expect, test } from "bun:test";
import { installDom, mockApi, render } from "./support/dom";
import { primeUnits } from "../src/ui/units";
import { parseTimeRoute } from "../src/time/module";
import { rangeDates } from "../src/time/ReportsTab";
import { CardTimeBadge, CardTimeSection } from "../src/time/CardTime";
import { TimesheetTab } from "../src/time/TimesheetTab";
import { TimerTopBar } from "../src/time/TimerBar";
import { resetTimerStoreForTests } from "../src/time/timerStore";
import { weekStartOf, type TimeEntry, type Timesheet } from "../shared/time";

/** Time's client (lane TIME, §D.2): routes, the header chip, the timesheet keyboard, and the card slots. */
installDom("http://nook.test/time");
primeUnits();

const notify = Object.assign(() => undefined, { success: () => undefined, info: () => undefined, warning: () => undefined, error: () => undefined }) as never;
const zone = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

const entry = (overrides: Partial<TimeEntry> = {}): TimeEntry => ({
  id: "e1", user: { id: "u1", name: "Riya" }, project: { id: "p1", name: "Acme website", color: "blue", client: "Acme Inc" }, description: "Fix the login loop",
  startedAt: new Date(Date.now() - 3600_000).toISOString(), endedAt: null, durationS: 3600, running: true, tz: "UTC", billable: true, rateMinor: null, amountMinor: null, currency: null,
  tags: [], target: { kind: "card", id: "c1", key: "WEB-1", title: "Fix login", href: "/tasks/WEB-1", icon: "square-check" }, source: "timer", locked: false, canEdit: true, revision: 1, ...overrides
});

describe("routes", () => {
  test("tabs, a project's friendly segment, a timesheet week, and an entry to open; anything else is the Timer", () => {
    expect(parseTimeRoute([], "")).toEqual({ path: [], search: "" });
    expect(parseTimeRoute(["timesheet"], "?week=2026-11-09&x=1")).toEqual({ path: ["timesheet"], search: "?week=2026-11-09" });
    expect(parseTimeRoute(["timesheet"], "?week=nope")).toEqual({ path: ["timesheet"], search: "" });
    expect(parseTimeRoute(["reports"], "")).toEqual({ path: ["reports"] });
    expect(parseTimeRoute(["projects", "acme-website-4lsa5ywomn"], "")).toEqual({ path: ["projects", "acme-website-4lsa5ywomn"] });
    expect(parseTimeRoute(["nope", "x"], "")).toEqual({ path: [], search: "" });
    expect(parseTimeRoute([], "?entry=01A1D5CE-A628-778C-9FF7-73727AF283AE")).toEqual({ path: [], search: "?entry=01a1d5ce-a628-778c-9ff7-73727af283ae" });
  });

  test("report ranges follow the week start", () => {
    expect(rangeDates("this_week", "2026-11-13", 1)).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(rangeDates("last_week", "2026-11-13", 0)).toEqual({ from: "2026-11-01", to: "2026-11-07" });
    expect(rangeDates("last_month", "2026-03-10", 1)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(weekStartOf("2026-11-13", 6)).toBe("2026-11-07");
  });
});

describe("the header timer chip", () => {
  test("idle it is one click to start; running it shows what it tracks with Stop and details", async () => {
    resetTimerStoreForTests({ entry: null });
    let running: TimeEntry | null = null;
    const api = mockApi({ [`GET /time/timer?tz=${zone}`]: () => ({ entry: running, today: { date: "2026-11-13", seconds: 0, entries: 0 } }), "POST /time/timer/start": () => { running = entry(); return { entry: running, stopped: null }; } });
    const view = await render(<TimerTopBar />);
    const start = view.container.querySelector('button[aria-label="Start timer"]')!;
    expect(start.getAttribute("aria-keyshortcuts")).toBe("Alt+T");
    await view.click(start);
    expect(api.calls.some((call) => call.method === "POST" && call.path === "/time/timer/start")).toBe(true);
    await view.waitFor(() => view.container.querySelector('[role="group"][aria-label="Timer running on WEB-1 Fix the login loop"]'));
    expect(view.container.querySelector('button[aria-label^="Stop timer"]')).not.toBeNull();
    expect(view.container.querySelector('button[aria-label="Timer details"]')).not.toBeNull();
  });
});

describe("the timesheet", () => {
  const sheet: Timesheet = {
    weekStart: "2026-11-09", days: ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"],
    rows: [
      { key: "p1|", project: { id: "p1", name: "Acme website", color: "blue" }, target: null, days: [3600, 0, 0, 0, 0, 0, 0], locked: [false, false, false, false, false, false, false] },
      { key: "p2|", project: { id: "p2", name: "Internal", color: "slate" }, target: null, days: [0, 1800, 0, 0, 0, 0, 0], locked: [false, true, false, false, false, false, false] }
    ],
    totals: [3600, 1800, 0, 0, 0, 0, 0], approvals: []
  };

  test("typing a duration and Enter saves the cell and moves down; arrows move; locked cells are read-only", async () => {
    const api = mockApi({
      [`GET /time/timesheet?tz=${zone}&week=2026-11-09`]: () => sheet,
      "PUT /time/timesheet/cell": () => ({ timesheet: { ...sheet, rows: [{ ...sheet.rows[0]!, days: [5400, 0, 0, 0, 0, 0, 0] }, sheet.rows[1]!] } })
    });
    const view = await render(<TimesheetTab week="2026-11-09" onWeek={() => undefined} onOpen={() => undefined} readOnly={false} />);
    const cell = await view.waitFor(() => document.getElementById("time-cell-0-0") as HTMLInputElement | null);
    expect(cell.value).toBe("1h");
    expect((document.getElementById("time-cell-1-1") as HTMLInputElement).disabled).toBe(true);
    const { act } = await import("react");
    await act(async () => {
      cell.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(cell, "1:30");
      cell.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    const put = await view.waitFor(() => api.calls.find((call) => call.method === "PUT"));
    expect(put.body).toMatchObject({ day: "2026-11-09", projectId: "p1", target: null, duration: 5400 });
    await view.waitFor(() => document.activeElement?.id === "time-cell-1-0");
    await act(async () => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(document.activeElement?.id).toBe("time-cell-0-0");
  });
});

describe("card slots", () => {
  const card = { id: "c1", board_id: "b1", key: "WEB-1", title: "Fix login", estimate: 5 };

  test("the Time section shows logged against the estimate and the worklog, and logs time inline", async () => {
    resetTimerStoreForTests({ entry: null });
    const api = mockApi({
      [`GET /time/timer?tz=${zone}`]: () => ({ entry: null, today: { date: "2026-11-13", seconds: 0, entries: 0 } }),
      "GET /time/targets/card/c1": () => ({
        target: { kind: "card", id: "c1", key: "WEB-1", title: "Fix login", href: "/tasks/WEB-1", icon: "square-check" }, totalSeconds: 12000, mySeconds: 3600, estimateSeconds: 18000,
        entries: [entry({ id: "e2", running: false, endedAt: new Date().toISOString(), durationS: 12000, user: { id: "u2", name: "Sam" } })], byPerson: [], privateEntries: false, defaultProject: { id: "p1", name: "Acme website" }
      }),
      "POST /time/entries": (call) => ({ entry: entry({ id: "e3", running: false, durationS: Number((call.body as { duration: number }).duration) }) })
    });
    const view = await render(<CardTimeSection card={card} readOnly={false} idPrefix="t" notify={notify} />);
    await view.waitFor(() => view.container.textContent?.includes("Sam"));
    expect(view.container.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toBe("3h 20m of 5h");
    await view.click(view.button("Log time")!);
    const { act } = await import("react");
    const input = view.container.querySelector<HTMLInputElement>(".time-card-log .ui-duration-input input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "45m");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(view.container.textContent).toContain("Goes to Acme website.");
    await view.click(view.button("Log")!);
    const post = await view.waitFor(() => api.calls.find((call) => call.method === "POST" && call.path === "/time/entries"));
    expect(post.body).toMatchObject({ duration: 2700, target: { kind: "card", id: "c1" }, projectId: "p1" });
  });

  test("face badges for many cards ask once", async () => {
    const api = mockApi({ "GET /time/cards?ids=k1,k2": () => ({ cards: { k1: { seconds: 5400, estimateSeconds: 7200, running: false }, k2: { seconds: 0, estimateSeconds: null, running: false } } }) });
    const view = await render(<div><CardTimeBadge card={{ id: "k1", board_id: "b", title: "One" }} /><CardTimeBadge card={{ id: "k2", board_id: "b", title: "Two" }} /></div>);
    await view.waitFor(() => view.container.textContent?.includes("1h 30m of 2h"), 4000).catch((error) => { throw new Error(`${String(error)} ${JSON.stringify(api.calls)}`); });
    expect(api.calls.filter((call) => call.path.startsWith("/time/cards")).length).toBe(1);
    expect(view.container.querySelectorAll(".time-face-badge").length).toBe(1);
  });
});
