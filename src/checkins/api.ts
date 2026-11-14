import { api, ApiError } from "../api";
import type { AnswerPrefill, CheckinDetail, CheckinSchedule, CheckinStats, CheckinSummary, CheckinTemplate, DueRound, FeedEntry, RoundView } from "../../shared/checkins";
import type { Answers, QuestionSet } from "../../shared/questions";
import type { ReactionAggregate } from "../../shared/reactions";

/** Standups' HTTP calls (docs/plan/API_CONTRACTS.md "Standups"). */

const json = (body: unknown) => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const listStandups = (mine: "participant" | "all" = "all") => api<{ items: CheckinSummary[]; nextCursor: string | null }>(`/checkins?mine=${mine}`);
export const dueStandups = () => api<{ items: DueRound[] }>("/checkins/due");
export const getStandup = (ref: string) => api<{ checkin: CheckinDetail }>(`/checkins/${enc(ref)}`);
export const createStandup = (body: { template: CheckinTemplate; name?: string; schedule?: Partial<CheckinSchedule>; participants?: { people: string[]; groups: string[] }; deadlineMinutes?: number; reminderMinutesBefore?: number | null }) =>
  api<{ checkin: CheckinDetail }>("/checkins", { method: "POST", ...json(body) });
export const updateStandup = (ref: string, body: Record<string, unknown>) => api<{ checkin: CheckinDetail }>(`/checkins/${enc(ref)}`, { method: "PATCH", ...json(body) });
export const deleteStandup = (ref: string) => api<{ binned: true }>(`/checkins/${enc(ref)}`, { method: "DELETE" });
export const setStandupParticipants = (ref: string, people: string[], groups: string[]) => api<{ participants: number }>(`/checkins/${enc(ref)}/participants`, { method: "PUT", ...json({ people, groups }) });
export const setMyStandup = (ref: string, body: { tz?: string | null; pausedUntil?: string | null }) => api<{ tz: string | null; paused_until: string | null }>(`/checkins/${enc(ref)}/participants/me`, { method: "PATCH", ...json(body) });
export const setStandupSubscription = (ref: string, summaries: boolean) => api<{ summaries: boolean }>(`/checkins/${enc(ref)}/subscription`, { method: "PUT", ...json({ summaries }) });
export const sendTimeZone = (tz: string) => api<{ updated: number }>("/checkin-participation/timezone", { method: "PUT", ...json({ tz }) });
export const readStandupQuestions = (ref: string) => api<{ current: QuestionSet | null; version: number; draft: QuestionSet | null }>(`/checkins/${enc(ref)}/questions`);
export const saveStandupQuestions = (ref: string, set: QuestionSet) => api<{ draft: QuestionSet }>(`/checkins/${enc(ref)}/questions`, { method: "PUT", ...json({ set }) });
export const publishStandupQuestions = (ref: string) => api<{ version: number }>(`/checkins/${enc(ref)}/questions/publish`, { method: "POST" });
export const startRound = (ref: string) => api<{ round: RoundView }>(`/checkins/${enc(ref)}/rounds`, { method: "POST" });
export const listRounds = (ref: string) => api<{ items: Array<{ id: string; date: string; status: string; answered: number; participants: number; you: string | null; href: string }>; nextCursor: string | null }>(`/checkins/${enc(ref)}/rounds`);
export const roundByDate = (ref: string, date: string) => api<RoundView>(`/checkins/${enc(ref)}/rounds/${enc(date)}`);
export const standupStats = (ref: string) => api<CheckinStats>(`/checkins/${enc(ref)}/stats`);
export const unblock = (ref: string, cardId: string) => api<{ unblocked: boolean }>(`/checkins/${enc(ref)}/unblock`, { method: "POST", ...json({ cardId }) });
export const roundPrefill = (roundId: string) => api<AnswerPrefill>(`/checkin-rounds/${enc(roundId)}/me`);
export const answerRound = (roundId: string, answers: Answers, expectedRevision?: number, goalUpdates?: Array<{ goalId: string; values: Record<string, number> }>) =>
  api<{ status: string; edited: boolean; blockers: number; round: RoundView }>(`/checkin-rounds/${enc(roundId)}/answer`, { method: "POST", ...json({ answers, ...(expectedRevision ? { expectedRevision } : {}), ...(goalUpdates?.length ? { goalUpdates } : {}) }) });
export const skipRound = (roundId: string) => api<{ status: "skipped" }>(`/checkin-rounds/${enc(roundId)}/skip`, { method: "POST" });
export const closeRound = (roundId: string) => api<RoundView>(`/checkin-rounds/${enc(roundId)}/close`, { method: "POST" });
export const nudgeRound = (roundId: string) => api<{ nudged: number }>(`/checkin-rounds/${enc(roundId)}/nudge`, { method: "POST" });
export const standupFeed = (params: { checkin?: string; person?: string; blockers?: boolean; q?: string; cursor?: string | null }) => {
  const query = new URLSearchParams();
  if (params.checkin) query.set("checkin", params.checkin);
  if (params.person) query.set("person", params.person);
  if (params.blockers) query.set("blockers", "1");
  if (params.q) query.set("q", params.q);
  if (params.cursor) query.set("cursor", params.cursor);
  return api<{ items: FeedEntry[]; nextCursor: string | null }>(`/checkins/feed?${query}`);
};
export const setAnswerReaction = (responseId: string, emoji: string, on: boolean) =>
  api<{ reactions: ReactionAggregate[] }>(`/reactions/checkin_answer/${enc(responseId)}/${enc(emoji)}`, { method: on ? "PUT" : "DELETE", headers: { "Content-Type": "application/json" } });


export const errorText = (reason: unknown, fallback: string) => reason instanceof ApiError ? reason.message : fallback;
export const errorCode = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as { code?: string }).code : undefined;
export const fieldErrors = (reason: unknown): Record<string, string> => reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? ((reason.payload as { errors?: Record<string, string> }).errors ?? {}) : {};
