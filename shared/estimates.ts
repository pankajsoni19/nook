/**
 * Card estimates (lane ESTIMATES, docs/plan/TASK_ESTIMATES.md, D750–D757; supersedes Q4 of the
 * hierarchy research). Pure and dependency-free, shared by the server (validation on create and
 * update, REST and MCP) and the client (the card field, badges, column and sprint totals), so both
 * accept and word the same values.
 *
 * A board chooses what its cards' `estimate` means (`boards.estimate_kind`, migration 082): `none`
 * (the default: no field, nothing shown), `points`, or `hours`. Points use a scale
 * (`boards.estimate_scale`): Fibonacci (0, 1, 2, 3, 5, 8, 13, 21) or free (any number in range).
 * A card stores one number; its meaning comes from the board, and changing the board's kind never
 * rewrites it (D752).
 */

export const ESTIMATE_KINDS = ["none", "points", "hours"] as const;
export type EstimateKind = typeof ESTIMATE_KINDS[number];
export const ESTIMATE_SCALES = ["fibonacci", "free"] as const;
export type EstimateScale = typeof ESTIMATE_SCALES[number];
export type EstimateSettings = { kind: EstimateKind; scale: EstimateScale };

/** The Fibonacci point scale (D751): Jira's and Linear's common values, 0 for "trivial", 21 the largest. */
export const FIBONACCI_POINTS = [0, 1, 2, 3, 5, 8, 13, 21] as const;
/** Every estimate is 0–999 (points or hours; 999 hours is about half a working year), with at most two decimals. */
export const ESTIMATE_MAX = 999;
export const ESTIMATE_DECIMALS = 2;

export const NO_ESTIMATES: EstimateSettings = { kind: "none", scale: "fibonacci" };

/** The board's settings from a summary; an older server (no fields) means estimates are off. */
export function estimateSettingsOf(board: { estimate_kind?: string | null; estimate_scale?: string | null } | null | undefined): EstimateSettings {
  const kind = (ESTIMATE_KINDS as readonly string[]).includes(board?.estimate_kind ?? "") ? board!.estimate_kind as EstimateKind : "none";
  const scale = (ESTIMATE_SCALES as readonly string[]).includes(board?.estimate_scale ?? "") ? board!.estimate_scale as EstimateScale : "fibonacci";
  return { kind, scale };
}

/** Whether `value` has at most two decimals (1.5, 0.25), within float error. */
function fewDecimals(value: number) {
  const scaled = value * 10 ** ESTIMATE_DECIMALS;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

export type EstimateErrorCode = "ESTIMATES_OFF" | "ESTIMATE_INVALID";
export type EstimateCheck = { ok: true; value: number | null } | { ok: false; code: EstimateErrorCode; error: string };

/** "0, 1, 2, 3, 5, 8, 13, or 21". */
const scaleWords = () => `${FIBONACCI_POINTS.slice(0, -1).join(", ")}, or ${FIBONACCI_POINTS[FIBONACCI_POINTS.length - 1]}`;

/**
 * Checks an estimate for a board (D753). `null` clears it and is always allowed, even with
 * estimates off. Otherwise: estimates must be on (`ESTIMATES_OFF`), and the value a number from 0
 * to 999 with at most two decimals, and on a Fibonacci board one of the scale (`ESTIMATE_INVALID`).
 * The stored value is rounded to two decimals, so 1.499999 from a float input reads back as 1.5.
 */
export function checkEstimate(settings: EstimateSettings, value: number | null): EstimateCheck {
  if (value === null) return { ok: true, value: null };
  if (settings.kind === "none") return { ok: false, code: "ESTIMATES_OFF", error: "Turn estimates on in Board settings first" };
  const unit = settings.kind === "hours" ? "Hours" : "Points";
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > ESTIMATE_MAX) {
    return { ok: false, code: "ESTIMATE_INVALID", error: `${unit} are a number from 0 to ${ESTIMATE_MAX}` };
  }
  if (!fewDecimals(value)) return { ok: false, code: "ESTIMATE_INVALID", error: `Use at most ${ESTIMATE_DECIMALS} decimal places` };
  const rounded = Math.round(value * 100) / 100;
  if (settings.kind === "points" && settings.scale === "fibonacci" && !(FIBONACCI_POINTS as readonly number[]).includes(rounded)) {
    return { ok: false, code: "ESTIMATE_INVALID", error: `This board estimates in Fibonacci points: use ${scaleWords()}` };
  }
  return { ok: true, value: rounded };
}

/** A number as people write it: 3, 1.5, 0.25 (no trailing zeros). */
const numberText = (value: number) => String(Math.round(value * 100) / 100);

/** The compact badge: "5 pts", "1 pt", "3h", "1.5h"; "" with estimates off or no value. */
export function estimateBadge(kind: EstimateKind, value: number | null | undefined) {
  if (kind === "none" || value === null || value === undefined) return "";
  return kind === "hours" ? `${numberText(value)}h` : `${numberText(value)} ${value === 1 ? "pt" : "pts"}`;
}

/** The words for screen readers and titles: "5 points", "1 point", "1.5 hours", "1 hour". */
export function estimateWords(kind: EstimateKind, value: number | null | undefined) {
  if (kind === "none" || value === null || value === undefined) return "";
  const noun = kind === "hours" ? "hour" : "point";
  return `${numberText(value)} ${value === 1 ? noun : `${noun}s`}`;
}

/** The sum of the estimates that are set, rounded to two decimals, and how many cards had one. */
export function estimateTotal(values: Iterable<number | null | undefined>) {
  let sum = 0;
  let counted = 0;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    sum += value;
    counted += 1;
  }
  return { sum: Math.round(sum * 100) / 100, counted };
}

/** The kind's name for settings and notes: "Story points", "Hours", "Off". */
export const ESTIMATE_KIND_LABELS: Record<EstimateKind, string> = { none: "Off", points: "Story points", hours: "Hours" };
export const ESTIMATE_SCALE_LABELS: Record<EstimateScale, string> = { fibonacci: "Fibonacci (0, 1, 2, 3, 5, 8, 13, 21)", free: "Any number" };
