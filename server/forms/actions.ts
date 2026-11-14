import { z } from "zod";
import { audit, db, now } from "../db";
import { logger } from "../log";
import { boardLevel, readableBoard } from "../tasks/access";
import { createCard, listColumns } from "../tasks/service";
import { canEditBook, upsertContactByEmail } from "../people/contacts";
import { createLink } from "../links/service";
import { notify } from "../notify";
import { upsertSchedule } from "../schedules/service";
import { getResponse, setVersion } from "../questions/service";
import { LEVEL_RANK } from "../access/levels";
import { createDeal } from "../crm/deals";
import { logInteraction } from "../crm/interactions";
import { bookCurrency, bookRow } from "../crm/core";
import { minorDigits, MONEY_MAX_MINOR } from "../../shared/money";
import { FormError, formRowById, host, onResponseSubmitted, requireForm, type FormRow } from "./service";
import { YES_NO_OPTIONS, type AnswerValue, type Question, type QuestionSet } from "../../shared/questions";
import { formPath, FORM_ACTIONS_MAX, type FormAction, type FormActionKind } from "../../shared/forms";

const slog = logger("forms");

/**
 * Response actions (docs/plan/WORKSPACE_MODULES.md §D.1, §C C2/C3/C21, D845): what each new response
 * does, configured per form. They run after the response commits, as the person who set the action
 * up (who must still be able to write the board or the contact book), and never block or fail the
 * respondent: each run is a `form_action_runs` row, retried by the `forms.actions_retry` schedule
 * (five attempts, five minutes apart) when it fails.
 *
 * - `create_card`: a card on a board/column, title and description from templates with `{{question}}`
 *   tokens (answers are escaped, T520; only `url` answers become links), an optional due date from a
 *   date question; linked card → response (`source`).
 * - `save_contact`: upsert by email into a contact book (§B.3, D806), name/phone/company from the
 *   questions with those roles; a hidden field is never used unless the form verifies email (T523).
 * - `notify`: notifications to chosen people.
 * - `create_deal` (C3, D1045): a deal in a book's pipeline and stage, titled from a template, valued from
 *   a number question (in major units of the pipeline's currency), with the respondent upserted by email
 *   as its contact when the form asks for one; linked deal → response (`source`). Idempotent per
 *   response and book: a retried run finds the deal it made.
 *
 * `save_contact` and `create_deal` also log a `form` interaction on what they touched (C21), titled
 * "Form response" (book readers may not read the form, T595); the response itself is in the record's
 * Linked work (`source` link), which opens only for the form's result readers.
 */

export const createCardConfig = z.object({
  boardId: z.string().uuid(), columnId: z.string().uuid(),
  title: z.string().min(1).max(500), description: z.string().max(5000).default(""),
  dueQuestionId: z.string().max(16).nullish(), assigneeIds: z.array(z.string().uuid()).max(10).default([])
}).strict();
export const saveContactConfig = z.object({
  bookId: z.string().uuid(), emailQuestionId: z.string().max(16).nullish(), nameQuestionId: z.string().max(16).nullish(),
  phoneQuestionId: z.string().max(16).nullish(), companyQuestionId: z.string().max(16).nullish()
}).strict();
export const notifyConfig = z.object({ userIds: z.array(z.string().uuid()).min(1).max(20) }).strict();
export const createDealConfig = z.object({
  bookId: z.string().uuid(), pipelineId: z.string().uuid().nullish(), stageId: z.string().uuid().nullish(),
  title: z.string().min(1).max(500), valueQuestionId: z.string().max(16).nullish(),
  emailQuestionId: z.string().max(16).nullish(), nameQuestionId: z.string().max(16).nullish(), companyQuestionId: z.string().max(16).nullish()
}).strict();
const CONFIGS = { create_card: createCardConfig, save_contact: saveContactConfig, notify: notifyConfig, create_deal: createDealConfig } as const;

type ActionRow = { id: string; form_id: string; kind: FormActionKind; config_json: string; enabled: number; position: number; created_by: string | null; created_at: string; updated_at: string };
const MAX_ATTEMPTS = 5;
const RETRY_MS = 5 * 60_000;

function toAction(row: ActionRow): FormAction {
  const last = db.query("SELECT status, updated_at, error FROM form_action_runs WHERE action_id = ? ORDER BY updated_at DESC LIMIT 1").get(row.id) as { status: "done" | "failed" | "pending"; updated_at: string; error: string | null } | null;
  const failed = (db.query("SELECT COUNT(*) AS n FROM form_action_runs WHERE action_id = ? AND status = 'failed'").get(row.id) as { n: number }).n;
  return { id: row.id, kind: row.kind, enabled: row.enabled === 1, position: row.position, config: JSON.parse(row.config_json) as Record<string, unknown>, lastRun: last ? { status: last.status, at: last.updated_at, error: last.error } : null, failed };
}

/** Checks a config now, as the person saving it: the board/column or book must be writable by them. */
function checkConfig(kind: FormActionKind, config: unknown, userId: string): Record<string, unknown> {
  const parsed = CONFIGS[kind].safeParse(config);
  if (!parsed.success) throw new FormError(400, "INVALID", "This action's settings are not valid", { details: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
  if (kind === "create_card") {
    const value = parsed.data as z.infer<typeof createCardConfig>;
    const board = readableBoard(value.boardId, userId);
    if (!board || LEVEL_RANK[boardLevel(board, userId)] < LEVEL_RANK.edit) throw new FormError(400, "INVALID", "Choose a board you can add cards to");
    if (!listColumns(value.boardId).some((column) => column.id === value.columnId)) throw new FormError(400, "INVALID", "Choose a column of that board");
  }
  if (kind === "save_contact" && !canEditBook((parsed.data as z.infer<typeof saveContactConfig>).bookId, userId)) throw new FormError(400, "INVALID", "Choose a contact book you can add to");
  if (kind === "create_deal") {
    const value = parsed.data as z.infer<typeof createDealConfig>;
    const book = bookRow(value.bookId);
    if (!book || book.system_kind !== null || !canEditBook(value.bookId, userId)) throw new FormError(400, "INVALID", "Choose a contact book you can add deals to");
    if (value.pipelineId) {
      const pipeline = db.query("SELECT id FROM pipelines WHERE id = ? AND book_id = ? AND deleted_at IS NULL").get(value.pipelineId, value.bookId);
      if (!pipeline) throw new FormError(400, "INVALID", "Choose a pipeline of that book");
      if (value.stageId && !db.query("SELECT 1 FROM pipeline_stages WHERE id = ? AND pipeline_id = ?").get(value.stageId, value.pipelineId)) throw new FormError(400, "INVALID", "Choose a stage of that pipeline");
    } else if (value.stageId) throw new FormError(400, "INVALID", "Choose the stage's pipeline too");
  }
  return parsed.data as Record<string, unknown>;
}

export function listActions(userId: string, ref: string): FormAction[] {
  const { row } = requireForm(ref, userId, "edit");
  return (db.query("SELECT * FROM form_actions WHERE form_id = ? ORDER BY position, created_at").all(row.id) as ActionRow[]).map(toAction);
}

export function createAction(userId: string, ref: string, input: { kind: FormActionKind; config: unknown; enabled?: boolean }): FormAction {
  return db.transaction(() => {
    const { row } = requireForm(ref, userId, "edit");
    const count = (db.query("SELECT COUNT(*) AS n FROM form_actions WHERE form_id = ?").get(row.id) as { n: number }).n;
    if (count >= FORM_ACTIONS_MAX) throw new FormError(409, "LIMIT_REACHED", `A form has at most ${FORM_ACTIONS_MAX} actions`);
    const config = checkConfig(input.kind, input.config, userId);
    const id = crypto.randomUUID();
    const timestamp = now();
    db.query("INSERT INTO form_actions (id, form_id, kind, config_json, enabled, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, row.id, input.kind, JSON.stringify(config), input.enabled === false ? 0 : 1, count, userId, timestamp, timestamp);
    audit(userId, null, "forms.action_create", { formId: row.id, actionId: id, kind: input.kind });
    return toAction(db.query("SELECT * FROM form_actions WHERE id = ?").get(id) as ActionRow);
  })();
}

export function updateAction(userId: string, ref: string, actionId: string, input: { config?: unknown; enabled?: boolean }): FormAction {
  return db.transaction(() => {
    const { row } = requireForm(ref, userId, "edit");
    const action = db.query("SELECT * FROM form_actions WHERE id = ? AND form_id = ?").get(actionId, row.id) as ActionRow | null;
    if (!action) throw new FormError(404, "NOT_FOUND", "Action not found");
    // Whoever changes the action's target now acts for it (they were checked against it).
    const config = input.config === undefined ? JSON.parse(action.config_json) : checkConfig(action.kind, input.config, userId);
    db.query("UPDATE form_actions SET config_json = ?, enabled = ?, created_by = CASE WHEN ? THEN ? ELSE created_by END, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(config), input.enabled === undefined ? action.enabled : input.enabled ? 1 : 0, input.config !== undefined ? 1 : 0, userId, now(), action.id);
    audit(userId, null, "forms.action_update", { formId: row.id, actionId });
    return toAction(db.query("SELECT * FROM form_actions WHERE id = ?").get(action.id) as ActionRow);
  })();
}

export function deleteAction(userId: string, ref: string, actionId: string) {
  return db.transaction(() => {
    const { row } = requireForm(ref, userId, "edit");
    const removed = db.query("DELETE FROM form_actions WHERE id = ? AND form_id = ?").run(actionId, row.id).changes;
    if (!removed) throw new FormError(404, "NOT_FOUND", "Action not found");
    audit(userId, null, "forms.action_delete", { formId: row.id, actionId });
  })();
}

// ---------------------------------------------------------------- templates

/** Escapes Markdown in an answer so it reads as text in a card (T520). */
export const escapeMarkdown = (text: string) => text.replace(/([\\`*_[\]{}()#+\-.!|<>~])/g, "\\$1");

function labelOf(question: Question, id: string) {
  if (question.type === "yes_no") return YES_NO_OPTIONS.find((option) => option.id === id)?.label ?? id;
  return question.options?.find((option) => option.id === id)?.label ?? id;
}

/** One answer as plain text (labels for choices). */
export function plainAnswer(question: Question, value: AnswerValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return ["single_choice", "dropdown", "yes_no"].includes(question.type) ? labelOf(question, value) : value;
  if (Array.isArray(value)) return value.map((id) => question.type === "ranking" ? labelOf(question, id) : id).join(", ");
  if ("options" in value && Array.isArray(value.options)) return [...value.options.map((id) => labelOf(question, String(id))), ...(typeof value.other === "string" ? [value.other] : [])].join(", ");
  if ("other" in value && typeof value.other === "string") return value.other;
  if ("name" in value && typeof value.name === "string") return [value.name, value.email, value.phone, value.company].filter(Boolean).join(", ");
  if (question.type === "time_slots") return Object.entries(value).filter(([, vote]) => vote === "yes").map(([slot]) => question.slots?.find((item) => item.id === slot)?.start ?? slot).join(", ");
  return Object.entries(value).map(([key, cell]) => `${question.matrix?.rows.find((row) => row.id === key)?.label ?? key}: ${(Array.isArray(cell) ? cell : [cell]).map((column) => question.matrix?.columns.find((item) => item.id === column)?.label ?? column).join("/")}`).join("; ");
}

/**
 * Fills `{{Question title}}` or `{{questionId}}` tokens; `{{answers}}` lists every answer. Answers are
 * escaped; a `url` answer becomes a link only when it is http(s) (T520). `markdown: false` (titles)
 * keeps plain text, cut to one line.
 */
export function renderTemplate(template: string, set: QuestionSet, answers: Record<string, AnswerValue>, options: { markdown: boolean }): string {
  const byKey = new Map<string, Question>();
  for (const question of set.questions) { byKey.set(question.id, question); byKey.set(question.title.trim().toLowerCase(), question); }
  const text = (question: Question) => {
    const plain = plainAnswer(question, answers[question.id]).replace(/\s+/g, options.markdown ? " " : " ").trim();
    if (!options.markdown) return plain;
    if (question.type === "url" && /^https?:\/\/[^\s<>()]+$/i.test(plain)) return `<${plain}>`;
    return escapeMarkdown(plain);
  };
  return template.replace(/\{\{\s*([^}]{1,200}?)\s*\}\}/g, (_all, key: string) => {
    if (key.toLowerCase() === "answers") {
      return set.questions.filter((question) => answers[question.id] !== undefined && question.type !== "hidden")
        .map((question) => options.markdown ? `**${escapeMarkdown(question.title)}**\n${text(question)}` : `${question.title}: ${text(question)}`).join(options.markdown ? "\n\n" : "; ");
    }
    const question = byKey.get(key) ?? byKey.get(key.toLowerCase());
    return question ? text(question) : "";
  });
}

// ---------------------------------------------------------------- running

type RunContext = { form: FormRow; responseId: string; publicSubmission: boolean };

const questionFor = (set: QuestionSet, id: string | null | undefined, role: Question["role"], type?: Question["type"]) =>
  (id ? set.questions.find((question) => question.id === id) : undefined) ?? set.questions.find((question) => question.role === role) ?? (type ? set.questions.find((question) => question.type === type) : undefined);

async function runOne(action: ActionRow, context: RunContext): Promise<string | null> {
  const response = getResponse(context.responseId);
  if (!response) throw new Error("The response was deleted");
  const set = setVersion(host(context.form.id), response.setVersion);
  if (!set) throw new Error("The questions are missing");
  const actor = action.created_by ?? context.form.owner_id;
  const config = JSON.parse(action.config_json) as Record<string, unknown>;
  const answers = response.answers;
  const usable = (question: Question | undefined) => question && (question.type !== "hidden" || (context.form.verify_email === 1 && !context.publicSubmission) || context.form.verify_email === 1) ? question : undefined;
  if (action.kind === "create_card") {
    const value = createCardConfig.parse(config);
    const title = renderTemplate(value.title, set, answers, { markdown: false }).slice(0, 500).trim() || `Response to ${context.form.title}`.slice(0, 500);
    const link = `[Open the response](${formPath(context.form.title, context.form.short_id, "results")}?response=${response.id})`;
    const description = `${renderTemplate(value.description || "{{answers}}", set, answers, { markdown: true })}\n\n${link}`.slice(0, 50_000);
    const due = value.dueQuestionId ? answers[value.dueQuestionId] : undefined;
    const dueOn = typeof due === "string" && /^\d{4}-\d{2}-\d{2}/.test(due) ? due.slice(0, 10) : undefined;
    const created = await createCard(actor, value.boardId, { columnId: value.columnId, title, description, ...(dueOn ? { dueOn } : {}), ...(value.assigneeIds.length ? { assigneeIds: value.assigneeIds } : {}) }) as { id?: string; card?: { id: string } };
    const cardId = created.card?.id ?? created.id ?? null;
    if (cardId) {
      try { createLink({ a: { kind: "card", id: cardId }, b: { kind: "response", id: response.id }, relation: "source", actorId: actor, via: "web" as never }); } catch { /* the card stands without the link */ }
    }
    return cardId ? `card:${cardId}` : null;
  }
  /** Upserts the respondent by their email answer into the book (D806); null without an email. */
  const saveRespondent = (bookId: string, ids: { emailQuestionId?: string | null; nameQuestionId?: string | null; phoneQuestionId?: string | null; companyQuestionId?: string | null }) => {
    const emailQuestion = usable(questionFor(set, ids.emailQuestionId, "contact_email", "email"));
    const contactQuestion = set.questions.find((question) => question.type === "contact");
    const contactAnswer = contactQuestion ? answers[contactQuestion.id] as { name?: string; email?: string; phone?: string; company?: string } | undefined : undefined;
    const email = (emailQuestion ? answers[emailQuestion.id] : undefined) ?? contactAnswer?.email;
    if (typeof email !== "string" || !email) return null;
    const pick = (question: Question | undefined) => { const found = usable(question); const answer = found ? answers[found.id] : undefined; return found && answer !== undefined ? plainAnswer(found, answer) : null; };
    const result = db.transaction(() => upsertContactByEmail(bookId, {
      email, name: pick(questionFor(set, ids.nameQuestionId, "contact_name")) ?? contactAnswer?.name ?? null,
      phone: pick(questionFor(set, ids.phoneQuestionId, "contact_phone", "phone")) ?? contactAnswer?.phone ?? null,
      company: pick(questionFor(set, ids.companyQuestionId, "company")) ?? contactAnswer?.company ?? null
    }, { source: "form", sourceRef: context.form.id, actor }))();
    try { createLink({ a: { kind: "contact", id: result.contactId }, b: { kind: "response", id: response.id }, relation: "source", actorId: actor, via: "web" as never }); } catch { /* already linked */ }
    return result.contactId;
  };
  /** The respondent on the contact (and deal) timeline (C21): one `form` interaction per action and response. */
  const logFormInteraction = (named: Array<{ kind: "contact" | "deal"; id: string }>) => {
    // One entry per record and response, whichever action (contact, deal) logs it first.
    const subjects = named.filter((subject) => !db.query(`SELECT 1 FROM interactions i JOIN interaction_subjects s ON s.interaction_id = i.id
      WHERE i.source = 'form' AND substr(i.source_ref, 1, 36) = ? AND s.subject_kind = ? AND s.subject_id = ?`).get(response.id, subject.kind, subject.id));
    if (!subjects.length) return;
    try {
      logInteraction(actor, { kind: "form", title: "Form response", body: "Sent a form response (in Linked work).", occurredAt: response.submittedAt, source: "form", sourceRef: `${response.id}:${action.id}`, subjects });
    } catch (error) { slog.warn("A form interaction could not be logged", { formId: context.form.id, error: error instanceof Error ? error.message : String(error) }); }
  };
  if (action.kind === "save_contact") {
    const value = saveContactConfig.parse(config);
    if (!canEditBook(value.bookId, actor)) throw new Error("The contact book is no longer writable");
    const contactId = saveRespondent(value.bookId, value);
    if (!contactId) return null;
    logFormInteraction([{ kind: "contact", id: contactId }]);
    return `contact:${contactId}`;
  }
  if (action.kind === "create_deal") {
    const value = createDealConfig.parse(config);
    const book = bookRow(value.bookId);
    if (!book || book.deleted_at !== null || !canEditBook(value.bookId, actor)) throw new Error("The contact book is no longer writable");
    const existing = db.query(`SELECT d.id FROM work_links l JOIN deals d ON d.id = l.a_id WHERE l.a_kind = 'deal' AND l.b_kind = 'response' AND l.b_id = ? AND l.relation = 'source' AND d.book_id = ? LIMIT 1`)
      .get(response.id, book.id) as { id: string } | null;
    if (existing) return `deal:${existing.id}`;
    const contactId = saveRespondent(book.id, value);
    const pipelineCurrency = value.pipelineId ? (db.query("SELECT currency FROM pipelines WHERE id = ?").get(value.pipelineId) as { currency: string | null } | null)?.currency ?? null : null;
    const currency = pipelineCurrency ?? bookCurrency(book);
    const raw = value.valueQuestionId ? answers[value.valueQuestionId] : undefined;
    const minor = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 10 ** minorDigits(currency)) : null;
    const title = renderTemplate(value.title, set, answers, { markdown: false }).slice(0, 200).trim() || `Response to ${context.form.title}`.slice(0, 200);
    const deal = createDeal(actor, {
      bookId: book.id, pipelineId: value.pipelineId ?? null, stageId: value.stageId ?? null, title, currency,
      value: minor !== null && minor <= MONEY_MAX_MINOR ? minor : null, contactIds: contactId ? [contactId] : []
    }, "form");
    try { createLink({ a: { kind: "deal", id: deal.id }, b: { kind: "response", id: response.id }, relation: "source", actorId: actor, via: "web" as never }); } catch { /* already linked */ }
    logFormInteraction([{ kind: "deal", id: deal.id }, ...(contactId ? [{ kind: "contact" as const, id: contactId }] : [])]);
    return `deal:${deal.id}`;
  }
  if (action.kind === "notify") {
    const value = notifyConfig.parse(config);
    db.transaction(() => notify({
      userIds: value.userIds, module: "forms", topic: "forms.action", title: `New response to “${context.form.title}”`.slice(0, 200),
      href: `${formPath(context.form.title, context.form.short_id, "results")}?response=${response.id}`, item: { kind: "form", id: context.form.id },
      actor: response.respondent.userId ?? null, dedupeKey: `forms.action:${context.form.id}`
    }))();
    return null;
  }
  throw new Error("This action is not available");
}

async function execute(runId: string) {
  const run = db.query(`SELECT r.id, r.response_id, r.attempts, a.* FROM form_action_runs r JOIN form_actions a ON a.id = r.action_id WHERE r.id = ?`).get(runId) as (ActionRow & { response_id: string; attempts: number }) | null;
  if (!run) return;
  const form = formRowById(run.form_id);
  if (!form || form.deleted_at !== null) return;
  const response = db.query("SELECT meta_json FROM responses WHERE id = ?").get(run.response_id) as { meta_json: string } | null;
  const publicSubmission = response ? (JSON.parse(response.meta_json) as { via?: string }).via === "public" : false;
  try {
    const ref = await runOne(run, { form, responseId: run.response_id, publicSubmission });
    db.query("UPDATE form_action_runs SET status = 'done', result_ref = ?, error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?").run(ref, now(), runId);
    audit(run.created_by, null, "forms.action_run", { formId: form.id, actionId: run.id, responseId: run.response_id, outcome: "done" });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "The action failed").slice(0, 500);
    db.transaction(() => {
      db.query("UPDATE form_action_runs SET status = 'failed', error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?").run(message, now(), runId);
      audit(run.created_by, null, "forms.action_run", { formId: form.id, actionId: run.id, responseId: run.response_id, outcome: "failed" });
      if (run.attempts + 1 < MAX_ATTEMPTS) upsertSchedule({ kind: "form", id: form.id }, "forms.actions_retry", { once: new Date(Date.now() + RETRY_MS).toISOString() }, {}, { userId: form.owner_id });
    })();
    slog.warn("A form action failed", { formId: form.id, kind: run.kind });
  }
}

/** Starts the form's enabled actions for a new response (after commit). Returns when they finish (tests await it). */
export async function runActionsFor(formId: string, responseId: string) {
  const actions = db.query("SELECT * FROM form_actions WHERE form_id = ? AND enabled = 1 ORDER BY position").all(formId) as ActionRow[];
  const runIds: string[] = [];
  db.transaction(() => {
    for (const action of actions) {
      const id = crypto.randomUUID();
      const inserted = db.query("INSERT OR IGNORE INTO form_action_runs (id, action_id, response_id, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)").run(id, action.id, responseId, now(), now()).changes;
      if (inserted) runIds.push(id);
    }
  })();
  for (const id of runIds) await execute(id);
}

/** The retry schedule's handler: failed runs of the form with attempts left. */
export async function retryFailedRuns(formId: string) {
  const runs = db.query(`SELECT r.id FROM form_action_runs r JOIN form_actions a ON a.id = r.action_id WHERE a.form_id = ? AND r.status = 'failed' AND r.attempts < ? AND a.enabled = 1 LIMIT 100`).all(formId, MAX_ATTEMPTS) as Array<{ id: string }>;
  for (const run of runs) await execute(run.id);
}

/** Runs a failed run again now (the Actions tab's Retry). */
export async function retryRun(userId: string, ref: string, actionId: string) {
  const { row } = requireForm(ref, userId, "edit");
  const runs = db.query(`SELECT r.id FROM form_action_runs r JOIN form_actions a ON a.id = r.action_id WHERE a.id = ? AND a.form_id = ? AND r.status = 'failed' LIMIT 100`).all(actionId, row.id) as Array<{ id: string }>;
  for (const run of runs) await execute(run.id);
  return runs.length;
}

/** Pending promises of the latest submissions (tests wait on them). */
export const pendingActionRuns = new Set<Promise<void>>();

onResponseSubmitted((outcome) => {
  if (!outcome.created || outcome.response.status !== "submitted") return;
  const promise = runActionsFor(outcome.form.id, outcome.response.id).catch((error) => slog.error("Form actions could not start", error)).finally(() => pendingActionRuns.delete(promise));
  pendingActionRuns.add(promise);
});
