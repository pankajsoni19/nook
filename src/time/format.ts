import { addDays } from "../../shared/time";

/** Small date and time helpers for Time's screens, in the browser's zone. Pure. */

export const pad = (value: number) => String(value).padStart(2, "0");

/** YYYY-MM-DD of an instant in the browser's zone. */
export function localDay(ms: number | string = Date.now()): string {
  const date = new Date(typeof ms === "string" ? Date.parse(ms) : ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** HH:MM of an instant in the browser's zone. */
export function clock(ms: number | string): string {
  const date = new Date(typeof ms === "string" ? Date.parse(ms) : ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant of a local date and HH:MM, or null when either is not one. */
export function instantOf(day: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  const t = /^([01]?\d|2[0-3])[:.]?([0-5]\d)$/.exec(time.trim());
  if (!d || !t) return null;
  const date = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** "Today", "Yesterday", or "Mon 9 Nov" (with the year when not this year). */
export function dayLabel(day: string, today = localDay()): string {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const value = new Date(year, month - 1, date);
  return value.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(String(year) !== today.slice(0, 4) ? { year: "numeric" } : {}) });
}

export const shortDay = (day: string) => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, date).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
};

export const weekdayName = (day: string) => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, date).toLocaleDateString(undefined, { weekday: "short" });
};

export const hoursText = (seconds: number) => `${(seconds / 3600).toFixed(2)} h`;
