import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { module as goals } from "../src/goals/module";
import { goalActivityRenderers } from "../src/goals/activity";
import { GoalRow } from "../src/goals/GoalsApp";
import { GOAL_ACTIVITY } from "../shared/goalsActivity";
import type { GoalSummary } from "../src/goals/goalsApi";
import type { ItemActivityEntry } from "../shared/itemActivity";

/** The Goals client module (lane GOALS, §D.3): routes, Today rows, activity lines, and a goal row. */

const summary: GoalSummary = {
  id: "g1", shortId: "7k3f9x2ab0", href: "/goals/grow-mrr-7k3f9x2ab0", title: "Grow MRR", kind: "objective", state: "active", health: "at_risk", suggestedHealth: "on_track",
  progress: 0.42, expected: 0.5, progressMode: "key_results", owner: { id: "u1", name: "Ana Silva" }, team: { id: "t1", name: "Growth" }, period: { id: "p1", name: "Q1 2027", startsOn: "2027-01-01", endsOn: "2027-03-31" },
  parentId: null, alignedToHidden: false, startOn: null, dueOn: null, lastCheckinAt: null, checkinDue: true, cadence: "weekly", krCount: 2, childCount: 1, hiddenChildCount: 1,
  finalProgress: null, closedAt: null, visibility: "all_users", revision: 3, createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-02T00:00:00.000Z"
};

describe("Goals client module", () => {
  test("is ready, with friendly goal routes and the home's view and period", () => {
    expect(goals.ready).toBe(true);
    expect(goals.parseRoute!(["Grow-MRR-7K3F9X2AB0"], "?x=1")).toEqual({ path: ["grow-mrr-7k3f9x2ab0"] });
    expect(goals.parseRoute!([], "?view=timeline&period=0190c2a0-1111-7222-8333-444455556666&junk=1")).toEqual({ path: [], search: "?view=timeline&period=0190c2a0-1111-7222-8333-444455556666" });
    expect(goals.parseRoute!(["insights"], "?view=nope")).toEqual({ path: [], search: "" });
    expect(goals.formatRoute!({ app: "goals", path: ["grow-mrr-7k3f9x2ab0"], search: "?view=list" })).toBe("/goals/grow-mrr-7k3f9x2ab0");
    expect(goals.formatRoute!({ app: "goals", path: [], search: "?view=list" })).toBe("/goals?view=list");
  });

  test("Today rows open the goal and say what is due", () => {
    const row = goals.todaySections!.goalsCheckin!.row!({ id: "g1", title: "Grow MRR", href: "/goals/grow-mrr-7k3f9x2ab0", progress: 0.42, lastCheckinAt: null }, "2027-01-05");
    expect(row).toEqual({ key: "g1", label: "Grow MRR", meta: "42% · no check-in yet", route: { app: "goals", path: ["grow-mrr-7k3f9x2ab0"], search: "" } as never, tone: "today" });
    expect(goals.todaySections!.goalsAtRisk!.row!({ id: "g1", title: "Grow MRR", href: "/goals/x-7k3f9x2ab0", progress: 0.1, health: "off_track" }, "2027-01-05").tone).toBe("overdue");
  });

  test("every goal activity kind has a line, and none leaks a check-in note", () => {
    for (const kind of Object.keys(GOAL_ACTIVITY)) expect(typeof (goalActivityRenderers as Record<string, unknown>)[kind]).toBe("function");
    const entry = (kind: string, payload: ItemActivityEntry["payload"]): ItemActivityEntry => ({ id: "a", itemKind: "goal", itemId: "g1", kind, actorId: "u1", actorName: "Ana", via: null, payload, createdAt: "2027-01-01T00:00:00.000Z" });
    expect(renderToStaticMarkup(<>{goalActivityRenderers.checked_in(entry("checked_in", { extra: { health: "at_risk", progress: 42, confidence: 6 } }))}</>)).toBe("checked in: At risk, 42%, confidence 6/10");
    expect(renderToStaticMarkup(<>{goalActivityRenderers.goal_closed(entry("goal_closed", { from: { label: "active" }, to: { label: "carried_over" } }))}</>)).toBe("closed it as Carried over");
  });

  test("a goal row: health in words, owner and team, progress with the expected marker, check-in due", () => {
    const html = renderToStaticMarkup(<ul><li><GoalRow goal={summary} depth={1} expanded onToggle={() => undefined} active onOpen={() => undefined} /></li></ul>);
    expect(html).toContain("At risk");
    expect(html).toContain('href="/goals/grow-mrr-7k3f9x2ab0"');
    expect(html).toContain("Ana Silva");
    expect(html).toContain(" · Growth");
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain("ui-progress-target");
    expect(html).toContain('data-due="true"');
    expect(html).toContain('aria-label="Collapse Grow MRR"');
    const quiet = renderToStaticMarkup(<GoalRow goal={{ ...summary, health: "none", state: "achieved", checkinDue: false }} depth={0} active={false} onOpen={() => undefined} />);
    expect(quiet).not.toContain("No status");
    expect(quiet).toContain("achieved");
  });
});
