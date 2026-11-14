import { layout, paragraph } from "../mail/layout";
import { defineTemplate } from "../mail/templates/types";
import { activityFooter, itemTitle } from "../mail/templates/common";
import { appLink } from "../mail/links";
import type { RegisteredMailTemplate } from "../mail/registry";
import { isValidTimeZone } from "../../shared/calendarRecurrence";
import { levelOn, sessionHref, sessionRow } from "./service";

/**
 * Townhall mail (D1081 follow-up, D1055): the reminder before a session starts also goes by email to
 * the team members it notifies, under the module's "Townhall" email switch (Settings → Notifications;
 * one-click unsubscribe). Members only: the audience link's outside participants get nothing. The
 * payload holds the session id; the title, time, and access are read again at send time, so a session
 * that went live, ended, moved to the Bin, or was unshared in the meantime sends nothing.
 */

type ReminderMail = { title: string; when: string; href: string };

/** "Tue 18 Nov, 14:00 (Europe/Paris)" in the recipient's zone. */
export function startWords(iso: string, tz: string) {
  const zone = isValidTimeZone(tz) ? tz : "UTC";
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return `${day}, ${time} (${zone})`;
}

const reminderTemplate = defineTemplate<ReminderMail>({
  name: "townhall.reminder",
  class: "reminders",
  category: "townhall",
  render: (data, context) => layout({
    instanceName: context.instanceName, subject: `Starting soon: ${itemTitle(data.title)}`, preheader: data.when, eyebrow: "Townhall", title: itemTitle(data.title),
    lead: `It starts ${data.when}.`, blocks: [paragraph("Add your questions and upvote the ones you want answered before it starts.")],
    action: { label: "Open the session", href: data.href },
    footer: activityFooter("townhall", "You got this because you take part in this townhall.", context)
  }),
  fixture: () => ({ title: "Q4 all-hands", when: "Tue 18 Nov, 14:00 (Europe/Paris)", href: "https://nook.example/townhall/q4-all-hands-0abc123def" })
});

export const townhallMailTemplates: Record<string, RegisteredMailTemplate<never>> = {
  "townhall.reminder": {
    ...reminderTemplate,
    resolve: (payload: Record<string, unknown>, recipient: { id: string; tz: string }) => {
      const row = typeof payload.sessionId === "string" ? sessionRow(payload.sessionId) : null;
      if (!row || row.deleted_at !== null || row.state !== "upcoming" || !row.starts_at) return { skip: "empty" as const };
      if (levelOn(row, recipient.id) === "none") return { skip: "access_lost" as const };
      return { data: { title: row.title, when: startWords(row.starts_at, recipient.tz), href: appLink(sessionHref(row)) } };
    }
  } as unknown as RegisteredMailTemplate<never>
};
