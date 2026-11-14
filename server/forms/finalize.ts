import { audit, db, now } from "../db";
import { CalendarError, createEvent } from "../calendar/service";
import { createLink } from "../links/service";
import { notify, enqueueExternalMail } from "../notify";
import { recordItemActivity } from "../activity/service";
import { currentSet } from "../questions/service";
import { isValidTimeZone, utcToZoned } from "../../shared/calendarRecurrence";
import { formPath } from "../../shared/forms";
import { keyedHash } from "../public/secret";
import { FormError, formRowById, host, requireForm, syncSchedules, type FormRow } from "./service";

/**
 * Finalizing a time poll (docs/plan/WORKSPACE_MODULES.md §C C19, D846): the organizer (an editor of
 * the poll) picks one proposed time; it becomes an event in a calendar they can write, the poll
 * closes, the event and the poll are linked (event `source` ← form), the workspace participants
 * (named voters and the people chosen) are notified, and outside voters who left an email get one
 * email with the time and a calendar file of it (§B.7 caps, a stop link; never more than once per address; D1055).
 */

/** "Tue 18 Nov 2026, 14:00–15:00 (Europe/Paris)" in a zone. */
export function slotWords(start: string, end: string, tz: string) {
  const zone = isValidTimeZone(tz) ? tz : "UTC";
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(start));
  const time = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  return `${day}, ${time(start)}–${time(end)} (${zone})`;
}

export async function finalizeTimePoll(userId: string, ref: string, input: { slotId: string; calendarId?: string | null; tz?: string; inviteUserIds?: string[]; emailGuests?: boolean }) {
  const { row } = requireForm(ref, userId, "edit");
  if (row.kind !== "time_poll") throw new FormError(400, "INVALID", "Only a time poll is finalized");
  if (row.finalized_slot_id) throw new FormError(409, "ALREADY_FINALIZED", "This time poll already has a time");
  const set = currentSet(host(row.id))?.set;
  const question = set?.questions.find((item) => item.type === "time_slots");
  const slot = question?.slots?.find((item) => item.id === input.slotId);
  if (!slot) throw new FormError(400, "INVALID", "Choose one of the proposed times");
  const tz = input.tz && isValidTimeZone(input.tz) ? input.tz : "UTC";
  const calendarId = input.calendarId ?? row.calendar_id;
  const participants = db.query(`SELECT DISTINCT respondent_user_id AS id FROM responses WHERE host_kind = 'form' AND host_id = ? AND status = 'submitted' AND respondent_user_id IS NOT NULL`).all(row.id) as Array<{ id: string }>;
  const names = db.query(`SELECT COALESCE(u.display_name, r.respondent_name, 'Guest') AS name FROM responses r LEFT JOIN users u ON u.id = r.respondent_user_id
    WHERE r.host_kind = 'form' AND r.host_id = ? AND r.status = 'submitted' AND r.respondent_kind <> 'anonymous' ORDER BY r.submitted_at LIMIT 100`).all(row.id) as Array<{ name: string }>;
  let eventId: string | null = null;
  if (calendarId) {
    const minutes = Math.max(5, Math.round((Date.parse(slot.end) - Date.parse(slot.start)) / 60_000));
    const description = [`Chosen in the time poll [${row.title}](${formPath(row.title, row.short_id)}).`, names.length ? `Voters: ${names.map((item) => item.name).join(", ")}` : ""].filter(Boolean).join("\n\n");
    try {
      const created = createEvent(userId, calendarId, { title: row.title, description: description.slice(0, 20_000), allDay: false, startLocal: utcToZoned(Date.parse(slot.start), tz), tz, durationMinutes: Math.min(minutes, 10_080) });
      eventId = created.event.id;
    } catch (error) {
      if (error instanceof CalendarError) throw new FormError(error.status === 429 ? 409 : error.status === 403 ? 403 : 400, error.code ?? "CALENDAR", error.message);
      throw error;
    }
  }
  const when = slotWords(slot.start, slot.end, tz);
  const guests = input.emailGuests === false ? [] : db.query(`SELECT DISTINCT lower(respondent_email) AS email FROM responses WHERE host_kind = 'form' AND host_id = ? AND status = 'submitted' AND respondent_email IS NOT NULL LIMIT 100`).all(row.id) as Array<{ email: string }>;
  let emailed = 0;
  // The calendar file's UID (D1055): a keyed hash of the poll, so outside mail never carries its id.
  const icsUid = keyedHash("forms-time-final", row.id).slice(0, 32);
  const finalized = db.transaction((): FormRow => {
    const timestamp = now();
    db.query("UPDATE forms SET finalized_slot_id = ?, finalized_event_id = ?, calendar_id = COALESCE(?, calendar_id), status = 'closed', closed_at = COALESCE(closed_at, ?), updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(slot.id, eventId, calendarId ?? null, timestamp, timestamp, row.id);
    if (eventId) { try { createLink({ a: { kind: "event", id: eventId }, b: { kind: "form", id: row.id }, relation: "source", actorId: userId }); } catch { /* the event stands without the link */ } }
    recordItemActivity({ itemKind: "form", itemId: row.id, actorId: userId, kind: "finalized", payload: { extra: { slot: slot.id, event: eventId !== null } } });
    const invitees = [...new Set([...participants.map((item) => item.id), ...(input.inviteUserIds ?? []).map((id) => id.toLowerCase())])];
    notify({
      userIds: invitees, module: "forms", topic: "forms.finalized", title: `Time set for “${row.title}”`.slice(0, 200), body: when.slice(0, 500),
      href: eventId ? `/calendar/event/${eventId}` : formPath(row.title, row.short_id), item: { kind: "form", id: row.id }, actor: userId, dedupeKey: `forms.finalized:${row.id}`
    });
    for (const guest of guests) if (enqueueExternalMail({ to: guest.email, template: "forms.time_final", payload: { title: row.title, when, start: slot.start, end: slot.end, uid: icsUid }, itemRef: { kind: "form", id: row.id } })) emailed += 1;
    audit(userId, null, "forms.finalize", { formId: row.id, slotId: slot.id, eventId, invited: invitees.length, emailed });
    const next = formRowById(row.id)!;
    syncSchedules(next);
    return next;
  })();
  return { form: finalized, eventId, emailed, when };
}
