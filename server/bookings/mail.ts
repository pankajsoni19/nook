import { appLink } from "../mail/links";
import { context, layout, note, paragraph, type Block } from "../mail/layout";
import { defineTemplate } from "../mail/templates/types";
import type { RegisteredMailTemplate } from "../mail/registry";
import { appName } from "../config";
import { formatWhen, LOCATION_LABELS, STATUS_LABELS } from "../../shared/bookings";
import { bookingAccess, bookingHref, bookingRow, userName } from "./model";
import { bookingIcs } from "./service";
import { icsAttachment } from "../mail/ics";

/**
 * Bookings mail (§D.6, §B.7): six templates to the booker's own address (enqueueExternalMail caps,
 * suppression, and a "Stop emails about this booking" link) and one to hosts (notify, the module's
 * mail category). Bookers' mail carries the manage link (reschedule / cancel, D1004) and an "Add to
 * calendar" ICS link of that booking; confirmations and new times also attach that ICS (D1054, which
 * replaces D1017's link-only mail; the link stays as a fallback for clients that drop attachments). Mail never prints an internal id; the payload's ids are read back at send time,
 * so a cancelled booking's reminder is skipped.
 */

type BookerMail = {
  kind: "confirmed" | "pending" | "declined" | "cancelled" | "rescheduled" | "reminder";
  typeTitle: string; when: string; previous: string | null; location: string; locationKind: string; hostName: string;
  manageHref: string | null; icsHref: string | null; reason: string | null; by: string | null; stopHref?: string;
  /** The booking's ICS, read at send time, attached to confirmations and new times (D1054). */
  ics?: string | null;
};

/** Kinds whose mail carries the booking as an attachment. */
export const ICS_ATTACHED_KINDS: ReadonlySet<BookerMail["kind"]> = new Set(["confirmed", "rescheduled"]);

const SUBJECTS: Record<BookerMail["kind"], (data: BookerMail) => string> = {
  confirmed: (data) => `Confirmed: ${data.typeTitle} with ${data.hostName}`,
  pending: (data) => `Requested: ${data.typeTitle} with ${data.hostName}`,
  declined: (data) => `Not confirmed: ${data.typeTitle} with ${data.hostName}`,
  cancelled: (data) => `Cancelled: ${data.typeTitle} with ${data.hostName}`,
  rescheduled: (data) => `New time: ${data.typeTitle} with ${data.hostName}`,
  reminder: (data) => `Reminder: ${data.typeTitle} with ${data.hostName}`
};
const LEADS: Record<BookerMail["kind"], string> = {
  confirmed: "You're booked. The details are below.",
  pending: "Your request was sent. You'll get another email when it is confirmed.",
  declined: "The host could not confirm this time. You can book another one.",
  cancelled: "This booking was cancelled.",
  rescheduled: "Your booking has a new time.",
  reminder: "This is a reminder of your upcoming booking."
};

function bookerTemplate(kind: BookerMail["kind"]) {
  return defineTemplate<BookerMail>({
    name: `bookings.${kind}`,
    class: kind === "reminder" ? "reminders" : "activity",
    render(data, ctx) {
      const rows = [
        { title: data.when, meta: data.previous ? `Was ${data.previous}` : undefined },
        { title: data.location ? `${LOCATION_LABELS[data.locationKind as keyof typeof LOCATION_LABELS] ?? "Where"}: ${data.location}` : LOCATION_LABELS[data.locationKind as keyof typeof LOCATION_LABELS] ?? "Location to follow" },
        { title: `Host: ${data.hostName}` }
      ];
      const blocks: Block[] = [context(rows)];
      if (data.reason) blocks.push(paragraph(`Message: ${data.reason}`));
      if (data.icsHref && kind !== "cancelled" && kind !== "declined") blocks.push(paragraph(`Add it to your calendar: ${data.icsHref}`));
      if (!data.manageHref && (kind === "confirmed" || kind === "pending")) blocks.push(note("Keep this email: it is the record of your booking."));
      const rendered = layout({
        instanceName: ctx.instanceName, subject: SUBJECTS[kind](data), preheader: `${data.typeTitle}, ${data.when}`, eyebrow: "Booking", title: data.typeTitle, lead: LEADS[kind], blocks,
        ...(data.manageHref && kind !== "cancelled" && kind !== "declined" ? { action: { label: "Reschedule or cancel", href: data.manageHref } } : {}),
        footer: { reason: `You got this because you booked time on ${appName()}.`, ...(data.stopHref ? { unsubscribe: { href: data.stopHref, label: "Stop emails about this booking" } } : {}) }
      });
      return data.ics && ICS_ATTACHED_KINDS.has(kind) ? { ...rendered, attachments: [icsAttachment(data.ics, "booking.ics")] } : rendered;
    },
    fixture: () => ({ kind, typeTitle: "Intro call", when: "Tue 3 Mar 2026, 09:30–10:00 (Europe/Berlin)", previous: kind === "rescheduled" ? "Mon 2 Mar 2026, 09:30–10:00 (Europe/Berlin)" : null,
      location: "https://meet.example.test/intro", locationKind: "video_link", hostName: "Priya Shah", manageHref: "https://nook.example.test/p/book/manage/TOKEN", icsHref: "https://nook.example.test/api/public/bookings/manage/TOKEN/ics",
      reason: kind === "cancelled" ? "Something came up." : null, by: null })
  });
}

function resolveBooker(kind: BookerMail["kind"]): RegisteredMailTemplate<BookerMail>["resolveExternal"] {
  return (payload) => {
    const booking = typeof payload.bookingId === "string" ? bookingRow(payload.bookingId) : null;
    if (!booking) return { skip: "empty" };
    if (kind === "reminder" && booking.status !== "confirmed") return { skip: "empty" };
    const tz = booking.booker_tz;
    const manage = typeof payload.manageUrl === "string" && payload.manageUrl.startsWith("/p/book/manage/") ? payload.manageUrl : null;
    return { data: {
      kind, typeTitle: booking.type_title, when: formatWhen(booking.start_utc, booking.end_utc, tz),
      previous: typeof payload.previousStart === "string" ? formatWhen(payload.previousStart, new Date(Date.parse(payload.previousStart) + booking.duration_min * 60_000).toISOString(), tz) : null,
      location: booking.location_resolved, locationKind: booking.location_kind, hostName: userName(booking.host_id),
      manageHref: manage ? appLink(manage) : null, icsHref: manage ? appLink(`/api/public/bookings/manage/${manage.slice("/p/book/manage/".length)}/ics`) : null,
      reason: typeof payload.reason === "string" && payload.reason ? payload.reason.slice(0, 500) : null, by: typeof payload.by === "string" ? payload.by : null,
      ics: ICS_ATTACHED_KINDS.has(kind) && booking.status === "confirmed" ? bookingIcs(booking) : null
    } };
  };
}

type HostMail = { topic: string; typeTitle: string; bookerName: string; when: string; status: string; href: string };
const hostTemplate = defineTemplate<HostMail>({
  name: "bookings.host_update",
  class: "activity",
  category: "bookings",
  render(data, ctx) {
    const title = data.topic === "bookings.pending" ? "A booking needs your approval" : data.topic === "bookings.cancelled" ? "A booking was cancelled"
      : data.topic === "bookings.rescheduled" ? "A booking was rescheduled" : "You have a new booking";
    return layout({
      instanceName: ctx.instanceName, subject: `${title}: ${data.typeTitle} with ${data.bookerName}`, preheader: data.when, eyebrow: "Bookings", title,
      blocks: [context([{ title: `${data.typeTitle} with ${data.bookerName}`, meta: `${data.when} · ${data.status}`, href: data.href }])],
      action: { label: "Open booking", href: data.href },
      footer: { reason: "You got this because you host this booking type.", ...(ctx.unsubscribeHref ? { unsubscribe: { href: ctx.unsubscribeHref, label: "Turn off Bookings emails" } } : {}) }
    });
  },
  fixture: () => ({ topic: "bookings.new", typeTitle: "Intro call", bookerName: "Ana Silva", when: "Tue 3 Mar 2026, 09:30–10:00 (Europe/Berlin)", status: "Confirmed", href: "https://nook.example.test/bookings/b/k7f3q2ab01" })
});

export const BOOKER_TEMPLATE_KINDS = ["confirmed", "pending", "declined", "cancelled", "rescheduled", "reminder"] as const;

export function bookingsMailTemplates(): Record<string, RegisteredMailTemplate<never>> {
  const templates: Record<string, RegisteredMailTemplate<never>> = {};
  for (const kind of BOOKER_TEMPLATE_KINDS) templates[`bookings.${kind}`] = { ...bookerTemplate(kind), resolveExternal: resolveBooker(kind) } as unknown as RegisteredMailTemplate<never>;
  templates["bookings.host_update"] = {
    ...hostTemplate,
    resolve: (payload: Record<string, unknown>, recipient: { id: string; tz: string }) => {
      const booking = typeof payload.bookingId === "string" ? bookingRow(payload.bookingId) : null;
      if (!booking) return { skip: "empty" };
      if (!bookingAccess(booking, recipient.id)) return { skip: "access_lost" };
      return { data: { topic: String(payload.topic ?? ""), typeTitle: booking.type_title, bookerName: booking.booker_name, when: formatWhen(booking.start_utc, booking.end_utc, recipient.tz), status: STATUS_LABELS[booking.status], href: appLink(bookingHref(booking)) } };
    }
  } as unknown as RegisteredMailTemplate<never>;
  return templates;
}
