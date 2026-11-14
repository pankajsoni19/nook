import type { Context } from "hono";
import { listPipelines } from "../crm/deals";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { db } from "../db";
import { parseJson } from "../validation";
import type { ModuleRouter } from "../workspaceRegistry";
import { readableIds } from "../access/workspaceItems";
import { listBoards, listColumns } from "../tasks/service";
import { listCalendars } from "../calendar/service";
import { createContactBook, PeopleError } from "../people/contacts";
import { canWriteContent } from "../team/userRole";
import {
  binForm, createForm, createFormPublicLink, createPoll, createTimePoll, deleteFormResponse, discardFormDraft, duplicateForm, editableSet, FormError, formDetail, formSummary,
  getFormResponse, listCounts, listForms, listResponses, parseFilter, publishForm, recordVisit, requireForm, respondView, retractVote, revokeFormPublicLink,
  saveFormDraft, setFormStatus, submitMemberResponse, updateFormSettings
} from "./service";
import { createAction, deleteAction, listActions, retryRun, updateAction } from "./actions";
import { finalizeTimePoll } from "./finalize";
import { exportCsv } from "../questions/service";
import { audit } from "../db";
import { FORM_ACTION_KINDS, FORM_AUDIENCES, FORM_DISPLAYS, FORM_KINDS, FORM_STATUSES, FORM_TEMPLATES, LIMIT_PER, RESULTS_VISIBILITIES } from "../../shared/forms";

/**
 * Forms over HTTP (docs/plan/WORKSPACE_MODULES.md §D.1 "HTTP", API_CONTRACTS "Forms"): every route is
 * behind the session, CSRF, two-factor, and role guards (T500); `:id` is a UUID or a short id. Errors
 * are `{ error, code }`; unreadable and missing are the same 404 (T90).
 */

function fail(c: Context<AppEnv>, error: unknown) {
  if (error instanceof FormError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  if (error instanceof PeopleError) return c.json({ error: error.message, code: error.code }, error.status as 400);
  throw error;
}
const handle = (run: (c: Context<AppEnv>) => Response | Promise<Response>) => async (c: Context<AppEnv>) => {
  try { return await run(c); } catch (error) { return fail(c, error); }
};
const user = (c: Context<AppEnv>) => c.get("user").id;
const idOf = (c: Context<AppEnv>) => c.req.param("id") ?? "";

const iso = z.string().max(40).nullable();
export const settingsSchema = z.object({
  title: z.string().max(200), description: z.string().max(20_000), audience: z.enum(FORM_AUDIENCES), audienceUsers: z.array(z.string().uuid()).max(200), audienceGroups: z.array(z.string().uuid()).max(50),
  anonymous: z.boolean(), limitPer: z.enum(LIMIT_PER), allowEdit: z.boolean(), resultsVisibility: z.enum(RESULTS_VISIBILITIES), display: z.enum(FORM_DISPLAYS), opensAt: iso, closesAt: iso,
  maxResponses: z.number().int().min(1).max(100_000).nullable(), verifyEmail: z.boolean(), theme: z.object({ accent: z.string().max(7).nullable() }).partial(),
  ending: z.object({ title: z.string().max(200), body: z.string().max(5000) }).partial(), settings: z.object({ notifyOnResponse: z.boolean(), showProgress: z.boolean(), allowAnother: z.boolean() }).partial(),
  calendarId: z.string().uuid().nullable()
}).partial().strict();

const createSchema = z.object({
  kind: z.enum(FORM_KINDS), title: z.string().max(200).optional(), description: z.string().max(20_000).optional(), template: z.enum(FORM_TEMPLATES).optional(),
  questions: z.unknown().optional(), publish: z.boolean().optional(), settings: settingsSchema.optional()
}).strict();
const pollSchema = z.object({
  question: z.string().max(200), options: z.array(z.string().max(200)).min(2).max(20), multiple: z.boolean().optional(), anonymous: z.boolean().optional(),
  closesAt: iso.optional(), resultsVisibility: z.enum(RESULTS_VISIBILITIES).optional(), audience: z.enum(FORM_AUDIENCES).optional(),
  audienceUsers: z.array(z.string().uuid()).max(200).optional(), audienceGroups: z.array(z.string().uuid()).max(50).optional()
}).strict();
const timePollSchema = z.object({
  title: z.string().max(200), description: z.string().max(20_000).optional(), slots: z.array(z.object({ start: z.string().max(40), end: z.string().max(40) })).min(1).max(60),
  allowMaybe: z.boolean().optional(), closesAt: iso.optional(), calendarId: z.string().uuid().nullable().optional(), audience: z.enum(FORM_AUDIENCES).optional(),
  audienceUsers: z.array(z.string().uuid()).max(200).optional(), audienceGroups: z.array(z.string().uuid()).max(50).optional()
}).strict();
const answerSchema = z.object({ answers: z.record(z.string().max(16), z.unknown()), responseId: z.string().uuid().nullish(), hidden: z.record(z.string().max(16), z.string().max(500)).optional(), expectedRevision: z.number().int().optional() }).strict();

export function registerFormsRoutes(router: ModuleRouter) {
  router.get("/api/forms", handle((c) => {
    const tab = c.req.query("tab");
    const kind = c.req.query("kind");
    const status = c.req.query("status");
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(listForms(user(c), {
      tab: tab === "mine" || tab === "shared" || tab === "answer" ? tab : "all",
      kind: (FORM_KINDS as readonly string[]).includes(kind ?? "") ? kind as never : undefined,
      status: (FORM_STATUSES as readonly string[]).includes(status ?? "") ? status as never : undefined,
      q: c.req.query("q") ?? undefined, cursor: c.req.query("cursor") ?? null, limit: Number.isFinite(limit) ? limit : 50
    }));
  }));
  router.get("/api/forms/counts", handle((c) => c.json(listCounts(user(c)))));
  // Where actions and finalizing can write: boards with columns, contact books, calendars (as the caller).
  router.get("/api/forms/targets", handle((c) => {
    const userId = user(c);
    const boards = (listBoards(userId) as Array<{ id: string; name: string; level?: string; role?: string }>).filter((board) => board.level === undefined || ["owner", "manage", "edit"].includes(String(board.level)))
      .slice(0, 200).map((board) => ({ id: board.id, name: board.name, columns: listColumns(board.id).map((column) => ({ id: column.id, name: column.name })) }));
    const bookIds = readableIds("contact_book", userId, "edit");
    const books = (bookIds.length ? db.query(`SELECT id, name FROM contact_books WHERE system_kind IS NULL AND deleted_at IS NULL AND id IN (${bookIds.map(() => "?").join(",")}) ORDER BY name COLLATE NOCASE`).all(...bookIds) as Array<{ id: string; name: string }> : [])
      // Pipelines and stages for "Create a deal" (C3, D1045).
      .map((book) => ({ ...book, pipelines: listPipelines(book.id, userId).map((pipeline) => ({ id: pipeline.id, name: pipeline.name, stages: pipeline.stages.filter((stage) => stage.kind === "open").map((stage) => ({ id: stage.id, name: stage.name })) })) }));
    const calendars = listCalendars(userId).calendars.filter((calendar) => calendar.role === "owner" || calendar.role === "editor" || String(calendar.role) === "edit").map((calendar) => ({ id: calendar.id, name: calendar.name }));
    return c.json({ boards, books, calendars });
  }));
  router.post("/api/forms/contact-books", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ name: z.string().min(1).max(120) }).strict());
    if (!canWriteContent(user(c))) return c.json({ error: "Read-only role", code: "ROLE_READ_ONLY" }, 403);
    const id = db.transaction(() => createContactBook({ ownerId: user(c), name: body.name }))();
    return c.json({ book: { id, name: body.name.trim() } }, 201);
  }));
  router.post("/api/forms", handle(async (c) => {
    const body = await parseJson(c.req.raw, createSchema);
    const row = createForm(user(c), { kind: body.kind, title: body.title, description: body.description, template: body.template, questions: body.questions as never, publish: body.publish, settings: body.settings });
    return c.json({ form: formDetail(row, user(c)) }, 201);
  }));
  router.post("/api/forms/polls", handle(async (c) => {
    const body = await parseJson(c.req.raw, pollSchema);
    return c.json({ form: formDetail(createPoll(user(c), body), user(c)) }, 201);
  }));
  router.post("/api/forms/time-polls", handle(async (c) => {
    const body = await parseJson(c.req.raw, timePollSchema);
    return c.json({ form: formDetail(createTimePoll(user(c), body), user(c)) }, 201);
  }));
  router.get("/api/forms/:id", handle((c) => {
    const { row, level } = requireForm(idOf(c), user(c), "respond");
    if (level === "none") return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    return c.json({ form: formDetail(row, user(c)) });
  }));
  router.patch("/api/forms/:id", handle(async (c) => {
    const body = await parseJson(c.req.raw, settingsSchema.extend({ status: z.enum(["open", "closed"]).optional(), expectedRevision: z.number().int().optional() }));
    const { status, expectedRevision, ...patch } = body;
    let row = Object.keys(patch).length ? updateFormSettings(user(c), idOf(c), patch, expectedRevision) : requireForm(idOf(c), user(c), "edit").row;
    if (status) row = setFormStatus(user(c), row.id, status);
    return c.json({ form: formDetail(row, user(c)) });
  }));
  router.delete("/api/forms/:id", handle((c) => { binForm(user(c), idOf(c)); return c.json({ binned: true }); }));
  router.get("/api/forms/:id/draft", handle((c) => {
    const { row } = requireForm(idOf(c), user(c), "edit");
    return c.json(editableSet(row.id));
  }));
  router.put("/api/forms/:id/draft", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ set: z.unknown() }).strict());
    return c.json(saveFormDraft(user(c), idOf(c), body.set));
  }));
  router.delete("/api/forms/:id/draft", handle((c) => c.json({ form: formDetail(discardFormDraft(user(c), idOf(c)), user(c)) })));
  router.post("/api/forms/:id/publish", handle((c) => c.json({ form: formDetail(publishForm(user(c), idOf(c)), user(c)) })));
  router.post("/api/forms/:id/duplicate", handle((c) => c.json({ form: formDetail(duplicateForm(user(c), idOf(c)), user(c)) }, 201)));
  router.get("/api/forms/:id/respond", handle((c) => c.json(respondView(user(c), idOf(c)))));
  router.post("/api/forms/:id/visit", handle((c) => { const { row } = requireForm(idOf(c), user(c), "respond"); recordVisit(row.id, "starts"); return c.body(null, 204); }));
  router.post("/api/forms/:id/responses", handle(async (c) => {
    const body = await parseJson(c.req.raw, answerSchema);
    const outcome = submitMemberResponse(user(c), idOf(c), body);
    return c.json({ responseId: outcome.response.id, ending: outcome.ending, updated: !outcome.created, view: respondView(user(c), outcome.form.id) }, outcome.created ? 201 : 200);
  }));
  router.put("/api/forms/:id/responses/:rid", handle(async (c) => {
    const body = await parseJson(c.req.raw, answerSchema);
    const outcome = submitMemberResponse(user(c), idOf(c), { ...body, responseId: c.req.param("rid") });
    return c.json({ responseId: outcome.response.id, ending: outcome.ending, updated: !outcome.created, view: respondView(user(c), outcome.form.id) });
  }));
  router.delete("/api/forms/:id/vote", handle((c) => { retractVote(user(c), idOf(c)); return c.json({ view: respondView(user(c), idOf(c)) }); }));
  router.get("/api/forms/:id/responses", handle((c) => {
    const filter = parseFilter({ question: c.req.query("question"), option: c.req.query("option"), since: c.req.query("since"), until: c.req.query("until") });
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(listResponses(user(c), idOf(c), filter, c.req.query("cursor") ?? null, Number.isFinite(limit) ? limit : 50));
  }));
  router.get("/api/forms/:id/responses/:rid", handle((c) => c.json(getFormResponse(user(c), idOf(c), c.req.param("rid") ?? ""))));
  router.delete("/api/forms/:id/responses/:rid", handle((c) => c.json(deleteFormResponse(user(c), idOf(c), c.req.param("rid") ?? ""))));
  router.get("/api/forms/:id/summary", handle((c) => c.json(formSummary(user(c), idOf(c), parseFilter({ question: c.req.query("question"), option: c.req.query("option"), since: c.req.query("since"), until: c.req.query("until") })))));
  router.get("/api/forms/:id/export.csv", handle((c) => {
    const { row } = requireForm(idOf(c), user(c), "view");
    const filter = parseFilter({ question: c.req.query("question"), option: c.req.query("option") });
    const csv = exportCsv({ kind: "form", id: row.id }, filter, { identity: row.anonymous === 0, dayOnly: row.anonymous === 1 });
    audit(user(c), null, "forms.export", { formId: row.id, bytes: csv.length });
    const name = `${row.title.replace(/[^A-Za-z0-9 _-]+/g, "").trim().slice(0, 60) || "responses"}.csv`;
    return new Response(`﻿${csv}`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
  }));
  router.get("/api/forms/:id/actions", handle((c) => c.json({ actions: listActions(user(c), idOf(c)) })));
  router.post("/api/forms/:id/actions", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ kind: z.enum(FORM_ACTION_KINDS), config: z.unknown(), enabled: z.boolean().optional() }).strict());
    return c.json({ action: createAction(user(c), idOf(c), body) }, 201);
  }));
  router.patch("/api/forms/:id/actions/:aid", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ config: z.unknown().optional(), enabled: z.boolean().optional() }).strict());
    return c.json({ action: updateAction(user(c), idOf(c), c.req.param("aid") ?? "", body) });
  }));
  router.delete("/api/forms/:id/actions/:aid", handle((c) => { deleteAction(user(c), idOf(c), c.req.param("aid") ?? ""); return c.body(null, 204); }));
  router.post("/api/forms/:id/actions/:aid/retry", handle(async (c) => c.json({ retried: await retryRun(user(c), idOf(c), c.req.param("aid") ?? "") })));
  router.post("/api/forms/:id/finalize", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ slotId: z.string().max(16), calendarId: z.string().uuid().nullable().optional(), tz: z.string().max(64).optional(), inviteUserIds: z.array(z.string().uuid()).max(100).optional(), emailGuests: z.boolean().optional() }).strict());
    const result = await finalizeTimePoll(user(c), idOf(c), body);
    return c.json({ form: formDetail(result.form, user(c)), eventId: result.eventId, emailed: result.emailed, when: result.when });
  }));
  router.post("/api/forms/:id/public-link", handle((c) => {
    const created = createFormPublicLink(user(c), idOf(c));
    return c.json({ token: created.token, path: `/p/f/${created.token}`, link: created.link }, 201);
  }));
  router.delete("/api/forms/:id/public-link", handle((c) => c.json({ revoked: revokeFormPublicLink(user(c), idOf(c)) })));
}

export const formsReadOnlyWrites = [
  { method: "POST" as const, path: "/api/forms/:id/responses", roles: ["guest", "viewer"] as const, why: "answer a form or poll shared with them (the handler checks the audience)" },
  { method: "PUT" as const, path: "/api/forms/:id/responses/:rid", roles: ["guest", "viewer"] as const, why: "edit their own response where the form allows it" },
  { method: "DELETE" as const, path: "/api/forms/:id/vote", roles: ["guest", "viewer"] as const, why: "take back their own vote on a poll" },
  { method: "POST" as const, path: "/api/forms/:id/visit", roles: ["guest", "viewer"] as const, why: "count a started response (the completion funnel)" }
];
