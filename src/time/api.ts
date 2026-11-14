import { api } from "../api";
import type { Summary, TargetTime, TimeEntry, TimeProject, Timesheet } from "../../shared/time";
import type { WorkRef, WorkSummary } from "../../shared/workRefs";

/** Time's endpoints (server/time/routes.ts), one place for the module's screens and slots. */

export const viewerZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

export type TargetInput = WorkRef | { kind: string; id: string } | { ref: string } | string | null;
export type StartBody = { description?: string; projectId?: string | null; target?: TargetInput; billable?: boolean; tags?: string[]; startedAt?: string };
export type EntryBody = { startedAt: string; duration?: number | string | null; endedAt?: string | null; description?: string; projectId?: string | null; target?: TargetInput; billable?: boolean; tags?: string[]; source?: "manual" | "calendar" };
export type EntryPatchBody = Partial<Omit<EntryBody, "source" | "endedAt">> & { endedAt?: string; expectedRevision?: number };
export type Approval = { id: string; project: { id: string; name: string }; user: { id: string; name: string }; weekStart: string; status: "submitted" | "approved" | "rejected"; note: string | null; seconds: number; decidedAt: string | null };
export type Suggestion = { kind: "event" | "card"; ref: WorkRef; title: string; subtitle?: string; start?: string; end?: string; seconds?: number; href?: string };
export type TimeSettings = { dailyReminder: boolean; reminderAt: string; reminderDays: number[]; longTimerHours: number; tz: string };
export type ClientOption = { id: string; name: string; domain: string | null; projects: number };
export type ProjectBody = {
  name?: string; code?: string | null; color?: string; clientId?: string | null; newClient?: string | null; boardId?: string | null; billableDefault?: boolean; rateMinor?: number | null;
  currency?: string; budget?: { kind: "none" | "hours" | "money"; value?: number | null; period?: "total" | "monthly" }; settings?: { privateEntries?: boolean; requireDescription?: boolean };
  archived?: boolean; visibility?: "private" | "all_users"; expectedRevision?: number;
};

const json = (body: unknown) => ({ body: JSON.stringify(body) });
const tz = () => viewerZone();

export const timeApi = {
  timer: () => api<{ entry: TimeEntry | null; today: { date: string; seconds: number; entries: number } }>(`/time/timer?tz=${encodeURIComponent(tz())}`),
  start: (body: StartBody) => api<{ entry: TimeEntry; stopped: string | null }>("/time/timer/start", { method: "POST", ...json({ ...body, tz: tz() }) }),
  stop: (at?: string) => api<{ entry: TimeEntry | null }>("/time/timer/stop", { method: "POST", ...json(at ? { at } : {}) }),
  entries: (query: Record<string, string | undefined>) => {
    const params = new URLSearchParams({ tz: tz() });
    for (const [name, value] of Object.entries(query)) if (value) params.set(name, value);
    return api<{ entries: TimeEntry[]; nextCursor: string | null }>(`/time/entries?${params}`);
  },
  recent: () => api<{ entries: TimeEntry[] }>("/time/recent"),
  create: (body: EntryBody) => api<{ entry: TimeEntry }>("/time/entries", { method: "POST", ...json({ ...body, tz: tz() }) }),
  update: (id: string, body: EntryPatchBody) => api<{ entry: TimeEntry }>(`/time/entries/${id}`, { method: "PATCH", ...json(body) }),
  remove: (id: string) => api<{ undoTicket: string }>(`/time/entries/${id}`, { method: "DELETE" }),
  split: (id: string, at: string) => api<{ entries: TimeEntry[] }>(`/time/entries/${id}/split`, { method: "POST", ...json({ at }) }),
  undo: (ticket: string) => api<{ restored: number }>(`/undo/${encodeURIComponent(ticket)}`, { method: "POST" }),
  timesheet: (week: string | null, carry = false) => api<Timesheet>(`/time/timesheet?${new URLSearchParams({ tz: tz(), ...(week ? { week } : {}), ...(carry ? { carry: "1" } : {}) })}`),
  setCell: (body: { day: string; projectId: string | null; target: TargetInput; duration: number | null }) =>
    api<{ timesheet: Timesheet; undoTicket?: string }>("/time/timesheet/cell", { method: "PUT", ...json({ ...body, tz: tz() }) }),
  summary: (query: Record<string, string | undefined>) => {
    const params = new URLSearchParams({ tz: tz() });
    for (const [name, value] of Object.entries(query)) if (value) params.set(name, value);
    return api<Summary>(`/time/summary?${params}`);
  },
  exportHref: (query: Record<string, string | undefined>) => {
    const params = new URLSearchParams({ tz: tz() });
    for (const [name, value] of Object.entries(query)) if (value) params.set(name, value);
    return `/api/time/export.csv?${params}`;
  },
  projects: (options: { loggable?: boolean; archived?: boolean } = {}) => api<{ projects: TimeProject[] }>(`/time/projects?${new URLSearchParams({ ...(options.loggable ? { loggable: "1" } : {}), ...(options.archived === false ? { archived: "0" } : {}) })}`),
  project: (id: string) => api<{ project: TimeProject }>(`/time/projects/${encodeURIComponent(id)}`),
  createProject: (body: ProjectBody) => api<{ project: TimeProject }>("/time/projects", { method: "POST", ...json(body) }),
  updateProject: (id: string, body: ProjectBody) => api<{ project: TimeProject }>(`/time/projects/${id}`, { method: "PATCH", ...json(body) }),
  binProject: (id: string) => api<{ binned: boolean }>(`/time/projects/${id}`, { method: "DELETE" }),
  rates: (id: string) => api<{ currency: string; projectRateMinor: number | null; members: Array<{ id: string; name: string; level: string | null; rateMinor: number | null }> }>(`/time/projects/${id}/rates`),
  setRate: (id: string, userId: string, rateMinor: number | null) => api<unknown>(`/time/projects/${id}/rates/${userId}`, { method: "PUT", ...json({ rateMinor }) }),
  clients: (q = "") => api<{ clients: ClientOption[] }>(`/time/clients?${new URLSearchParams({ q })}`),
  tags: () => api<{ tags: string[] }>("/time/tags"),
  approvals: (query: Record<string, string>) => api<{ approvals: Approval[] }>(`/time/approvals?${new URLSearchParams(query)}`),
  submitWeek: (projectId: string, weekStart: string) => api<unknown>("/time/approvals", { method: "POST", ...json({ projectId, weekStart }) }),
  decide: (id: string, decision: "approve" | "reject" | "unlock", note?: string) => api<{ status: string | null; entries: number }>(`/time/approvals/${id}`, { method: "PATCH", ...json({ decision, ...(note ? { note } : {}) }) }),
  target: (kind: string, id: string) => api<TargetTime>(`/time/targets/${kind}/${id}`),
  cards: (ids: readonly string[]) => api<{ cards: Record<string, { seconds: number; estimateSeconds: number | null; running: boolean }> }>(`/time/cards?ids=${ids.join(",")}`),
  suggestions: (date: string) => api<{ suggestions: Suggestion[] }>(`/time/suggestions?${new URLSearchParams({ date, tz: tz() })}`),
  settings: () => api<{ settings: TimeSettings }>("/time/settings"),
  saveSettings: (settings: TimeSettings) => api<{ settings: TimeSettings }>("/time/settings", { method: "PUT", ...json(settings) }),
  boards: () => api<{ boards: Array<{ id: string; name: string; level?: string }> }>("/tasks/boards")
};

export type { TimeEntry, TimeProject, Timesheet, Summary, TargetTime, WorkSummary };
