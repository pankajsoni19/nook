/**
 * Sprint naming and dates (research 2026-09-26-task-hierarchy-workflows.md D124, D131, §7.5).
 * Pure and dependency-free, shared by the server (completing a sprint into a new one, the Scrum
 * template's first sprint) and the client (the New sprint form and the close dialog), so both
 * suggest the same name and dates.
 */

/** A sprint's state as the API reports it; the database stores `completed` as `closed` (migration 019). */
export const SPRINT_STATES = ["planned", "active", "completed"] as const;
export type SprintState = typeof SPRINT_STATES[number];

export const SPRINT_NAME_MAX = 60;
export const SPRINT_GOAL_MAX = 500;
/** The default sprint length in days, start and end included (two weeks). */
export const SPRINT_DEFAULT_DAYS = 14;

/** `date` (YYYY-MM-DD) plus `days`, as YYYY-MM-DD. */
export function addSprintDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function sprintDaysBetween(from: string, to: string) {
  const at = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year!, month! - 1, day!);
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

/**
 * "Sprint 12" → "Sprint 13"; a name without a trailing number gets " 2". Names in `taken` (the
 * board's other sprints, ignoring case) are skipped, so completing Sprint 1 while Sprint 2 is
 * planned suggests Sprint 3. Stays within 60 characters.
 */
export function nextSprintName(name: string | null | undefined, taken: Iterable<string> = []) {
  const base = (name ?? "").trim() || "Sprint 0";
  const used = new Set([...taken].map((item) => item.trim().toLowerCase()));
  const match = /^(.*?)(\d+)$/.exec(base);
  const prefix = match ? match[1]! : `${base} `;
  let number = match ? Number(match[2]) + 1 : 2;
  const fit = (text: string) => text.length > SPRINT_NAME_MAX ? text.slice(text.length - SPRINT_NAME_MAX) : text;
  // At most one more than the number of taken names is ever needed.
  for (let guard = 0; guard <= used.size && used.has(fit(`${prefix}${number}`).toLowerCase()); guard += 1) number += 1;
  return fit(`${prefix}${number}`);
}

/**
 * The dates of the sprint after one: it starts the day after `endOn` and lasts as long (start and
 * end included). Without an end date it starts on `today` and lasts two weeks.
 */
export function nextSprintDates(previous: { start_on: string | null; end_on: string | null } | null, today: string): { startOn: string; endOn: string } {
  if (previous?.end_on) {
    const length = previous.start_on ? Math.max(0, sprintDaysBetween(previous.start_on, previous.end_on)) : SPRINT_DEFAULT_DAYS - 1;
    const startOn = addSprintDays(previous.end_on, 1);
    return { startOn, endOn: addSprintDays(startOn, length) };
  }
  return { startOn: today, endOn: addSprintDays(today, SPRINT_DEFAULT_DAYS - 1) };
}

/**
 * The dates of a new sprint made while completing `sprint` today (QA 0.9.0): as long as it, but
 * from today, never chained after an end date that has not come yet (completed early) or has passed
 * (completed late). Completed on its last day, the new one starts tomorrow.
 */
export function sprintDatesAfterCompleting(sprint: { start_on: string | null; end_on: string | null }, today: string): { startOn: string; endOn: string } {
  const length = sprint.start_on && sprint.end_on ? Math.max(0, sprintDaysBetween(sprint.start_on, sprint.end_on)) : SPRINT_DEFAULT_DAYS - 1;
  const startOn = sprint.end_on === today ? addSprintDays(today, 1) : today;
  return { startOn, endOn: addSprintDays(startOn, length) };
}
