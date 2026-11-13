/**
 * Goals (lane GOALS, docs/plan/WORKSPACE_MODULES.md §D.3): the words, the progress math (D901), and the
 * suggested health (D902). Pure, shared by the server, the client, and tests.
 */

export const GOAL_KINDS = ["objective", "kpi"] as const;
export type GoalKind = typeof GOAL_KINDS[number];
export const GOAL_STATES = ["draft", "active", "achieved", "missed", "dropped", "carried_over"] as const;
export type GoalState = typeof GOAL_STATES[number];
export const CLOSED_STATES = ["achieved", "missed", "dropped", "carried_over"] as const;
export const GOAL_HEALTHS = ["none", "on_track", "at_risk", "off_track"] as const;
export type GoalHealth = typeof GOAL_HEALTHS[number];
export const PROGRESS_MODES = ["key_results", "children", "manual"] as const;
export type ProgressMode = typeof PROGRESS_MODES[number];
export const CHECKIN_CADENCES = ["none", "weekly", "biweekly", "monthly"] as const;
export type CheckinCadence = typeof CHECKIN_CADENCES[number];
export const KR_METRICS = ["number", "percent", "currency", "boolean", "milestones"] as const;
export type KrMetric = typeof KR_METRICS[number];
export const KR_DIRECTIONS = ["increase", "decrease", "stay_above", "stay_below"] as const;
export type KrDirection = typeof KR_DIRECTIONS[number];

export const GOAL_STATE_LABEL: Record<GoalState, string> = {
  draft: "Draft", active: "Active", achieved: "Achieved", missed: "Missed", dropped: "Dropped", carried_over: "Carried over"
};
export const KR_METRIC_LABEL: Record<KrMetric, string> = { number: "Number", percent: "Percent", currency: "Currency", boolean: "Done / not done", milestones: "Milestones" };
export const KR_DIRECTION_LABEL: Record<KrDirection, string> = { increase: "Increase to", decrease: "Decrease to", stay_above: "Stay at or above", stay_below: "Stay at or below" };
export const CADENCE_LABEL: Record<CheckinCadence, string> = { none: "No reminders", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };
/** Days between check-ins before a goal is "due a check-in". */
export const CADENCE_DAYS: Record<CheckinCadence, number | null> = { none: null, weekly: 7, biweekly: 14, monthly: 30 };

export const GOAL_LIMITS = { title: 200, description: 20_000, note: 10_000, krsPerGoal: 25, milestonesPerKr: 50, periodName: 60, depth: 6 } as const;

const clamp01 = (value: number) => !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, value));

export type KrForMath = {
  metric: KrMetric; direction: KrDirection; start_value: number; target_value: number; current_value: number;
  milestones?: { done: number; total: number };
};

/**
 * One key result's progress, 0–1 (D901): `(current − start) / (target − start)` clamped (a decrease KR
 * inverts by the same formula, since target < start); `stay_above`/`stay_below` are 1 when within the
 * bound else 0; yes/no is 0 or 1; milestones are done / total.
 */
export function krProgress(kr: KrForMath): number {
  if (kr.metric === "boolean") return kr.current_value >= 1 ? 1 : 0;
  if (kr.metric === "milestones") return kr.milestones && kr.milestones.total > 0 ? clamp01(kr.milestones.done / kr.milestones.total) : 0;
  if (kr.direction === "stay_above") return kr.current_value >= kr.target_value ? 1 : 0;
  if (kr.direction === "stay_below") return kr.current_value <= kr.target_value ? 1 : 0;
  const span = kr.target_value - kr.start_value;
  if (span === 0) return kr.direction === "decrease" ? (kr.current_value <= kr.target_value ? 1 : 0) : (kr.current_value >= kr.target_value ? 1 : 0);
  // A decrease KR whose target is above its start (a typo) still reads as "lower is better".
  if (kr.direction === "decrease" && span > 0) return clamp01((kr.start_value - kr.current_value) / span);
  return clamp01((kr.current_value - kr.start_value) / span);
}

/** The weighted mean of parts (KRs or child goals); 0 for none. */
export function weightedProgress(parts: ReadonlyArray<{ progress: number; weight?: number }>): number {
  let sum = 0;
  let weights = 0;
  for (const part of parts) {
    const weight = part.weight && part.weight > 0 ? part.weight : 1;
    sum += clamp01(part.progress) * weight;
    weights += weight;
  }
  return weights > 0 ? clamp01(sum / weights) : 0;
}

/** The fraction of [start, end] (local dates, inclusive) elapsed at `today`; null without dates. */
export function elapsedFraction(start: string | null, end: string | null, today: string): number | null {
  if (!start || !end) return null;
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`) + 86_400_000;
  const t = Date.parse(`${today}T12:00:00Z`);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  return clamp01((t - s) / (e - s));
}

/**
 * The suggested health (D902, shown, never stored): progress against time elapsed. Within 10 points
 * of the ideal line or ahead → on track; within 25 → at risk; else off track. Nothing before 5% of
 * the time has passed, or without dates.
 */
export function suggestedHealth(progress: number, elapsed: number | null): GoalHealth {
  if (elapsed === null || elapsed < 0.05) return "none";
  const gap = elapsed - progress;
  if (gap <= 0.1) return "on_track";
  if (gap <= 0.25) return "at_risk";
  return "off_track";
}

/** Whether a goal with this cadence and last check-in is due one at `nowMs`. */
export function checkinDue(cadence: CheckinCadence, lastCheckinAt: string | null, createdAt: string, nowMs: number): boolean {
  const days = CADENCE_DAYS[cadence];
  if (days === null) return false;
  const since = Date.parse(lastCheckinAt ?? createdAt);
  return Number.isFinite(since) && nowMs - since >= days * 86_400_000;
}

/** A KR value as people read it: "42", "62%", "$1,200", "Done". */
export function formatKrValue(value: number, kr: { metric: KrMetric; unit?: string | null; currency?: string | null }): string {
  if (!Number.isFinite(value)) return "—";
  if (kr.metric === "boolean") return value >= 1 ? "Done" : "Not done";
  if (kr.metric === "percent") return `${round(value)}%`;
  if (kr.metric === "currency") {
    try { return new Intl.NumberFormat("en", { style: "currency", currency: kr.currency || "USD", minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value); }
    catch { return `${round(value)} ${kr.currency ?? ""}`.trim(); }
  }
  const text = round(value).toLocaleString("en");
  return kr.unit ? `${text} ${kr.unit}` : text;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** The work kinds a goal's "Link work" offers, and how cards read the link. */
export const GOAL_LINK_RELATION = "contributes" as const;
