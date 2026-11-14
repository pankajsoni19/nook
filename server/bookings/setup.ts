import { audit, db, now } from "../db";
import { isValidDate, isValidTimeZone } from "../../shared/calendarRecurrence";
import { slugify } from "../../shared/friendlyUrls";
import { DEFAULT_WEEKLY, HANDLE_PATTERN, normalizeWeekly, rangesProblem, RESERVED_HANDLES, type TimeRange, type WeeklyRules } from "../../shared/bookings";
import { BookingError, invalid, notFound, overridesOf, parseJson, weeklyOf, type ProfileRow, type ScheduleRow } from "./model";

/**
 * Booking profiles (public handles, D1006) and availability schedules with date overrides (D1000).
 * Every write is one transaction with an audit row (ids only, T505).
 */

export const HANDLE_ALIAS_DAYS = 90;
export const MAX_SCHEDULES = 10;
export const MAX_OVERRIDES = 400;

export type ProfileView = { handle: string; displayName: string; welcome: string; tz: string; enabled: boolean; busyCalendarIds: string[]; publicPath: string };

const profileView = (row: ProfileRow): ProfileView => ({
  handle: row.handle, displayName: row.display_name, welcome: row.welcome_md, tz: row.tz, enabled: row.enabled === 1,
  busyCalendarIds: parseJson<string[]>(row.busy_calendar_ids_json, []), publicPath: `/p/book/${row.handle}`
});

export const profileRow = (userId: string) => db.query("SELECT * FROM booking_profiles WHERE user_id = ?").get(userId) as ProfileRow | null;

/**
 * The person's zone when the client did not send one (D1129): the first zone other modules stored for
 * them that is not their UTC default (mail, then Time), else UTC.
 */
function userZone(userId: string) {
  for (const sql of ["SELECT tz FROM email_prefs WHERE user_id = ?", "SELECT tz FROM time_user_settings WHERE user_id = ?"]) {
    const tz = (db.query(sql).get(userId) as { tz: string } | null)?.tz;
    if (tz && tz !== "UTC" && isValidTimeZone(tz)) return tz;
  }
  return "UTC";
}

function handleTaken(handle: string, userId: string, nowIso = now()) {
  if (db.query("SELECT 1 FROM booking_profiles WHERE handle = ? AND user_id <> ?").get(handle, userId)) return true;
  return Boolean(db.query("SELECT 1 FROM booking_handle_aliases WHERE handle = ? AND user_id <> ? AND expires_at > ?").get(handle, userId, nowIso));
}

export function handleProblem(handle: string): string | null {
  if (!HANDLE_PATTERN.test(handle)) return "Use 3–30 lower-case letters, digits, or hyphens";
  if (RESERVED_HANDLES.has(handle)) return "That name is reserved";
  return null;
}

/** The person's profile, created on first use with a handle from their name (D1006). */
export function ensureProfile(userId: string, tz?: string): ProfileView {
  const existing = profileRow(userId);
  if (existing) return profileView(existing);
  const user = db.query("SELECT display_name FROM users WHERE id = ?").get(userId) as { display_name: string } | null;
  if (!user) throw notFound("Person");
  let base = slugify(user.display_name, 24).replace(/^-+|-+$/g, "");
  if (base.length < 3 || RESERVED_HANDLES.has(base)) base = `${base || "book"}-me`.slice(0, 24);
  let handle = base;
  for (let attempt = 0; handleTaken(handle, userId) || handleProblem(handle); attempt += 1) handle = `${base}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 30);
  const timestamp = now();
  const zone = tz && isValidTimeZone(tz) ? tz : userZone(userId);
  db.transaction(() => {
    db.query("INSERT OR IGNORE INTO booking_profiles (user_id, handle, display_name, tz, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
      .run(userId, handle, user.display_name.slice(0, 80), zone, timestamp, timestamp);
    ensureDefaultSchedule(userId, zone);
  })();
  return profileView(profileRow(userId)!);
}

export function updateProfile(userId: string, input: { handle?: string; displayName?: string; welcome?: string; tz?: string; enabled?: boolean; busyCalendarIds?: string[] }, nowMs = Date.now()): ProfileView {
  const current = ensureProfile(userId);
  const nowIso = new Date(nowMs).toISOString();
  return db.transaction(() => {
    const handle = input.handle?.trim().toLowerCase();
    if (handle !== undefined && handle !== current.handle) {
      const problem = handleProblem(handle);
      if (problem) throw invalid(problem, { field: "handle" });
      if (handleTaken(handle, userId, nowIso)) throw new BookingError(409, "HANDLE_TAKEN", "That link name is taken", { field: "handle" });
      db.query("DELETE FROM booking_handle_aliases WHERE handle = ? OR expires_at <= ?").run(handle, nowIso);
      // The old handle keeps working for 90 days (D1006).
      db.query("INSERT OR REPLACE INTO booking_handle_aliases (handle, user_id, expires_at) VALUES (?, ?, ?)").run(current.handle, userId, new Date(nowMs + HANDLE_ALIAS_DAYS * 86_400_000).toISOString());
    }
    if (input.tz !== undefined && !isValidTimeZone(input.tz)) throw invalid("Choose a valid time zone", { field: "tz" });
    const calendars = input.busyCalendarIds === undefined ? undefined : [...new Set(input.busyCalendarIds)].slice(0, 20);
    if (calendars?.some((id) => !db.query("SELECT 1 FROM calendars WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").get(id, userId))) throw invalid("Choose your own calendars", { field: "busyCalendarIds" });
    db.query(`UPDATE booking_profiles SET handle = ?, display_name = ?, welcome_md = ?, tz = ?, enabled = ?, busy_calendar_ids_json = ?, updated_at = ? WHERE user_id = ?`).run(
      handle ?? current.handle, (input.displayName?.trim() || current.displayName).slice(0, 80), (input.welcome ?? current.welcome).slice(0, 2000), input.tz ?? current.tz,
      input.enabled === undefined ? (current.enabled ? 1 : 0) : input.enabled ? 1 : 0, JSON.stringify(calendars ?? current.busyCalendarIds), nowIso, userId);
    audit(userId, null, "bookings.profile_update", { handleChanged: handle !== undefined && handle !== current.handle, enabled: input.enabled ?? current.enabled });
    return profileView(profileRow(userId)!);
  })();
}

/** The profile a public handle (or a live alias) names, when it is enabled. */
export function profileByHandle(handle: string, nowIso = now()): ProfileRow | null {
  const clean = handle.toLowerCase();
  if (!HANDLE_PATTERN.test(clean)) return null;
  const row = db.query("SELECT p.* FROM booking_profiles p JOIN users u ON u.id = p.user_id WHERE p.handle = ? AND u.disabled_at IS NULL").get(clean) as ProfileRow | null
    ?? db.query("SELECT p.* FROM booking_handle_aliases a JOIN booking_profiles p ON p.user_id = a.user_id JOIN users u ON u.id = p.user_id WHERE a.handle = ? AND a.expires_at > ? AND u.disabled_at IS NULL").get(clean, nowIso) as ProfileRow | null;
  return row && row.enabled === 1 ? row : null;
}

/** Admins reset a squatted or impersonating handle (T579): the person gets a fresh one from their name. */
export function resetHandle(adminId: string, userId: string) {
  db.transaction(() => {
    db.query("DELETE FROM booking_handle_aliases WHERE user_id = ?").run(userId);
    const deleted = db.query("DELETE FROM booking_profiles WHERE user_id = ?").run(userId).changes;
    if (!deleted) throw notFound("Profile");
    audit(adminId, null, "bookings.handle_reset", { userId });
  })();
  return ensureProfile(userId);
}

// ---------------------------------------------------------------- schedules

export type ScheduleView = { id: string; name: string; tz: string; weekly: WeeklyRules; overrides: Array<{ date: string; ranges: TimeRange[] | null; note: string }>; isDefault: boolean; updatedAt: string };

export function scheduleView(row: ScheduleRow): ScheduleView {
  const overrides = db.query("SELECT date, ranges_json, note FROM availability_overrides WHERE schedule_id = ? ORDER BY date").all(row.id) as Array<{ date: string; ranges_json: string | null; note: string }>;
  return {
    id: row.id, name: row.name, tz: row.tz, weekly: weeklyOf(row), isDefault: row.is_default === 1, updatedAt: row.updated_at,
    overrides: overrides.map((item) => ({ date: item.date, ranges: item.ranges_json === null ? null : parseJson<TimeRange[]>(item.ranges_json, []), note: item.note }))
  };
}

export function ensureDefaultSchedule(userId: string, tz?: string): ScheduleRow {
  const existing = db.query("SELECT * FROM availability_schedules WHERE user_id = ? AND is_default = 1").get(userId) as ScheduleRow | null;
  if (existing) return existing;
  const id = Bun.randomUUIDv7();
  const timestamp = now();
  db.query("INSERT INTO availability_schedules (id, user_id, name, tz, rules_json, is_default, created_at, updated_at) VALUES (?, ?, 'Working hours', ?, ?, 1, ?, ?)")
    .run(id, userId, tz && isValidTimeZone(tz) ? tz : profileRow(userId)?.tz ?? userZone(userId), JSON.stringify(DEFAULT_WEEKLY), timestamp, timestamp);
  return db.query("SELECT * FROM availability_schedules WHERE id = ?").get(id) as ScheduleRow;
}

/** `tz` is the client's zone, used when this first call makes the profile and the default schedule (D1129). */
export function listSchedules(userId: string, tz?: string): ScheduleView[] {
  ensureProfile(userId, tz);
  ensureDefaultSchedule(userId, tz);
  return (db.query("SELECT * FROM availability_schedules WHERE user_id = ? ORDER BY is_default DESC, name").all(userId) as ScheduleRow[]).map(scheduleView);
}

export function ownSchedule(userId: string, scheduleId: string): ScheduleRow {
  const row = db.query("SELECT * FROM availability_schedules WHERE id = ? AND user_id = ?").get(scheduleId, userId) as ScheduleRow | null;
  if (!row) throw notFound("Schedule");
  return row;
}

function weeklyOrThrow(weekly: unknown) {
  try { return normalizeWeekly(weekly); } catch (error) { throw invalid(error instanceof Error ? error.message : "Weekly hours are invalid", { field: "weekly" }); }
}

export function createSchedule(userId: string, input: { name: string; tz: string; weekly?: unknown; isDefault?: boolean }): ScheduleView {
  if (!isValidTimeZone(input.tz)) throw invalid("Choose a valid time zone", { field: "tz" });
  const weekly = input.weekly === undefined ? DEFAULT_WEEKLY : weeklyOrThrow(input.weekly);
  return db.transaction(() => {
    ensureDefaultSchedule(userId);
    if ((db.query("SELECT COUNT(*) AS count FROM availability_schedules WHERE user_id = ?").get(userId) as { count: number }).count >= MAX_SCHEDULES) throw new BookingError(409, "LIMIT_REACHED", `At most ${MAX_SCHEDULES} schedules`);
    const id = Bun.randomUUIDv7();
    const timestamp = now();
    if (input.isDefault) db.query("UPDATE availability_schedules SET is_default = 0 WHERE user_id = ?").run(userId);
    db.query("INSERT INTO availability_schedules (id, user_id, name, tz, rules_json, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, input.name.trim().slice(0, 60) || "Schedule", input.tz, JSON.stringify(weekly), input.isDefault ? 1 : 0, timestamp, timestamp);
    audit(userId, null, "bookings.schedule_create", { scheduleId: id });
    return scheduleView(ownSchedule(userId, id));
  })();
}

export function updateSchedule(userId: string, scheduleId: string, input: { name?: string; tz?: string; weekly?: unknown; isDefault?: boolean }): ScheduleView {
  const row = ownSchedule(userId, scheduleId);
  if (input.tz !== undefined && !isValidTimeZone(input.tz)) throw invalid("Choose a valid time zone", { field: "tz" });
  const weekly = input.weekly === undefined ? weeklyOf(row) : weeklyOrThrow(input.weekly);
  return db.transaction(() => {
    if (input.isDefault) db.query("UPDATE availability_schedules SET is_default = 0 WHERE user_id = ?").run(userId);
    db.query("UPDATE availability_schedules SET name = ?, tz = ?, rules_json = ?, is_default = ?, updated_at = ? WHERE id = ?")
      .run((input.name?.trim() || row.name).slice(0, 60), input.tz ?? row.tz, JSON.stringify(weekly), input.isDefault ? 1 : row.is_default, now(), row.id);
    audit(userId, null, "bookings.schedule_update", { scheduleId });
    return scheduleView(ownSchedule(userId, scheduleId));
  })();
}

export function deleteSchedule(userId: string, scheduleId: string) {
  const row = ownSchedule(userId, scheduleId);
  if (row.is_default) throw new BookingError(409, "DEFAULT_SCHEDULE", "Make another schedule the default first");
  db.transaction(() => {
    db.query("DELETE FROM availability_schedules WHERE id = ?").run(row.id);
    audit(userId, null, "bookings.schedule_delete", { scheduleId });
  })();
}

/** Sets one date's override: `ranges` null = unavailable all day; an empty `clear` removes it. */
export function putOverride(userId: string, scheduleId: string, input: { date: string; ranges: TimeRange[] | null; note?: string }): ScheduleView {
  const row = ownSchedule(userId, scheduleId);
  if (!isValidDate(input.date)) throw invalid("Enter a real date", { field: "date" });
  if (input.ranges !== null) {
    const sorted = [...input.ranges].sort((a, b) => a.from.localeCompare(b.from));
    const problem = rangesProblem(sorted);
    if (problem) throw invalid(problem, { field: "ranges" });
    input = { ...input, ranges: sorted };
  }
  return db.transaction(() => {
    if ((db.query("SELECT COUNT(*) AS count FROM availability_overrides WHERE schedule_id = ?").get(row.id) as { count: number }).count >= MAX_OVERRIDES
      && !db.query("SELECT 1 FROM availability_overrides WHERE schedule_id = ? AND date = ?").get(row.id, input.date)) throw new BookingError(409, "LIMIT_REACHED", `At most ${MAX_OVERRIDES} date overrides`);
    db.query(`INSERT INTO availability_overrides (id, schedule_id, date, ranges_json, note) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (schedule_id, date) DO UPDATE SET ranges_json = excluded.ranges_json, note = excluded.note`)
      .run(Bun.randomUUIDv7(), row.id, input.date, input.ranges === null ? null : JSON.stringify(input.ranges), (input.note ?? "").slice(0, 100));
    db.query("UPDATE availability_schedules SET updated_at = ? WHERE id = ?").run(now(), row.id);
    audit(userId, null, "bookings.override_put", { scheduleId });
    return scheduleView(ownSchedule(userId, scheduleId));
  })();
}

export function deleteOverride(userId: string, scheduleId: string, date: string): ScheduleView {
  const row = ownSchedule(userId, scheduleId);
  db.query("DELETE FROM availability_overrides WHERE schedule_id = ? AND date = ?").run(row.id, date);
  return scheduleView(ownSchedule(userId, scheduleId));
}

/** The schedule input of the slot math for one stored schedule. */
export const scheduleInput = (row: ScheduleRow) => ({ tz: row.tz, weekly: weeklyOf(row), overrides: overridesOf(row.id) });
