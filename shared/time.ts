import { addDays, dateToDay, utcToZoned, weekdayIndex, zonedToUtc } from "./calendarRecurrence";
import type { WorkKind, WorkSummary } from "./workRefs";

/**
 * Time tracking's shared vocabulary (lane TIME, docs/plan/WORKSPACE_MODULES.md §D.2): the shapes the
 * server returns and the client renders, and the pure date helpers both use (local days and weeks in
 * a person's zone). Durations are seconds; money is integer minor units (shared/money.ts).
 */

/** The longest one entry may be (D871): a longer stretch is split into days. */
export const MAX_ENTRY_SECONDS = 86_400;
export const MAX_TAGS = 5;
export const TAG_MAX = 40;
export const DESCRIPTION_MAX = 500;
/** Work kinds an entry may track (C12, C13, C15). */
export const TIME_TARGET_KINDS = ["card", "goal", "key_result", "contact", "company", "deal", "booking", "event"] as const satisfies readonly WorkKind[];
export type TimeTargetKind = typeof TIME_TARGET_KINDS[number];
export const isTimeTargetKind = (value: unknown): value is TimeTargetKind => typeof value === "string" && (TIME_TARGET_KINDS as readonly string[]).includes(value);

export const TIME_SOURCES = ["timer", "manual", "timesheet", "calendar", "import", "mcp", "proposal"] as const;
export type TimeSource = typeof TIME_SOURCES[number];

export const PROJECT_COLORS = ["amber", "blue", "green", "purple", "pink", "red", "orange", "teal", "slate"] as const;
export type ProjectColor = typeof PROJECT_COLORS[number];
export const PROJECT_COLOR_HEX: Record<ProjectColor, string> = {
  amber: "#f6c453", blue: "#60a5fa", green: "#4ade80", purple: "#c084fc", pink: "#f472b6", red: "#f87171", orange: "#fb923c", teal: "#2dd4bf", slate: "#94a3b8"
};

export const SUMMARY_GROUPS = ["project", "client", "user", "target", "tag", "day", "week", "month", "billable"] as const;
export type SummaryGroup = typeof SUMMARY_GROUPS[number];
export const SUMMARY_GROUP_LABELS: Record<SummaryGroup, string> = {
  project: "Project", client: "Client", user: "Person", target: "Work item", tag: "Tag", day: "Day", week: "Week", month: "Month", billable: "Billable"
};

/** A project as the API returns it. Rates and amounts only for those who may see them (D873). */
export type TimeProject = {
  id: string;
  shortId: string;
  name: string;
  code: string | null;
  color: ProjectColor;
  client: { id: string; name: string } | null;
  board: { id: string; name: string } | null;
  billableDefault: boolean;
  currency: string;
  /** Hourly rate in minor units; null when unset or hidden from the viewer. */
  rateMinor: number | null;
  budget: { kind: "none" | "hours" | "money"; value: number | null; period: "total" | "monthly" };
  /** Seconds and money used against the budget (this month for monthly budgets); money hidden like rates. */
  used?: { seconds: number; amountMinor: number | null };
  settings: { privateEntries: boolean; requireDescription: boolean };
  archived: boolean;
  owner: { id: string; name: string };
  level: "owner" | "manage" | "edit" | "comment" | "view";
  /** The viewer may see rates and amounts (owner, manage). */
  canSeeRates: boolean;
  canLog: boolean;
  revision: number;
  visibility: "private" | "selected" | "all_users";
};

/** One entry as the API returns it. */
export type TimeEntry = {
  id: string;
  user: { id: string; name: string };
  project: { id: string; name: string; color: ProjectColor; client: string | null } | null;
  description: string;
  startedAt: string;
  endedAt: string | null;
  /** Seconds; for a running timer, seconds so far when it was read. */
  durationS: number;
  running: boolean;
  tz: string;
  billable: boolean;
  /** Only for the author and project managers (D873). */
  rateMinor: number | null;
  amountMinor: number | null;
  currency: string | null;
  tags: string[];
  target: WorkSummary | { kind: WorkKind; hidden: true } | null;
  source: TimeSource;
  locked: boolean;
  /** The viewer may change it: their own unlocked entry, or a project manager's. */
  canEdit: boolean;
  revision: number;
};

export type TimesheetRow = {
  key: string;
  project: { id: string; name: string; color: ProjectColor } | null;
  target: WorkSummary | null;
  /** Seconds per day, Monday-first (or the week start) for the seven days. */
  days: number[];
  locked: boolean[];
};

export type Timesheet = {
  weekStart: string;
  days: string[];
  rows: TimesheetRow[];
  totals: number[];
  approvals: Array<{ projectId: string; projectName: string; status: "submitted" | "approved" | "rejected"; note: string | null }>;
};

export type SummaryRow = { key: string; label: string; seconds: number; billableSeconds: number; amountMinor: number | null; entries: number; sub?: SummaryRow[]; href?: string | null; color?: string | null };
export type Summary = {
  from: string;
  to: string;
  groupBy: SummaryGroup[];
  rows: SummaryRow[];
  totals: { seconds: number; billableSeconds: number; amountMinor: number | null; entries: number };
  currency: string | null;
  /** Amounts in more than one currency were left out of money totals (no conversion, ever). */
  mixedCurrency: boolean;
  rounding: number;
};

export type TargetTime = {
  target: WorkSummary;
  totalSeconds: number;
  mySeconds: number;
  /** For a card on a board estimating in hours. */
  estimateSeconds: number | null;
  /** Entries the viewer may see (D872); empty when the project keeps entries private. */
  entries: TimeEntry[];
  byPerson: Array<{ id: string; name: string; seconds: number }>;
  privateEntries: boolean;
  defaultProject: { id: string; name: string } | null;
};

// ---------------------------------------------------------------------------
// Days and weeks in a zone

/** The local date (YYYY-MM-DD) of an instant in a zone. */
export const localDate = (iso: string | number, tz: string) => utcToZoned(typeof iso === "number" ? iso : Date.parse(iso), tz).slice(0, 10);

/** The first day of the week holding `date`, for a week start (0 Sunday, 1 Monday, 6 Saturday). */
export function weekStartOf(date: string, weekStart: 0 | 1 | 6 = 1): string {
  const day = dateToDay(date);
  // weekdayIndex: 0 = Monday … 6 = Sunday. Convert to 0 = Sunday … 6 = Saturday.
  const sundayIndexed = (weekdayIndex(day) + 1) % 7;
  const back = (sundayIndexed - weekStart + 7) % 7;
  return addDays(date, -back);
}

export const weekDays = (start: string) => Array.from({ length: 7 }, (_, index) => addDays(start, index));

/** The UTC instant where a local date starts in a zone. */
export const dayStartUtc = (date: string, tz: string) => zonedToUtc(`${date}T00:00`, tz);

export { addDays };

/** "MYT-12 Fix login" for a running timer chip. */
export function entryLabel(entry: Pick<TimeEntry, "description" | "target" | "project">): string {
  const target = entry.target && !("hidden" in entry.target) ? entry.target : null;
  const key = target?.key ? `${target.key} ` : "";
  return `${key}${entry.description || target?.title || entry.project?.name || ""}`.trim();
}
