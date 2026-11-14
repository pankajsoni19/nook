import { describe, expect, test } from "bun:test";
import { computeSlots, dayIntervals, normalizeWeekly, slotsByDate, weekOf, windowProblem, type ScheduleInput, type SlotRules } from "../shared/bookings";
import { utcToZoned, zonedToUtc } from "../shared/calendarRecurrence";

/**
 * The slot math (D1000) with a fixed clock: zones, DST transitions in both hemispheres, overrides,
 * buffers, notice, horizon, date ranges, and daily/weekly limits. Pure: no server.
 */

const weekdays = (from: string, to: string) => Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((day) => [day, [{ from, to }]]));
const rules = (over: Partial<SlotRules> = {}): SlotRules => ({ durationMin: 30, intervalMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxDaysAhead: 365, ...over });
const local = (ms: number, tz: string) => utcToZoned(ms, tz);
const run = (schedule: ScheduleInput, slotRules: SlotRules, nowIso: string, fromIso: string, toIso: string, extra: { busy?: Array<[string, string]>; held?: Array<[string, string, number, number]> } = {}) =>
  computeSlots(schedule, slotRules, {
    nowMs: Date.parse(nowIso), fromMs: Date.parse(fromIso), toMs: Date.parse(toIso),
    busy: (extra.busy ?? []).map(([start, end]) => ({ start: Date.parse(start), end: Date.parse(end) })),
    held: (extra.held ?? []).map(([start, end, before, after]) => ({ start: Date.parse(start), end: Date.parse(end), bufferBefore: before, bufferAfter: after, typeId: "t" }))
  });

describe("weekly rules", () => {
  test("normalizes, sorts, and refuses overlaps and bad times", () => {
    expect(normalizeWeekly({ mon: [{ from: "13:00", to: "17:00" }, { from: "09:00", to: "12:00" }] })).toEqual({ mon: [{ from: "09:00", to: "12:00" }, { from: "13:00", to: "17:00" }] });
    expect(() => normalizeWeekly({ mon: [{ from: "09:00", to: "12:00" }, { from: "11:00", to: "13:00" }] })).toThrow("overlap");
    expect(() => normalizeWeekly({ mon: [{ from: "12:00", to: "09:00" }] })).toThrow("end after");
    expect(() => normalizeWeekly({ funday: [] })).toThrow("Unknown day");
    expect(normalizeWeekly({ sun: [{ from: "22:00", to: "24:00" }] })).toEqual({ sun: [{ from: "22:00", to: "24:00" }] });
  });
  test("windows and weeks", () => {
    expect(windowProblem("2026-03-01", "2026-04-15", 31)).toContain("31");
    expect(windowProblem("2026-03-02", "2026-03-01", 31)).toContain("ends after");
    expect(weekOf("2026-11-15")).toBe("2026-11-09");
  });
});

// Zones × a plain week: every slot is on the hour or half hour in the schedule's zone, within 09:00–17:00.
const ZONES = ["UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Australia/Sydney", "Pacific/Auckland", "America/St_Johns", "Asia/Kathmandu", "Pacific/Chatham"];
describe.each(ZONES)("zone %s", (tz) => {
  test("slots sit on the schedule's wall clock, 16 a weekday", () => {
    const schedule: ScheduleInput = { tz, weekly: weekdays("09:00", "17:00"), overrides: {} };
    const from = zonedToUtc("2026-06-08T00:00", tz);
    const slots = computeSlots(schedule, rules(), { busy: [], held: [], nowMs: from - 86_400_000, fromMs: from, toMs: zonedToUtc("2026-06-13T00:00", tz) });
    expect(slots.length).toBe(5 * 16);
    for (const slot of slots) {
      const time = local(slot, tz).slice(11);
      expect(time >= "09:00" && time <= "16:30").toBe(true);
      expect(["00", "30"]).toContain(time.slice(3));
    }
    const days = slotsByDate(slots, tz);
    expect(Object.keys(days)).toEqual(["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12"]);
  });
});

describe("DST", () => {
  test("Europe/Berlin spring forward: wall clock kept, UTC shifts by an hour", () => {
    const schedule: ScheduleInput = { tz: "Europe/Berlin", weekly: { fri: [{ from: "09:00", to: "10:00" }], mon: [{ from: "09:00", to: "10:00" }] }, overrides: {} };
    const slots = run(schedule, rules(), "2026-03-20T00:00:00Z", "2026-03-27T00:00:00Z", "2026-03-31T00:00:00Z");
    expect(slots.map((ms) => new Date(ms).toISOString())).toEqual(["2026-03-27T08:00:00.000Z", "2026-03-27T08:30:00.000Z", "2026-03-30T07:00:00.000Z", "2026-03-30T07:30:00.000Z"]);
  });
  test("a range across the spring gap loses the missing hour; nothing is offered twice", () => {
    const schedule: ScheduleInput = { tz: "Europe/Berlin", weekly: { sun: [{ from: "01:00", to: "04:00" }] }, overrides: {} };
    const slots = run(schedule, rules({ intervalMin: 30 }), "2026-03-20T00:00:00Z", "2026-03-28T00:00:00Z", "2026-03-30T00:00:00Z");
    const times = slots.map((ms) => local(ms, "Europe/Berlin").slice(11));
    // 02:00 and 02:30 do not exist on 29 March 2026 in Berlin.
    expect(times).toEqual(["01:00", "01:30", "03:00", "03:30"]);
    expect(new Set(slots).size).toBe(slots.length);
  });
  test("fall back: the repeated hour is offered once per wall time (earlier instant)", () => {
    const schedule: ScheduleInput = { tz: "America/New_York", weekly: { sun: [{ from: "00:30", to: "02:30" }] }, overrides: {} };
    const slots = run(schedule, rules(), "2026-10-20T00:00:00Z", "2026-11-01T00:00:00Z", "2026-11-03T00:00:00Z");
    const times = slots.map((ms) => local(ms, "America/New_York").slice(11));
    expect(times).toEqual(["00:30", "01:00", "01:30", "02:00"]);
    // 01:00 and 01:30 resolve to the EDT (earlier) instants.
    expect(new Date(slots[1]!).toISOString()).toBe("2026-11-01T05:00:00.000Z");
  });
  test("southern hemisphere (Sydney, April fall back) keeps 09:00 local", () => {
    const schedule: ScheduleInput = { tz: "Australia/Sydney", weekly: weekdays("09:00", "09:30"), overrides: {} };
    const slots = run(schedule, rules(), "2026-03-30T00:00:00Z", "2026-04-01T00:00:00Z", "2026-04-08T00:00:00Z");
    expect(slots.map((ms) => local(ms, "Australia/Sydney").slice(11))).toEqual(Array(slots.length).fill("09:00"));
    expect(new Date(slots[0]!).toISOString()).toBe("2026-04-01T22:00:00.000Z"); // 2 April, AEDT (+11)
    expect(new Date(slots.at(-1)!).toISOString()).toBe("2026-04-07T23:00:00.000Z"); // 8 April, AEST (+10)
  });
  test("a booker in another zone sees the same instants on their own dates", () => {
    const schedule: ScheduleInput = { tz: "Asia/Kolkata", weekly: weekdays("09:00", "10:00"), overrides: {} };
    const slots = run(schedule, rules(), "2026-06-01T00:00:00Z", "2026-06-08T00:00:00Z", "2026-06-09T00:00:00Z");
    expect(slotsByDate(slots, "America/Los_Angeles")).toEqual({ "2026-06-07": ["2026-06-08T03:30:00.000Z", "2026-06-08T04:00:00.000Z"] });
  });
});

describe("rules", () => {
  const schedule: ScheduleInput = { tz: "UTC", weekly: weekdays("09:00", "12:00"), overrides: {} };
  const day = ["2026-06-08T00:00:00Z", "2026-06-09T00:00:00Z"] as const;
  test("overrides close a day or replace its hours", () => {
    expect(run({ ...schedule, overrides: { "2026-06-08": null } }, rules(), "2026-06-01T00:00:00Z", ...day)).toEqual([]);
    const custom = run({ ...schedule, overrides: { "2026-06-08": [{ from: "15:00", to: "16:00" }] } }, rules(), "2026-06-01T00:00:00Z", ...day);
    expect(custom.map((ms) => new Date(ms).toISOString().slice(11, 16))).toEqual(["15:00", "15:30"]);
    const saturday = run({ ...schedule, overrides: { "2026-06-13": [{ from: "10:00", to: "11:00" }] } }, rules(), "2026-06-01T00:00:00Z", "2026-06-13T00:00:00Z", "2026-06-14T00:00:00Z");
    expect(saturday.length).toBe(2);
  });
  test("busy time with buffers around the slot", () => {
    const slots = run(schedule, rules({ bufferBeforeMin: 10, bufferAfterMin: 10 }), "2026-06-01T00:00:00Z", ...day, { busy: [["2026-06-08T10:00:00Z", "2026-06-08T10:30:00Z"]] });
    // 09:30 ends 10:00 + 10 min buffer → clashes; 10:30 starts after busy but its 10 min before-buffer clashes.
    expect(slots.map((ms) => new Date(ms).toISOString().slice(11, 16))).toEqual(["09:00", "11:00", "11:30"]);
  });
  test("held bookings: the gap is the larger of the two buffers", () => {
    const slots = run(schedule, rules({ bufferBeforeMin: 0 }), "2026-06-01T00:00:00Z", ...day, { held: [["2026-06-08T10:00:00Z", "2026-06-08T10:30:00Z", 0, 30]] });
    expect(slots.map((ms) => new Date(ms).toISOString().slice(11, 16))).toEqual(["09:00", "09:30", "11:00", "11:30"]);
  });
  test("minimum notice, horizon, and date range", () => {
    expect(run(schedule, rules({ minNoticeMin: 120 }), "2026-06-08T08:30:00Z", ...day).map((ms) => new Date(ms).toISOString().slice(11, 16))).toEqual(["10:30", "11:00", "11:30"]);
    expect(run(schedule, rules({ maxDaysAhead: 3 }), "2026-06-05T12:00:00Z", "2026-06-05T00:00:00Z", "2026-06-12T00:00:00Z").length).toBe(6); // Mon 8 only (Fri 5 after noon, weekend closed)
    expect(run(schedule, rules({ dateFrom: "2026-06-09", dateTo: "2026-06-09" }), "2026-06-01T00:00:00Z", "2026-06-08T00:00:00Z", "2026-06-12T00:00:00Z").length).toBe(6);
  });
  test("daily and weekly limits count this type's held bookings", () => {
    const held: Array<[string, string, number, number]> = [["2026-06-08T09:00:00Z", "2026-06-08T09:30:00Z", 0, 0]];
    expect(run(schedule, rules({ dailyLimit: 1, typeId: "t" }), "2026-06-01T00:00:00Z", ...day, { held })).toEqual([]);
    expect(run(schedule, rules({ weeklyLimit: 1, typeId: "t" }), "2026-06-01T00:00:00Z", "2026-06-08T00:00:00Z", "2026-06-13T00:00:00Z", { held }).length).toBe(0);
    expect(run(schedule, rules({ weeklyLimit: 1, typeId: "t" }), "2026-06-01T00:00:00Z", "2026-06-15T00:00:00Z", "2026-06-16T00:00:00Z", { held }).length).toBe(6);
  });
  test("durations that do not fit the range are not offered; intervals step from the range start", () => {
    const slots = run({ tz: "UTC", weekly: { mon: [{ from: "09:15", to: "10:30" }] }, overrides: {} }, rules({ durationMin: 45, intervalMin: 15 }), "2026-06-01T00:00:00Z", ...day);
    expect(slots.map((ms) => new Date(ms).toISOString().slice(11, 16))).toEqual(["09:15", "09:30", "09:45"]);
  });
  test("a range to midnight (24:00)", () => {
    const slots = run({ tz: "Europe/Berlin", weekly: { mon: [{ from: "23:00", to: "24:00" }] }, overrides: {} }, rules(), "2026-06-01T00:00:00Z", "2026-06-08T00:00:00Z", "2026-06-10T00:00:00Z");
    expect(slots.map((ms) => local(ms, "Europe/Berlin"))).toEqual(["2026-06-08T23:00", "2026-06-08T23:30"]);
    expect(dayIntervals({ tz: "UTC", weekly: { mon: [{ from: "22:00", to: "24:00" }] }, overrides: {} }, "2026-06-08")).toEqual([{ start: Date.parse("2026-06-08T22:00:00Z"), end: Date.parse("2026-06-09T00:00:00Z") }]);
  });
});
