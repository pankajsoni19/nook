import { db } from "../db";
import { listOccurrences } from "../calendar/service";
import { addDays, rangeFor, utcToZoned, zonedToUtc } from "../../shared/calendarRecurrence";
import { computeSlots, type HeldBooking, type Interval, type ScheduleInput } from "../../shared/bookings";
import { durationsOf, hostsOf, invalid, parseJson, type HostRow, type ScheduleRow, type TypeRow } from "./model";
import { ensureDefaultSchedule, profileRow, scheduleInput } from "./setup";
import { feedBusy, refreshStaleFeeds } from "./feeds";

/**
 * Availability (D1000, D1005): per host, the schedule's open ranges minus busy time (the host's
 * chosen Nook calendars, recurring events expanded, all-day events when the type says so, plus their
 * outside ICS feeds) minus their live bookings with buffers, then notice, horizon, and limits
 * (shared/bookings.ts computeSlots). Round robin offers a slot when any host is free; collective
 * when all are. All math is in UTC instants; zones only shape the schedule's wall times (T581).
 */

export type HostPlan = { userId: string; priority: number; calendarId: string | null; schedule: ScheduleInput };
export type SlotMap = Map<number, string[]>;

/** The schedule a host uses for this type: their row's, else (single type) the type's, else their default. */
function hostSchedule(type: TypeRow, host: HostRow): ScheduleRow {
  const pick = (id: string | null) => id ? db.query("SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?").get(id, host.user_id) as ScheduleRow | null : null;
  return pick(host.schedule_id) ?? (host.user_id === type.owner_id ? pick(type.schedule_id) : null) ?? ensureDefaultSchedule(host.user_id);
}

/** A team member who can host: not blocked, and an admin or member (D1029). */
export const ownerActive = (userId: string) => Boolean(db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL AND role IN ('admin','member')").get(userId));

export function hostPlans(type: TypeRow): HostPlan[] {
  const hosts = hostsOf(type.id);
  const list = type.assignment === "single" ? hosts.filter((host) => host.user_id === type.owner_id) : hosts;
  const live = list.filter((host) => ownerActive(host.user_id));
  // A single type falls back to its owner only while the owner can host; a blocked owner has no slots (D1029).
  const fallback: HostRow[] = live.length ? live : type.assignment === "single" && ownerActive(type.owner_id) ? [{ type_id: type.id, user_id: type.owner_id, priority: 0, calendar_id: null, schedule_id: null }] : [];
  return fallback.map((host) => ({ userId: host.user_id, priority: host.priority, calendarId: host.calendar_id, schedule: scheduleInput(hostSchedule(type, host)) }));
}

/** The calendars whose events block a host: the type's choice for its owner, else their profile's, else every calendar they own. */
function busyCalendars(type: TypeRow, userId: string): string[] {
  const own = (db.query("SELECT id FROM calendars WHERE owner_id = ? AND deleted_at IS NULL").all(userId) as Array<{ id: string }>).map((row) => row.id);
  const typeChoice = userId === type.owner_id ? parseJson<string[]>(type.busy_calendar_ids_json, []) : [];
  if (typeChoice.length) return typeChoice;
  const profile = profileRow(userId);
  const chosen = profile ? parseJson<string[]>(profile.busy_calendar_ids_json, []) : [];
  return chosen.length ? chosen : own;
}

/** Busy intervals of a host's calendars; events made for bookings are left out (the bookings count, with their buffers). */
export function calendarBusy(type: TypeRow, userId: string, fromMs: number, toMs: number, tz: string): Interval[] {
  const calendars = busyCalendars(type, userId);
  if (!calendars.length) return [];
  const fromDate = utcToZoned(fromMs, "UTC").slice(0, 10);
  const toDate = addDays(utcToZoned(toMs, "UTC").slice(0, 10), 1);
  const out: Interval[] = [];
  const { occurrences } = listOccurrences(userId, rangeFor(fromDate, toDate, "UTC"), calendars);
  const ids = [...new Set(occurrences.map((occurrence) => occurrence.eventId))];
  const excluded = new Set(ids.length ? (db.query("SELECT event_id FROM booking_events WHERE event_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as Array<{ event_id: string }>).map((row) => row.event_id) : []);
  for (const occurrence of occurrences) {
    // Events made for bookings are counted as the bookings themselves (with their buffers), never twice.
    if (excluded.has(occurrence.eventId)) continue;
    if (occurrence.allDay) {
      if (type.include_all_day_busy !== 1) continue;
      out.push({ start: zonedToUtc(`${occurrence.start}T00:00`, tz), end: zonedToUtc(`${occurrence.end}T00:00`, tz) });
    } else out.push({ start: Date.parse(occurrence.start), end: Date.parse(occurrence.end) });
  }
  return out;
}

/** Live bookings a host holds (as lead or co-host) around the window, except `excludeBookingId`. */
export function heldBookings(userId: string, fromMs: number, toMs: number, excludeBookingId: string | null): HeldBooking[] {
  const lower = new Date(fromMs - 8 * 86_400_000).toISOString();
  const upper = new Date(toMs + 8 * 86_400_000).toISOString();
  const rows = db.query(`SELECT id, type_id, start_utc, end_utc, buffer_before_min, buffer_after_min FROM bookings
    WHERE status IN ('pending','confirmed') AND start_utc < ? AND end_utc > ? AND (host_id = ? OR id IN (SELECT booking_id FROM booking_cohosts WHERE user_id = ?))`)
    .all(upper, lower, userId, userId) as Array<{ id: string; type_id: string | null; start_utc: string; end_utc: string; buffer_before_min: number; buffer_after_min: number }>;
  return rows.filter((row) => row.id !== excludeBookingId).map((row) => ({ start: Date.parse(row.start_utc), end: Date.parse(row.end_utc), bufferBefore: row.buffer_before_min, bufferAfter: row.buffer_after_min, typeId: row.type_id }));
}

export type SlotQuery = { fromMs: number; toMs: number; durationMin: number; nowMs: number; excludeBookingId?: string | null };

/** Bookable starts → the hosts free at each (round robin: any; collective: all; single: the owner). Synchronous: feeds come from their cache. */
export function slotHosts(type: TypeRow, query: SlotQuery): SlotMap {
  if (!durationsOf(type).includes(query.durationMin)) throw invalid("Choose one of the type's durations", { field: "duration" });
  const plans = hostPlans(type);
  const perHost = plans.map((plan) => {
    const busy = [...calendarBusy(type, plan.userId, query.fromMs - 86_400_000, query.toMs + 86_400_000, plan.schedule.tz),
      ...feedBusy(plan.userId, query.fromMs - 86_400_000, query.toMs + 86_400_000, type.include_all_day_busy === 1)];
    const slots = computeSlots(plan.schedule, {
      durationMin: query.durationMin, intervalMin: type.slot_interval_min, bufferBeforeMin: type.buffer_before_min, bufferAfterMin: type.buffer_after_min,
      minNoticeMin: type.min_notice_min, maxDaysAhead: type.max_days_ahead, dateFrom: type.date_from, dateTo: type.date_to, dailyLimit: type.daily_limit,
      weeklyLimit: type.weekly_limit, typeId: type.id
    }, { busy, held: heldBookings(plan.userId, query.fromMs, query.toMs, query.excludeBookingId ?? null), nowMs: query.nowMs, fromMs: query.fromMs, toMs: query.toMs });
    return { userId: plan.userId, slots };
  });
  const map: SlotMap = new Map();
  if (type.assignment === "collective") {
    if (!perHost.length) return map;
    const [first, ...rest] = perHost;
    const sets = rest.map((host) => new Set(host.slots));
    for (const slot of first!.slots) if (sets.every((set) => set.has(slot))) map.set(slot, perHost.map((host) => host.userId));
    return map;
  }
  for (const host of perHost) for (const slot of host.slots) map.set(slot, [...(map.get(slot) ?? []), host.userId]);
  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
}

/** Refreshes stale outside feeds of the type's hosts (bounded wait), then answers slotHosts. */
export async function availability(type: TypeRow, query: SlotQuery): Promise<SlotMap> {
  await refreshStaleFeeds(hostPlans(type).map((plan) => plan.userId), query.nowMs);
  return slotHosts(type, query);
}

/**
 * Round robin (D1005): among the free hosts, the one with the fewest bookings of this type in the
 * last 30 days; ties by priority (higher first), then the least recently booked.
 */
export function pickRoundRobin(type: TypeRow, free: readonly string[], nowMs: number): string {
  if (free.length === 1) return free[0]!;
  const since = new Date(nowMs - 30 * 86_400_000).toISOString();
  const priority = new Map(hostsOf(type.id).map((host) => [host.user_id, host.priority]));
  const stats = free.map((userId) => {
    const row = db.query("SELECT COUNT(*) AS count, MAX(created_at) AS last FROM bookings WHERE type_id = ? AND host_id = ? AND created_at > ? AND status NOT IN ('declined','expired')").get(type.id, userId, since) as { count: number; last: string | null };
    return { userId, count: row.count, last: row.last ?? "", priority: priority.get(userId) ?? 0 };
  });
  stats.sort((a, b) => a.count - b.count || b.priority - a.priority || a.last.localeCompare(b.last) || a.userId.localeCompare(b.userId));
  return stats[0]!.userId;
}
