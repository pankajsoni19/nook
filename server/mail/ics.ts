import type { MailAttachment } from "../mail";
import { escapeText, foldLine } from "../calendar/ics";

/**
 * Calendar attachments for mail (D1053, T598). One VEVENT in UTC, every TEXT value escaped and every
 * line folded by the calendar feed's own helpers (server/calendar/ics.ts), CRLF endings. `METHOD` is
 * PUBLISH ("add this to your calendar"): Nook sends no ORGANIZER or ATTENDEE, so no client treats it
 * as an invitation to answer; CANCEL removes an earlier one with the same UID. The UID is chosen by
 * the caller (never an internal id for outside addresses) and kept across reschedules, with SEQUENCE
 * raised, so a calendar that imported the first file updates the event instead of adding a second.
 */

export type MailEvent = {
  uid: string;
  sequence?: number;
  title: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  startUtc: string;
  endUtc: string;
  stampUtc?: string;
  method?: "PUBLISH" | "CANCEL";
};

const compactUtc = (iso: string) => `${new Date(iso).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
// A UID is a short token of our own: anything else in it is dropped so it can never break the line.
const safeUid = (uid: string) => uid.replace(/[^A-Za-z0-9@._-]/g, "").slice(0, 120) || "event";

export function singleEventIcs(event: MailEvent) {
  const method = event.method ?? "PUBLISH";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Nook//Mail//EN", "CALSCALE:GREGORIAN", `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${safeUid(event.uid)}`,
    `SEQUENCE:${Math.max(0, Math.min(1000, Math.trunc(event.sequence ?? 0)))}`,
    `DTSTAMP:${compactUtc(event.stampUtc ?? new Date().toISOString())}`,
    `DTSTART:${compactUtc(event.startUtc)}`,
    `DTEND:${compactUtc(event.endUtc)}`,
    `SUMMARY:${escapeText(event.title.slice(0, 300))}`
  ];
  if (event.location) lines.push(`LOCATION:${escapeText(event.location.slice(0, 500))}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description.slice(0, 4000))}`);
  // A URL value is not TEXT: only an http(s) address without spaces or control characters is written.
  if (event.url && /^https?:\/\/[^\s\u0000-\u001f\u007f]+$/.test(event.url) && event.url.length <= 2000) lines.push(`URL:${event.url}`);
  lines.push(method === "CANCEL" ? "STATUS:CANCELLED" : "STATUS:CONFIRMED", "TRANSP:OPAQUE", "END:VEVENT", "END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/** The attachment of a calendar file; the content type's method matches the file's METHOD. */
export function icsAttachment(ics: string, filename = "invite.ics"): MailAttachment {
  const method = /^METHOD:(PUBLISH|REQUEST|CANCEL)\r?$/m.exec(ics)?.[1] ?? "PUBLISH";
  return { filename, contentType: `text/calendar; charset=utf-8; method=${method}`, content: ics };
}
