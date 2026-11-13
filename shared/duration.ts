/**
 * Durations (§B.16): parse what people type (`1h30`, `1h 30m`, `1.5h`, `90m`, `1:30`, `45`), format
 * as `1h 30m` or `1:30`, and round for reports. Seconds are the unit everywhere. Pure.
 */

export type DurationFormat = "hm" | "colon";
/** Bare numbers ("45") are minutes by default; a preference can make them hours. */
export type BareUnit = "minutes" | "hours";

/** The longest duration one entry may have: 999 hours. */
export const MAX_DURATION_SECONDS = 999 * 3600;

/**
 * Seconds for a typed duration, or null when it is not one. Accepts hours, minutes, and seconds with
 * units (`2h`, `1h30`, `1h 30m`, `1.5h`, `90m`, `45s`, `1h30m15s`, `2 hrs 5 mins`), `H:MM` and
 * `H:MM:SS`, and a bare number (minutes, or hours with `bare: "hours"`). Decimal commas are read as points.
 */
export function parseDuration(text: string, options: { bare?: BareUnit } = {}): number | null {
  const value = text.trim().toLowerCase().replace(/,/g, ".");
  if (!value || value.length > 32) return null;
  let seconds: number | null = null;
  const colon = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
  if (colon) seconds = Number(colon[1]) * 3600 + Number(colon[2]) * 60 + Number(colon[3] ?? 0);
  else if (/^\d+(\.\d+)?$/.test(value)) seconds = Math.round(Number(value) * (options.bare === "hours" ? 3600 : 60));
  else {
    // Number-and-unit parts, largest first; a bare number right after hours is minutes ("1h30").
    const parts = [...value.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]*)\s*/g)];
    if (!parts.length || parts.map((part) => part[0]).join("") !== value) return null;
    const UNIT: Record<string, number> = { h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, s: 1, sec: 1, secs: 1, second: 1, seconds: 1 };
    let total = 0;
    let last = Infinity;
    for (const [index, part] of parts.entries()) {
      const unit = part[2] ? UNIT[part[2]] : index === parts.length - 1 && last === 3600 ? 60 : undefined;
      if (unit === undefined || unit >= last) return null;
      total += Number(part[1]) * unit;
      last = unit;
    }
    seconds = Math.round(total);
  }
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DURATION_SECONDS) return null;
  return seconds;
}

/** `1h 30m`, `45m`, `0m` (format "hm"), or `1:30` (format "colon"). Seconds are rounded to minutes unless `seconds` is set. */
export function formatDuration(totalSeconds: number, format: DurationFormat = "hm", options: { seconds?: boolean } = {}): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const minutesTotal = options.seconds ? Math.floor(safe / 60) : Math.round(safe / 60);
  const hours = Math.floor(minutesTotal / 60);
  const minutes = minutesTotal % 60;
  const secs = safe % 60;
  if (format === "colon") return options.seconds ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${hours}:${String(minutes).padStart(2, "0")}`;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes || !hours) parts.push(`${minutes}m`);
  if (options.seconds && secs) parts.push(`${secs}s`);
  return parts.join(" ");
}

export const ROUNDING_MINUTES = [0, 6, 15, 30] as const;
export type RoundingMinutes = typeof ROUNDING_MINUTES[number];
export type RoundingMode = "up" | "nearest";

/** Rounds seconds to a step of minutes (0: no rounding), up or to the nearest. Report-time only (§A.2). */
export function roundDuration(seconds: number, stepMinutes: RoundingMinutes, mode: RoundingMode = "nearest"): number {
  if (!stepMinutes) return seconds;
  const step = stepMinutes * 60;
  return (mode === "up" ? Math.ceil(seconds / step) : Math.round(seconds / step)) * step;
}

/** Decimal hours for reports and money (`5400` → 1.5). */
export const hoursOf = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;
