import { slugSegment } from "./friendlyUrls";

/**
 * Townhall (docs/plan/WORKSPACE_MODULES.md §D.7 Townhall): words and shapes both sides share.
 */

export const TOWNHALL_STATES = ["upcoming", "live", "ended"] as const;
export type TownhallState = typeof TOWNHALL_STATES[number];

export const QUESTION_STATUSES = ["pending", "approved", "answered", "hidden"] as const;
export type TownhallQuestionStatus = typeof QUESTION_STATUSES[number];

export const POLL_KINDS = ["single", "multi", "word_cloud", "rating", "open_text"] as const;
export type TownhallPollKind = typeof POLL_KINDS[number];
export const POLL_KIND_LABELS: Record<TownhallPollKind, string> = {
  single: "Single choice", multi: "Multiple choice", word_cloud: "Word cloud", rating: "Rating", open_text: "Open text"
};

export const MODERATION_ACTIONS = ["approve", "hide", "unhide", "answered", "reopen", "pin", "unpin", "star", "unstar", "merge"] as const;
export type TownhallModeration = typeof MODERATION_ACTIONS[number];

export const TOWNHALL_LIMITS = {
  question: 500,
  title: 200,
  description: 20000,
  pollTitle: 300,
  pollOptions: 10,
  optionLabel: 120,
  word: 25,
  openText: 500,
  wordsPerPerson: 3,
  name: 80,
  pollsPerSession: 50,
  questionsPerSession: 2000,
  cardsAtOnce: 50
} as const;

export type TownhallSessionSummary = {
  id: string;
  shortId: string;
  title: string;
  state: TownhallState;
  startsAt: string | null;
  endsAt: string | null;
  questionCount: number;
  ownerName: string;
  href: string;
  updatedAt: string;
};

/**
 * Whose name a question shows (D1104, T621): `member`, a workspace member's display name; `guest`, a
 * name a public participant typed (anyone can type any name); null when anonymous.
 */
export type TownhallAuthorKind = "member" | "guest" | null;

/** The name to show for a question's asker: a guest's typed name says so ("Ada · guest"), so it cannot pass for a member. */
export const authorLabel = (question: { author: string | null; authorKind?: TownhallAuthorKind }) =>
  question.author === null ? null : question.authorKind === "guest" ? `${question.author} · guest` : question.author;

export type TownhallQuestionView = {
  id: string;
  text: string;
  /** Null: anonymous (or hidden from this reader). Show it with `authorLabel`. */
  author: string | null;
  authorKind: TownhallAuthorKind;
  votes: number;
  voted: boolean;
  status: TownhallQuestionStatus;
  pinned: boolean;
  /** Moderators only (false for everyone else). */
  starred: boolean;
  mine: boolean;
  createdAt: string;
  answeredAt: string | null;
  mergedCount: number;
  commentCount: number;
  /** Moderators: the card made from it. */
  card: { id: string; href: string } | null;
};

export type TownhallPollView = {
  id: string;
  kind: TownhallPollKind;
  title: string;
  options: Array<{ id: string; label: string }>;
  status: "draft" | "live" | "closed";
  resultsHidden: boolean;
  /** Null when this reader does not see results yet. */
  counts: Record<string, number> | null;
  total: number;
  myVote: string[];
  /** Word clouds: phrases and counts; open text: the latest answers. */
  words: Array<{ text: string; count: number }>;
  entries: string[];
  /** Ratings. */
  average: number | null;
  distribution: Record<number, number>;
  myRating: number | null;
  myWords: string[];
  max: number;
};

export type TownhallSessionView = {
  id: string;
  shortId: string;
  title: string;
  description: string;
  state: TownhallState;
  startsAt: string | null;
  endsAt: string | null;
  questionsOpen: boolean;
  allowAnonymous: boolean;
  moderation: "off" | "review";
  allowComments: boolean;
  reminderMinutes: number;
  pinnedQuestionId: string | null;
  activePollId: string | null;
  event: { id: string; title: string; href: string; start: string | null } | null;
  owner: { id: string; name: string };
  href: string;
  revision: number;
  wentLiveAt: string | null;
  endedAt: string | null;
  recapNote: { id: string; href: string } | null;
  visibility: "private" | "selected" | "all_users";
};

export type TownhallYou = {
  level: string;
  canModerate: boolean;
  canAsk: boolean;
  canVote: boolean;
  canComment: boolean;
  canManage: boolean;
  /** Public participants only: the name they gave. */
  name?: string | null;
};

export type TownhallLiveState = {
  session: TownhallSessionView;
  you: TownhallYou;
  questions: TownhallQuestionView[];
  polls: TownhallPollView[];
  stats: { questions: number; pending: number; answered: number; participants: number };
  /** Editors: the audience link (when public pages allow it and one was made). */
  publicUrl?: string | null;
  publicAllowed?: boolean;
};

export type TownhallRecap = {
  session: { id: string; title: string; state: TownhallState; startsAt: string | null; wentLiveAt: string | null; endedAt: string | null; href: string };
  totals: { questions: number; answered: number; unanswered: number; hidden: number; votes: number; participants: number; members: number; publicParticipants: number; polls: number };
  answered: Array<{ id: string; text: string; votes: number; author: string | null; authorKind: TownhallAuthorKind; answeredAt: string | null }>;
  unanswered: Array<{ id: string; text: string; votes: number; author: string | null; authorKind: TownhallAuthorKind; card: { id: string; href: string } | null }>;
  polls: Array<{ id: string; kind: TownhallPollKind; title: string; total: number; results: Array<{ label: string; count: number }>; average: number | null }>;
};

/** The path of a session: `/townhall/<slug>-<shortid>` (friendly URLs, D772). */
export const townhallPath = (title: string, shortId: string) => `/townhall/${slugSegment(title, shortId)}`;
