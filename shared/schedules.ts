import { addDays, dateToDay, isValidTimeZone, nextOccurrence, normalizeRule, utcToZoned, zonedToUtc, type RecurrenceRule } from "./calendarRecurrence";

/**
 * Schedule rules (§B.6, D808): when something fires — a standup round opens, a poll closes, a booking
 * reminder goes out. One rule language for every module, run by the dispatcher in
 * server/schedules/dispatcher.ts; `nextFires` is pure so the UI can preview "Next: Mon 09:00, Tue 09:00".
 *
 * - `{ once }`: one instant (UTC ISO).
 * - `{ cadence }`: wall-clock `at` (HH:MM) on the chosen `weekdays` (0 = Sunday … 6 = Saturday), every
 *   `everyNWeeks` weeks counted from the week of `anchor` (a local date; default: every week).
 * - `{ rrule }`: a calendar recurrence (shared/calendarRecurrence.ts) from a local start `startLocal`.
 * - `{ everyMinutes }`: a fixed interval (5 minutes to 7 days), aligned to the epoch.
 *
 * Wall times are in the schedule's zone. DST behaves as the calendar's zonedToUtc: a time a jump
 * skips moves forward by the gap; a time that repeats fires once, at the earlier instant.
 */
export type CadenceRule = { weekdays: number[]; at: string; everyNWeeks?: number; anchor?: string };
export type ScheduleRule =
  | { once: string }
  | { cadence: CadenceRule }
  | { rrule: { rule: RecurrenceRule; startLocal: string } }
  | { everyMinutes: number };

export const MAX_NEXT_FIRES = 50;
const AT = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

/** A user-facing problem with the rule, or null when it is valid. */
export function scheduleRuleProblem(rule: unknown, tz: string): string | null {
  if (!isValidTimeZone(tz)) return "Choose a valid time zone";
  if (!rule || typeof rule !== "object") return "Choose when it runs";
  if ("once" in rule) return typeof rule.once === "string" && !Number.isNaN(Date.parse(rule.once)) ? null : "Choose a date and time";
  if ("everyMinutes" in rule) return Number.isInteger(rule.everyMinutes) && (rule.everyMinutes as number) >= 5 && (rule.everyMinutes as number) <= 10_080 ? null : "Every 5 minutes to 7 days";
  if ("cadence" in rule) {
    const cadence = rule.cadence as CadenceRule;
    if (!cadence || !Array.isArray(cadence.weekdays) || !cadence.weekdays.length || cadence.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return "Choose at least one weekday";
    if (!AT.test(cadence.at ?? "")) return "Choose a time of day (HH:MM)";
    if (cadence.everyNWeeks !== undefined && !(Number.isInteger(cadence.everyNWeeks) && cadence.everyNWeeks >= 1 && cadence.everyNWeeks <= 8)) return "Every 1 to 8 weeks";
    if (cadence.anchor !== undefined && !LOCAL_DATE.test(cadence.anchor)) return "Invalid start week";
    return null;
  }
  if ("rrule" in rule) {
    const value = rule.rrule as { rule?: RecurrenceRule; startLocal?: string };
    if (!value || !LOCAL_TIME.test(value.startLocal ?? "") || !value.rule) return "Choose a start and a repeat rule";
    try { normalizeRule(value.rule, { allDay: false, startLocal: value.startLocal!, tz, durationMinutes: 1 }); } catch (error) { return error instanceof Error ? error.message : "Invalid repeat rule"; }
    return null;
  }
  return "Choose when it runs";
}

const weekdayOfDate = (date: string) => new Date(dateToDay(date) * 86_400_000).getUTCDay();
/** Monday-based week number of a local date (for everyNWeeks). */
const weekNumber = (date: string) => Math.floor((dateToDay(date) + 3) / 7);

/**
 * The next `count` fire instants (UTC ms) strictly after `afterMs`. Empty for a rule that has ended
 * (a past `once`, an rrule past its count or until).
 */
export function nextFires(rule: ScheduleRule, tz: string, afterMs: number, count = 1): number[] {
  const wanted = Math.min(Math.max(1, count), MAX_NEXT_FIRES);
  if (scheduleRuleProblem(rule, tz)) return [];
  if ("once" in rule) {
    const at = Date.parse(rule.once);
    return at > afterMs ? [at] : [];
  }
  if ("everyMinutes" in rule) {
    const step = rule.everyMinutes * 60_000;
    const first = (Math.floor(afterMs / step) + 1) * step;
    return Array.from({ length: wanted }, (_, index) => first + index * step);
  }
  if ("cadence" in rule) {
    const { weekdays, at, everyNWeeks = 1 } = rule.cadence;
    const anchorWeek = weekNumber(rule.cadence.anchor ?? "1970-01-05");
    const fires: number[] = [];
    let date = addDays(utcToZoned(afterMs, tz).slice(0, 10), -1);
    for (let guard = 0; guard < 7 * everyNWeeks * (wanted + 2) + 14 && fires.length < wanted; guard += 1, date = addDays(date, 1)) {
      if (!weekdays.includes(weekdayOfDate(date))) continue;
      if (((weekNumber(date) - anchorWeek) % everyNWeeks + everyNWeeks) % everyNWeeks !== 0) continue;
      const instant = zonedToUtc(`${date}T${at}`, tz);
      if (instant > afterMs && !fires.includes(instant)) fires.push(instant);
    }
    return fires;
  }
  const series = { allDay: false as const, startLocal: rule.rrule.startLocal, tz, durationMinutes: 1, rule: rule.rrule.rule };
  const fires: number[] = [];
  let from = afterMs + 1;
  for (let guard = 0; guard < wanted; guard += 1) {
    const next = nextOccurrence(series, from, tz);
    if (!next) break;
    fires.push(next.startMs);
    from = next.startMs + 1;
  }
  return fires;
}

/** The next fire after `afterMs`, as an ISO string, or null. */
export function nextFireIso(rule: ScheduleRule, tz: string, afterMs: number): string | null {
  const [next] = nextFires(rule, tz, afterMs, 1);
  return next === undefined ? null : new Date(next).toISOString();
}
