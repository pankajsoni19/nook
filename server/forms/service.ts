import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { itemLevel, readableContainerSql } from "../access/workspaceItems";
import { LEVEL_RANK, type ItemLevel } from "../access/levels";
import { audienceAllUsersFor } from "../team/roles";
import { recordItemActivity, recordItemChange } from "../activity/service";
import { cancelSchedules, upsertSchedule } from "../schedules/service";
import { createPublicLink as createLink, listPublicLinks, publicPolicyAllows, revokePublicLinksOf } from "../public";
import {
  anonymousDedupeHash, currentSet, deleteResponse as deleteEngineResponse, discardDraftSet, draftSet, getResponse, publishSet, QuestionError, responsesPage,
  saveDraftSet, setVersion, submitResponse, summarize, updateResponse, type QuestionHost, type ResponseFilter
} from "../questions/service";
import { keyedHash } from "../public/secret";
import {
  emptyQuestionSet, QUESTION_TYPES, validateQuestionSet, type Answers, type QuestionSet, type QuestionSummary, type ResponseSummary
} from "../../shared/questions";
import { isShortId, shortIdOfSegment } from "../../shared/friendlyUrls";
import {
  DEFAULT_ENDING, DEFAULT_FORM_SETTINGS, formPath, formTemplate, kindProblem, pollSet, timePollSet,
  type FormAudience, type FormDetail, type FormDisplay, type FormEnding, type FormKind, type FormListItem, type FormSettings, type FormStatus, type FormSummaryView,
  type FormTemplate, type FormTheme, type LimitPer, type PersonRefLite, type PollResults, type RespondView, type ResultsVisibility
} from "../../shared/forms";
import { FORM_ACTIVITY } from "../../shared/formsActivity";

/**
 * The forms service (docs/plan/WORKSPACE_MODULES.md §D.1): every write of the module goes through
 * here, inside one transaction with audit and item activity, so the web, MCP, REST v1, and agents
 * behave the same (the D742 pattern). Access:
 *
 * - **Results and editing** follow the form's level (the generic container access, §B.9): `view` reads
 *   results (T517), `comment` comments on responses, `edit` changes questions and settings, `manage`
 *   and the owner share it. Missing, binned, and unreadable look the same (NOT_FOUND).
 * - **Answering** is the audience (D842): everyone in the workspace (not guests), chosen people and
 *   groups, or also anyone with the public link. A person who can read results may always answer.
 */

void FORM_ACTIVITY;

export class FormError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}
export const formNotFound = () => new FormError(404, "NOT_FOUND", "Form not found");

export type FormRow = {
  id: string; short_id: string; owner_id: string; kind: FormKind; title: string; description_md: string; status: FormStatus; audience: FormAudience; audience_json: string;
  anonymous: number; limit_per: LimitPer; allow_edit: number; results_visibility: ResultsVisibility; display: FormDisplay; opens_at: string | null; closes_at: string | null;
  max_responses: number | null; verify_email: number; theme_json: string; ending_json: string; settings_json: string; calendar_id: string | null; finalized_slot_id: string | null;
  finalized_event_id: string | null; response_count: number; last_response_at: string | null; visibility: string; share_role: string; revision: number; created_at: string;
  updated_at: string; closed_at: string | null; deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A form id from what a caller typed: a UUID, a short id, a friendly segment, or an in-app URL/path. */
export function formIdOf(ref: string): string | null {
  const text = ref.trim();
  if (UUID.test(text)) return text.toLowerCase();
  const segments = text.split(/[?#]/)[0]!.split("/").filter(Boolean);
  const formsAt = segments.indexOf("forms");
  const candidate = formsAt >= 0 ? segments[formsAt + 1] : segments.length === 1 ? segments[0] : text;
  if (candidate && UUID.test(candidate)) return candidate.toLowerCase();
  const shortId = shortIdOfSegment(candidate ?? "");
  if (!shortId) return null;
  return (db.query("SELECT id FROM forms WHERE short_id = ?").get(shortId) as { id: string } | null)?.id ?? null;
}

export function formRow(ref: string): FormRow | null {
  const id = formIdOf(ref);
  return id ? db.query("SELECT * FROM forms WHERE id = ?").get(id) as FormRow | null : null;
}

export const host = (formId: string): QuestionHost => ({ kind: "form", id: formId });
export const levelOf = (row: FormRow, userId: string): ItemLevel => row.deleted_at !== null ? "none" : itemLevel("form", row.id, userId);
const atLeast = (level: ItemLevel, needed: ItemLevel) => LEVEL_RANK[level] >= LEVEL_RANK[needed];

type AudienceIds = { users: string[]; groups: string[] };
const audienceIds = (row: FormRow): AudienceIds => {
  const parsed = JSON.parse(row.audience_json) as Partial<AudienceIds>;
  return { users: parsed.users ?? [], groups: parsed.groups ?? [] };
};

/** Whether the person is in the form's audience (who may answer, D842), apart from their level. */
export function inAudience(row: FormRow, userId: string): boolean {
  // A draft is not offered to its audience until it is published.
  if (row.deleted_at !== null || row.status === "draft") return false;
  const user = db.query("SELECT role, kind FROM users WHERE id = ? AND disabled_at IS NULL").get(userId) as { role: string; kind: string } | null;
  if (!user || user.kind !== "person") return false;
  if (row.audience === "workspace" || row.audience === "public") return user.role !== "guest";
  const ids = audienceIds(row);
  if (ids.users.includes(userId)) return true;
  if (!ids.groups.length) return false;
  return db.query(`SELECT 1 FROM group_members WHERE user_id = ? AND group_id IN (${ids.groups.map(() => "?").join(",")}) LIMIT 1`).get(userId, ...ids.groups) !== null;
}

/** May answer in the app: in the audience, or able to read the form. */
export const mayRespond = (row: FormRow, userId: string) => row.deleted_at === null && (inAudience(row, userId) || levelOf(row, userId) !== "none");

/** SQL: the form aliased `f` may be answered in the app by `$userId` (audience or level). */
export const respondableSql = (alias = "f") => `(${alias}.deleted_at IS NULL AND (
  (${alias}.status <> 'draft' AND ${alias}.audience IN ('workspace','public') AND ${audienceAllUsersFor("$userId")})
  OR (${alias}.status <> 'draft' AND ${alias}.audience = 'selected' AND (EXISTS (SELECT 1 FROM json_each(${alias}.audience_json, '$.users') au WHERE au.value = $userId)
    OR EXISTS (SELECT 1 FROM json_each(${alias}.audience_json, '$.groups') ag JOIN group_members agm ON agm.group_id = ag.value WHERE agm.user_id = $userId)))
  OR ${readableContainerSql("form", alias)}))`;

/** Why the form does not accept responses now, or null when it does. */
export function closedReason(row: FormRow, nowMs = Date.now()): RespondView["closedReason"] {
  if (row.status === "draft") return "draft";
  if (row.status === "closed") return "closed";
  if (row.opens_at && Date.parse(row.opens_at) > nowMs) return "not_open_yet";
  if (row.closes_at && Date.parse(row.closes_at) <= nowMs) return "closed";
  if (row.max_responses !== null && row.response_count >= row.max_responses) return "full";
  return null;
}
export const accepting = (row: FormRow, nowMs = Date.now()) => row.deleted_at === null && closedReason(row, nowMs) === null;

/**
 * The form for an action needing `needed` (`respond` = may answer), or NOT_FOUND. A reader without
 * the level gets 403 READ_ONLY (they know it exists); someone who cannot read it at all gets 404.
 */
export function requireForm(ref: string, userId: string, needed: ItemLevel | "respond"): { row: FormRow; level: ItemLevel } {
  const row = formRow(ref);
  if (!row || row.deleted_at !== null) throw formNotFound();
  const level = levelOf(row, userId);
  if (needed === "respond") {
    if (level === "none" && !inAudience(row, userId)) throw formNotFound();
    return { row, level };
  }
  if (level === "none" && !inAudience(row, userId)) throw formNotFound();
  if (!atLeast(level, needed)) {
    if (level === "none") throw formNotFound();
    throw new FormError(403, needed === "view" ? "NOT_FOUND" : "READ_ONLY", needed === "edit" ? "You can see this form but not change it" : "You cannot do this on this form");
  }
  return { row, level };
}

const userName = (userId: string) => (db.query("SELECT display_name FROM users WHERE id = ?").get(userId) as { display_name: string } | null)?.display_name ?? "Former member";
const parseJson = <T>(text: string, fallback: T): T => { try { return { ...fallback, ...(JSON.parse(text) as object) } as T; } catch { return fallback; } };
export const settingsOf = (row: FormRow): FormSettings => parseJson(row.settings_json, DEFAULT_FORM_SETTINGS);
export const themeOf = (row: FormRow): FormTheme => parseJson(row.theme_json, { accent: null });
export const endingOf = (row: FormRow): FormEnding => parseJson(row.ending_json, DEFAULT_ENDING);
const hrefOf = (row: FormRow) => formPath(row.title, row.short_id);

function mySubmitted(row: FormRow, userId: string): string | null {
  if (row.anonymous) {
    const hash = anonymousDedupeHash(host(row.id), userId);
    return (db.query("SELECT id FROM responses WHERE host_kind = 'form' AND host_id = ? AND dedupe_hash = ? AND status = 'submitted' ORDER BY submitted_at DESC LIMIT 1").get(row.id, hash) as { id: string } | null)?.id ?? null;
  }
  return (db.query("SELECT id FROM responses WHERE host_kind = 'form' AND host_id = ? AND respondent_user_id = ? AND status = 'submitted' ORDER BY submitted_at DESC LIMIT 1").get(row.id, userId) as { id: string } | null)?.id ?? null;
}

function spark(formId: string, nowMs = Date.now()): number[] {
  const days = Array.from({ length: 14 }, (_, index) => new Date(nowMs - (13 - index) * 86_400_000).toISOString().slice(0, 10));
  const rows = db.query("SELECT substr(submitted_at, 1, 10) AS day, COUNT(*) AS n FROM responses WHERE host_kind = 'form' AND host_id = ? AND status = 'submitted' AND submitted_at >= ? GROUP BY day")
    .all(formId, `${days[0]}T00:00:00.000Z`) as Array<{ day: string; n: number }>;
  const byDay = new Map(rows.map((row) => [row.day, row.n]));
  return days.map((day) => byDay.get(day) ?? 0);
}

export function listItem(row: FormRow, userId: string, level = levelOf(row, userId)): FormListItem {
  const reader = level !== "none";
  return {
    id: row.id, shortId: row.short_id, kind: row.kind, title: row.title, status: row.status, accepting: accepting(row),
    responseCount: row.response_count, lastResponseAt: reader ? row.last_response_at : null, closesAt: row.closes_at,
    owner: { id: row.owner_id, name: userName(row.owner_id) }, level: reader ? level as FormListItem["level"] : null,
    canRespond: mayRespond(row, userId), responded: mySubmitted(row, userId) !== null, spark: reader ? spark(row.id) : null,
    updatedAt: row.updated_at, href: hrefOf(row)
  };
}

const publishedVersion = (formId: string) => (db.query("SELECT MAX(version) AS v FROM question_sets WHERE host_kind = 'form' AND host_id = ? AND status = 'published'").get(formId) as { v: number | null }).v ?? 0;

export function formDetail(row: FormRow, userId: string): FormDetail {
  const level = levelOf(row, userId);
  const ids = audienceIds(row);
  const users = ids.users.length ? db.query(`SELECT id, display_name AS name FROM users WHERE id IN (${ids.users.map(() => "?").join(",")})`).all(...ids.users) as PersonRefLite[] : [];
  const groups = ids.groups.length ? db.query(`SELECT id, name FROM user_groups WHERE id IN (${ids.groups.map(() => "?").join(",")})`).all(...ids.groups) as PersonRefLite[] : [];
  const link = atLeast(level, "edit") ? listPublicLinks("form", row.id)[0] ?? null : null;
  return {
    ...listItem(row, userId, level),
    description: row.description_md, audience: row.audience, audienceUsers: users, audienceGroups: groups, anonymous: row.anonymous === 1, limitPer: row.limit_per,
    allowEdit: row.allow_edit === 1, resultsVisibility: row.results_visibility, display: row.display, opensAt: row.opens_at, maxResponses: row.max_responses,
    verifyEmail: row.verify_email === 1, theme: themeOf(row), ending: endingOf(row), settings: settingsOf(row), calendarId: atLeast(level, "edit") ? row.calendar_id : null,
    finalizedSlotId: row.finalized_slot_id, finalizedEventId: row.finalized_event_id, revision: row.revision, version: publishedVersion(row.id),
    hasDraft: draftSet(host(row.id)) !== null, publicLink: link ? { id: link.id, prefix: link.tokenPrefix, createdAt: link.createdAt, useCount: link.useCount, lastUsedAt: link.lastUsedAt } : null,
    publicAllowed: publicPolicyAllows("form"), createdAt: row.created_at
  };
}

/** The form's search row (titles of the questions people see, never answers; T519). */
export function indexForm(formId: string) {
  const row = db.query("SELECT id, title, description_md FROM forms WHERE id = ?").get(formId) as { id: string; title: string; description_md: string } | null;
  db.query("DELETE FROM forms_fts WHERE form_id = ?").run(formId);
  if (!row) return;
  const set = draftSet(host(formId))?.set ?? currentSet(host(formId))?.set;
  const titles = (set?.questions ?? []).map((question) => question.title).join("\n").slice(0, 50_000);
  db.query("INSERT INTO forms_fts (form_id, title, body) VALUES (?, ?, ?)").run(formId, row.title, `${row.description_md}\n${titles}`);
}

function bump(formId: string, timestamp = now()) {
  db.query("UPDATE forms SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, formId);
}

function wrapQuestion<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof QuestionError) throw new FormError(error.status, error.code, error.message, error.details);
    throw error;
  }
}

function checkKind(kind: FormKind, set: QuestionSet) {
  const problem = kindProblem(kind, set);
  if (problem) throw new FormError(400, "INVALID_QUESTIONS", problem, { problems: [{ path: "questions", message: problem }] });
}

/** Schedules of a form's dates (§B.6): close at closes_at, the owner's 24-hour notice before it. */
export function syncSchedules(row: FormRow, nowMs = Date.now()) {
  cancelSchedules({ kind: "form", id: row.id }, "forms.close");
  cancelSchedules({ kind: "form", id: row.id }, "forms.closing");
  if (row.deleted_at !== null || row.status === "closed" || !row.closes_at) return;
  const closes = Date.parse(row.closes_at);
  if (closes > nowMs) upsertSchedule({ kind: "form", id: row.id }, "forms.close", { once: new Date(closes).toISOString() }, {}, { userId: row.owner_id, fromMs: nowMs });
  if (closes - 86_400_000 > nowMs) upsertSchedule({ kind: "form", id: row.id }, "forms.closing", { once: new Date(closes - 86_400_000).toISOString() }, {}, { userId: row.owner_id, fromMs: nowMs });
}

export type CreateFormInput = {
  kind: FormKind;
  title?: string;
  description?: string;
  template?: FormTemplate;
  questions?: QuestionSet | QuestionSet["questions"];
  /** Polls and time polls open at once; a form opens when it is first published. */
  publish?: boolean;
  settings?: Partial<FormSettingsPatch>;
};

export type FormSettingsPatch = {
  title: string; description: string; audience: FormAudience; audienceUsers: string[]; audienceGroups: string[]; anonymous: boolean; limitPer: LimitPer;
  allowEdit: boolean; resultsVisibility: ResultsVisibility; display: FormDisplay; opensAt: string | null; closesAt: string | null; maxResponses: number | null;
  verifyEmail: boolean; theme: Partial<FormTheme>; ending: Partial<FormEnding>; settings: Partial<FormSettings>; calendarId: string | null;
};

const toSet = (questions: CreateFormInput["questions"]): QuestionSet | null => questions === undefined ? null : Array.isArray(questions) ? { ...emptyQuestionSet(), questions } : questions;

export function createForm(userId: string, input: CreateFormInput): FormRow {
  const template = input.template ? formTemplate(input.template) : null;
  const kind = input.kind;
  const set = toSet(input.questions) ?? (template && template.kind === kind ? template.set : kind === "poll" ? pollSet("Which option do you prefer?", ["Option A", "Option B"], false) : kind === "time_poll" ? emptyQuestionSet() : formTemplate("blank").set);
  const title = (input.title?.trim() || template?.title || (kind === "poll" ? set.questions[0]?.title : null) || (kind === "time_poll" ? "Find a time" : "Untitled form")).slice(0, 200);
  if (kind !== "form" && set.questions.length) checkKind(kind, set);
  const id = crypto.randomUUID();
  const timestamp = now();
  return db.transaction(() => {
    db.query(`INSERT INTO forms (id, owner_id, kind, title, description_md, status, results_visibility, limit_per, created_at, updated_at, settings_json, ending_json)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, 'person', ?, ?, ?, ?)`)
      .run(id, userId, kind, title, (input.description ?? "").slice(0, 20_000), kind === "form" ? "owner_only" : "live", timestamp, timestamp,
        JSON.stringify(DEFAULT_FORM_SETTINGS), JSON.stringify(DEFAULT_ENDING));
    wrapQuestion(() => saveDraftSet(host(id), set, userId));
    recordItemActivity({ itemKind: "form", itemId: id, actorId: userId, kind: "created", payload: { to: { label: title } } });
    audit(userId, null, "forms.create", { formId: id, kind, questions: set.questions.length });
    if (input.settings && Object.keys(input.settings).length) applySettings(formRowById(id)!, userId, input.settings);
    if (input.publish ?? kind !== "form") publishForm(userId, id);
    indexForm(id);
    return formRowById(id)!;
  })();
}

export const formRowById = (id: string) => db.query("SELECT * FROM forms WHERE id = ?").get(id) as FormRow | null;

function applySettings(row: FormRow, userId: string, patch: Partial<FormSettingsPatch>) {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const set = (column: string, value: string | number | null) => { sets.push(`${column} = ?`); values.push(value); };
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title || title.length > 200) throw new FormError(400, "INVALID", "A title is 1 to 200 characters");
    if (title !== row.title) { set("title", title); recordItemChange({ itemKind: "form", itemId: row.id, actorId: userId, kind: "title", from: { label: row.title }, to: { label: title } }); }
  }
  if (patch.description !== undefined) set("description_md", patch.description.slice(0, 20_000));
  if (patch.audience !== undefined || patch.audienceUsers !== undefined || patch.audienceGroups !== undefined) {
    const audience = patch.audience ?? row.audience;
    const current = audienceIds(row);
    const users = [...new Set((patch.audienceUsers ?? current.users).map((value) => value.toLowerCase()))].slice(0, 200);
    const groups = [...new Set((patch.audienceGroups ?? current.groups).map((value) => value.toLowerCase()))].slice(0, 50);
    if (users.length) {
      const found = db.query(`SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NULL AND id IN (${users.map(() => "?").join(",")})`).get(...users) as { n: number };
      if (found.n !== users.length) throw new FormError(400, "INVALID", "One or more people were not found");
    }
    if (groups.length) {
      const found = db.query(`SELECT COUNT(*) AS n FROM user_groups WHERE id IN (${groups.map(() => "?").join(",")})`).get(...groups) as { n: number };
      if (found.n !== groups.length) throw new FormError(400, "INVALID", "One or more groups were not found");
    }
    if (audience === "selected" && !users.length && !groups.length) throw new FormError(400, "INVALID", "Choose at least one person or group to answer");
    if (audience === "public") {
      if (!publicPolicyAllows("form")) throw new FormError(403, "POLICY_OFF", "Public forms are turned off for this workspace");
      const live = currentSet(host(row.id))?.set ?? null;
      const draft = draftSet(host(row.id))?.set ?? null;
      for (const candidate of [live, draft]) if (candidate?.questions.some((question) => !QUESTION_TYPES[question.type].public)) throw new FormError(400, "MEMBERS_ONLY_TYPES", "Files, people, and cards can only be asked of members; remove them to share publicly");
    }
    if (audience !== row.audience) {
      set("audience", audience);
      recordItemChange({ itemKind: "form", itemId: row.id, actorId: userId, kind: "audience", from: { label: row.audience }, to: { label: audience } });
      if (row.audience === "public") revokePublicLinksOf("form", row.id, userId);
    }
    set("audience_json", JSON.stringify({ users: audience === "selected" ? users : [], groups: audience === "selected" ? groups : [] }));
  }
  if (patch.anonymous !== undefined && (patch.anonymous ? 1 : 0) !== row.anonymous) {
    if (row.response_count > 0) throw new FormError(409, "HAS_RESPONSES", "Anonymity cannot change once there are responses");
    set("anonymous", patch.anonymous ? 1 : 0);
    if (patch.anonymous) set("allow_edit", 0);
  }
  if (patch.limitPer !== undefined) set("limit_per", patch.limitPer);
  if (patch.allowEdit !== undefined) set("allow_edit", patch.allowEdit && !(patch.anonymous ?? row.anonymous === 1) ? 1 : 0);
  if (patch.resultsVisibility !== undefined) set("results_visibility", patch.resultsVisibility);
  if (patch.display !== undefined) set("display", patch.display);
  const iso = (value: string | null, name: string) => {
    if (value === null) return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new FormError(400, "INVALID", `${name} must be a date and time`);
    return new Date(ms).toISOString();
  };
  if (patch.opensAt !== undefined) set("opens_at", iso(patch.opensAt, "opensAt"));
  if (patch.closesAt !== undefined) set("closes_at", iso(patch.closesAt, "closesAt"));
  const opens = patch.opensAt !== undefined ? iso(patch.opensAt, "opensAt") : row.opens_at;
  const closes = patch.closesAt !== undefined ? iso(patch.closesAt, "closesAt") : row.closes_at;
  if (opens && closes && Date.parse(opens) >= Date.parse(closes)) throw new FormError(400, "INVALID", "The form must open before it closes");
  if (patch.maxResponses !== undefined) {
    if (patch.maxResponses !== null && (!Number.isInteger(patch.maxResponses) || patch.maxResponses < 1 || patch.maxResponses > 100_000)) throw new FormError(400, "INVALID", "A response limit is 1 to 100,000");
    set("max_responses", patch.maxResponses);
  }
  if (patch.verifyEmail !== undefined) set("verify_email", patch.verifyEmail ? 1 : 0);
  if (patch.theme !== undefined) {
    const accent = patch.theme.accent === undefined ? themeOf(row).accent : patch.theme.accent;
    if (accent !== null && !/^#[0-9a-f]{6}$/i.test(accent)) throw new FormError(400, "INVALID", "An accent is a #rrggbb color");
    set("theme_json", JSON.stringify({ accent }));
  }
  if (patch.ending !== undefined) {
    const ending = { ...endingOf(row), ...patch.ending };
    if (!ending.title.trim() || ending.title.length > 200 || ending.body.length > 5000) throw new FormError(400, "INVALID", "An ending needs a title (200 characters) and at most 5,000 characters of text");
    set("ending_json", JSON.stringify(ending));
  }
  if (patch.settings !== undefined) set("settings_json", JSON.stringify({ ...settingsOf(row), ...patch.settings }));
  if (patch.calendarId !== undefined) set("calendar_id", patch.calendarId);
  if (!sets.length) return;
  db.query(`UPDATE forms SET ${sets.join(", ")}, updated_at = ?, revision = revision + 1 WHERE id = ?`).run(...values, now(), row.id);
  const next = formRowById(row.id)!;
  syncSchedules(next);
  if (patch.title !== undefined || patch.description !== undefined) indexForm(row.id);
}

export function updateFormSettings(userId: string, ref: string, patch: Partial<FormSettingsPatch>, expectedRevision?: number): FormRow {
  return db.transaction(() => {
    const { row } = requireForm(ref, userId, "edit");
    if (expectedRevision !== undefined && expectedRevision !== row.revision) throw new FormError(409, "FORM_CHANGED", "This form changed since you opened it", { revision: row.revision });
    if ((patch.audience !== undefined && patch.audience !== row.audience) || patch.audienceUsers !== undefined || patch.audienceGroups !== undefined) {
      // Who may answer is a sharing decision: managers and the owner.
      if (!atLeast(levelOf(row, userId), "manage")) throw new FormError(403, "OWNER_ONLY", "Only the owner or a manager changes who can answer");
    }
    applySettings(row, userId, patch);
    audit(userId, null, "forms.update", { formId: row.id, fields: Object.keys(patch) });
    return formRowById(row.id)!;
  })();
}

/** The draft to edit: the draft when there is one, else the published version. */
export function editableSet(formId: string): { set: QuestionSet; hasDraft: boolean; version: number } {
  const draft = draftSet(host(formId));
  const current = currentSet(host(formId));
  return { set: draft?.set ?? current?.set ?? emptyQuestionSet(), hasDraft: draft !== null && (!current || JSON.stringify(draft.set) !== JSON.stringify(current.set)), version: current?.version ?? 0 };
}

export function saveFormDraft(userId: string, ref: string, set: unknown): { set: QuestionSet; hasDraft: boolean } {
  return db.transaction(() => {
    const { row } = requireForm(ref, userId, "edit");
    const checked = validateQuestionSet(set);
    if (!checked.ok) throw new FormError(400, "INVALID_QUESTIONS", checked.problems[0]?.message ?? "The questions are not valid", { problems: checked.problems });
    if (row.kind !== "form" && checked.set.questions.length) checkKind(row.kind, checked.set);
    const current = currentSet(host(row.id));
    if (current && JSON.stringify(current.set) === JSON.stringify(checked.set)) discardDraftSet(host(row.id));
    else wrapQuestion(() => saveDraftSet(host(row.id), checked.set, userId));
    bump(row.id);
    indexForm(row.id);
    return { set: checked.set, hasDraft: draftSet(host(row.id)) !== null };
  })();
}

/** Publishes the draft as the next version (D841) and opens a draft form. 409 NO_DRAFT when nothing changed. */
export function publishForm(userId: string, ref: string): FormRow {
  return db.transaction(() => {
    const { row } = requireForm(ref, userId, "edit");
    const draft = draftSet(host(row.id));
    if (!draft) {
      if (row.status === "draft" && currentSet(host(row.id))) return setStatusIn(row, userId, "open");
      throw new FormError(409, "NO_DRAFT", "There are no changes to publish");
    }
    if (!draft.set.questions.some((question) => QUESTION_TYPES[question.type].answers)) throw new FormError(400, "INVALID_QUESTIONS", "Add at least one question to publish");
    checkKind(row.kind, draft.set);
    const published = wrapQuestion(() => publishSet(host(row.id), userId, { audience: row.audience === "public" ? "public" : "member" }));
    recordItemActivity({ itemKind: "form", itemId: row.id, actorId: userId, kind: "published", payload: { count: published.version } });
    audit(userId, null, "forms.publish", { formId: row.id, version: published.version });
    bump(row.id);
    if (row.status === "draft") return setStatusIn(formRowById(row.id)!, userId, "open");
    return formRowById(row.id)!;
  })();
}

export function discardFormDraft(userId: string, ref: string) {
  return db.transaction(() => {
    const { row } = requireForm(ref, userId, "edit");
    if (!currentSet(host(row.id))) throw new FormError(409, "NO_VERSION", "This form was never published; there is nothing to go back to");
    discardDraftSet(host(row.id));
    bump(row.id);
    indexForm(row.id);
    return formRowById(row.id)!;
  })();
}

function setStatusIn(row: FormRow, userId: string | null, status: FormStatus): FormRow {
  if (row.status === status) return row;
  if (status === "open" && !currentSet(host(row.id))) throw new FormError(409, "NOT_PUBLISHED", "Publish the questions first");
  if (status === "draft") throw new FormError(400, "INVALID", "A published form cannot go back to draft; close it instead");
  const timestamp = now();
  // Reopening a form whose date or limit closed it clears that date or limit (the person asked for it open).
  const clearClose = status === "open" && row.closes_at && Date.parse(row.closes_at) <= Date.now() ? ", closes_at = NULL" : "";
  const clearLimit = status === "open" && row.max_responses !== null && row.response_count >= row.max_responses ? ", max_responses = NULL" : "";
  db.query(`UPDATE forms SET status = ?, closed_at = ?${clearClose}${clearLimit}, updated_at = ?, revision = revision + 1 WHERE id = ?`).run(status, status === "closed" ? timestamp : null, timestamp, row.id);
  recordItemChange({ itemKind: "form", itemId: row.id, actorId: userId, kind: "status", from: { label: row.status }, to: { label: status } });
  audit(userId, null, "forms.status", { formId: row.id, from: row.status, to: status });
  const next = formRowById(row.id)!;
  syncSchedules(next);
  if (status === "closed") closedHook?.(next, userId);
  return next;
}

/** Set by server/forms/notifications.ts: who hears that a poll closed. */
let closedHook: ((row: FormRow, actorId: string | null) => void) | null = null;
export const onFormClosed = (hook: (row: FormRow, actorId: string | null) => void) => { closedHook = hook; };

export function setFormStatus(userId: string | null, ref: string, status: FormStatus): FormRow {
  return db.transaction(() => {
    const row = userId ? requireForm(ref, userId, "edit").row : formRow(ref);
    if (!row || row.deleted_at !== null) throw formNotFound();
    return setStatusIn(row, userId, status);
  })();
}

export function duplicateForm(userId: string, ref: string): FormRow {
  const { row } = requireForm(ref, userId, "edit");
  const source = editableSet(row.id).set;
  return db.transaction(() => {
    const copy = createForm(userId, { kind: row.kind, title: `${row.title} (copy)`.slice(0, 200), description: row.description_md, questions: source, publish: false });
    db.query(`UPDATE forms SET anonymous = ?, limit_per = ?, allow_edit = ?, results_visibility = ?, display = ?, max_responses = ?, verify_email = ?, theme_json = ?, ending_json = ?, settings_json = ? WHERE id = ?`)
      .run(row.anonymous, row.limit_per, row.allow_edit, row.results_visibility, row.display, row.max_responses, row.verify_email, row.theme_json, row.ending_json, row.settings_json, copy.id);
    audit(userId, null, "forms.duplicate", { formId: copy.id, sourceId: row.id });
    return formRowById(copy.id)!;
  })();
}

/** To the Bin (30 days, §B.13). Owner or manager. */
export function binForm(userId: string, ref: string): FormRow {
  return db.transaction(() => {
    const { row } = requireForm(ref, userId, "manage");
    const timestamp = new Date();
    db.query("UPDATE forms SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ?").run(timestamp.toISOString(), userId, purgeAfterFrom(timestamp), timestamp.toISOString(), row.id);
    recordItemActivity({ itemKind: "form", itemId: row.id, actorId: userId, kind: "binned" });
    audit(userId, null, "forms.delete", { formId: row.id });
    return formRowById(row.id)!;
  })();
}

// ---------------------------------------------------------------- lists

export type ListFilter = { tab?: "mine" | "shared" | "answer" | "all"; kind?: FormKind; status?: FormStatus; q?: string; cursor?: string | null; limit?: number; extra?: { sql: string; params: Record<string, string> } };

const encodeCursor = (row: { updated_at: string; id: string }) => Buffer.from(JSON.stringify([row.updated_at, row.id])).toString("base64url");
function decodeCursor(value: string | null | undefined): [string, string] | null {
  if (!value || value.length > 200) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string" ? [parsed[0], parsed[1]] : null;
  } catch { return null; }
}

/** Keyset-paged lists of the home tabs (newest change first); access predicates before LIMIT. */
export function listForms(userId: string, filter: ListFilter = {}): { items: FormListItem[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(1, filter.limit ?? 50), 100);
  const terms: string[] = [];
  const params: Record<string, string | number> = { userId, limit: limit + 1 };
  const tab = filter.tab ?? "all";
  if (tab === "mine") terms.push("f.deleted_at IS NULL AND f.owner_id = $userId");
  else if (tab === "shared") terms.push(`f.owner_id <> $userId AND ${readableContainerSql("form", "f")}`);
  else if (tab === "answer") {
    // Your own forms are not "to answer" (they are in My forms).
    terms.push(`${respondableSql("f")} AND f.owner_id <> $userId AND f.status = 'open' AND (f.opens_at IS NULL OR f.opens_at <= $now) AND (f.closes_at IS NULL OR f.closes_at > $now) AND (f.max_responses IS NULL OR f.response_count < f.max_responses)`);
    terms.push(`NOT EXISTS (SELECT 1 FROM responses r WHERE r.host_kind = 'form' AND r.host_id = f.id AND r.status = 'submitted' AND r.respondent_user_id = $userId)`);
    params.now = now();
  } else terms.push(`(${readableContainerSql("form", "f")} OR ${respondableSql("f")})`);
  if (filter.kind) { terms.push("f.kind = $kind"); params.kind = filter.kind; }
  if (filter.status) { terms.push("f.status = $status"); params.status = filter.status; }
  if (filter.q?.trim()) { terms.push("instr(lower(f.title), lower($q)) > 0"); params.q = filter.q.trim().slice(0, 200); }
  if (filter.extra) { terms.push(filter.extra.sql); Object.assign(params, filter.extra.params); }
  const after = decodeCursor(filter.cursor);
  if (after) { terms.push("(f.updated_at, f.id) < ($cursorAt, $cursorId)"); params.cursorAt = after[0]; params.cursorId = after[1]; }
  let rows = db.query(`SELECT f.* FROM forms f WHERE ${terms.join(" AND ")} ORDER BY f.updated_at DESC, f.id DESC LIMIT $limit`).all(params) as FormRow[];
  // Anonymous forms: the person's response is found by its keyed hash, never stored with them (D843).
  if (tab === "answer") rows = rows.filter((row) => !row.anonymous || mySubmitted(row, userId) === null);
  const page = rows.slice(0, limit);
  return { items: page.map((row) => listItem(row, userId)), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null };
}

/** Tab counts for the home (readable "shared" and "to answer"). */
export function listCounts(userId: string) {
  const mine = (db.query("SELECT COUNT(*) AS n FROM forms f WHERE f.deleted_at IS NULL AND f.owner_id = $userId").get({ userId }) as { n: number }).n;
  const answer = listForms(userId, { tab: "answer", limit: 100 }).items.length;
  return { mine, answer };
}

// ---------------------------------------------------------------- answering

/** Results a respondent (not a reader) may see (D844), and a reader always. */
export function resultsVisibleTo(row: FormRow, userId: string | null, options: { responded: boolean; level: ItemLevel }): boolean {
  if (options.level !== "none") return true;
  switch (row.results_visibility) {
    case "live": return true;
    case "after_vote": return options.responded;
    case "after_close": return !accepting(row);
    default: return false;
  }
}

/** Poll and time-poll results (aggregates; voters only on named polls; never text answers, T517). */
export function pollResults(row: FormRow, viewerId: string | null, options: { withVoters: boolean }): PollResults | null {
  const current = currentSet(host(row.id));
  if (!current) return null;
  const question = current.set.questions.find((item) => item.type !== "statement");
  if (!question) return null;
  const summary = summarize(host(row.id));
  const mine = summary.questions.find((item) => item.questionId === question.id) as QuestionSummary | undefined;
  const voters: PollResults["voters"] = [];
  const participants: PollResults["participants"] = [];
  if (options.withVoters && !row.anonymous) {
    if (row.kind === "time_poll") {
      const rows = db.query(`SELECT r.id, r.respondent_user_id AS user_id, COALESCE(u.display_name, r.respondent_name, 'Guest') AS name, a.option_id, a.value_text
        FROM responses r LEFT JOIN users u ON u.id = r.respondent_user_id JOIN response_answers a ON a.response_id = r.id AND a.question_id = ?
        WHERE r.host_kind = 'form' AND r.host_id = ? AND r.status = 'submitted' ORDER BY r.submitted_at LIMIT 20000`).all(question.id, row.id) as Array<{ id: string; user_id: string | null; name: string; option_id: string; value_text: string }>;
      const byResponse = new Map<string, PollResults["participants"][number]>();
      for (const item of rows) {
        const entry = byResponse.get(item.id) ?? { key: item.id, name: item.name, you: viewerId !== null && item.user_id === viewerId, votes: {} };
        entry.votes[item.option_id] = item.value_text as "yes" | "maybe" | "no";
        byResponse.set(item.id, entry);
      }
      participants.push(...byResponse.values());
    } else {
      const rows = db.query(`SELECT a.option_id, r.respondent_user_id AS id, COALESCE(u.display_name, r.respondent_name, 'Guest') AS name
        FROM responses r JOIN response_answers a ON a.response_id = r.id AND a.question_id = ? LEFT JOIN users u ON u.id = r.respondent_user_id
        WHERE r.host_kind = 'form' AND r.host_id = ? AND r.status = 'submitted' ORDER BY r.submitted_at LIMIT 5000`).all(question.id, row.id) as Array<{ option_id: string; id: string | null; name: string }>;
      const byOption = new Map<string, PersonRefLite[]>();
      for (const item of rows) byOption.set(item.option_id, [...(byOption.get(item.option_id) ?? []), { id: item.id ?? "", name: item.name }]);
      for (const [optionId, people] of byOption) voters.push({ optionId, people: people.slice(0, 50) });
    }
  }
  return { total: summary.responses, summary: mine ?? null, voters, participants };
}

export function respondView(userId: string, ref: string): RespondView {
  const { row, level } = requireForm(ref, userId, "respond");
  const current = currentSet(host(row.id));
  const mineId = mySubmitted(row, userId);
  const mineResponse = mineId && !row.anonymous ? getResponse(mineId) : null;
  let reason = closedReason(row);
  const respondable = mayRespond(row, userId);
  if (!reason && !respondable) reason = "not_invited";
  const repeat = row.kind !== "form" ? !row.anonymous : row.allow_edit === 1;
  if (!reason && mineId && row.limit_per !== "none" && !repeat) reason = "answered";
  const responded = mineId !== null;
  const visible = row.kind !== "form" && resultsVisibleTo(row, userId, { responded, level });
  recordVisit(row.id, "views");
  return {
    form: {
      id: row.id, shortId: row.short_id, kind: row.kind, title: row.title, description: row.description_md, status: row.status, accepting: accepting(row), display: row.display,
      anonymous: row.anonymous === 1, allowEdit: row.allow_edit === 1, limitPer: row.limit_per, closesAt: row.closes_at, theme: themeOf(row), ending: endingOf(row), settings: settingsOf(row),
      resultsVisibility: row.results_visibility, finalizedSlotId: row.finalized_slot_id, owner: { id: row.owner_id, name: userName(row.owner_id) }, responseCount: row.response_count,
      href: hrefOf(row), level: level === "none" ? null : level as FormListItem["level"], canRespond: respondable
    },
    version: current?.version ?? 0,
    set: current?.set ?? null,
    mine: mineResponse ? { id: mineResponse.id, answers: mineResponse.answers as Record<string, unknown>, submittedAt: mineResponse.submittedAt, revision: mineResponse.revision } : responded ? { id: "", answers: {}, submittedAt: "", revision: 0 } : null,
    closedReason: reason,
    results: visible ? pollResults(row, userId, { withVoters: true }) : null
  };
}

export function recordVisit(formId: string, field: "views" | "starts" | "submits", nowMs = Date.now()) {
  db.query(`INSERT INTO form_visits (form_id, day, ${field}) VALUES (?, ?, 1) ON CONFLICT (form_id, day) DO UPDATE SET ${field} = ${field} + 1`).run(formId, new Date(nowMs).toISOString().slice(0, 10));
}

export function recount(formId: string, at?: string) {
  const row = db.query("SELECT COUNT(*) AS n, MAX(submitted_at) AS last FROM responses WHERE host_kind = 'form' AND host_id = ? AND status = 'submitted'").get(formId) as { n: number; last: string | null };
  db.query("UPDATE forms SET response_count = ?, last_response_at = ?, updated_at = COALESCE(?, updated_at) WHERE id = ?").run(row.n, row.last, at ?? null, formId);
  const form = formRowById(formId)!;
  // A response limit reached closes the form (and tells the poll's voters).
  if (form.status === "open" && form.max_responses !== null && form.response_count >= form.max_responses) setStatusIn(form, null, "closed");
}

export type SubmitOutcome = { response: ResponseSummary; ending: string | null; created: boolean; form: FormRow };

/** Set by server/forms/actions.ts and notifications.ts: what happens after a response commits. */
type AfterSubmit = (outcome: SubmitOutcome, context: { actorId: string | null; via: "app" | "public" | "mcp" }) => void;
const afterSubmit: AfterSubmit[] = [];
export const onResponseSubmitted = (hook: AfterSubmit) => { afterSubmit.push(hook); };
/** Runs the hooks (after commit: actions are async, notifications are their own transactions). */
export function responseCommitted(outcome: SubmitOutcome, context: Parameters<AfterSubmit>[1]) {
  for (const hook of afterSubmit) {
    try { hook(outcome, context); } catch { /* a hook never fails the respondent (D845) */ }
  }
}

function wrapAnswers<T>(run: () => T): T {
  return wrapQuestion(run);
}

/**
 * A member's response (in the app, MCP, REST). One per person unless the form allows more; polls
 * and time polls replace the earlier vote (named polls; anonymous ones keep the first, D843); forms
 * with "allow editing" replace the earlier response when `responseId` names it.
 */
export function submitMemberResponse(userId: string, ref: string, input: { answers: Record<string, unknown>; responseId?: string | null; hidden?: Record<string, string>; expectedRevision?: number }, via: "app" | "mcp" = "app"): SubmitOutcome {
  const outcome = db.transaction((): SubmitOutcome => {
    const { row } = requireForm(ref, userId, "respond");
    if (!mayRespond(row, userId)) throw formNotFound();
    const reason = closedReason(row);
    if (reason) throw new FormError(409, reason === "full" ? "FORM_FULL" : reason === "not_open_yet" ? "NOT_OPEN_YET" : "FORM_CLOSED", reason === "not_open_yet" ? "This form is not open yet" : "This form is not accepting responses");
    const existing = mySubmitted(row, userId);
    const replaceable = row.kind !== "form" ? !row.anonymous : row.allow_edit === 1 && !row.anonymous;
    const hidden = Object.fromEntries(Object.entries(input.hidden ?? {}).filter(([key, value]) => typeof key === "string" && typeof value === "string").slice(0, 20).map(([key, value]) => [key, value.slice(0, 500)]));
    if (existing && (input.responseId === existing || (row.kind !== "form" && replaceable))) {
      if (!replaceable) throw new FormError(409, "ALREADY_RESPONDED", "You already responded");
      const response = wrapAnswers(() => updateResponse({ responseId: existing, answers: input.answers, audience: "member", expectedRevision: input.expectedRevision }));
      recount(row.id);
      audit(userId, null, "forms.response_update", { formId: row.id, responseId: existing });
      return { response, ending: null, created: false, form: formRowById(row.id)! };
    }
    if (existing && row.limit_per !== "none") throw new FormError(409, "ALREADY_RESPONDED", row.kind === "form" ? "You already responded to this form" : "You already voted");
    const respondent = row.anonymous ? { kind: "anonymous" as const, dedupeHash: anonymousDedupeHash(host(row.id), userId) } : { kind: "user" as const, userId };
    const response = wrapAnswers(() => submitResponse({ host: host(row.id), respondent, answers: input.answers, audience: "member", hidden, meta: { via } }));
    const meta = JSON.parse((db.query("SELECT meta_json FROM responses WHERE id = ?").get(response.id) as { meta_json: string }).meta_json) as { ending?: string };
    const at = response.submittedAt;
    recordVisit(row.id, "submits");
    recount(row.id, at);
    if (!row.anonymous) recordItemActivity({ itemKind: "response", itemId: response.id, container: { kind: "form", id: row.id }, actorId: userId, kind: "submitted" });
    audit(userId, null, "forms.response_submit", { formId: row.id, responseId: response.id, via });
    return { response, ending: meta.ending ?? null, created: true, form: formRowById(row.id)! };
  })();
  responseCommitted(outcome, { actorId: userId, via });
  return outcome;
}

/** Removes the caller's vote on a poll (named polls only). */
export function retractVote(userId: string, ref: string) {
  return db.transaction(() => {
    const { row } = requireForm(ref, userId, "respond");
    if (row.kind === "form" || row.anonymous) throw new FormError(400, "INVALID", "Only a named poll's vote can be removed");
    if (!accepting(row)) throw new FormError(409, "FORM_CLOSED", "This poll is closed");
    const existing = mySubmitted(row, userId);
    if (!existing) return false;
    db.query("DELETE FROM responses WHERE id = ?").run(existing);
    recount(row.id);
    audit(userId, null, "forms.vote_retract", { formId: row.id });
    return true;
  })();
}

// ---------------------------------------------------------------- results

const anonymousView = (row: FormRow, response: ResponseSummary): ResponseSummary => row.anonymous
  ? { ...response, respondent: { kind: "anonymous" }, submittedAt: response.submittedAt.slice(0, 10), updatedAt: response.updatedAt.slice(0, 10) }
  : response;

export type ResponseListItem = ResponseSummary & { respondentName: string; actions: Array<{ kind: string; status: string; resultRef: string | null }> };

function withNames(row: FormRow, items: ResponseSummary[]): ResponseListItem[] {
  return items.map((item) => {
    const view = anonymousView(row, item);
    const name = row.anonymous ? "Anonymous" : item.respondent.userId ? userName(item.respondent.userId) : item.respondent.name || "Guest";
    const actions = db.query("SELECT a.kind, r.status, r.result_ref FROM form_action_runs r JOIN form_actions a ON a.id = r.action_id WHERE r.response_id = ? ORDER BY a.position").all(item.id) as Array<{ kind: string; status: string; result_ref: string | null }>;
    return { ...view, respondentName: name, actions: actions.map((action) => ({ kind: action.kind, status: action.status, resultRef: action.result_ref })) };
  });
}

export function parseFilter(input: { question?: string | null; option?: string | null; since?: string | null; until?: string | null }): ResponseFilter {
  const filter: ResponseFilter = {};
  if (input.question && input.option && input.question.length <= 16 && input.option.length <= 64) filter.answer = { questionId: input.question, optionId: input.option };
  if (input.since && Number.isFinite(Date.parse(input.since))) filter.since = new Date(input.since).toISOString();
  if (input.until && Number.isFinite(Date.parse(input.until))) filter.until = new Date(input.until).toISOString();
  return filter;
}

export function listResponses(userId: string, ref: string, filter: ResponseFilter, cursor?: string | null, limit = 50) {
  const { row } = requireForm(ref, userId, "view");
  const page = responsesPage(host(row.id), filter, cursor, limit);
  return { items: withNames(row, page.items), nextCursor: page.nextCursor, total: row.response_count };
}

export function getFormResponse(userId: string, ref: string, responseId: string) {
  const { row, level } = requireForm(ref, userId, "view");
  const response = getResponse(responseId);
  if (!response || response.hostKind !== "form" || response.hostId !== row.id) throw new FormError(404, "NOT_FOUND", "Response not found");
  const [item] = withNames(row, [response]);
  const set = setVersion(host(row.id), response.setVersion);
  return { response: item!, set, canDelete: atLeast(level, "edit") };
}

export function deleteFormResponse(userId: string, ref: string, responseId: string) {
  return db.transaction(() => {
    const { row } = requireForm(ref, userId, "edit");
    const response = getResponse(responseId);
    if (!response || response.hostKind !== "form" || response.hostId !== row.id) throw new FormError(404, "NOT_FOUND", "Response not found");
    const result = wrapQuestion(() => deleteEngineResponse(responseId, userId));
    recount(row.id);
    audit(userId, null, "forms.response_delete", { formId: row.id, responseId });
    return result;
  })();
}

export function formSummary(userId: string, ref: string, filter: ResponseFilter = {}): FormSummaryView {
  const { row } = requireForm(ref, userId, "view");
  const summary = summarize(host(row.id), filter);
  const textHidden = row.anonymous === 1 && summary.responses < 3;
  const questions = textHidden ? summary.questions.map((item) => item.kind === "text" ? { ...item, latest: [], topWords: [] } : item) : summary.questions;
  const funnel = db.query("SELECT COALESCE(SUM(views), 0) AS views, COALESCE(SUM(starts), 0) AS starts, COALESCE(SUM(submits), 0) AS submits FROM form_visits WHERE form_id = ?").get(row.id) as FormSummaryView["funnel"];
  const byDay = db.query("SELECT substr(submitted_at, 1, 10) AS day, COUNT(*) AS count FROM responses WHERE host_kind = 'form' AND host_id = ? AND status = 'submitted' GROUP BY day ORDER BY day DESC LIMIT 90").all(row.id) as Array<{ day: string; count: number }>;
  return { ...summary, questions, set: currentSet(host(row.id))?.set ?? null, funnel, byDay: byDay.reverse(), textHidden };
}

// ---------------------------------------------------------------- public link

export function createFormPublicLink(userId: string, ref: string): { token: string; link: FormDetail["publicLink"] } {
  return db.transaction(() => {
    const { row, level } = requireForm(ref, userId, "edit");
    if (!atLeast(level, "manage")) throw new FormError(403, "OWNER_ONLY", "Only the owner or a manager shares a form publicly");
    if (!publicPolicyAllows("form")) throw new FormError(403, "POLICY_OFF", "Public forms are turned off for this workspace");
    if (row.audience !== "public") applySettings(row, userId, { audience: "public" });
    revokePublicLinksOf("form", row.id, userId);
    const created = createLink({ kind: "form", itemId: row.id, createdBy: userId });
    recordItemActivity({ itemKind: "form", itemId: row.id, actorId: userId, kind: "public_link", payload: { extra: { action: "created" } } });
    audit(userId, null, "forms.public_link", { formId: row.id, action: "create", linkId: created.link.id });
    return { token: created.token, link: { id: created.link.id, prefix: created.link.tokenPrefix, createdAt: created.link.createdAt, useCount: 0, lastUsedAt: null } };
  })();
}

export function revokeFormPublicLink(userId: string, ref: string) {
  return db.transaction(() => {
    const { row, level } = requireForm(ref, userId, "edit");
    if (!atLeast(level, "manage")) throw new FormError(403, "OWNER_ONLY", "Only the owner or a manager shares a form publicly");
    const count = revokePublicLinksOf("form", row.id, userId);
    if (row.audience === "public") db.query("UPDATE forms SET audience = 'workspace', updated_at = ?, revision = revision + 1 WHERE id = ?").run(now(), row.id);
    recordItemActivity({ itemKind: "form", itemId: row.id, actorId: userId, kind: "public_link", payload: { extra: { action: "revoked" } } });
    audit(userId, null, "forms.public_link", { formId: row.id, action: "revoke", count });
    return count;
  })();
}

// ---------------------------------------------------------------- polls and time polls (quick create)

export function createPoll(userId: string, input: { question: string; options: string[]; multiple?: boolean; anonymous?: boolean; closesAt?: string | null; resultsVisibility?: ResultsVisibility; audience?: FormAudience; audienceUsers?: string[]; audienceGroups?: string[] }): FormRow {
  const options = input.options.map((label) => label.trim()).filter(Boolean);
  if (options.length < 2) throw new FormError(400, "INVALID", "A poll needs at least two options");
  if (options.length > 20) throw new FormError(400, "INVALID", "A poll has at most 20 options");
  const question = input.question.trim();
  if (!question || question.length > 200) throw new FormError(400, "INVALID", "Ask a question (at most 200 characters)");
  return db.transaction(() => {
    const row = createForm(userId, { kind: "poll", title: question, questions: pollSet(question, options, input.multiple ?? false), publish: false });
    applySettings(row, userId, {
      anonymous: input.anonymous ?? false, closesAt: input.closesAt ?? null, resultsVisibility: input.resultsVisibility ?? "live",
      ...(input.audience ? { audience: input.audience, audienceUsers: input.audienceUsers ?? [], audienceGroups: input.audienceGroups ?? [] } : {})
    });
    return publishForm(userId, row.id);
  })();
}

export function createTimePoll(userId: string, input: { title: string; description?: string; slots: Array<{ start: string; end: string }>; allowMaybe?: boolean; closesAt?: string | null; calendarId?: string | null; audience?: FormAudience; audienceUsers?: string[]; audienceGroups?: string[] }): FormRow {
  const slots = input.slots.map((slot) => {
    const start = Date.parse(slot.start);
    const end = Date.parse(slot.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new FormError(400, "INVALID", "Each time needs a start before its end");
    if (end - start > 24 * 3_600_000) throw new FormError(400, "INVALID", "A proposed time is at most 24 hours long");
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  }).sort((a, b) => a.start.localeCompare(b.start));
  if (!slots.length) throw new FormError(400, "INVALID", "Propose at least one time");
  if (slots.length > 60) throw new FormError(400, "INVALID", "Propose at most 60 times");
  const title = input.title.trim() || "Find a time";
  return db.transaction(() => {
    const row = createForm(userId, { kind: "time_poll", title, description: input.description, questions: timePollSet("Which times work for you?", slots, input.allowMaybe ?? true), publish: false });
    applySettings(row, userId, {
      resultsVisibility: "live", closesAt: input.closesAt ?? null, calendarId: input.calendarId ?? null,
      ...(input.audience ? { audience: input.audience, audienceUsers: input.audienceUsers ?? [], audienceGroups: input.audienceGroups ?? [] } : {})
    });
    return publishForm(userId, row.id);
  })();
}

export const answersOfResponse = (response: ResponseSummary): Answers => response.answers;

/** A dedupe hash for the public "one per browser" limit (best effort, never reversible to the browser id). */
export const browserHash = (formId: string, browser: string) => keyedHash("form-browser", `${formId}:${browser}`);

export const isFormShortId = isShortId;
