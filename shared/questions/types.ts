/**
 * The question engine's types (docs/plan/WORKSPACE_MODULES.md §B.2, D802): one way to define
 * questions, answers, logic, and endings for Forms, Polls, Time polls, Standups, Townhall, and
 * Booking intake. Pure; shared by the server (server/questions/*) and the client (src/ui/questions/*).
 *
 * A question set is versioned per host (`question_sets`, migration 087): editing a live form saves a
 * draft, publishing makes a new version, and each response pins the version it answered.
 */

export const QUESTION_SET_VERSION = 1;
export const MAX_QUESTIONS = 200;
export const MAX_SET_BYTES = 262_144;
export const MAX_OPTIONS = 200;
export const MAX_SLOTS = 100;
export const MAX_MATRIX_ROWS = 50;
export const MAX_MATRIX_COLUMNS = 20;
export const MAX_SECTIONS = 50;
export const MAX_LOGIC_RULES = 200;
export const MAX_ENDINGS = 10;
export const MAX_FILES = 5;
export const MAX_PEOPLE = 20;
export const MAX_CARDS = 20;
export const TITLE_MAX = 500;
export const HELP_MAX = 1000;
export const OPTION_LABEL_MAX = 200;
export const SHORT_TEXT_MAX = 500;
export const LONG_TEXT_MAX = 10_000;
export const OTHER_TEXT_MAX = 200;
/** Ids of questions, options, sections, rows, columns, slots, rules, and endings. Generated ones are 8 characters. */
export const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

export type QuestionType =
  | "short_text" | "long_text"
  | "single_choice" | "dropdown" | "yes_no" | "multi_choice" | "ranking"
  | "rating" | "scale" | "nps" | "number"
  | "email" | "phone" | "url"
  | "date" | "time" | "datetime"
  | "matrix" | "time_slots" | "contact" | "hidden"
  | "file" | "person" | "card"
  | "statement";

/** What other modules read a question as (Standups' blockers, Bookings' contact fields, …). */
export type QuestionRole =
  | "done" | "plan" | "blockers" | "mood" | "goal_update"
  | "contact_name" | "contact_email" | "contact_phone" | "company";

export type QuestionOption = { id: string; label: string; score?: number; color?: string };

export type Question = {
  /** Stable id, never reused inside a host's sets. */
  id: string;
  type: QuestionType;
  /** ≤ 500 characters; inline **bold**, _italic_, and links only. */
  title: string;
  help?: string;
  required?: boolean;
  sectionId?: string;
  role?: QuestionRole;
  options?: QuestionOption[];
  allowOther?: boolean;
  shuffle?: boolean;
  minSelect?: number;
  maxSelect?: number;
  validation?: { minLength?: number; maxLength?: number; min?: number; max?: number; step?: number; pattern?: "email" | "url" | "phone" | "integer" };
  scale?: { min: 0 | 1; max: number; minLabel?: string; maxLabel?: string; icon?: "number" | "star" | "heart" | "emoji" };
  matrix?: { rows: Array<{ id: string; label: string }>; columns: Array<{ id: string; label: string }>; multiple?: boolean };
  /** time_slots: UTC ISO instants. */
  slots?: Array<{ id: string; start: string; end: string }>;
  allowMaybe?: boolean;
  /** hidden: the URL parameter whose value it takes. */
  hiddenKey?: string;
  /** Standups (§D.4). */
  prefill?: "last_answer" | "suggest_cards_done" | "suggest_cards_planned";
  /** number/rating/scale: counts towards the response's score (§B.2 Scoring). */
  scored?: boolean;
};

export type Section = { id: string; title?: string; description?: string };

export type ConditionOp = "answered" | "not_answered" | "eq" | "neq" | "includes" | "gt" | "lt" | "between";
export type Condition = { questionId: string; op: ConditionOp; value?: string | number | [number, number] };
export type LogicRule = {
  id: string;
  when: { all?: Condition[]; any?: Condition[] };
  then: { show: string[] } | { hide: string[] } | { jumpTo: string };
};

export type Ending = { id: string; title: string; body?: string; redirectUrl?: string };

export type QuestionSet = {
  version: typeof QUESTION_SET_VERSION;
  questions: Question[];
  sections: Section[];
  logic: LogicRule[];
  endings: Ending[];
};

export const emptyQuestionSet = (): QuestionSet => ({ version: QUESTION_SET_VERSION, questions: [], sections: [], logic: [], endings: [] });

// ---------------------------------------------------------------- answers

/** single_choice, dropdown, yes_no: an option id, or "Other" with its text. */
export type ChoiceAnswer = string | { other: string };
/** multi_choice: option ids, plus an optional "Other" text. */
export type MultiChoiceAnswer = { options: string[]; other?: string };
export type ContactAnswer = { name: string; email?: string; phone?: string; company?: string };
export type SlotVote = "yes" | "maybe" | "no";

/**
 * One answer. Its shape follows the question type:
 * text, email, phone, url, hidden → string; date → "YYYY-MM-DD"; time → "HH:MM"; datetime → ISO instant;
 * single_choice, dropdown, yes_no → ChoiceAnswer; multi_choice → MultiChoiceAnswer; ranking → option ids
 * in order; rating, scale, nps, number → number; matrix → { rowId: colId | colId[] }; time_slots →
 * { slotId: "yes" | "maybe" | "no" }; contact → ContactAnswer; file → document ids; person → user ids;
 * card → card ids or keys.
 */
export type AnswerValue =
  | string | number | string[]
  | { other: string }
  | MultiChoiceAnswer
  | ContactAnswer
  | Record<string, string | string[]>;

/** Answers by question id. Unanswered questions are absent. */
export type Answers = Record<string, AnswerValue>;

export type Audience = "public" | "member";

/** Who answered (`responses.respondent_kind`). */
export type RespondentKind = "user" | "contact" | "guest" | "anonymous";

/** A response as the result readers get it. */
export type ResponseSummary = {
  id: string;
  hostKind: QuestionHostKind;
  hostId: string;
  setVersion: number;
  respondent: { kind: RespondentKind; userId?: string | null; contactId?: string | null; name?: string | null; email?: string | null };
  status: "submitted" | "pending_verification";
  score: number | null;
  answers: Answers;
  submittedAt: string;
  updatedAt: string;
  revision: number;
};

/** Hosts of question sets (087's CHECK list). */
export const QUESTION_HOST_KINDS = ["form", "checkin", "booking_type", "townhall_session"] as const;
export type QuestionHostKind = typeof QUESTION_HOST_KINDS[number];

// ---------------------------------------------------------------- summaries

export type OptionCount = { optionId: string; label: string; count: number; removed?: boolean };
/** Per-question aggregate (`summarize`), one shape per aggregation family. */
export type QuestionSummary =
  | { questionId: string; kind: "choice"; answered: number; options: OptionCount[]; other: number }
  | { questionId: string; kind: "ranking"; answered: number; options: Array<OptionCount & { averageRank: number | null; borda: number }> }
  | { questionId: string; kind: "numeric"; answered: number; min: number | null; max: number | null; mean: number | null; median: number | null; sum: number; distribution: Array<{ value: number; count: number }> }
  | { questionId: string; kind: "nps"; answered: number; promoters: number; passives: number; detractors: number; score: number | null; distribution: Array<{ value: number; count: number }> }
  | { questionId: string; kind: "text"; answered: number; latest: string[]; topWords: Array<{ word: string; count: number }> }
  | { questionId: string; kind: "count"; answered: number }
  | { questionId: string; kind: "dates"; answered: number; byDay: Array<{ day: string; count: number }> }
  | { questionId: string; kind: "matrix"; answered: number; cells: Array<{ rowId: string; columnId: string; count: number }> }
  | { questionId: string; kind: "slots"; answered: number; slots: Array<{ slotId: string; yes: number; maybe: number; no: number }>; best: string | null };

export type SetSummary = { responses: number; questions: QuestionSummary[] };

/** Validation errors of a set, each naming where (`questions.3.options`) and what. */
export type SetProblem = { path: string; message: string };
