import { api } from "../api";
import type { FormAction, FormActionKind, FormDetail, FormKind, FormListItem, FormSummaryView, FormTemplate, PollResults, RespondView, ResultsVisibility } from "../../shared/forms";
import type { QuestionSet, ResponseSummary } from "../../shared/questions";

/** The Forms module's HTTP calls (server/forms/routes.ts, API_CONTRACTS "Forms"). */

const json = (body: unknown) => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

export type FormsTab = "mine" | "shared" | "answer" | "all";
export const listForms = (input: { tab: FormsTab; kind?: FormKind | null; q?: string; cursor?: string | null }, signal?: AbortSignal) => {
  const params = new URLSearchParams({ tab: input.tab });
  if (input.kind) params.set("kind", input.kind);
  if (input.q?.trim()) params.set("q", input.q.trim());
  if (input.cursor) params.set("cursor", input.cursor);
  return api<{ items: FormListItem[]; nextCursor: string | null }>(`/forms?${params}`, { signal });
};
export const formCounts = () => api<{ mine: number; answer: number }>("/forms/counts");
export const getForm = (id: string) => api<{ form: FormDetail }>(`/forms/${enc(id)}`);
export const createForm = (input: { kind: FormKind; title?: string; template?: FormTemplate; questions?: QuestionSet; publish?: boolean }) => api<{ form: FormDetail }>("/forms", { method: "POST", ...json(input) });
export const createPoll = (input: { question: string; options: string[]; multiple?: boolean; anonymous?: boolean; closesAt?: string | null; resultsVisibility?: ResultsVisibility }) =>
  api<{ form: FormDetail }>("/forms/polls", { method: "POST", ...json(input) });
export const createTimePoll = (input: { title: string; description?: string; slots: Array<{ start: string; end: string }>; allowMaybe?: boolean; calendarId?: string | null; closesAt?: string | null }) =>
  api<{ form: FormDetail }>("/forms/time-polls", { method: "POST", ...json(input) });
export const patchForm = (id: string, patch: Record<string, unknown>) => api<{ form: FormDetail }>(`/forms/${enc(id)}`, { method: "PATCH", ...json(patch) });
export const binForm = (id: string) => api<{ binned: true }>(`/forms/${enc(id)}`, { method: "DELETE" });
export const getDraft = (id: string) => api<{ set: QuestionSet; hasDraft: boolean; version: number }>(`/forms/${enc(id)}/draft`);
export const saveDraft = (id: string, set: QuestionSet, signal?: AbortSignal) => api<{ set: QuestionSet; hasDraft: boolean }>(`/forms/${enc(id)}/draft`, { method: "PUT", ...json({ set }), signal });
export const discardDraft = (id: string) => api<{ form: FormDetail }>(`/forms/${enc(id)}/draft`, { method: "DELETE" });
export const publishForm = (id: string) => api<{ form: FormDetail }>(`/forms/${enc(id)}/publish`, { method: "POST", ...json({}) });
export const duplicateForm = (id: string) => api<{ form: FormDetail }>(`/forms/${enc(id)}/duplicate`, { method: "POST", ...json({}) });
export const respondView = (id: string) => api<RespondView>(`/forms/${enc(id)}/respond`);
export const countStart = (id: string) => api<void>(`/forms/${enc(id)}/visit`, { method: "POST", ...json({}) }).catch(() => undefined);
export const submitResponse = (id: string, answers: Record<string, unknown>, options: { responseId?: string | null; hidden?: Record<string, string> } = {}) =>
  api<{ responseId: string; ending: string | null; updated: boolean; view: RespondView }>(`/forms/${enc(id)}/responses`, { method: "POST", ...json({ answers, ...options }) });
export const retractVote = (id: string) => api<{ view: RespondView }>(`/forms/${enc(id)}/vote`, { method: "DELETE" });

export type ResponseRow = ResponseSummary & { respondentName: string; actions: Array<{ kind: string; status: string; resultRef: string | null }> };
export type ResponseFilterInput = { question?: string | null; option?: string | null };
const filterParams = (filter: ResponseFilterInput) => {
  const params = new URLSearchParams();
  if (filter.question && filter.option) { params.set("question", filter.question); params.set("option", filter.option); }
  return params;
};
export const listResponses = (id: string, filter: ResponseFilterInput, cursor?: string | null) => {
  const params = filterParams(filter);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "100");
  return api<{ items: ResponseRow[]; nextCursor: string | null; total: number }>(`/forms/${enc(id)}/responses?${params}`);
};
export const getResponse = (id: string, responseId: string) => api<{ response: ResponseRow; set: QuestionSet | null; canDelete: boolean }>(`/forms/${enc(id)}/responses/${enc(responseId)}`);
export const deleteResponse = (id: string, responseId: string) => api<{ undoTicket: string }>(`/forms/${enc(id)}/responses/${enc(responseId)}`, { method: "DELETE" });
export const undo = (ticket: string) => api<unknown>(`/undo/${enc(ticket)}`, { method: "POST", ...json({}) });
export const getSummary = (id: string, filter: ResponseFilterInput) => api<FormSummaryView>(`/forms/${enc(id)}/summary?${filterParams(filter)}`);
export const exportUrl = (id: string, filter: ResponseFilterInput) => `/api/forms/${enc(id)}/export.csv?${filterParams(filter)}`;

export const listActions = (id: string) => api<{ actions: FormAction[] }>(`/forms/${enc(id)}/actions`);
export const createAction = (id: string, kind: FormActionKind, config: Record<string, unknown>) => api<{ action: FormAction }>(`/forms/${enc(id)}/actions`, { method: "POST", ...json({ kind, config }) });
export const updateAction = (id: string, actionId: string, patch: { config?: Record<string, unknown>; enabled?: boolean }) => api<{ action: FormAction }>(`/forms/${enc(id)}/actions/${enc(actionId)}`, { method: "PATCH", ...json(patch) });
export const deleteAction = (id: string, actionId: string) => api<void>(`/forms/${enc(id)}/actions/${enc(actionId)}`, { method: "DELETE" });
export const retryAction = (id: string, actionId: string) => api<{ retried: number }>(`/forms/${enc(id)}/actions/${enc(actionId)}/retry`, { method: "POST", ...json({}) });
export type Targets = { boards: Array<{ id: string; name: string; columns: Array<{ id: string; name: string }> }>; books: Array<{ id: string; name: string; pipelines?: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }> }>; calendars: Array<{ id: string; name: string }> };
export const getTargets = () => api<Targets>("/forms/targets");
export const createBook = (name: string) => api<{ book: { id: string; name: string } }>("/forms/contact-books", { method: "POST", ...json({ name }) });

export const createPublicLink = (id: string) => api<{ token: string; path: string; link: FormDetail["publicLink"] }>(`/forms/${enc(id)}/public-link`, { method: "POST", ...json({}) });
export const revokePublicLink = (id: string) => api<{ revoked: number }>(`/forms/${enc(id)}/public-link`, { method: "DELETE" });
export const finalize = (id: string, input: { slotId: string; calendarId: string | null; tz: string; emailGuests: boolean }) =>
  api<{ form: FormDetail; eventId: string | null; emailed: number; when: string }>(`/forms/${enc(id)}/finalize`, { method: "POST", ...json(input) });

export type BusyItem = { eventId: string; title: string; allDay: boolean; start: string; end: string };
export const busyTimes = (from: string, to: string, tz: string) => api<{ occurrences: BusyItem[] }>(`/events?${new URLSearchParams({ from, to, tz })}`);

export type { PollResults };
