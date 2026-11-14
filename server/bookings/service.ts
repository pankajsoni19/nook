import { audit, db, now } from "../db";
import { logger } from "../log";
import { createEvent, deleteEvent, ensurePersonalCalendar } from "../calendar/service";
import { singleEventIcs } from "../mail/ics";
import { recordItemActivity, recordItemChange } from "../activity/service";
import { canEditBook, PeopleError, upsertContactByEmail } from "../people/contacts";
import { createPublicLink, revokePublicLinksOf } from "../public";
import { keyedHash } from "../public/secret";
import { currentSet, getResponse, setVersion, submitResponse } from "../questions/service";
import { cancelSchedules, upsertSchedule } from "../schedules/service";
import { notify, enqueueExternalMail } from "../notify";
import { mailEnabled } from "../mail";
import { createCard } from "../tasks/service";
import { isValidTimeZone, utcToZoned } from "../../shared/calendarRecurrence";
import { isEmail, normalizeEmail, type QuestionSet } from "../../shared/questions";
import { DEFAULT_CARD_TITLE, fillTemplate, formatWhen, LIVE_STATUSES, MAX_GUESTS, STATUS_LABELS, UPCOMING_PER_EMAIL, type BookingSource, type BookingStatus } from "../../shared/bookings";
import { slotHosts, pickRoundRobin } from "./availability";
import { BookingError, bookingHref, bookingRow, cardTemplateOf, cohostsOf, hostsOf, invalid, notFound, parseJson, remindersOf, typeRow, userName, type BookingRow, type TypeRow } from "./model";
import { profileRow } from "./setup";

const slog = logger("bookings");

/**
 * Bookings: create, approve, decline, cancel, reschedule, no-show (§D.6).
 *
 * D1001: a booking is created inside one IMMEDIATE transaction that recomputes the slot's
 * availability for the chosen host(s) from the database (outside feeds from their cache, refreshed
 * just before), so two concurrent requests for one slot serialize and the second finds it taken
 * (409 SLOT_TAKEN); `bookings_host_slot` is the backstop. In that transaction: the booking, the
 * intake response, the host's calendar events (D1002), the booker as a contact with a meeting
 * entry (D1003), work links, notifications, mail to the booker, reminders and the manage link
 * (D1004). A prep card (Tasks' createCard is async) is made right after commit (D1014).
 */

export type BookerInput = { name: string; email: string; guests?: string[]; tz: string; location?: string | null; answers?: Record<string, unknown> };
export type CreateInput = {
  type: TypeRow; start: string; durationMin: number; booker: BookerInput; source: BookingSource; actorId: string | null;
  nowMs?: number; linkId?: string | null; hostId?: string | null; contactId?: string | null;
};
export type CreatedBooking = { booking: BookingRow; manageToken: string; mailQueued: boolean };

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function cleanBooker(type: TypeRow, booker: BookerInput) {
  const name = booker.name.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!name) throw invalid("Enter your name", { field: "name" });
  const email = normalizeEmail(booker.email);
  if (!isEmail(email)) throw invalid("Enter an email address", { field: "email" });
  if (!isValidTimeZone(booker.tz)) throw invalid("Choose a valid time zone", { field: "tz" });
  const guests = [...new Set((booker.guests ?? []).map(normalizeEmail).filter((guest) => guest && guest !== email))];
  if (guests.length > MAX_GUESTS || guests.some((guest) => !isEmail(guest))) throw invalid(`Add at most ${MAX_GUESTS} guest email addresses`, { field: "guests" });
  const needsLocation = type.location_kind === "ask" || (type.location_kind === "phone" && !type.location_value.trim());
  const typed = (booker.location ?? "").trim().slice(0, 500);
  if (needsLocation && !typed) throw invalid(type.location_kind === "phone" ? "Enter the number to call" : "Tell us where to meet", { field: "location" });
  const location = needsLocation ? (type.location_kind === "phone" ? `Phone: ${typed}` : typed) : type.location_value.trim();
  return { name, email, rawEmail: booker.email.trim().slice(0, 254), guests, location };
}

/** Plain-text answers for the event description (T580: stored and shown as text, never HTML). */
export function answersText(set: QuestionSet | null, answers: Record<string, unknown>): string {
  if (!set) return "";
  const lines: string[] = [];
  for (const question of set.questions) {
    const value = answers[question.id];
    if (value === undefined || value === null || value === "") continue;
    const label = (id: unknown) => question.options?.find((option) => option.id === id)?.label ?? String(id);
    let text: string;
    if (Array.isArray(value)) text = value.map(label).join(", ");
    else if (typeof value === "object") text = JSON.stringify(value);
    else text = question.options ? label(value) : String(value);
    lines.push(`${question.title.replace(/\*\*|_/g, "")}: ${text}`.slice(0, 1200));
  }
  return lines.join("\n");
}

const manageExpiry = (booking: Pick<BookingRow, "end_utc">) => booking.end_utc;

/** A fresh manage link for the booker (D1004): valid until the booking ends. */
export function newManageToken(booking: BookingRow) {
  return createPublicLink({ kind: "booking_manage", itemId: booking.id, createdBy: null, expiresAt: manageExpiry(booking) }).token;
}

export const managePath = (token: string) => `/p/book/manage/${token}`;

function linkSystem(a: { kind: string; id: string }, b: { kind: string; id: string }, relation: "source" | "relates", actorId: string | null) {
  db.query(`INSERT OR IGNORE INTO work_links (id, a_kind, a_id, b_kind, b_id, relation, created_by, created_via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'system', ?)`)
    .run(Bun.randomUUIDv7(), a.kind, a.id, b.kind, b.id, relation, actorId, now());
}

function hostTz(userId: string) {
  return profileRow(userId)?.tz ?? "UTC";
}

/** Makes the calendar events of a confirmed booking: one per host (collective), linked to the booking (D1002). */
function createBookingEvents(booking: BookingRow, type: TypeRow | null) {
  const hosts = [booking.host_id, ...cohostsOf(booking.id)];
  const hostRows = type ? hostsOf(type.id) : [];
  const response = booking.response_id ? getResponse(booking.response_id) : null;
  const set = response && type ? setVersion({ kind: "booking_type", id: type.id }, response.setVersion) : null;
  const guests = parseJson<string[]>(booking.guests_json, []);
  const description = [
    `Booked by ${booking.booker_name} <${booking.booker_email}>`,
    guests.length ? `Guests: ${guests.join(", ")}` : "",
    response ? answersText(set, response.answers as Record<string, unknown>) : "",
    `Booking ${booking.short_id} (Nook Bookings)`
  ].filter(Boolean).join("\n\n").slice(0, 9000);
  for (const hostId of hosts) {
    try {
      const own = hostRows.find((row) => row.user_id === hostId)?.calendar_id ?? (type && hostId === type.owner_id ? type.calendar_id : null);
      let calendarId = own && db.query("SELECT 1 FROM calendars WHERE id = ? AND owner_id = ? AND deleted_at IS NULL").get(own, hostId) ? own : null;
      if (!calendarId) {
        ensurePersonalCalendar(hostId);
        calendarId = (db.query("SELECT id FROM calendars WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get(hostId) as { id: string } | null)?.id ?? null;
      }
      if (!calendarId) continue;
      const tz = hostTz(hostId);
      const created = createEvent(hostId, calendarId, {
        title: `${booking.type_title} with ${booking.booker_name}`.slice(0, 200), description, location: booking.location_resolved, allDay: false,
        startLocal: utcToZoned(Date.parse(booking.start_utc), tz), tz, durationMinutes: booking.duration_min
      }) as { event?: { id: string }; id?: string };
      const eventId = created.event?.id ?? created.id ?? null;
      db.query("INSERT OR REPLACE INTO booking_events (booking_id, host_id, event_id) VALUES (?, ?, ?)").run(booking.id, hostId, eventId);
      if (eventId) linkSystem({ kind: "booking", id: booking.id }, { kind: "event", id: eventId }, "relates", hostId);
    } catch (error) {
      slog.warn(`Booking event not created: booking=${booking.short_id} reason=${error instanceof Error ? error.name : "error"}`);
    }
  }
}

function removeBookingEvents(booking: BookingRow) {
  for (const row of db.query("SELECT host_id, event_id FROM booking_events WHERE booking_id = ?").all(booking.id) as Array<{ host_id: string; event_id: string | null }>) {
    if (!row.event_id) continue;
    try { deleteEvent(row.host_id, row.event_id); } catch { /* the event was already removed */ }
  }
}

/** Reminders (booker mail, host push) at each offset before the start, and completion after the end. */
function scheduleReminders(booking: BookingRow, type: TypeRow | null, nowMs: number) {
  const owner = { kind: "booking", id: booking.id };
  for (let index = 1; index <= 3; index += 1) cancelSchedules(owner, `bookings.remind_${index}`);
  const settings = type ? remindersOf(type) : { offsets: [], booker: false, host: false };
  settings.offsets.slice(0, 3).forEach((minutes, index) => {
    const fireAt = Date.parse(booking.start_utc) - minutes * MINUTE;
    if (fireAt <= nowMs) return;
    upsertSchedule(owner, `bookings.remind_${index + 1}`, { once: iso(fireAt) }, { minutes, booker: settings.booker, host: settings.host }, { userId: booking.host_id, fromMs: nowMs });
  });
  upsertSchedule(owner, "bookings.complete", { once: booking.end_utc }, {}, { userId: booking.host_id, fromMs: nowMs });
}

function mailBooker(booking: BookingRow, template: string, extra: Record<string, unknown> = {}, nowMs = Date.now()) {
  return enqueueExternalMail({ to: booking.booker_email_norm, template, payload: { bookingId: booking.id, tz: booking.booker_tz, ...extra }, itemRef: { kind: "booking", id: booking.id }, nowMs }) !== null;
}

function notifyHosts(booking: BookingRow, topic: string, title: string, actorId: string | null, nowMs: number, email = true) {
  notify({
    userIds: [booking.host_id, ...cohostsOf(booking.id)], module: "bookings", topic, title: title.slice(0, 200),
    body: `${formatWhen(booking.start_utc, booking.end_utc, hostTz(booking.host_id))}`, href: bookingHref(booking), item: { kind: "booking", id: booking.id },
    actor: actorId, dedupeKey: `booking:${booking.id}:${topic}`, nowMs, ...(email ? { email: { template: "bookings.host_update", payload: { bookingId: booking.id, topic } } } : {})
  });
}

function recordStatus(booking: BookingRow, from: BookingStatus | null, to: BookingStatus, actorId: string | null) {
  recordItemChange({ itemKind: "booking", itemId: booking.id, container: booking.type_id ? { kind: "booking_type", id: booking.type_id } : null, actorId, kind: "booking_status",
    from: from ? { label: STATUS_LABELS[from], id: from } : null, to: { label: STATUS_LABELS[to], id: to } });
}

/** The booker as a contact in the type's book, with a meeting entry on their timeline (D1003, C1). */
function upsertBooker(booking: BookingRow, type: TypeRow, actorId: string | null): string | null {
  if (!type.contact_book_id || !canEditBook(type.contact_book_id, type.owner_id)) return null;
  try {
    const result = upsertContactByEmail(type.contact_book_id, { email: booking.booker_email_norm, name: booking.booker_name }, { source: "booking", sourceRef: booking.short_id, actor: actorId });
    db.query("UPDATE contacts SET last_interaction_at = ? WHERE id = ?").run(booking.start_utc, result.contactId);
    db.query("UPDATE bookings SET contact_id = ? WHERE id = ?").run(result.contactId, booking.id);
    linkSystem({ kind: "contact", id: result.contactId }, { kind: "booking", id: booking.id }, "source", actorId ?? type.owner_id);
    recordItemActivity({ itemKind: "contact", itemId: result.contactId, container: { kind: "contact_book", id: type.contact_book_id }, actorId, via: actorId ? undefined : "public", kind: "meeting_booked",
      payload: { item: { kind: "booking", id: booking.id, label: booking.type_title }, extra: { start: booking.start_utc, durationMin: booking.duration_min } } });
    return result.contactId;
  } catch (error) {
    if (error instanceof PeopleError) return null;
    throw error;
  }
}

/** The common steps once a booking is confirmed (on create with auto confirmation, or on approval). */
function onConfirmed(booking: BookingRow, type: TypeRow | null, nowMs: number) {
  createBookingEvents(booking, type);
  scheduleReminders(booking, type, nowMs);
  cancelSchedules({ kind: "booking", id: booking.id }, "bookings.pending_expire");
}

/**
 * Creates a booking (D1001). Validates the booker and the intake answers, re-checks the slot under
 * an IMMEDIATE transaction, picks the host (round robin, D1005), and does everything a booking
 * implies. Returns the booking and the booker's manage token (shown once).
 */
export function createBooking(input: CreateInput): CreatedBooking {
  const type = input.type;
  const nowMs = input.nowMs ?? Date.now();
  const booker = cleanBooker(type, input.booker);
  const startMs = Date.parse(input.start);
  if (!Number.isFinite(startMs) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(input.start)) throw invalid("Choose a time", { field: "start" });
  const isPublic = input.source === "public" || input.source === "secret_link";
  const run = db.transaction((): CreatedBooking => {
    const fresh = typeRow(type.id);
    if (!fresh || fresh.deleted_at !== null || (isPublic && fresh.status !== "active")) throw notFound("Booking type");
    if (isPublic) {
      const upcoming = (db.query("SELECT COUNT(*) AS count FROM bookings WHERE type_id = ? AND booker_email_norm = ? AND status IN ('pending','confirmed') AND end_utc > ?").get(type.id, booker.email, iso(nowMs)) as { count: number }).count;
      if (upcoming >= UPCOMING_PER_EMAIL) throw new BookingError(429, "TOO_MANY", `You already have ${UPCOMING_PER_EMAIL} upcoming bookings of this type`);
      const lastHour = (db.query("SELECT COUNT(*) AS count FROM bookings WHERE type_id = ? AND source IN ('public','secret_link') AND created_at > ?").get(type.id, iso(nowMs - 3_600_000)) as { count: number }).count;
      if (lastHour >= fresh.hourly_cap) throw new BookingError(429, "RATE_LIMITED", "This booking page is busy. Try again in a while.");
    }
    const free = slotHosts(fresh, { fromMs: startMs - 86_400_000, toMs: startMs + 86_400_000, durationMin: input.durationMin, nowMs }).get(startMs);
    if (!free?.length || (input.hostId && !free.includes(input.hostId))) throw new BookingError(409, "SLOT_TAKEN", "That time was just taken. Choose another.");
    const hostId = fresh.assignment === "collective" ? fresh.owner_id && free.includes(fresh.owner_id) ? fresh.owner_id : free[0]! : input.hostId ?? pickRoundRobin(fresh, free, nowMs);
    const cohosts = fresh.assignment === "collective" ? free.filter((id) => id !== hostId) : [];
    // Intake answers through the question engine (§B.2); public pages refuse members-only types.
    const set = currentSet({ kind: "booking_type", id: fresh.id });
    const response = set && set.set.questions.length
      ? submitResponse({ host: { kind: "booking_type", id: fresh.id }, respondent: input.contactId ? { kind: "contact", contactId: input.contactId, name: booker.name, email: booker.email } : { kind: "guest", name: booker.name, email: booker.email }, answers: input.booker.answers ?? {}, audience: isPublic ? "public" : "member", nowMs })
      : null;
    const id = crypto.randomUUID();
    const status: BookingStatus = fresh.confirm === "manual" ? "pending" : "confirmed";
    const timestamp = iso(nowMs);
    try {
      db.query(`INSERT INTO bookings (id, type_id, type_title, host_id, start_utc, end_utc, duration_min, buffer_before_min, buffer_after_min, booker_tz, status, booker_name, booker_email,
          booker_email_norm, guests_json, location_kind, location_resolved, response_id, source, created_by, contact_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, fresh.id, fresh.title, hostId, iso(startMs), iso(startMs + input.durationMin * MINUTE), input.durationMin, fresh.buffer_before_min, fresh.buffer_after_min,
          input.booker.tz, status, booker.name, booker.rawEmail, booker.email, JSON.stringify(booker.guests), fresh.location_kind, booker.location, response?.id ?? null,
          input.source, input.actorId, input.contactId ?? null, timestamp, timestamp);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: bookings\.host_id/.test(error.message)) throw new BookingError(409, "SLOT_TAKEN", "That time was just taken. Choose another.");
      throw error;
    }
    for (const cohost of cohosts) db.query("INSERT INTO booking_cohosts (booking_id, user_id) VALUES (?, ?)").run(id, cohost);
    let booking = bookingRow(id)!;
    if (response) db.query("UPDATE responses SET subject_kind = 'booking', subject_id = ? WHERE id = ?").run(id, response.id);
    recordItemActivity({ itemKind: "booking", itemId: id, container: { kind: "booking_type", id: fresh.id }, actorId: input.actorId, via: input.actorId ? undefined : "public", kind: "created",
      payload: { from: null, to: { label: STATUS_LABELS[status], id: status } } });
    if (!input.contactId) upsertBooker(booking, fresh, input.actorId);
    else linkSystem({ kind: "contact", id: input.contactId }, { kind: "booking", id }, "source", input.actorId);
    booking = bookingRow(id)!;
    if (status === "confirmed") onConfirmed(booking, fresh, nowMs);
    else upsertSchedule({ kind: "booking", id }, "bookings.pending_expire", { once: iso(Math.min(nowMs + fresh.pending_hours * 3_600_000, startMs)) }, {}, { userId: hostId, fromMs: nowMs });
    const manageToken = newManageToken(booking);
    const mailQueued = mailBooker(booking, status === "confirmed" ? "bookings.confirmed" : "bookings.pending", { manageUrl: managePath(manageToken) }, nowMs);
    notifyHosts(booking, status === "pending" ? "bookings.pending" : "bookings.new", status === "pending" ? `Approve: ${fresh.title} with ${booker.name}` : `New booking: ${fresh.title} with ${booker.name}`, input.actorId, nowMs);
    audit(input.actorId, null, "bookings.create", { bookingId: id, typeId: fresh.id, source: input.source, status, linkId: input.linkId ?? null });
    return { booking: bookingRow(id)!, manageToken, mailQueued };
  });
  const created = run.immediate();
  if (created.booking.status === "confirmed") void makePrepCard(created.booking.id);
  return created;
}

/** The prep card on the type's board (C1), after commit; failures are logged, never undo the booking. */
export async function makePrepCard(bookingId: string) {
  const booking = bookingRow(bookingId);
  const type = booking?.type_id ? typeRow(booking.type_id) : null;
  const template = type ? cardTemplateOf(type) : null;
  if (!booking || !type || !template || booking.card_id) return null;
  try {
    const title = fillTemplate(template.titleTemplate || DEFAULT_CARD_TITLE, { type: booking.type_title, name: booking.booker_name, email: booking.booker_email_norm, date: booking.start_utc.slice(0, 10) });
    const { card } = await createCard(type.owner_id, template.boardId, {
      columnId: template.columnId, title, description: `Booking ${booking.short_id}: ${formatWhen(booking.start_utc, booking.end_utc, hostTz(booking.host_id))}.`,
      dueOn: utcToZoned(Date.parse(booking.start_utc), hostTz(booking.host_id)).slice(0, 10), ...(template.assignHost ? { assigneeIds: [booking.host_id] } : {})
    }) as { card: { id: string } };
    db.transaction(() => {
      db.query("UPDATE bookings SET card_id = ? WHERE id = ?").run(card.id, booking.id);
      linkSystem({ kind: "card", id: card.id }, { kind: "booking", id: booking.id }, "source", type.owner_id);
    })();
    return card.id;
  } catch (error) {
    slog.warn(`Prep card not created: booking=${booking.short_id} reason=${error instanceof Error ? error.message.slice(0, 80) : "error"}`);
    return null;
  }
}

function transition(booking: BookingRow, to: BookingStatus, fields: { reason?: string | null; by?: "host" | "booker" | "system" }, actorId: string | null) {
  const changed = db.query(`UPDATE bookings SET status = ?, cancel_reason = COALESCE(?, cancel_reason), cancelled_by = COALESCE(?, cancelled_by), revision = revision + 1, updated_at = ? WHERE id = ? AND status = ?`)
    .run(to, fields.reason ?? null, fields.by ?? null, now(), booking.id, booking.status).changes;
  if (changed !== 1) throw new BookingError(409, "BOOKING_CHANGED", "This booking was changed meanwhile");
  recordStatus(booking, booking.status, to, actorId);
  return bookingRow(booking.id)!;
}

export function approveBooking(booking: BookingRow, actorId: string, nowMs = Date.now()) {
  if (booking.status !== "pending") throw new BookingError(409, "NOT_PENDING", "Only a booking awaiting approval can be approved");
  const result = db.transaction(() => {
    const updated = transition(booking, "confirmed", {}, actorId);
    onConfirmed(updated, updated.type_id ? typeRow(updated.type_id) : null, nowMs);
    mailBooker(updated, "bookings.confirmed", { manageUrl: managePath(newManageToken(updated)) }, nowMs);
    audit(actorId, null, "bookings.approve", { bookingId: booking.id });
    return updated;
  })();
  void makePrepCard(result.id);
  return result;
}

export function declineBooking(booking: BookingRow, actorId: string | null, reason: string | null, nowMs = Date.now(), status: "declined" | "expired" = "declined") {
  if (booking.status !== "pending") throw new BookingError(409, "NOT_PENDING", "Only a booking awaiting approval can be declined");
  return db.transaction(() => {
    const updated = transition(booking, status, { reason: reason?.slice(0, 500) ?? null, by: actorId ? "host" : "system" }, actorId);
    cancelSchedules({ kind: "booking", id: booking.id });
    revokePublicLinksOf("booking_manage", booking.id, actorId);
    mailBooker(updated, "bookings.declined", { reason: reason ?? "" }, nowMs);
    audit(actorId, null, status === "declined" ? "bookings.decline" : "bookings.expire", { bookingId: booking.id });
    return updated;
  })();
}

export function cancelBooking(booking: BookingRow, by: "host" | "booker", actorId: string | null, reason: string | null, nowMs = Date.now(), options: { silent?: boolean } = {}) {
  if (!LIVE_STATUSES.includes(booking.status)) throw new BookingError(409, "NOT_LIVE", "This booking is already over or cancelled");
  if (Date.parse(booking.end_utc) <= nowMs) throw new BookingError(409, "NOT_LIVE", "This booking is already over");
  // The booker cancels before the start, as the manage page offers; the host may still cancel one under way (D1126).
  if (by === "booker" && Date.parse(booking.start_utc) <= nowMs) throw new BookingError(409, "NOT_LIVE", "This booking has already started");
  return db.transaction(() => {
    const updated = transition(booking, "cancelled", { reason: reason?.slice(0, 500) ?? null, by }, actorId);
    removeBookingEvents(booking);
    cancelSchedules({ kind: "booking", id: booking.id });
    if (!options.silent) {
      if (by === "host") mailBooker(updated, "bookings.cancelled", { reason: reason ?? "", by }, nowMs);
      else mailBooker(updated, "bookings.cancelled", { by }, nowMs);
      notifyHosts(updated, "bookings.cancelled", `Cancelled: ${updated.type_title} with ${updated.booker_name}`, actorId, nowMs);
    }
    audit(actorId, null, "bookings.cancel", { bookingId: booking.id, by });
    return updated;
  })();
}

/**
 * Reschedules (D1004): a new booking at `start` (same host where free, else round robin), linked by
 * `rescheduled_from_id`, carrying the booker, answers, and contact; the old one is cancelled and its
 * manage links revoked. The new booking keeps the old one's status.
 */
export function rescheduleBooking(booking: BookingRow, input: { start: string; by: "host" | "booker"; actorId: string | null; reason?: string | null; nowMs?: number }): CreatedBooking {
  const nowMs = input.nowMs ?? Date.now();
  if (!LIVE_STATUSES.includes(booking.status) || Date.parse(booking.start_utc) <= nowMs) throw new BookingError(409, "NOT_LIVE", "Only an upcoming booking can be rescheduled");
  const type = booking.type_id ? typeRow(booking.type_id) : null;
  if (!type || type.deleted_at !== null) throw new BookingError(409, "TYPE_GONE", "This booking's type was deleted; book a new time instead");
  const startMs = Date.parse(input.start);
  if (!Number.isFinite(startMs)) throw invalid("Choose a time", { field: "start" });
  const run = db.transaction((): CreatedBooking => {
    const free = slotHosts(type, { fromMs: startMs - 86_400_000, toMs: startMs + 86_400_000, durationMin: booking.duration_min, nowMs, excludeBookingId: booking.id }).get(startMs);
    if (!free?.length) throw new BookingError(409, "SLOT_TAKEN", "That time is not available. Choose another.");
    const hostId = type.assignment === "collective" ? (free.includes(booking.host_id) ? booking.host_id : free[0]!) : free.includes(booking.host_id) ? booking.host_id : pickRoundRobin(type, free, nowMs);
    const old = transition(booking, "cancelled", { reason: input.reason ?? "Rescheduled", by: input.by }, input.actorId);
    removeBookingEvents(booking);
    cancelSchedules({ kind: "booking", id: booking.id });
    revokePublicLinksOf("booking_manage", booking.id, input.actorId);
    const id = crypto.randomUUID();
    const timestamp = iso(nowMs);
    try {
      db.query(`INSERT INTO bookings (id, type_id, type_title, host_id, start_utc, end_utc, duration_min, buffer_before_min, buffer_after_min, booker_tz, status, booker_name, booker_email,
          booker_email_norm, guests_json, location_kind, location_resolved, contact_id, response_id, card_id, rescheduled_from_id, source, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, type.id, type.title, hostId, iso(startMs), iso(startMs + booking.duration_min * MINUTE), booking.duration_min, type.buffer_before_min, type.buffer_after_min,
          booking.booker_tz, booking.status, booking.booker_name, booking.booker_email, booking.booker_email_norm, booking.guests_json, booking.location_kind, booking.location_resolved,
          booking.contact_id, booking.response_id, booking.card_id, booking.id, booking.source, booking.created_by, timestamp, timestamp);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: bookings\.host_id/.test(error.message)) throw new BookingError(409, "SLOT_TAKEN", "That time was just taken. Choose another.");
      throw error;
    }
    if (type.assignment === "collective") for (const cohost of free.filter((user) => user !== hostId)) db.query("INSERT INTO booking_cohosts (booking_id, user_id) VALUES (?, ?)").run(id, cohost);
    const created = bookingRow(id)!;
    recordItemActivity({ itemKind: "booking", itemId: id, container: { kind: "booking_type", id: type.id }, actorId: input.actorId, via: input.actorId ? undefined : "public", kind: "booking_rescheduled",
      payload: { from: { label: old.start_utc }, to: { label: created.start_utc } } });
    if (created.contact_id) linkSystem({ kind: "contact", id: created.contact_id }, { kind: "booking", id }, "source", input.actorId ?? type.owner_id);
    if (created.card_id) linkSystem({ kind: "card", id: created.card_id }, { kind: "booking", id }, "source", type.owner_id);
    if (created.status === "confirmed") onConfirmed(created, type, nowMs);
    else upsertSchedule({ kind: "booking", id }, "bookings.pending_expire", { once: iso(Math.min(nowMs + type.pending_hours * 3_600_000, startMs)) }, {}, { userId: hostId, fromMs: nowMs });
    const manageToken = newManageToken(created);
    const mailQueued = mailBooker(created, "bookings.rescheduled", { manageUrl: managePath(manageToken), previousStart: booking.start_utc, by: input.by }, nowMs);
    notifyHosts(created, "bookings.rescheduled", `Rescheduled: ${type.title} with ${created.booker_name}`, input.actorId, nowMs);
    audit(input.actorId, null, "bookings.reschedule", { bookingId: booking.id, newBookingId: id, by: input.by });
    return { booking: created, manageToken, mailQueued };
  });
  return run.immediate();
}

export function markNoShow(booking: BookingRow, actorId: string, nowMs = Date.now()) {
  if (!["confirmed", "completed"].includes(booking.status) || Date.parse(booking.start_utc) > nowMs) throw new BookingError(409, "NOT_STARTED", "Mark a no-show after the booking starts");
  return db.transaction(() => {
    const updated = transition(booking, "no_show", {}, actorId);
    audit(actorId, null, "bookings.no_show", { bookingId: booking.id });
    return updated;
  })();
}

// ---------------------------------------------------------------- views

export type BookingView = ReturnType<typeof bookingView>;

export function bookingView(booking: BookingRow, viewerId: string | null, options: { answers?: boolean } = {}) {
  const type = booking.type_id ? typeRow(booking.type_id) : null;
  const response = options.answers && booking.response_id ? getResponse(booking.response_id) : null;
  const events = db.query("SELECT host_id, event_id FROM booking_events WHERE booking_id = ?").all(booking.id) as Array<{ host_id: string; event_id: string | null }>;
  return {
    id: booking.id, shortId: booking.short_id, href: bookingHref(booking), typeId: type && type.deleted_at === null ? type.id : null, typeTitle: booking.type_title,
    typeDeleted: !type || type.deleted_at !== null, color: type?.color ?? "#929299",
    hostId: booking.host_id, hostName: userName(booking.host_id), cohosts: cohostsOf(booking.id).map((id) => ({ id, name: userName(id) })),
    start: booking.start_utc, end: booking.end_utc, durationMin: booking.duration_min, bookerTz: booking.booker_tz, status: booking.status,
    bookerName: booking.booker_name, bookerEmail: booking.booker_email, guests: parseJson<string[]>(booking.guests_json, []), locationKind: booking.location_kind, location: booking.location_resolved,
    contactId: booking.contact_id, cardId: booking.card_id, eventId: events.find((event) => event.host_id === viewerId)?.event_id ?? events[0]?.event_id ?? null,
    rescheduledFromId: booking.rescheduled_from_id, cancelReason: booking.cancel_reason, cancelledBy: booking.cancelled_by, source: booking.source,
    createdAt: booking.created_at, revision: booking.revision,
    ...(response ? { response: { setVersion: response.setVersion, answers: response.answers }, questions: type ? setVersion({ kind: "booking_type", id: type.id }, response.setVersion) : null } : {})
  };
}

/**
 * The first booking of a reschedule chain and how many times it moved: a moved booking keeps the
 * first one's UID with a higher SEQUENCE, so a calendar that imported the first file updates it (D1054).
 */
function rescheduleChain(booking: BookingRow): { rootId: string; depth: number } {
  let rootId = booking.id;
  let from = booking.rescheduled_from_id;
  let depth = 0;
  while (from && depth < 50) {
    rootId = from;
    depth += 1;
    from = (db.query("SELECT rescheduled_from_id FROM bookings WHERE id = ?").get(from) as { rescheduled_from_id: string | null } | null)?.rescheduled_from_id ?? null;
  }
  return { rootId, depth };
}

/**
 * Whether the booker gets a calendar file of this booking (D1122): a confirmed (or held, completed)
 * booking, or a cancelled one (METHOD:CANCEL removes an imported copy). A request awaiting approval,
 * and one declined or expired, has nothing to add: its file would say CONFIRMED.
 */
export const bookingHasIcs = (booking: Pick<BookingRow, "status">) => ["confirmed", "completed", "no_show", "cancelled"].includes(booking.status);

/**
 * An ICS file of one booking (the booker's "Add to calendar", the manage page, and the mail attachment, D1054).
 * The UID is a keyed hash of the chain's first booking, never its internal id (T598, D1123).
 */
export function bookingIcs(booking: BookingRow) {
  const chain = rescheduleChain(booking);
  return singleEventIcs({
    uid: `${keyedHash("booking-ics", chain.rootId).slice(0, 32)}@nook`, sequence: chain.depth, title: `${booking.type_title} with ${userName(booking.host_id)}`, description: `Booking ${booking.short_id}`,
    location: booking.location_resolved, startUtc: booking.start_utc, endUtc: booking.end_utc, stampUtc: booking.updated_at, method: booking.status === "cancelled" ? "CANCEL" : "PUBLISH"
  });
}

export const mailOn = () => mailEnabled();

// ---------------------------------------------------------------- schedule handlers (§B.6)

/** `bookings.remind_N`: the booker's reminder mail (with a fresh manage link) and the hosts' push. */
export function sendReminder(bookingId: string, payload: { minutes?: unknown; booker?: unknown; host?: unknown }, nowMs = Date.now()) {
  const booking = bookingRow(bookingId);
  if (!booking || booking.status !== "confirmed" || Date.parse(booking.start_utc) <= nowMs) return;
  if (payload.booker !== false) mailBooker(booking, "bookings.reminder", { manageUrl: managePath(newManageToken(booking)) }, nowMs);
  if (payload.host !== false) {
    const minutes = Number(payload.minutes ?? 0);
    const lead = minutes >= 1440 ? `${Math.round(minutes / 1440)} day${minutes >= 2880 ? "s" : ""}` : minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${minutes} min`;
    notify({ userIds: [booking.host_id, ...cohostsOf(booking.id)], module: "bookings", topic: "bookings.reminder", title: `In ${lead}: ${booking.type_title} with ${booking.booker_name}`.slice(0, 200),
      href: bookingHref(booking), item: { kind: "booking", id: booking.id }, dedupeKey: `booking:${booking.id}:reminder`, nowMs });
  }
}

/** `bookings.complete`: a confirmed booking that ended becomes completed. */
export function completeBooking(bookingId: string) {
  const booking = bookingRow(bookingId);
  if (!booking || booking.status !== "confirmed") return;
  transition(booking, "completed", {}, null);
}

/** `bookings.pending_expire`: a request nobody approved in time expires (D1007). */
export function expirePending(bookingId: string, nowMs = Date.now()) {
  const booking = bookingRow(bookingId);
  if (!booking || booking.status !== "pending") return;
  declineBooking(booking, null, null, nowMs, "expired");
}
