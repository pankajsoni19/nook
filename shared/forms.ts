import { slugSegment } from "./friendlyUrls";
import { emptyQuestionSet, newQuestionItemId, type Question, type QuestionSet, type QuestionSummary, type SetSummary } from "./questions";

/**
 * Forms, polls, and find-a-time polls (docs/plan/WORKSPACE_MODULES.md §D.1, D840–D869): the words,
 * limits, API shapes, and templates the server (server/forms/*) and the app (src/forms/*) share. Pure.
 *
 * One module, three kinds in one table (D840): a `form` (any number of questions, sections, logic,
 * endings), a `poll` (exactly one single- or multiple-choice question with live results), and a
 * `time_poll` (one `time_slots` question: proposed times, yes / if need be / no per slot).
 */

export const FORM_KINDS = ["form", "poll", "time_poll"] as const;
export type FormKind = typeof FORM_KINDS[number];
export const FORM_STATUSES = ["draft", "open", "closed"] as const;
export type FormStatus = typeof FORM_STATUSES[number];
/** Who may answer (D842; separate from who sees results): everyone in the workspace, chosen people and groups, or also anyone with the public link. */
export const FORM_AUDIENCES = ["workspace", "selected", "public"] as const;
export type FormAudience = typeof FORM_AUDIENCES[number];
export const LIMIT_PER = ["none", "person", "browser"] as const;
export type LimitPer = typeof LIMIT_PER[number];
/** D844: who sees a poll's (or form's) aggregate results besides result readers. */
export const RESULTS_VISIBILITIES = ["owner_only", "live", "after_vote", "after_close"] as const;
export type ResultsVisibility = typeof RESULTS_VISIBILITIES[number];
export const FORM_DISPLAYS = ["page", "stepper"] as const;
export type FormDisplay = typeof FORM_DISPLAYS[number];
export const FORM_ACTION_KINDS = ["create_card", "save_contact", "create_deal", "notify"] as const;
export type FormActionKind = typeof FORM_ACTION_KINDS[number];

export const FORM_TITLE_MAX = 200;
export const FORM_DESCRIPTION_MAX = 20_000;
export const POLL_OPTIONS_MAX = 20;
export const TIME_POLL_SLOTS_MAX = 60;
export const MAX_RESPONSES_LIMIT = 100_000;
export const FORM_ACTIONS_MAX = 10;
/** Accents a form may pick (the §E palette; the public page keeps contrast, D831). */
export const FORM_ACCENTS = ["#f6c453", "#60a5fa", "#34d399", "#f472b6", "#a78bfa", "#fb923c", "#2dd4bf", "#f87171"] as const;

export type FormSettings = {
  /** Owner and editors get a notification (and email) for new responses, coalesced. */
  notifyOnResponse: boolean;
  /** The stepper and long pages show a progress line. */
  showProgress: boolean;
  /** Members see the button "Submit another response" after submitting (limit none). */
  allowAnother: boolean;
};
export const DEFAULT_FORM_SETTINGS: FormSettings = { notifyOnResponse: true, showProgress: true, allowAnother: false };

export type FormTheme = { accent: string | null };
export type FormEnding = { title: string; body: string };
export const DEFAULT_ENDING: FormEnding = { title: "Thanks, your response was sent", body: "" };

export type PersonRefLite = { id: string; name: string };

/** One row of a list ("My forms", "Shared with me", "To answer"). */
export type FormListItem = {
  id: string;
  shortId: string;
  kind: FormKind;
  title: string;
  status: FormStatus;
  /** Accepting responses now (status open, inside its dates, under its limit). */
  accepting: boolean;
  responseCount: number;
  lastResponseAt: string | null;
  closesAt: string | null;
  owner: PersonRefLite;
  /** The viewer's level on the form (results and editing), or null when they only answer it. */
  level: "owner" | "manage" | "edit" | "comment" | "view" | null;
  canRespond: boolean;
  /** The viewer has a response (a vote) on it. */
  responded: boolean;
  /** Responses per day for the last 14 days, oldest first (readers only). */
  spark: number[] | null;
  updatedAt: string;
  href: string;
};

export type PublicLinkInfo = { id: string; prefix: string; createdAt: string; useCount: number; lastUsedAt: string | null };

export type FormDetail = FormListItem & {
  description: string;
  audience: FormAudience;
  audienceUsers: PersonRefLite[];
  audienceGroups: PersonRefLite[];
  anonymous: boolean;
  limitPer: LimitPer;
  allowEdit: boolean;
  resultsVisibility: ResultsVisibility;
  display: FormDisplay;
  opensAt: string | null;
  maxResponses: number | null;
  verifyEmail: boolean;
  /** Whether this server sends email: with mail off, "confirm email" is skipped (D863). */
  mailEnabled: boolean;
  theme: FormTheme;
  ending: FormEnding;
  settings: FormSettings;
  calendarId: string | null;
  finalizedSlotId: string | null;
  finalizedEventId: string | null;
  revision: number;
  /** The published version (0: never published). */
  version: number;
  /** The draft differs from the published version ("Publish changes"). */
  hasDraft: boolean;
  publicLink: PublicLinkInfo | null;
  /** Whether the workspace allows public links now (§G.1 Q2). */
  publicAllowed: boolean;
  createdAt: string;
};

export type FormAction = { id: string; kind: FormActionKind; enabled: boolean; position: number; config: Record<string, unknown>; lastRun: { status: "done" | "failed" | "pending"; at: string; error: string | null } | null; failed: number };

/** Poll and time-poll results the respondents may see (D844). */
export type PollResults = {
  total: number;
  summary: QuestionSummary | null;
  /** Named votes: who chose what (empty on anonymous polls, T518). */
  voters: Array<{ optionId: string; people: PersonRefLite[] }>;
  /** Time polls: each participant's row (named), for the grid. */
  participants: Array<{ key: string; name: string; you: boolean; votes: Record<string, "yes" | "maybe" | "no"> }>;
};

/** What a respondent loads (`GET /api/forms/:id/respond`). */
export type RespondView = {
  form: Pick<FormDetail, "id" | "shortId" | "kind" | "title" | "description" | "status" | "accepting" | "display" | "anonymous" | "allowEdit" | "limitPer" | "closesAt" | "theme" | "ending" | "settings" | "resultsVisibility" | "finalizedSlotId" | "owner" | "responseCount" | "href"> & { level: FormListItem["level"]; canRespond: boolean };
  version: number;
  set: QuestionSet | null;
  /** The viewer's own latest response (for edit, or a poll's current vote). */
  mine: { id: string; answers: Record<string, unknown>; submittedAt: string; revision: number } | null;
  /** Why the viewer cannot answer now, when they cannot. */
  closedReason: "closed" | "not_open_yet" | "full" | "answered" | "not_invited" | "draft" | null;
  results: PollResults | null;
};

export type FormSummaryView = SetSummary & {
  set: QuestionSet | null;
  funnel: { views: number; starts: number; submits: number };
  byDay: Array<{ day: string; count: number }>;
  /** Anonymous forms hide text answers below 3 responses (T518). */
  textHidden: boolean;
};

/** The in-app path of a form (friendly URLs, D812): `/forms/<slug>-<shortid>[/edit|/results]`. */
export const formPath = (title: string, shortId: string, view?: "edit" | "results") => `/forms/${slugSegment(title, shortId)}${view ? `/${view}` : ""}`;
export const publicFormPath = (token: string) => `/p/f/${token}`;

/** A form's `/` editor word for each kind. */
export const FORM_KIND_LABELS: Record<FormKind, string> = { form: "Form", poll: "Poll", time_poll: "Find a time" };

// ---------------------------------------------------------------- templates

const option = (label: string, score?: number) => ({ id: newQuestionItemId(), label, ...(score !== undefined ? { score } : {}) });
const q = (type: Question["type"], title: string, extra: Partial<Question> = {}): Question => ({ id: newQuestionItemId(), type, title, ...extra });

export const FORM_TEMPLATES = ["blank", "feedback", "event_registration", "intake", "nps", "job_application", "quick_poll"] as const;
export type FormTemplate = typeof FORM_TEMPLATES[number];
export const FORM_TEMPLATE_LABELS: Record<FormTemplate, { label: string; description: string; kind: FormKind }> = {
  blank: { label: "Blank form", description: "Start from nothing.", kind: "form" },
  feedback: { label: "Feedback", description: "Rating, what went well, what to improve.", kind: "form" },
  event_registration: { label: "Event registration", description: "Name, email, sessions, dietary needs.", kind: "form" },
  intake: { label: "Intake request", description: "A request that becomes a card.", kind: "form" },
  nps: { label: "NPS survey", description: "Net Promoter Score with a follow-up.", kind: "form" },
  job_application: { label: "Job application", description: "Contact details, role, experience, links.", kind: "form" },
  quick_poll: { label: "Quick poll", description: "One question, live results.", kind: "poll" }
};

/** A template's title and questions (fresh ids each time). */
export function formTemplate(template: FormTemplate): { title: string; kind: FormKind; set: QuestionSet } {
  const set = emptyQuestionSet();
  switch (template) {
    case "feedback":
      set.questions = [
        q("rating", "How would you rate it overall?", { required: true, scale: { min: 1, max: 5, icon: "star" } }),
        q("long_text", "What went well?"),
        q("long_text", "What could be better?"),
        q("yes_no", "May we follow up with you?"),
        q("email", "Your email", { role: "contact_email" })
      ];
      set.logic = [{ id: newQuestionItemId(), when: { all: [{ questionId: set.questions[3]!.id, op: "eq", value: "yes" }] }, then: { show: [set.questions[4]!.id] } }];
      return { title: "Feedback", kind: "form", set };
    case "event_registration":
      set.questions = [
        q("short_text", "Full name", { required: true, role: "contact_name" }),
        q("email", "Email", { required: true, role: "contact_email" }),
        q("multi_choice", "Which sessions will you attend?", { options: [option("Morning keynote"), option("Workshops"), option("Evening social")] }),
        q("dropdown", "Dietary needs", { options: [option("None"), option("Vegetarian"), option("Vegan"), option("Gluten free")], allowOther: true }),
        q("long_text", "Anything else we should know?")
      ];
      return { title: "Event registration", kind: "form", set };
    case "intake":
      set.questions = [
        q("short_text", "What do you need?", { required: true }),
        q("long_text", "Details", { help: "Links, context, and what done looks like." }),
        q("single_choice", "How urgent is it?", { required: true, options: [option("This week"), option("This month"), option("Whenever")] }),
        q("date", "Needed by"),
        q("email", "Your email", { role: "contact_email" })
      ];
      return { title: "Intake request", kind: "form", set };
    case "nps":
      set.questions = [
        q("nps", "How likely are you to recommend us to a friend or colleague?", { required: true }),
        q("long_text", "What is the main reason for your score?")
      ];
      return { title: "NPS survey", kind: "form", set };
    case "job_application":
      set.sections = [{ id: newQuestionItemId(), title: "About you" }, { id: newQuestionItemId(), title: "Experience" }];
      set.questions = [
        q("short_text", "Full name", { required: true, role: "contact_name", sectionId: set.sections[0]!.id }),
        q("email", "Email", { required: true, role: "contact_email", sectionId: set.sections[0]!.id }),
        q("phone", "Phone", { role: "contact_phone", sectionId: set.sections[0]!.id }),
        q("dropdown", "Which role are you applying for?", { required: true, options: [option("Engineering"), option("Design"), option("Sales"), option("Support")], sectionId: set.sections[1]!.id }),
        q("number", "Years of experience", { validation: { min: 0, max: 60 }, sectionId: set.sections[1]!.id }),
        q("url", "Portfolio or LinkedIn", { sectionId: set.sections[1]!.id }),
        q("long_text", "Why do you want to join?", { sectionId: set.sections[1]!.id })
      ];
      return { title: "Job application", kind: "form", set };
    case "quick_poll":
      return { title: "Quick poll", kind: "poll", set: pollSet("Which option do you prefer?", ["Option A", "Option B"], false) };
    default:
      set.questions = [q("short_text", "Untitled question")];
      return { title: "Untitled form", kind: "form", set };
  }
}

/** A poll's question set: one single (or multiple) choice question. */
export function pollSet(question: string, options: readonly string[], multiple: boolean): QuestionSet {
  return { ...emptyQuestionSet(), questions: [q(multiple ? "multi_choice" : "single_choice", question, { required: true, options: options.map((label) => option(label)) })] };
}

/** A time poll's question set: one time_slots question (UTC instants, D846). */
export function timePollSet(title: string, slots: ReadonlyArray<{ start: string; end: string }>, allowMaybe = true): QuestionSet {
  return { ...emptyQuestionSet(), questions: [q("time_slots", title, { required: true, allowMaybe, slots: slots.map((slot) => ({ id: newQuestionItemId(), start: slot.start, end: slot.end })) })] };
}

/** The shape check for a kind (D840): a poll has exactly one choice question; a time poll one time_slots question. */
export function kindProblem(kind: FormKind, set: QuestionSet): string | null {
  if (kind === "form") return null;
  const answerable = set.questions.filter((question) => question.type !== "statement");
  if (kind === "poll") return answerable.length === 1 && ["single_choice", "multi_choice"].includes(answerable[0]!.type) ? null : "A poll has exactly one single or multiple choice question";
  return answerable.length === 1 && answerable[0]!.type === "time_slots" ? null : "A time poll has exactly one question of proposed times";
}
