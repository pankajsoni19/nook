import { api } from "../api";
import type { TownhallLiveState, TownhallModeration, TownhallPollKind, TownhallRecap, TownhallSessionSummary, TownhallSessionView, TownhallState } from "../../shared/townhall";

/** Townhall's client calls (server/townhall/routes.ts). Every write sends a JSON body (the CSRF guard needs one). */

const json = (method: string, body: unknown = {}) => ({ method, body: JSON.stringify(body) });
const enc = encodeURIComponent;

export type SessionDraft = {
  title: string; description?: string; startsAt?: string | null; endsAt?: string | null; eventId?: string | null;
  questionsOpen?: boolean; allowAnonymous?: boolean; moderation?: "off" | "review"; allowComments?: boolean; reminderMinutes?: number;
};

export const listSessions = (state: TownhallState | "all", q = "", cursor?: string | null) =>
  api<{ items: TownhallSessionSummary[]; nextCursor: string | null }>(`/townhall/sessions?${new URLSearchParams({ state, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) })}`);
export const createSession = (draft: SessionDraft) => api<{ session: TownhallSessionView }>("/townhall/sessions", json("POST", draft));
export const getState = (ref: string) => api<TownhallLiveState>(`/townhall/sessions/${enc(ref)}`);
export const updateSession = (id: string, patch: Partial<SessionDraft> & { expectedRevision?: number }) => api<{ session: TownhallSessionView }>(`/townhall/sessions/${enc(id)}`, json("PATCH", patch));
export const binSession = (id: string) => api<{ binned: true }>(`/townhall/sessions/${enc(id)}`, json("DELETE"));
export const setState = (id: string, state: "live" | "ended") => api<{ session: TownhallSessionView }>(`/townhall/sessions/${enc(id)}/state`, json("POST", { state }));
export const setPublicLink = (id: string, enabled: boolean) => api<{ publicUrl: string | null }>(`/townhall/sessions/${enc(id)}/public-link`, json("PUT", { enabled }));
export const showOnScreen = (id: string, pollId: string | null) => api<{ activePollId: string | null }>(`/townhall/sessions/${enc(id)}/screen`, json("PUT", { pollId }));

export const ask = (id: string, text: string, anonymous: boolean) => api<{ question: unknown }>(`/townhall/sessions/${enc(id)}/questions`, json("POST", { text, anonymous }));
export const vote = (questionId: string, upvote: boolean) => api<{ votes: number }>(`/townhall/questions/${enc(questionId)}/vote`, json("PUT", { upvote }));
export const withdraw = (questionId: string) => api<{ withdrawn: true }>(`/townhall/questions/${enc(questionId)}`, json("DELETE"));
export const moderate = (questionId: string, action: TownhallModeration, targetId?: string) => api<{ question: unknown }>(`/townhall/questions/${enc(questionId)}/moderate`, json("POST", { action, ...(targetId ? { targetId } : {}) }));
export const toCards = (id: string, boardId: string, columnId: string, questionIds: string[]) =>
  api<{ cards: Array<{ questionId: string; cardId: string; href: string }> }>(`/townhall/sessions/${enc(id)}/cards`, json("POST", { boardId, columnId, questionIds }));

export type PollDraft = { kind: TownhallPollKind; title: string; options?: string[]; resultsHidden?: boolean; launch?: boolean };
export const createPoll = (id: string, draft: PollDraft) => api<{ pollId: string }>(`/townhall/sessions/${enc(id)}/polls`, json("POST", draft));
export const launchPoll = (id: string, pollId: string) => api(`/townhall/sessions/${enc(id)}/polls/${enc(pollId)}/launch`, json("POST"));
export const closePoll = (id: string, pollId: string) => api(`/townhall/sessions/${enc(id)}/polls/${enc(pollId)}/close`, json("POST"));
export const deletePoll = (id: string, pollId: string) => api(`/townhall/sessions/${enc(id)}/polls/${enc(pollId)}`, json("DELETE"));
export const updatePoll = (id: string, pollId: string, patch: { resultsHidden?: boolean }) => api(`/townhall/sessions/${enc(id)}/polls/${enc(pollId)}`, json("PATCH", patch));
export type PollAnswer = { optionIds?: string[]; rating?: number; text?: string };
export const votePoll = (id: string, pollId: string, answer: PollAnswer) => api(`/townhall/sessions/${enc(id)}/polls/${enc(pollId)}/vote`, json("POST", answer));

export const getRecap = (id: string) => api<{ recap: TownhallRecap }>(`/townhall/sessions/${enc(id)}/recap`);
export const postRecapNote = (id: string) => api<{ noteId: string; href: string }>(`/townhall/sessions/${enc(id)}/recap/note`, json("POST"));
export const recapDownloadUrl = (id: string, format: "csv" | "markdown") => `/api/townhall/sessions/${enc(id)}/recap?format=${format}`;

export type BoardOption = { id: string; name: string };
export const listBoards = () => api<{ boards: Array<{ id: string; name: string; level?: string; role?: string }> }>("/tasks/boards");
export const listColumns = (boardId: string) => api<{ columns: Array<{ id: string; name: string }> }>(`/tasks/boards/${enc(boardId)}/columns`);
export type EventOption = { id: string; title: string; start: string; allDay: boolean };
export const upcomingEvents = () => {
  const from = new Date();
  const to = new Date(Date.now() + 60 * 86_400_000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return api<{ occurrences: Array<{ eventId: string; title: string; start: string; allDay: boolean }> }>(`/events?${new URLSearchParams({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), tz })}`);
};

export type DatasetRows = { columns: Array<{ name: string }>; rows: unknown[][]; truncated: boolean };
export const queryDataset = (query: Record<string, unknown>) => api<DatasetRows>("/datasets/query", json("POST", query));
