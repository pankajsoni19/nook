import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "./support/harness";

const { nextFires, scheduleRuleProblem } = await import("../shared/schedules");
const { registerScheduleHandler, upsertSchedule, cancelSchedules, setScheduleEnabled, nextFireTimes } = await import("../server/schedules/service");
const { runScheduleTick } = await import("../server/schedules/dispatcher");

/** The schedules engine (docs/plan/WORKSPACE_MODULES.md §B.6, D808, T504). */

const iso = (ms: number) => new Date(ms).toISOString();

describe("rules (pure)", () => {
  test("cadence: weekdays at a wall time, across a DST change; every N weeks from an anchor", () => {
    // Europe/Berlin springs forward on 2026-03-29: 09:00 stays 09:00 local (08:00Z before, 07:00Z after).
    const fires = nextFires({ cadence: { weekdays: [1, 2, 3, 4, 5], at: "09:00" } }, "Europe/Berlin", Date.parse("2026-03-26T12:00:00Z"), 4).map(iso);
    expect(fires).toEqual(["2026-03-27T08:00:00.000Z", "2026-03-30T07:00:00.000Z", "2026-03-31T07:00:00.000Z", "2026-04-01T07:00:00.000Z"]);
    // A time the jump skips (02:30 on 2026-03-29) moves forward by the gap.
    expect(nextFires({ cadence: { weekdays: [0], at: "02:30" } }, "Europe/Berlin", Date.parse("2026-03-28T00:00:00Z")).map(iso)).toEqual(["2026-03-29T01:30:00.000Z"]);
    const biweekly = nextFires({ cadence: { weekdays: [1], at: "10:00", everyNWeeks: 2, anchor: "2026-01-05" } }, "UTC", Date.parse("2026-01-01T00:00:00Z"), 3).map(iso);
    expect(biweekly).toEqual(["2026-01-05T10:00:00.000Z", "2026-01-19T10:00:00.000Z", "2026-02-02T10:00:00.000Z"]);
  });

  test("once, everyMinutes, rrule, and invalid rules", () => {
    expect(nextFires({ once: "2026-05-01T10:00:00Z" }, "UTC", Date.parse("2026-04-01T00:00:00Z"))).toEqual([Date.parse("2026-05-01T10:00:00Z")]);
    expect(nextFires({ once: "2026-05-01T10:00:00Z" }, "UTC", Date.parse("2026-06-01T00:00:00Z"))).toEqual([]);
    expect(nextFires({ everyMinutes: 15 }, "UTC", Date.parse("2026-01-01T00:07:00Z"), 2).map(iso)).toEqual(["2026-01-01T00:15:00.000Z", "2026-01-01T00:30:00.000Z"]);
    expect(nextFires({ rrule: { rule: { freq: "monthly", interval: 1, count: 2 }, startLocal: "2026-01-31T09:00" } }, "UTC", Date.parse("2026-01-01T00:00:00Z"), 5).length).toBeGreaterThanOrEqual(1);
    expect(scheduleRuleProblem({ cadence: { weekdays: [], at: "09:00" } }, "UTC")).toBe("Choose at least one weekday");
    expect(scheduleRuleProblem({ everyMinutes: 1 }, "UTC")).toBe("Every 5 minutes to 7 days");
    expect(scheduleRuleProblem({ once: "2026-01-01T00:00:00Z" }, "Mars/Base")).toBe("Choose a valid time zone");
  });
});

describe("dispatcher (T504)", () => {
  const runs: string[] = [];
  const undo: Array<() => void> = [];
  beforeAll(() => {
    undo.push(registerScheduleHandler("schedtest.count", { run: (schedule, fireAt) => { runs.push(`${schedule.owner.id}@${fireAt}`); } }));
    undo.push(registerScheduleHandler("schedtest.fail", { run: () => { throw new Error("handler broke"); } }));
    undo.push(registerScheduleHandler("schedtest.late", { run: (schedule) => { runs.push(`late:${schedule.owner.id}`); }, skipIfLateMs: 60_000 }));
  });
  afterAll(() => { for (const fn of undo) fn(); });

  test("each occurrence runs once; a recurring schedule moves on; missed occurrences are not replayed one by one", async () => {
    const base = Date.parse("2030-01-07T08:00:00Z");
    const owner = { kind: "goal", id: crypto.randomUUID() };
    db.transaction(() => upsertSchedule(owner, "schedtest.count", { everyMinutes: 60 }, {}, { fromMs: base }))();
    expect(nextFireTimes({ everyMinutes: 60 }, "UTC", base, 2)).toEqual(["2030-01-07T09:00:00.000Z", "2030-01-07T10:00:00.000Z"]);
    await runScheduleTick({ nowMs: base + 3_600_000 + 1 });
    await runScheduleTick({ nowMs: base + 3_600_000 + 2 });
    expect(runs.filter((run) => run.startsWith(owner.id))).toEqual([`${owner.id}@2030-01-07T09:00:00.000Z`]);
    // Ten hours later: one run (the due one), and the next fire is after now.
    await runScheduleTick({ nowMs: base + 10 * 3_600_000 + 5 });
    expect(runs.filter((run) => run.startsWith(owner.id)).length).toBe(2);
    expect((db.query("SELECT next_fire_at FROM schedules WHERE owner_id = ?").get(owner.id) as { next_fire_at: string }).next_fire_at).toBe("2030-01-07T19:00:00.000Z");
    expect(cancelSchedules(owner)).toBe(1);
  });

  test("a crash between claim and finish never runs the occurrence again", async () => {
    const owner = { kind: "goal", id: crypto.randomUUID() };
    const fireAt = "2030-02-01T09:00:00.000Z";
    const schedule = db.transaction(() => upsertSchedule(owner, "schedtest.count", { once: fireAt }, {}, { fromMs: Date.parse("2030-01-31T00:00:00Z") }))();
    // A previous process claimed it and wrote the fire row, then died before running.
    db.query("UPDATE schedules SET claimed_at = ? WHERE id = ?").run("2030-02-01T09:00:01.000Z", schedule.id);
    db.query("INSERT INTO schedule_fires (schedule_id, fire_at, status, started_at) VALUES (?, ?, 'running', ?)").run(schedule.id, fireAt, "2030-02-01T09:00:01.000Z");
    const counts = await runScheduleTick({ nowMs: Date.parse("2030-02-01T09:10:00Z") });
    expect(counts?.duplicate).toBe(1);
    expect(runs.some((run) => run.startsWith(owner.id))).toBe(false);
    expect(db.query("SELECT next_fire_at, claimed_at FROM schedules WHERE id = ?").get(schedule.id)).toEqual({ next_fire_at: null, claimed_at: null });
  });

  test("a failing handler is recorded and the schedule moves on; a late occurrence past its window is skipped; paused schedules wait", async () => {
    const failing = { kind: "goal", id: crypto.randomUUID() };
    const late = { kind: "goal", id: crypto.randomUUID() };
    const paused = { kind: "goal", id: crypto.randomUUID() };
    const at = Date.parse("2030-03-01T09:00:00Z");
    db.transaction(() => {
      upsertSchedule(failing, "schedtest.fail", { once: iso(at) }, {}, { fromMs: at - 1000 });
      upsertSchedule(late, "schedtest.late", { once: iso(at) }, {}, { fromMs: at - 1000 });
      upsertSchedule(paused, "schedtest.count", { once: iso(at) }, {}, { fromMs: at - 1000 });
    })();
    setScheduleEnabled(paused, "schedtest.count", false, at - 1000);
    await runScheduleTick({ nowMs: at + 120_000 });
    const fire = (owner: { id: string }) => db.query("SELECT f.status, f.error FROM schedule_fires f JOIN schedules s ON s.id = f.schedule_id WHERE s.owner_id = ?").get(owner.id);
    expect(fire(failing)).toEqual({ status: "failed", error: "handler broke" });
    expect(fire(late)).toEqual({ status: "skipped_late", error: null });
    expect(fire(paused)).toBeNull();
    expect(runs.some((run) => run === `late:${late.id}`)).toBe(false);
  });
});
