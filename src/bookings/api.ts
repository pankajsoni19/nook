import { api } from "../api";
import type { Assignment, BookingSource, BookingStatus, CardTemplate, LocationKind, ReminderSettings, TimeRange, WeeklyRules } from "../../shared/bookings";
import type { QuestionSet } from "../../shared/questions";

/** The Bookings app's endpoints (server/bookings/routes.ts). */

export type Profile = { handle: string; displayName: string; welcome: string; tz: string; enabled: boolean; busyCalendarIds: string[]; publicPath: string };
export type Feed = { id: string; label: string; hint: string; lastFetchedAt: string | null; status: "new" | "ok" | "error"; error: string | null; busyCount: number };
export type Schedule = { id: string; name: string; tz: string; weekly: WeeklyRules; overrides: Array<{ date: string; ranges: TimeRange[] | null; note: string }>; isDefault: boolean; updatedAt: string };
export type BookingType = {
  id: string; shortId: string; slug: string; title: string; description: string; durations: number[]; locationKind: LocationKind; locationValue: string; assignment: Assignment;
  scheduleId: string | null; calendarId: string | null; busyCalendarIds: string[]; includeAllDayBusy: boolean; bufferBefore: number; bufferAfter: number; minNotice: number;
  maxDaysAhead: number; dateFrom: string | null; dateTo: string | null; slotInterval: number; dailyLimit: number | null; weeklyLimit: number | null; confirm: "auto" | "manual";
  pendingHours: number; verifyEmail: boolean; hourlyCap: number; contactBookId: string | null; card: CardTemplate | null; reminders: ReminderSettings; color: string;
  public: boolean; status: "active" | "hidden"; visibility: string; shareRole: string; revision: number; ownerId: string; ownerName: string; level: string; href: string;
  publicPath: string | null; hosts: Array<{ userId: string; name: string; priority: number; calendarId: string | null; scheduleId: string | null }>; createdAt: string; updatedAt: string;
};
export type Booking = {
  id: string; shortId: string; href: string; typeId: string | null; typeTitle: string; typeDeleted: boolean; color: string; hostId: string; hostName: string;
  cohosts: Array<{ id: string; name: string }>; start: string; end: string; durationMin: number; bookerTz: string; status: BookingStatus; bookerName: string; bookerEmail: string;
  guests: string[]; locationKind: LocationKind; location: string; contactId: string | null; cardId: string | null; eventId: string | null; rescheduledFromId: string | null;
  cancelReason: string | null; cancelledBy: string | null; source: BookingSource; createdAt: string; revision: number;
  response?: { setVersion: number; answers: Record<string, unknown> }; questions?: QuestionSet | null;
};
export type SlotDays = { tz: string; duration: number; days: Record<string, string[]> };
export type Insights = {
  days: number; tz: string; total: number; statusCounts: Record<string, number>; cancelRate: number | null; noShowRate: number | null; avgLeadHours: number | null;
  weeks: Array<{ week: string; count: number }>; types: Array<{ type: string; count: number; minutes: number }>; hosts: Array<{ host: string; count: number }>;
};

const send = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const enc = encodeURIComponent;

export const bookingsApi = {
  profile: () => api<{ profile: Profile; feeds: Feed[] }>("/bookings/profile"),
  saveProfile: (input: Partial<Profile>) => api<{ profile: Profile }>("/bookings/profile", send("PUT", input)),
  addFeed: (input: { label: string; url: string }) => api<{ feed: Feed }>("/bookings/feeds", send("POST", input)),
  refreshFeed: (id: string) => api<{ feed: Feed }>(`/bookings/feeds/${enc(id)}/refresh`, send("POST", {})),
  removeFeed: (id: string) => api<void>(`/bookings/feeds/${enc(id)}`, send("DELETE")),
  schedules: () => api<{ schedules: Schedule[] }>("/bookings/schedules"),
  createSchedule: (input: { name: string; tz: string; weekly?: WeeklyRules }) => api<{ schedule: Schedule }>("/bookings/schedules", send("POST", input)),
  saveSchedule: (id: string, input: { name?: string; tz?: string; weekly?: WeeklyRules; isDefault?: boolean }) => api<{ schedule: Schedule }>(`/bookings/schedules/${enc(id)}`, send("PUT", input)),
  deleteSchedule: (id: string) => api<void>(`/bookings/schedules/${enc(id)}`, send("DELETE")),
  putOverride: (id: string, input: { date: string; ranges: TimeRange[] | null; note?: string }) => api<{ schedule: Schedule }>(`/bookings/schedules/${enc(id)}/overrides`, send("PUT", input)),
  deleteOverride: (id: string, date: string) => api<{ schedule: Schedule }>(`/bookings/schedules/${enc(id)}/overrides/${enc(date)}`, send("DELETE")),
  types: () => api<{ types: BookingType[] }>("/bookings/types"),
  type: (ref: string) => api<{ type: BookingType }>(`/bookings/types/${enc(ref)}`),
  createType: (input: Partial<BookingType> & { title: string }) => api<{ type: BookingType }>("/bookings/types", send("POST", input)),
  saveType: (id: string, input: Record<string, unknown>) => api<{ type: BookingType }>(`/bookings/types/${enc(id)}`, send("PATCH", input)),
  deleteType: (id: string) => api<{ ok: true }>(`/bookings/types/${enc(id)}`, send("DELETE")),
  questions: (id: string) => api<{ published: { version: number; set: QuestionSet } | null; draft: { set: QuestionSet } | null }>(`/bookings/types/${enc(id)}/questions`),
  saveQuestions: (id: string, set: QuestionSet, publish: boolean) => api<{ draft: QuestionSet }>(`/bookings/types/${enc(id)}/questions`, send("PUT", { set, publish })),
  typeSlots: (id: string, query: { from: string; to: string; tz: string; duration: number }) => api<SlotDays>(`/bookings/types/${enc(id)}/slots?${new URLSearchParams({ ...query, duration: String(query.duration) })}`),
  secretLinks: (id: string) => api<{ links: Array<{ id: string; prefix: string; expiresAt: string | null; maxUses: number | null; useCount: number; label: string }> }>(`/bookings/types/${enc(id)}/secret-links`),
  createSecretLink: (id: string, input: { singleUse?: boolean; expiresInDays?: number | null; label?: string }) => api<{ link: { id: string; path: string } }>(`/bookings/types/${enc(id)}/secret-links`, send("POST", input)),
  revokeSecretLink: (id: string, linkId: string) => api<void>(`/bookings/types/${enc(id)}/secret-links/${enc(linkId)}`, send("DELETE")),
  bookings: (query: { view?: string; cursor?: string | null; type?: string }) => api<{ items: Booking[]; nextCursor: string | null }>(`/bookings?${new URLSearchParams(Object.entries(query).filter(([, value]) => value) as Array<[string, string]>)}`),
  booking: (ref: string) => api<{ booking: Booking }>(`/bookings/b/${enc(ref)}`),
  act: (ref: string, action: "approve" | "decline" | "cancel" | "no-show", message?: string) => api<{ booking: Booking }>(`/bookings/b/${enc(ref)}/${action}`, send("POST", message ? { message } : {})),
  reschedule: (ref: string, start: string, message?: string) => api<{ booking: Booking }>(`/bookings/b/${enc(ref)}/reschedule`, send("POST", { start, ...(message ? { message } : {}) })),
  bookingSlots: (ref: string, query: { from: string; to: string; tz: string }) => api<SlotDays>(`/bookings/b/${enc(ref)}/slots?${new URLSearchParams(query)}`),
  insights: (days: number, tz: string) => api<Insights>(`/bookings/insights?${new URLSearchParams({ days: String(days), tz })}`),
  calendars: () => api<{ calendars: Array<{ id: string; name: string; role: string; color: string }> }>("/calendars"),
  embed: (ref: string) => api<{ title: string; publicPath: string | null; durations: number[]; ownerName: string }>(`/bookings/types/${enc(ref)}/embed`)
};

export const viewerZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
export const zones = (): string[] => { try { return Intl.supportedValuesOf("timeZone"); } catch { return ["UTC"]; } };

/** "Tue 3 Mar" in a zone. */
export const dayLabel = (iso: string, tz: string, options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) => new Intl.DateTimeFormat(undefined, { timeZone: tz, ...options }).format(new Date(iso));
/** "09:30" in a zone (the viewer's clock style). */
export const timeLabel = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { timeZone: tz, timeStyle: "short" }).format(new Date(iso));
export const durationLabel = (minutes: number) => minutes % 60 === 0 ? `${minutes / 60} h` : minutes > 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
