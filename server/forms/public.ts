import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { audit, db } from "../db";
import { appName } from "../config";
import { clientIp } from "../clientAddress";
import { mailEnabled } from "../mail";
import {
  checkSubmission, confirmEmailVerification, consumePublicLink, issueRenderNonce, publicLimit, publicNotFound, readPublicJson, readPublicLink, startEmailVerification,
  type PublicLink, type PublicRouter
} from "../public";
import { currentSet, submitResponse, QuestionError } from "../questions/service";
import { normalizeEmail, isEmail, QUESTION_TYPES, type Question, type QuestionSet } from "../../shared/questions";
import { HONEYPOT_FIELD, MIN_FILL_MS, NONCE_FIELD } from "../../shared/publicPages";
import {
  accepting, browserHash, closedReason, endingOf, formRowById, host, pollResults, recordVisit, responseCommitted, settingsOf, themeOf, type FormRow, type SubmitOutcome
} from "./service";
import { recordItemActivity } from "../activity/service";

/**
 * Public forms, polls, and time polls (docs/plan/WORKSPACE_MODULES.md §B.8, §D.1, D810, T515–T523):
 * `/p/f/<token>` pages and `/api/public/forms/<token>/…` JSON, no session. A link opens while it is
 * live (not revoked or expired), the workspace allows public forms, and the form is live, shared with
 * "anyone with the link", and not in the Bin; anything else is the one uniform 404 (T507). A closed
 * form still opens to show that it is closed (and its results when they are public after close).
 *
 * Every submission passes the foundation's checks first (per-address limits, signed single-use render
 * nonce, honeypot, three-second minimum fill time; §B.8), then the per-link hourly limit, then the
 * question engine's validation with the public audience (members-only types refused, T516). Hidden
 * fields are stored as typed and never trusted for identity (T523). With email verification on, the
 * response is held until the six-digit code is entered (T577); with mail off nothing can be confirmed,
 * so verification is skipped and the response counts unverified (D863, as bookings do).
 */

const opensFor = (link: PublicLink) => {
  const row = formRowById(link.itemId);
  return row !== null && row.deleted_at === null && row.audience === "public" && row.status !== "draft";
};
/** Email verification applies only when this server can send the code (D863). */
const verifying = (row: FormRow) => row.verify_email === 1 && mailEnabled();

const linkOf = (c: Context<AppEnv>) => readPublicLink("form", c.req.param("token") ?? "", { opens: opensFor });

/** The definition a visitor may see: question and option ids, titles, and settings; never people, ids of other items, or answers. */
function publicSet(set: QuestionSet): QuestionSet {
  return { ...set, questions: set.questions.filter((question) => QUESTION_TYPES[question.type].public).map((question): Question => ({ ...question, role: undefined })) };
}

// A hidden question (filled from the URL) never names the respondent of a public submission (T523, D864).
const visible = (set: QuestionSet) => set.questions.filter((question) => question.type !== "hidden");
const emailQuestion = (set: QuestionSet) => visible(set).find((question) => question.role === "contact_email") ?? visible(set).find((question) => question.type === "email");
const nameQuestion = (set: QuestionSet) => visible(set).find((question) => question.role === "contact_name");

function publicResults(row: FormRow, browser: string | null) {
  if (row.kind === "form") return null;
  const voted = browser ? db.query("SELECT 1 FROM responses WHERE host_kind = 'form' AND host_id = ? AND dedupe_hash = ? AND status = 'submitted'").get(row.id, browserHash(row.id, browser)) !== null : false;
  const visible = row.results_visibility === "live" || (row.results_visibility === "after_vote" && voted) || (row.results_visibility === "after_close" && !accepting(row));
  // Named voters are never public; a time poll's grid shows first names as people typed them.
  return visible ? pollResults(row, null, { withVoters: row.kind === "time_poll" }) : null;
}

const submitSchema = z.object({
  answers: z.record(z.string().max(16), z.unknown()),
  hidden: z.record(z.string().max(16), z.string().max(500)).optional(),
  respondent: z.object({ name: z.string().max(120).optional(), email: z.string().max(254).optional() }).optional(),
  browser: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
  [NONCE_FIELD]: z.string().max(400).optional(),
  [HONEYPOT_FIELD]: z.string().max(500).optional()
});
type SubmitBody = z.infer<typeof submitSchema>;

function identity(row: FormRow, set: QuestionSet, body: SubmitBody) {
  const typedName = body.respondent?.name?.trim();
  const named = nameQuestion(set);
  const answerName = named && typeof body.answers[named.id] === "string" ? String(body.answers[named.id]).trim() : "";
  const contact = set.questions.find((question) => question.type === "contact");
  const contactAnswer = contact ? body.answers[contact.id] as { name?: string; email?: string } | undefined : undefined;
  const asked = emailQuestion(set);
  const answerEmail = asked && typeof body.answers[asked.id] === "string" ? String(body.answers[asked.id]) : contactAnswer?.email ?? "";
  const typedEmail = body.respondent?.email?.trim() ?? "";
  const email = [typedEmail, answerEmail].map((value) => normalizeEmail(value)).find((value) => value && isEmail(value)) ?? null;
  return { name: (typedName || answerName || contactAnswer?.name || "Guest").slice(0, 120), email };
}

function save(row: FormRow, link: PublicLink, body: SubmitBody, address: string | null, verified = false): SubmitOutcome {
  const set = currentSet(host(row.id))!.set;
  const who = identity(row, set, body);
  const respondent = row.anonymous ? { kind: "anonymous" as const, dedupeHash: body.browser ? browserHash(row.id, body.browser) : null } : { kind: "guest" as const, name: who.name, email: who.email };
  const response = submitResponse({ host: host(row.id), respondent, answers: body.answers, hidden: body.hidden, audience: "public", meta: { via: "public", link: link.id, ...(verified ? { verified: true } : {}) } });
  if (!row.anonymous && body.browser) db.query("UPDATE responses SET dedupe_hash = ? WHERE id = ?").run(browserHash(row.id, body.browser), response.id);
  const meta = JSON.parse((db.query("SELECT meta_json FROM responses WHERE id = ?").get(response.id) as { meta_json: string }).meta_json) as { ending?: string };
  recordVisit(row.id, "submits");
  const counts = db.query("SELECT COUNT(*) AS n, MAX(submitted_at) AS last FROM responses WHERE host_kind = 'form' AND host_id = ? AND status = 'submitted'").get(row.id) as { n: number; last: string | null };
  db.query("UPDATE forms SET response_count = ?, last_response_at = ?, updated_at = ? WHERE id = ?").run(counts.n, counts.last, response.submittedAt, row.id);
  if (row.max_responses !== null && counts.n >= row.max_responses && row.status === "open") db.query("UPDATE forms SET status = 'closed', closed_at = ?, revision = revision + 1 WHERE id = ?").run(response.submittedAt, row.id);
  recordItemActivity({ itemKind: "response", itemId: response.id, container: { kind: "form", id: row.id }, actorId: null, via: "public" as never, kind: "submitted" });
  audit(null, null, "forms.response_submit", { formId: row.id, responseId: response.id, via: "public", linkId: link.id });
  void address;
  return { response, ending: meta.ending ?? null, created: true, form: formRowById(row.id)! };
}

function refuse(c: Context<AppEnv>, error: unknown) {
  if (error instanceof QuestionError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  throw error;
}

export function registerFormsPublicRoutes(router: PublicRouter) {
  router.page("/p/f/:token", (c) => linkOf(c) !== null);

  router.get("/api/public/forms/:token", (c) => {
    const link = linkOf(c);
    if (!link) return publicNotFound(c);
    const row = formRowById(link.itemId)!;
    const current = currentSet(host(row.id));
    if (!current) return publicNotFound(c);
    recordVisit(row.id, "views");
    const reason = closedReason(row);
    return c.json({
      form: {
        kind: row.kind, title: row.title, description: row.description_md, display: row.display, theme: themeOf(row), ending: endingOf(row), showProgress: settingsOf(row).showProgress,
        anonymous: row.anonymous === 1, verifyEmail: verifying(row), limitPer: row.limit_per, resultsVisibility: row.results_visibility, closesAt: row.closes_at,
        accepting: reason === null, closedReason: reason, finalizedSlotId: row.finalized_slot_id, responseCount: row.kind === "form" ? null : row.response_count
      },
      set: publicSet(current.set),
      renderNonce: reason === null ? issueRenderNonce("form", row.id) : null,
      meta: { appName: appName(), workspaceName: appName(), logoUrl: null },
      results: publicResults(row, c.req.query("browser") ?? null)
    });
  });

  router.get("/api/public/forms/:token/results", (c) => {
    const link = linkOf(c);
    if (!link) return publicNotFound(c);
    const row = formRowById(link.itemId)!;
    return c.json({ results: publicResults(row, c.req.query("browser") ?? null), responseCount: row.kind === "form" ? null : row.response_count, accepting: accepting(row) });
  });

  router.post("/api/public/forms/:token/visit", async (c) => {
    const link = linkOf(c);
    if (!link) return publicNotFound(c);
    if (publicLimit("page", clientIp(c))) return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429);
    recordVisit(link.itemId, "starts");
    return c.body(null, 204);
  });

  router.post("/api/public/forms/:token/responses", async (c) => {
    const link = linkOf(c);
    if (!link) return publicNotFound(c);
    const row = formRowById(link.itemId)!;
    const body = await readPublicJson(c, submitSchema);
    if (!body) return c.json({ error: "Invalid request", code: "INVALID" }, 400);
    const address = clientIp(c);
    const check = checkSubmission({ kind: "form", itemId: row.id, linkId: link.id, address, body: body as Record<string, unknown>, minFillMs: MIN_FILL_MS.form });
    if (!check.ok) {
      if (check.retryAfter) c.header("Retry-After", String(check.retryAfter));
      return check.status === 404 ? publicNotFound(c) : c.json({ error: check.outcome === "rate_limited" ? "Too many submissions. Try again in a minute." : "This submission was not accepted. Reload the page and try again.", code: check.outcome.toUpperCase() }, check.status);
    }
    if (!accepting(row)) return c.json({ error: "This form is not accepting responses", code: "FORM_CLOSED" }, 409);
    const set = currentSet(host(row.id))!.set;
    if (row.kind === "time_poll" && !row.anonymous && !body.respondent?.name?.trim()) return c.json({ error: "Enter your name", code: "INVALID_ANSWERS", errors: { _name: "Enter your name" } }, 400);
    if (row.limit_per !== "none" && body.browser) {
      const seen = db.query("SELECT 1 FROM responses WHERE host_kind = 'form' AND host_id = ? AND dedupe_hash = ?").get(row.id, browserHash(row.id, body.browser));
      if (seen) return c.json({ error: row.kind === "form" ? "You already responded from this browser" : "You already voted from this browser", code: "ALREADY_RESPONDED" }, 409);
    }
    try {
      if (verifying(row)) {
        const email = identity(row, set, body).email;
        if (!email) return c.json({ error: "Enter your email address to get a code", code: "INVALID_ANSWERS", errors: { [emailQuestion(set)?.id ?? "_email"]: "Enter your email address" } }, 400);
        // Validate now, so the code is only sent for a response that will be accepted.
        const probe = db.transaction(() => { submitResponse({ host: host(row.id), respondent: { kind: "guest", name: "probe" }, answers: body.answers, hidden: body.hidden, audience: "public" }); throw new RollbackProbe(); });
        try { probe(); } catch (error) { if (!(error instanceof RollbackProbe)) throw error; }
        const started = db.transaction(() => startEmailVerification({ kind: "form", itemId: row.id, linkId: link.id, email, payload: { ...body, [NONCE_FIELD]: undefined }, address }))();
        return c.json({ verificationId: started.verificationId, mailQueued: started.mailQueued }, 202);
      }
      const outcome = db.transaction(() => {
        if (!consumePublicLink(link)) return null;
        return save(row, link, body, address);
      })();
      if (!outcome) return c.json({ error: "This form is getting too many responses. Try again later.", code: "RATE_LIMITED" }, 429);
      responseCommitted(outcome, { actorId: null, via: "public" });
      return c.json({ ok: true, ending: outcome.ending, results: publicResults(outcome.form, body.browser ?? null) }, 201);
    } catch (error) {
      return refuse(c, error);
    }
  });

  router.post("/api/public/forms/:token/verify", async (c) => {
    const link = linkOf(c);
    const body = await readPublicJson(c, z.object({ id: z.string().max(64), code: z.string().max(12) }));
    if (!link || !body) return publicNotFound(c);
    const row = formRowById(link.itemId)!;
    if (publicLimit("submit", clientIp(c))) return c.json({ error: "Too many attempts. Try again in a minute.", code: "RATE_LIMITED" }, 429);
    const result = confirmEmailVerification({ id: body.id, code: body.code, kind: "form", itemId: row.id });
    if (!result.ok) return c.json({ error: result.reason === "expired" ? "That code expired. Submit again for a new one." : result.reason === "too_many" ? "Too many wrong codes. Submit again for a new one." : "That code did not work", code: result.reason.toUpperCase() }, 400);
    if (!accepting(row)) return c.json({ error: "This form is not accepting responses", code: "FORM_CLOSED" }, 409);
    try {
      const held = submitSchema.parse(result.payload);
      const outcome = db.transaction(() => consumePublicLink(link) ? save(row, link, held, clientIp(c), true) : null)();
      if (!outcome) return c.json({ error: "This form is getting too many responses. Try again later.", code: "RATE_LIMITED" }, 429);
      responseCommitted(outcome, { actorId: null, via: "public" });
      return c.json({ ok: true, ending: outcome.ending, results: publicResults(outcome.form, held.browser ?? null) }, 201);
    } catch (error) {
      return refuse(c, error);
    }
  });
}

class RollbackProbe extends Error {}
