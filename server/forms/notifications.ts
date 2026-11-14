import { db } from "../db";
import { appName, config } from "../config";
import { notify } from "../notify";
import { layout, paragraph } from "../mail/layout";
import { defineTemplate } from "../mail/templates/types";
import { icsAttachment, singleEventIcs } from "../mail/ics";
import type { RegisteredMailTemplate } from "../mail/registry";
import { formRowById, levelOf, onFormClosed, onResponseSubmitted, setFormStatus, settingsOf, type FormRow } from "./service";
import { retryFailedRuns } from "./actions";
import { formPath } from "../../shared/forms";
import type { ScheduleHandler } from "../schedules/service";

/**
 * Forms notifications (docs/plan/WORKSPACE_MODULES.md §D.1 "Notifications", §B.7, D809): the owner
 * and editors hear about new responses (one unread row per form that updates, "5 responses to
 * *Onboarding survey*", and one email per 15 minutes); a poll's voters hear that it closed; the owner
 * hears a day before a form closes; a time poll's participants hear the chosen time (finalize.ts).
 * Titles name the form only (the recipients can read it); never an answer (T505).
 */

const recipientsOf = (row: FormRow) => {
  const editors = db.query("SELECT user_id FROM item_members WHERE item_kind = 'form' AND item_id = ? AND level IN ('edit','manage')").all(row.id) as Array<{ user_id: string }>;
  return [row.owner_id, ...editors.map((item) => item.user_id)];
};
const resultsHref = (row: FormRow) => formPath(row.title, row.short_id, row.kind === "form" ? "results" : undefined);

type ResponsesMail = { title: string; count: number; href: string };
const responsesTemplate = defineTemplate<ResponsesMail>({
  name: "forms.responses",
  class: "activity",
  category: "forms",
  render: (data, context) => layout({
    instanceName: context.instanceName, subject: `New responses to ${data.title}`, preheader: `${data.count} responses so far`, eyebrow: "Forms", title: `New responses to ${data.title}`,
    lead: `${data.count} ${data.count === 1 ? "response" : "responses"} so far.`, blocks: [paragraph("Open the results to read them.")], action: { label: "Open results", href: data.href },
    footer: { reason: "You get this because you own or edit this form and asked to hear about new responses.", settingsHref: `${config.appOrigin}/settings/notifications` }
  }),
  fixture: () => ({ title: "Onboarding survey", count: 5, href: "https://nook.example/forms/onboarding-survey-0a1b2c3d4e/results" })
});

/** `ics`: the chosen time as a calendar file, built at send time from the payload's UTC times (D1055). */
type FinalMail = { title: string; when: string; stopHref?: string; ics?: string | null };
const finalTemplate = defineTemplate<FinalMail>({
  name: "forms.time_final",
  class: "activity",
  category: "forms",
  render: (data, context) => {
    const rendered = layout({
      instanceName: context.instanceName, subject: `The time is set: ${data.title}`, preheader: data.when, eyebrow: "Find a time", title: data.title,
      lead: `The organizer chose ${data.when}.`, blocks: [paragraph(data.ics ? "Thanks for voting. The time is attached: open the file to add it to your calendar." : "Thanks for voting. Add it to your calendar.")],
      footer: { reason: `You voted on a ${appName()} time poll with this address.`, ...(data.stopHref ? { unsubscribe: { href: data.stopHref, label: "Stop emails about this" } } : {}) }
    });
    return data.ics ? { ...rendered, attachments: [icsAttachment(data.ics, "invite.ics")] } : rendered;
  },
  fixture: () => ({ title: "Team offsite planning", when: "Tue 18 Nov, 14:00–15:00 UTC" })
});

const responsesRegistered: RegisteredMailTemplate<ResponsesMail> = {
  ...responsesTemplate,
  resolve: (payload, recipient) => {
    const row = typeof payload.formId === "string" ? formRowById(payload.formId) : null;
    if (!row || row.deleted_at !== null || levelOf(row, recipient.id) === "none") return { skip: "access_lost" };
    return { data: { title: row.title, count: row.response_count, href: `${config.appOrigin}${resultsHref(row)}` } };
  }
};
const finalRegistered: RegisteredMailTemplate<FinalMail> = {
  ...finalTemplate,
  resolveExternal: (payload) => {
    if (typeof payload.title !== "string" || typeof payload.when !== "string") return { skip: "empty" };
    const timed = typeof payload.start === "string" && typeof payload.end === "string" && typeof payload.uid === "string" && Number.isFinite(Date.parse(payload.start)) && Date.parse(payload.end) > Date.parse(payload.start);
    const ics = timed ? singleEventIcs({ uid: `${payload.uid as string}@nook`, title: payload.title, description: `Chosen in a ${appName()} time poll.`, startUtc: payload.start as string, endUtc: payload.end as string }) : null;
    return { data: { title: payload.title, when: payload.when, ics } };
  }
};
export const formsMailTemplates: Record<string, RegisteredMailTemplate<never>> = { "forms.responses": responsesRegistered as never, "forms.time_final": finalRegistered as never };

onResponseSubmitted((outcome) => {
  const row = outcome.form;
  if (!outcome.created || !settingsOf(row).notifyOnResponse) return;
  const vote = row.kind !== "form";
  db.transaction(() => notify({
    userIds: recipientsOf(row), module: "forms", topic: vote ? "forms.vote" : "forms.response",
    title: `${vote ? "New votes on" : "New responses to"} “${row.title}”`.slice(0, 200), body: `${row.response_count} ${vote ? (row.response_count === 1 ? "vote" : "votes") : row.response_count === 1 ? "response" : "responses"} so far`,
    href: resultsHref(row), item: { kind: "form", id: row.id }, actor: outcome.response.respondent.userId ?? null, dedupeKey: `forms.responses:${row.id}`,
    ...(vote ? {} : { email: { template: "forms.responses", payload: { formId: row.id }, coalesceKey: `forms.responses:${row.id}`, windowMs: 15 * 60_000 } })
  }))();
});

onFormClosed((row, actorId) => {
  if (row.kind === "form" || row.anonymous) return;
  const voters = db.query("SELECT DISTINCT respondent_user_id AS id FROM responses WHERE host_kind = 'form' AND host_id = ? AND respondent_user_id IS NOT NULL").all(row.id) as Array<{ id: string }>;
  if (!voters.length) return;
  notify({
    userIds: voters.map((voter) => voter.id), module: "forms", topic: "forms.closed", title: `${row.kind === "poll" ? "Poll" : "Time poll"} closed: “${row.title}”`.slice(0, 200),
    href: formPath(row.title, row.short_id), item: { kind: "form", id: row.id }, actor: actorId, dedupeKey: `forms.closed:${row.id}`
  });
});

export const formsScheduleHandlers: Record<string, ScheduleHandler> = {
  "forms.close": {
    run: (schedule) => {
      const row = formRowById(schedule.owner.id);
      if (!row || row.deleted_at !== null || row.status !== "open" || !row.closes_at || Date.parse(row.closes_at) > Date.now() + 1000) return;
      setFormStatus(null, row.id, "closed");
    }
  },
  "forms.closing": {
    run: (schedule) => {
      const row = formRowById(schedule.owner.id);
      if (!row || row.deleted_at !== null || row.status !== "open" || !row.closes_at) return;
      notify({
        userIds: [row.owner_id], module: "forms", topic: "forms.closing", title: `“${row.title}” closes in 24 hours`.slice(0, 200), body: `${row.response_count} responses so far`,
        href: resultsHref(row), item: { kind: "form", id: row.id }, dedupeKey: `forms.closing:${row.id}`
      });
    }
  },
  "forms.actions_retry": {
    run: async (schedule) => { await retryFailedRuns(schedule.owner.id); }
  }
};
