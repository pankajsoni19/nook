import { emptyQuestionSet, type Answers, type QuestionSet } from "./questions";
import type { WorkSummary, HiddenWorkSummary } from "./workRefs";
import { registerActivityKinds } from "./itemActivity";

/**
 * Standups (module id `checkins`, docs/plan/WORKSPACE_MODULES.md §D.4, D930–D959): what the server
 * and the client share — templates, the schedule shape, participation states, and the JSON the
 * HTTP API and MCP return. Pure; no imports beyond shared/.
 */

export const CHECKIN_TEMPLATES = ["standup", "weekly", "retro", "pulse", "custom"] as const;
export type CheckinTemplate = typeof CHECKIN_TEMPLATES[number];

export const PARTICIPATION_STATES = ["pending", "answered", "late", "skipped", "out"] as const;
export type ParticipationState = typeof PARTICIPATION_STATES[number];

export const CHECKIN_NAME_MAX = 120;
export const CHECKIN_DESCRIPTION_MAX = 4000;
/** Goals one standup answer may check in on (§C5, D1043). */
export const STANDUP_GOAL_UPDATES_MAX = 10;
export const CHECKIN_MAX_PARTICIPANTS = 200;
export const CHECKIN_MAX_GROUPS = 20;
/** Anonymous standups show results only from this many answers on (T553). */
export const ANONYMOUS_MIN_ANSWERS = 3;
/** Answers stay editable (and late answers accepted) this long after a round closes (D933). */
export const ANSWER_GRACE_MS = 24 * 3_600_000;

/** When a standup runs (`checkins.schedule_json`). `zoneMode: "each"` opens it at `at` in each participant's own zone. */
export type CheckinSchedule = { weekdays: number[]; at: string; everyNWeeks: number; zoneMode: "each" | "fixed"; tz: string };

export type CheckinTemplateDef = {
  label: string;
  description: string;
  name: string;
  anonymous: boolean;
  schedule: Omit<CheckinSchedule, "tz">;
  deadlineMinutes: number;
  reminderMinutesBefore: number | null;
  questions: () => QuestionSet;
};

const set = (questions: QuestionSet["questions"]): QuestionSet => ({ ...emptyQuestionSet(), questions });
const mood = (title = "How are you feeling?", required = false): QuestionSet["questions"][number] =>
  ({ id: "mood", type: "rating", title, role: "mood", required, scale: { min: 1, max: 5, minLabel: "Rough", maxLabel: "Great", icon: "emoji" } });

/** The templates (§A.4): each seeds the question set, the schedule, the deadline, and the reminder. */
export const CHECKIN_TEMPLATE_DEFS: Record<CheckinTemplate, CheckinTemplateDef> = {
  standup: {
    label: "Daily standup", description: "What you did, what's next, and what's in the way. Every weekday morning.", name: "Daily standup", anonymous: false,
    schedule: { weekdays: [1, 2, 3, 4, 5], at: "09:30", everyNWeeks: 1, zoneMode: "each" }, deadlineMinutes: 360, reminderMinutesBefore: 60,
    questions: () => set([
      { id: "done", type: "long_text", title: "What did you get done since last time?", role: "done", prefill: "suggest_cards_done", required: true },
      { id: "plan", type: "long_text", title: "What will you work on today?", role: "plan", prefill: "suggest_cards_planned", required: true },
      { id: "blockers", type: "long_text", title: "Anything blocking you?", help: "Name cards like KAN-12 to flag them as blocked.", role: "blockers" },
      mood()
    ])
  },
  weekly: {
    label: "Weekly update", description: "Progress, plans, and problems once a week.", name: "Weekly update", anonymous: false,
    schedule: { weekdays: [5], at: "14:00", everyNWeeks: 1, zoneMode: "each" }, deadlineMinutes: 1440, reminderMinutesBefore: 240,
    questions: () => set([
      { id: "progress", type: "long_text", title: "What did you make progress on this week?", role: "done", prefill: "suggest_cards_done", required: true },
      { id: "plans", type: "long_text", title: "What are your plans for next week?", role: "plan", prefill: "suggest_cards_planned", required: true },
      { id: "problems", type: "long_text", title: "Any problems or blockers?", role: "blockers" },
      mood("How was your week?"),
      { id: "else", type: "long_text", title: "Anything else to share?" }
    ])
  },
  retro: {
    label: "Retro", description: "What went well, what didn't, and what to try next. Every two weeks.", name: "Sprint retro", anonymous: false,
    schedule: { weekdays: [5], at: "15:00", everyNWeeks: 2, zoneMode: "fixed" }, deadlineMinutes: 2880, reminderMinutesBefore: 480,
    questions: () => set([
      { id: "well", type: "long_text", title: "What went well?", required: true },
      { id: "badly", type: "long_text", title: "What didn't go well?" },
      { id: "try", type: "long_text", title: "What should we try next?" },
      { id: "rating", type: "rating", title: "How would you rate this sprint?", scale: { min: 1, max: 5, icon: "star" } }
    ])
  },
  pulse: {
    label: "Pulse survey", description: "An anonymous mood check. Results show from 3 answers on.", name: "Team pulse", anonymous: true,
    schedule: { weekdays: [5], at: "15:00", everyNWeeks: 1, zoneMode: "each" }, deadlineMinutes: 2880, reminderMinutesBefore: 240,
    questions: () => set([
      mood("How are you feeling about work this week?", true),
      { id: "better", type: "long_text", title: "What's one thing that would make work better?" }
    ])
  },
  custom: {
    label: "Custom", description: "Start from one question and build your own.", name: "Check-in", anonymous: false,
    schedule: { weekdays: [1, 2, 3, 4, 5], at: "10:00", everyNWeeks: 1, zoneMode: "each" }, deadlineMinutes: 480, reminderMinutesBefore: null,
    questions: () => set([{ id: "update", type: "long_text", title: "What's your update?", required: true }])
  }
};

export const PARTICIPATION_LABELS: Record<ParticipationState, string> = {
  pending: "Not yet", answered: "Answered", late: "Late", skipped: "Skipped", out: "Out"
};

/** A person as the API shows them. */
export type CheckinPerson = { id: string; name: string; avatarUrl: string | null };

/** One standup in lists. */
export type CheckinSummary = {
  id: string;
  shortId: string;
  href: string;
  name: string;
  template: CheckinTemplate;
  anonymous: boolean;
  status: "active" | "paused";
  schedule: CheckinSchedule;
  deadlineMinutes: number;
  participantCount: number;
  participants: CheckinPerson[];
  /** The viewer's level: owner, manage, edit, comment, view. */
  level: string;
  youParticipate: boolean;
  /** Consecutive scheduled rounds the viewer answered (out rounds don't break it), or null. */
  streak: number | null;
  lastRound: { id: string; date: string; status: "open" | "closed" | "scheduled"; answered: number; participants: number } | null;
  nextOpensAt: string | null;
  revision: number;
};

export type CheckinDetail = CheckinSummary & {
  description: string;
  privateAnswers: boolean;
  tz: string;
  reminderMinutesBefore: number | null;
  summary: { notifyParticipants: boolean; email: boolean; noteId?: string | null };
  ownerId: string;
  groups: Array<{ id: string; name: string }>;
  /** Participants with their zones and pauses (people the viewer may see). */
  people: Array<CheckinPerson & { tz: string | null; pausedUntil: string | null; viaGroupId: string | null }>;
  you: { tz: string | null; pausedUntil: string | null; summaries: boolean } | null;
  questions: QuestionSet;
  questionsVersion: number;
  hasDraft: boolean;
  createdAt: string;
};

export type RoundParticipant = {
  person: CheckinPerson;
  status: ParticipationState;
  opensAt: string;
  deadlineAt: string;
  /** Null on anonymous standups. */
  answeredAt: string | null;
};

export type AnswerView = {
  /** The response id; comments and reactions hang on it. Absent on anonymous standups. */
  id: string | null;
  person: CheckinPerson | null;
  late: boolean;
  submittedAt: string | null;
  updatedAt: string | null;
  setVersion: number;
  answers: Answers;
  /** Items the answer names (refs and blockers), as the viewer may see them. */
  refs: Array<{ text: string; summary: WorkSummary | HiddenWorkSummary }>;
  reactions: Array<{ emoji: string; count: number; reacted: boolean; names: string[] }>;
  commentCount: number;
  mine: boolean;
};

export type RoundBlocker = { card: WorkSummary | HiddenWorkSummary; people: CheckinPerson[]; flagged: boolean };

export type RoundView = {
  checkin: { id: string; shortId: string; name: string; href: string; anonymous: boolean; template: CheckinTemplate; level: string };
  round: { id: string; date: string; status: "scheduled" | "open" | "closed"; opensAt: string; closesAt: string; closedAt: string | null; manual: boolean; answered: number; participants: number };
  prev: string | null;
  next: string | null;
  /** Question sets by version (answers pin theirs). */
  sets: Record<string, QuestionSet>;
  participants: RoundParticipant[];
  answers: AnswerView[];
  /** Anonymous rounds below the threshold: answers are withheld until this many answered. */
  hiddenUntil: number | null;
  blockers: RoundBlocker[];
  mood: { average: number | null; count: number; distribution: Array<{ value: number; count: number }> } | null;
  you: { status: ParticipationState; deadlineAt: string; canAnswer: boolean; answered: boolean } | null;
  canManage: boolean;
};

export type DueRound = { roundId: string; checkinId: string; name: string; href: string; date: string; deadlineAt: string; status: ParticipationState; anonymous: boolean };

/** Prefill for the answer sheet (D936): suggestions only, nothing posts without the person. */
export type AnswerPrefill = {
  lastAnswers: Answers | null;
  lastPlan: string | null;
  doneCards: WorkSummary[];
  plannedCards: WorkSummary[];
  openBlockers: WorkSummary[];
  current: { id: string; answers: Answers; revision: number } | null;
  /** Cards you logged time on since your last answer (C6, D1046), when Time is there; part of doneCards too. */
  timeCards?: WorkSummary[];
};

/** A goal with key results a participant can check in on from a `goal_update` question (§C5, D1043). */
export type StandupGoalTarget = {
  id: string; title: string; href: string; health: "on_track" | "at_risk" | "off_track" | "none"; progress: number;
  keyResults: Array<{ id: string; title: string; metric: string; currentValue: number; targetValue: number; unit: string | null; manual: boolean }>;
};

export type FeedEntry = AnswerView & { checkin: { id: string; name: string; href: string }; round: { id: string; date: string; href: string }; blockers: number; set: QuestionSet };

export type CheckinStats = {
  rounds: Array<{ id: string; date: string; status: string; answered: number; late: number; skipped: number; out: number; pending: number; participants: number; mood: number | null }>;
  participationRate: number | null;
  averageMood: number | null;
  people: Array<{ person: CheckinPerson; answered: number; late: number; skipped: number; missed: number; streak: number }>;
};

/** A round's path: `/standups/<slug>-<sid>/<date>`. */
export const roundPath = (checkinHref: string, date: string) => `${checkinHref}/${date}`;

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Card references in answer text (KAN-12) and in-app links: the tokens the server resolves into
 * `mentions` and `blocks` links, and the client renders as chips.
 */
export const ANSWER_REF_PATTERN = /(?:https?:\/\/[^\s)>\]]+|\/(?:tasks|notes|files|whiteboards|collections|reports|forms|goals|standups|contacts|bookings|time|townhall)\/[^\s)>\]]+|\b[A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]{0,8}\b)/g;

/** Standups' item activity kinds (§B.5): on a standup (`checkin`) and on a round (`checkin_round`). Ids and dates only, never answer text (T505). */
export const CHECKIN_ACTIVITY = registerActivityKinds("checkins", {
  settings_changed: { shape: "event", coalesce: true },
  questions_published: { shape: "event", coalesce: false },
  participants_changed: { shape: "event", coalesce: true },
  round_opened: { shape: "item", coalesce: false },
  round_closed: { shape: "item", coalesce: false },
  answered: { shape: "item", coalesce: false },
  answer_edited: { shape: "item", coalesce: true },
  /** A closed round was added to the standup's note (C23, D1044). */
  summary_posted: { shape: "item", coalesce: false }
});

/** Text of an answer for search and summaries: strings joined (choice ids and numbers left out). */
export function answerText(set: QuestionSet, answers: Answers): string {
  const parts: string[] = [];
  for (const question of set.questions) {
    const value = answers[question.id];
    if (typeof value === "string" && ["short_text", "long_text"].includes(question.type)) parts.push(value);
  }
  return parts.join("\n");
}
