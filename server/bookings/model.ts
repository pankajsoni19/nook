import { db } from "../db";
import { itemLevel, readableContainerSql } from "../access/workspaceItems";
import { LEVEL_RANK, type ItemLevel } from "../access/levels";
import { isShortId, shortIdOfSegment, slugSegment } from "../../shared/friendlyUrls";
import { DEFAULT_REMINDERS, type Assignment, type BookingSource, type BookingStatus, type CardTemplate, type LocationKind, type ReminderSettings, type TimeRange, type WeeklyRules } from "../../shared/bookings";

/** Rows, errors, and access helpers of the Bookings module (§D.6). */

export class BookingError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}
export const notFound = (what = "Booking") => new BookingError(404, "NOT_FOUND", `${what} not found`);
export const invalid = (message: string, details?: Record<string, unknown>) => new BookingError(400, "INVALID", message, details);

export type ProfileRow = { user_id: string; handle: string; display_name: string; welcome_md: string; tz: string; enabled: number; busy_calendar_ids_json: string; created_at: string; updated_at: string };
export type ScheduleRow = { id: string; user_id: string; name: string; tz: string; rules_json: string; is_default: number; created_at: string; updated_at: string };
export type OverrideRow = { id: string; schedule_id: string; date: string; ranges_json: string | null; note: string };
export type TypeRow = {
  id: string; short_id: string; owner_id: string; slug: string; title: string; description_md: string; durations_json: string; location_kind: LocationKind; location_value: string;
  assignment: Assignment; schedule_id: string | null; calendar_id: string | null; busy_calendar_ids_json: string; include_all_day_busy: number; buffer_before_min: number;
  buffer_after_min: number; min_notice_min: number; max_days_ahead: number; date_from: string | null; date_to: string | null; slot_interval_min: number;
  daily_limit: number | null; weekly_limit: number | null; confirm: "auto" | "manual"; pending_hours: number; verify_email: number; hourly_cap: number;
  contact_book_id: string | null; card_json: string | null; reminders_json: string; color: string; public: number; status: "active" | "hidden";
  visibility: "private" | "selected" | "all_users"; share_role: string; revision: number; created_at: string; updated_at: string;
  deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null;
};
export type HostRow = { type_id: string; user_id: string; priority: number; calendar_id: string | null; schedule_id: string | null };
export type BookingRow = {
  id: string; short_id: string; type_id: string | null; type_title: string; host_id: string; start_utc: string; end_utc: string; duration_min: number;
  buffer_before_min: number; buffer_after_min: number; booker_tz: string; status: BookingStatus; booker_name: string; booker_email: string; booker_email_norm: string;
  guests_json: string; location_kind: LocationKind; location_resolved: string; contact_id: string | null; response_id: string | null; card_id: string | null;
  rescheduled_from_id: string | null; cancel_reason: string | null; cancelled_by: "host" | "booker" | "system" | null; source: BookingSource; created_by: string | null;
  created_at: string; updated_at: string; revision: number;
};

export const parseJson = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};
export const durationsOf = (type: TypeRow) => parseJson<number[]>(type.durations_json, [30]);
export const remindersOf = (type: TypeRow): ReminderSettings => ({ ...DEFAULT_REMINDERS, ...parseJson<Partial<ReminderSettings>>(type.reminders_json, {}) });
export const cardTemplateOf = (type: TypeRow) => parseJson<CardTemplate | null>(type.card_json, null);
export const weeklyOf = (schedule: ScheduleRow) => parseJson<WeeklyRules>(schedule.rules_json, {});
export const overridesOf = (scheduleId: string): Record<string, TimeRange[] | null> => Object.fromEntries(
  (db.query("SELECT date, ranges_json FROM availability_overrides WHERE schedule_id = ?").all(scheduleId) as Array<{ date: string; ranges_json: string | null }>)
    .map((row) => [row.date, row.ranges_json === null ? null : parseJson<TimeRange[]>(row.ranges_json, [])])
);

/** A type by id or short id (live or binned). */
export function typeRow(ref: string): TypeRow | null {
  // An id, a short id, or a friendly segment (`intro-call-k7f3q2ab01`, D825).
  const short = isShortId(ref) ? ref : /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(ref) ? null : shortIdOfSegment(ref);
  return db.query(`SELECT * FROM booking_types WHERE ${short ? "short_id" : "id"} = ?`).get((short ?? ref).toLowerCase()) as TypeRow | null;
}
export function bookingRow(ref: string): BookingRow | null {
  const column = isShortId(ref) ? "short_id" : "id";
  return db.query(`SELECT * FROM bookings WHERE ${column} = ?`).get(ref.toLowerCase()) as BookingRow | null;
}
export const hostsOf = (typeId: string) => db.query("SELECT * FROM booking_type_hosts WHERE type_id = ? ORDER BY priority DESC, user_id").all(typeId) as HostRow[];
export const cohostsOf = (bookingId: string) => (db.query("SELECT user_id FROM booking_cohosts WHERE booking_id = ?").all(bookingId) as Array<{ user_id: string }>).map((row) => row.user_id);
export const userName = (id: string | null) => id ? (db.query("SELECT display_name FROM users WHERE id = ?").get(id) as { display_name: string } | null)?.display_name ?? "Former member" : "";

/** The caller's level on a live type (`none` when missing, binned, or unreadable). */
export const typeLevel = (typeId: string, userId: string): ItemLevel => itemLevel("booking_type", typeId, userId);
export const atLeast = (level: ItemLevel, wanted: "view" | "comment" | "edit" | "manage") => LEVEL_RANK[level] >= LEVEL_RANK[wanted];

/** A live type the caller reads at `level` or more, else NOT_FOUND (never 403 for existence). */
export function requireType(ref: string, userId: string, level: "view" | "edit" | "manage" = "view") {
  const row = typeRow(ref);
  if (!row || row.deleted_at !== null) throw notFound("Booking type");
  const found = typeLevel(row.id, userId);
  if (found === "none") throw notFound("Booking type");
  if (!atLeast(found, level)) throw new BookingError(403, "READ_ONLY", level === "manage" ? "Only the type's owner or a manager can do this" : "You can view this booking type but not change it");
  return { type: row, level: found };
}

/**
 * Who reads a booking (T583): its host and co-hosts, the member who booked it internally, and the
 * type's managers. Nobody else, not even other readers of the type.
 */
export function bookingAccess(booking: BookingRow, userId: string): "host" | "manager" | "booker" | null {
  if (booking.host_id === userId || cohostsOf(booking.id).includes(userId)) return "host";
  if (booking.type_id && atLeast(typeLevel(booking.type_id, userId), "manage")) return "manager";
  if (booking.created_by === userId) return "booker";
  return null;
}
export function requireBooking(ref: string, userId: string, act = false) {
  const row = bookingRow(ref);
  if (!row) throw notFound();
  const access = bookingAccess(row, userId);
  if (!access) throw notFound();
  if (act && access === "booker") throw new BookingError(403, "READ_ONLY", "Only the host can do this");
  return { booking: row, access };
}

/** SQL: bookings the user (bound as $userId) may read (T583). Alias `b`. */
export const readableBookingSql = (alias = "b") => `(${alias}.host_id = $userId OR ${alias}.created_by = $userId
  OR EXISTS (SELECT 1 FROM booking_cohosts bc WHERE bc.booking_id = ${alias}.id AND bc.user_id = $userId)
  OR EXISTS (SELECT 1 FROM booking_types bt WHERE bt.id = ${alias}.type_id AND ${readableContainerSql("booking_type", "bt", { minLevel: "manage" })}))`;

export const typeHref = (type: Pick<TypeRow, "title" | "short_id">) => `/bookings/types/${slugSegment(type.title, type.short_id)}`;
export const bookingHref = (booking: Pick<BookingRow, "short_id">) => `/bookings/b/${booking.short_id}`;
