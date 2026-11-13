import { addDays, dateToDay, isValidDate, isValidTimeZone, utcToZoned, weekdayIndex, zonedToUtc } from "./calendarRecurrence";

/**
 * Bookings (docs/plan/WORKSPACE_MODULES.md §D.6): the words both sides need and the pure slot math
 * (D1000). Everything here is a pure function of its inputs, so the server (authoritative) and the
 * tests (the zone/DST matrix with a fixed clock) run the same code.
 *
 * Times: instants are UTC milliseconds or ISO strings; wall times are `HH:MM` in a schedule's zone;
 * dates are local `yyyy-mm-dd` in the schedule's zone. Weekly rules are keyed `mon`…`sun`.
 */

export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekdayKey = typeof WEEKDAY_KEYS[number];
export type TimeRange = { from: string; to: string };
export type WeeklyRules = Partial<Record<WeekdayKey, TimeRange[]>>;

export const LOCATION_KINDS = ["video_link", "phone", "in_person", "custom", "ask"] as const;
export type LocationKind = typeof LOCATION_KINDS[number];
export const LOCATION_LABELS: Record<LocationKind, string> = {
  video_link: "Video call", phone: "Phone call", in_person: "In person", custom: "Custom", ask: "Booker chooses"
};
export const ASSIGNMENTS = ["single", "round_robin", "collective"] as const;
export type Assignment = typeof ASSIGNMENTS[number];
export const ASSIGNMENT_LABELS: Record<Assignment, string> = { single: "Just me", round_robin: "Round robin", collective: "Everyone (collective)" };
export const BOOKING_STATUSES = ["pending", "confirmed", "cancelled", "declined", "expired", "completed", "no_show"] as const;
export type BookingStatus = typeof BOOKING_STATUSES[number];
export const LIVE_STATUSES: readonly BookingStatus[] = ["pending", "confirmed"];
export const STATUS_LABELS: Record<BookingStatus, string> = {
  pending: "Awaiting approval", confirmed: "Confirmed", cancelled: "Cancelled", declined: "Declined", expired: "Expired", completed: "Completed", no_show: "No-show"
};
export const STATUS_TONES: Record<BookingStatus, "success" | "warning" | "danger" | "info" | "neutral"> = {
  pending: "warning", confirmed: "success", cancelled: "neutral", declined: "danger", expired: "neutral", completed: "info", no_show: "danger"
};
export const SLOT_INTERVALS = [5, 10, 15, 20, 30, 60] as const;
export const BOOKING_SOURCES = ["public", "secret_link", "internal", "mcp"] as const;
export type BookingSource = typeof BOOKING_SOURCES[number];

/** Limits (D1000, T575): a slot request spans at most 62 days in the app, 31 on public pages. */
export const MAX_SLOT_WINDOW_DAYS = 62;
export const MAX_PUBLIC_SLOT_DAYS = 31;
export const MAX_DURATIONS = 6;
export const MAX_GUESTS = 10;
export const MAX_HOSTS = 20;
export const MAX_REMINDERS = 3;
export const MAX_RANGES_PER_DAY = 8;
/** Per booker email: at most this many upcoming bookings per type (§B.8). */
export const UPCOMING_PER_EMAIL = 3;
/** Handles (D1006): lower-case letters, digits, hyphens, 3–30 characters, not starting or ending with a hyphen. */
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
export const RESERVED_HANDLES = new Set(["admin", "administrator", "api", "app", "book", "booking", "bookings", "help", "link", "links", "login", "logout", "manage",
  "me", "new", "nook", "null", "p", "root", "security", "settings", "signin", "signup", "support", "system", "team", "undefined", "www", "verify", "staff", "official"]);
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
export const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
export const timeOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** A problem with one day's ranges (sorted, non-overlapping, from < to), or null. */
export function rangesProblem(ranges: unknown): string | null {
  if (!Array.isArray(ranges)) return "Ranges must be a list";
  if (ranges.length > MAX_RANGES_PER_DAY) return `At most ${MAX_RANGES_PER_DAY} ranges a day`;
  let last = -1;
  for (const range of ranges as TimeRange[]) {
    if (!range || typeof range.from !== "string" || typeof range.to !== "string" || !TIME.test(range.from) || !TIME.test(range.to) || range.from === "24:00") return "Use times like 09:00";
    const from = minutesOf(range.from);
    const to = minutesOf(range.to);
    if (to <= from) return "Each range must end after it starts";
    if (from < last) return "Ranges must not overlap";
    last = to;
  }
  return null;
}

/** Sorts each day's ranges; refuses an invalid rule set (throws a plain Error with a user-facing message). */
export function normalizeWeekly(rules: unknown): WeeklyRules {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw new Error("Weekly hours are invalid");
  const out: WeeklyRules = {};
  for (const [key, value] of Object.entries(rules as Record<string, unknown>)) {
    if (!(WEEKDAY_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown day ${key}`);
    const sorted = Array.isArray(value) ? [...(value as TimeRange[])].sort((a, b) => (a?.from ?? "").localeCompare(b?.from ?? "")) : value;
    const problem = rangesProblem(sorted);
    if (problem) throw new Error(problem);
    if ((sorted as TimeRange[]).length) out[key as WeekdayKey] = (sorted as TimeRange[]).map((range) => ({ from: range.from, to: range.to }));
  }
  return out;
}

export const DEFAULT_WEEKLY: WeeklyRules = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((day) => [day, [{ from: "09:00", to: "17:00" }]])) as WeeklyRules;

export type ScheduleInput = { tz: string; weekly: WeeklyRules; overrides: Record<string, TimeRange[] | null> };
export type Interval = { start: number; end: number };
/** An existing booking of the host: its time and its own buffers (D1012). */
export type HeldBooking = Interval & { bufferBefore: number; bufferAfter: number; typeId: string | null };

export type SlotRules = {
  durationMin: number;
  intervalMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxDaysAhead: number;
  dateFrom?: string | null;
  dateTo?: string | null;
  dailyLimit?: number | null;
  weeklyLimit?: number | null;
  /** The type the limits count (bookings of other types never count against them). */
  typeId?: string | null;
};

const MINUTE = 60_000;
const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;
const localDate = (ms: number, tz: string) => utcToZoned(ms, tz).slice(0, 10);
/** Monday of the local date's week. */
export const weekOf = (date: string) => addDays(date, -weekdayIndex(dateToDay(date)));

/** The open intervals of one local date: its override if any (null = closed), else its weekday's ranges. */
export function dayIntervals(schedule: ScheduleInput, date: string): Interval[] {
  const ranges = Object.hasOwn(schedule.overrides, date) ? schedule.overrides[date] ?? [] : schedule.weekly[WEEKDAY_KEYS[weekdayIndex(dateToDay(date))]!] ?? [];
  return ranges.map((range) => ({
    start: zonedToUtc(`${date}T${range.from}`, schedule.tz),
    end: range.to === "24:00" ? zonedToUtc(`${addDays(date, 1)}T00:00`, schedule.tz) : zonedToUtc(`${date}T${range.to}`, schedule.tz)
  })).filter((interval) => interval.end > interval.start);
}

/**
 * Bookable starts (UTC ms, ascending) within [fromMs, toMs) for one host (D1000):
 * schedule ranges in the schedule's zone (candidates step by the interval in wall-clock time from
 * each range's start, so 09:00, 09:30 … stay on the clock across DST), minus busy time with this
 * type's buffers around the slot, minus held bookings (a held booking's own buffers count too, so
 * the gap is the larger of the two), then notice, horizon, date range, and daily/weekly limits.
 */
export function computeSlots(schedule: ScheduleInput, rules: SlotRules, input: { busy: readonly Interval[]; held: readonly HeldBooking[]; nowMs: number; fromMs: number; toMs: number }): number[] {
  if (!isValidTimeZone(schedule.tz)) return [];
  const duration = rules.durationMin * MINUTE;
  const before = rules.bufferBeforeMin * MINUTE;
  const after = rules.bufferAfterMin * MINUTE;
  const earliest = Math.max(input.fromMs, input.nowMs + rules.minNoticeMin * MINUTE);
  const today = localDate(input.nowMs, schedule.tz);
  const lastDate = addDays(today, rules.maxDaysAhead);
  const busy = [...input.busy].sort((a, b) => a.start - b.start);
  const held = input.held;
  const perDay = new Map<string, number>();
  const perWeek = new Map<string, number>();
  const counted = held.filter((booking) => !rules.typeId || booking.typeId === rules.typeId);
  for (const booking of counted) {
    const date = localDate(booking.start, schedule.tz);
    perDay.set(date, (perDay.get(date) ?? 0) + 1);
    perWeek.set(weekOf(date), (perWeek.get(weekOf(date)) ?? 0) + 1);
  }
  const out = new Set<number>();
  let date = localDate(input.fromMs - 86_400_000, schedule.tz);
  const endDate = localDate(input.toMs + 86_400_000, schedule.tz);
  for (let guard = 0; date <= endDate && guard < 400; guard += 1, date = addDays(date, 1)) {
    if (date < today || date > lastDate) continue;
    if (rules.dateFrom && date < rules.dateFrom) continue;
    if (rules.dateTo && date > rules.dateTo) continue;
    if (rules.dailyLimit && (perDay.get(date) ?? 0) >= rules.dailyLimit) continue;
    if (rules.weeklyLimit && (perWeek.get(weekOf(date)) ?? 0) >= rules.weeklyLimit) continue;
    const ranges = Object.hasOwn(schedule.overrides, date) ? schedule.overrides[date] ?? [] : schedule.weekly[WEEKDAY_KEYS[weekdayIndex(dateToDay(date))]!] ?? [];
    for (const range of ranges) {
      const rangeEnd = range.to === "24:00" ? zonedToUtc(`${addDays(date, 1)}T00:00`, schedule.tz) : zonedToUtc(`${date}T${range.to}`, schedule.tz);
      const endMinute = range.to === "24:00" ? 1440 : minutesOf(range.to);
      for (let minute = minutesOf(range.from); minute + rules.durationMin <= endMinute; minute += rules.intervalMin) {
        if (minute >= 1440) break;
        const start = zonedToUtc(`${date}T${timeOf(minute)}`, schedule.tz);
        const end = start + duration;
        // A wall time a DST jump skipped lands later; it must still fit the range and be on this date.
        if (end > rangeEnd || localDate(start, schedule.tz) !== date) continue;
        if (start < earliest || start >= input.toMs) continue;
        const padded = { start: start - before, end: end + after };
        if (busy.some((interval) => overlaps(padded, interval))) continue;
        if (held.some((booking) => overlaps(padded, booking) || overlaps({ start, end }, { start: booking.start - booking.bufferBefore * MINUTE, end: booking.end + booking.bufferAfter * MINUTE }))) continue;
        out.add(start);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Groups slot instants by the viewer's local date (the public page's month view and time list). */
export function slotsByDate(slots: readonly number[], tz: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const slot of slots) (out[localDate(slot, tz)] ??= []).push(new Date(slot).toISOString());
  return out;
}

/** Whole local dates [from, to) for a request, checked: real dates, ascending, at most `maxDays`. */
export function windowProblem(from: string, to: string, maxDays: number): string | null {
  if (!isValidDate(from) || !isValidDate(to)) return "Enter real dates";
  const days = dateToDay(to) - dateToDay(from);
  if (days < 1) return "The range ends after it starts";
  if (days > maxDays) return `Ask for at most ${maxDays} days at a time`;
  return null;
}

export type ReminderSettings = { offsets: number[]; booker: boolean; host: boolean };
export const DEFAULT_REMINDERS: ReminderSettings = { offsets: [1440, 60], booker: true, host: true };

export type CardTemplate = { boardId: string; columnId: string; titleTemplate: string; assignHost: boolean };
export const DEFAULT_CARD_TITLE = "Prepare: {{type}} with {{name}}";
/** Fills `{{type}}`, `{{name}}`, `{{email}}`, `{{date}}` in a card title (≤ 200 characters). */
export const fillTemplate = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{\s*(type|name|email|date)\s*\}\}/g, (_all, key: string) => values[key] ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "Booking";

/** "Tue 3 Mar, 09:30–10:00 (Europe/Berlin)" for mail and the confirmation page. */
export function formatWhen(startIso: string, endIso: string, tz: string, locale = "en-GB") {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${day}, ${time.format(start)}–${time.format(end)} (${tz.replace(/_/g, " ")})`;
}

export type PublicTypeSummary = {
  slug: string; title: string; description: string; durations: number[]; locationKind: LocationKind; color: string;
};
export type PublicSlots = { tz: string; durations: number[]; duration: number; days: Record<string, string[]> };
