import { db } from "../db";
import { readableBoardPredicate, readableCard } from "../tasks/access";
import { listOccurrences } from "../calendar/service";
import { resolveRefs, workKindAdapter } from "../links/service";
import { readUnitPreferences } from "../workspaceSettings";
import { csvCell } from "../questions/service";
import { formatDuration, roundDuration, type RoundingMinutes } from "../../shared/duration";
import { addDays, isValidTimeZone, zonedToUtc } from "../../shared/calendarRecurrence";
import { workRefKey, type WorkRef, type WorkSummary } from "../../shared/workRefs";
import {
  localDate, PROJECT_COLOR_HEX, PROJECT_COLORS, weekDays, weekStartOf,
  type ProjectColor, type Summary, type SummaryGroup, type SummaryRow, type TargetTime, type Timesheet, type TimesheetRow
} from "../../shared/time";
import { HIDDEN_PROJECT_LABEL, hiddenProjectSql, PROJECT_JOIN, projectRow, projectSettings, visibleEntrySql } from "./access";
import {
  createEntry, deleteEntry, entrySeconds, entrySelect, entryWhere, resolveTarget, TimeError, toEntries, updateEntry, defaultProjectFor,
  type Actor, type EntryFilters, type TargetInput, type EntryRow
} from "./service";
import { captureUndo } from "../undo";

/**
 * Timesheets, summaries, exports, and per-item totals (lane TIME, §D.2). Everything is computed from
 * the entries the viewer may see (D872) and money only where they may see it (D873, T530). Rounding
 * applies per entry at report time only, never to stored entries (D875).
 */

const zoneOr = (tz: string | undefined) => tz && isValidTimeZone(tz) ? tz : "UTC";
const colorOf = (value: string | null): ProjectColor => (PROJECT_COLORS as readonly string[]).includes(value ?? "") ? value as ProjectColor : "amber";

type ViewRow = EntryRow & { user_name: string | null; project_name: string | null; project_color: string | null; client_name: string | null; money_ok: number; manager: number; project_deleted: string | null; project_hidden: number };

// ---------------------------------------------------------------------------
// The week timesheet

const rowKey = (projectId: string | null, kind: string | null, id: string | null) => `${projectId ?? ""}|${kind && id ? `${kind}:${id}` : ""}`;

export function timesheet(userId: string, week: string | undefined, tz: string | undefined, options: { carry?: boolean } = {}): Timesheet {
  const zone = zoneOr(tz);
  const weekStartPref = readUnitPreferences(userId).weekStart;
  const today = localDate(Date.now(), zone);
  const start = weekStartOf(week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : today, weekStartPref);
  const days = weekDays(start);
  const fromIso = new Date(zonedToUtc(`${start}T00:00`, zone)).toISOString();
  const toIso = new Date(zonedToUtc(`${addDays(start, 7)}T00:00`, zone)).toISOString();
  const rows = db.query(`${entrySelect()} WHERE e.user_id = $userId AND e.started_at >= $from AND e.started_at < $to ORDER BY e.started_at`).all({ userId, from: fromIso, to: toIso }) as ViewRow[];
  const byKey = new Map<string, { project: TimesheetRow["project"]; ref: WorkRef | null; days: number[]; locked: boolean[] }>();
  const add = (row: Pick<ViewRow, "project_id" | "project_name" | "project_color" | "project_deleted" | "target_kind" | "target_id">) => {
    const key = rowKey(row.project_id && !row.project_deleted ? row.project_id : null, row.target_kind, row.target_id);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        project: row.project_id && row.project_name && !row.project_deleted ? { id: row.project_id, name: row.project_name, color: colorOf(row.project_color) } : null,
        ref: row.target_kind && row.target_id ? { kind: row.target_kind, id: row.target_id } as WorkRef : null,
        days: [0, 0, 0, 0, 0, 0, 0], locked: [false, false, false, false, false, false, false]
      };
      byKey.set(key, entry);
    }
    return entry;
  };
  for (const row of rows) {
    const entry = add(row);
    const index = days.indexOf(localDate(row.started_at, zone));
    if (index < 0) continue;
    entry.days[index]! += entrySeconds(row);
    if (row.locked_at) entry.locked[index] = true;
  }
  if (options.carry) {
    const previousFrom = new Date(zonedToUtc(`${addDays(start, -7)}T00:00`, zone)).toISOString();
    const previous = db.query(`SELECT e.project_id, CASE WHEN ${hiddenProjectSql()} THEN '${HIDDEN_PROJECT_LABEL.replace("'", "''")}' ELSE p.name END AS project_name,
        CASE WHEN ${hiddenProjectSql()} THEN 'slate' ELSE p.color END AS project_color, p.deleted_at AS project_deleted, e.target_kind, e.target_id
      FROM ${PROJECT_JOIN} WHERE e.user_id = $userId AND e.started_at >= $from AND e.started_at < $to GROUP BY e.project_id, e.target_kind, e.target_id`)
      .all({ userId, from: previousFrom, to: fromIso }) as Array<Pick<ViewRow, "project_id" | "project_name" | "project_color" | "project_deleted" | "target_kind" | "target_id">>;
    for (const row of previous) add(row);
  }
  const refs = [...byKey.values()].flatMap((entry) => entry.ref ? [entry.ref] : []);
  const summaries = refs.length ? resolveRefs(refs, { userId }) : new Map<string, WorkSummary | null>();
  const sheetRows: TimesheetRow[] = [...byKey.entries()].map(([key, entry]) => ({
    key, project: entry.project, target: entry.ref ? summaries.get(workRefKey(entry.ref)) ?? null : null, days: entry.days, locked: entry.locked
  })).sort((a, b) => (a.project?.name ?? "￿").localeCompare(b.project?.name ?? "￿") || (a.target?.title ?? "").localeCompare(b.target?.title ?? ""));
  const totals = days.map((_, index) => sheetRows.reduce((sum, row) => sum + row.days[index]!, 0));
  const approvals = db.query(`SELECT a.project_id, p.name, a.status, a.note FROM time_approvals a JOIN time_projects p ON p.id = a.project_id WHERE a.user_id = ? AND a.week_start = ?`)
    .all(userId, start) as Array<{ project_id: string; name: string; status: "submitted" | "approved" | "rejected"; note: string | null }>;
  return { weekStart: start, days, rows: sheetRows, totals, approvals: approvals.map((row) => ({ projectId: row.project_id, projectName: row.name, status: row.status, note: row.note })) };
}

export type CellInput = { day: string; projectId: string | null; target: TargetInput; duration: number | null; tz?: string };

/**
 * Sets one timesheet cell to a total (§D.2 HTTP): the difference goes on the cell's own timesheet
 * entry (created at 09:00 local when there is none). Lowering below what other entries hold is
 * refused (edit those in the list), except clearing the cell, which deletes them with an undo ticket.
 */
export function setCell(actor: Actor, input: CellInput): { timesheet: Timesheet; undoTicket?: string } {
  const tz = zoneOr(input.tz);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw new TimeError(400, "INVALID", "day is a date");
  if (input.duration !== null && (!Number.isFinite(input.duration) || input.duration < 0 || input.duration > 86_400)) throw new TimeError(400, "TOO_LONG", "A day holds at most 24 hours");
  const target = resolveTarget(input.target, actor.userId);
  const project = input.projectId ? projectRow(input.projectId) : null;
  if (input.projectId && !project) throw new TimeError(404, "NOT_FOUND", "Project not found");
  let undoTicket: string | undefined;
  db.transaction(() => {
    const fromIso = new Date(zonedToUtc(`${input.day}T00:00`, tz)).toISOString();
    const toIso = new Date(zonedToUtc(`${addDays(input.day, 1)}T00:00`, tz)).toISOString();
    const cell = db.query(`SELECT * FROM time_entries WHERE user_id = ? AND started_at >= ? AND started_at < ? AND project_id IS ? AND target_kind IS ? AND target_id IS ? ORDER BY started_at`)
      .all(actor.userId, fromIso, toIso, project?.id ?? null, target?.kind ?? null, target?.id ?? null) as EntryRow[];
    const current = cell.reduce((sum, row) => sum + entrySeconds(row), 0);
    const desired = input.duration ?? 0;
    const delta = desired - current;
    if (delta === 0) return;
    const own = [...cell].reverse().find((row) => row.source === "timesheet" && row.locked_at === null && row.ended_at !== null);
    if (desired === 0) {
      if (cell.some((row) => row.locked_at !== null)) throw new TimeError(409, "LOCKED", "Part of this day is approved and locked");
      if (cell.some((row) => row.ended_at === null)) throw new TimeError(409, "TIMER_RUNNING", "Stop the timer before clearing this day");
      undoTicket = captureUndo({ actorId: actor.userId, kind: "time_entry", label: "Timesheet cell", rows: cell.map((row) => ({ table: "time_entries", where: { id: row.id } })) });
      for (const row of cell) deleteEntry(actor, row.id);
      return;
    }
    if (own && own.duration_s! + delta >= 0 && own.duration_s! + delta <= 86_400) {
      if (own.duration_s! + delta === 0) deleteEntry(actor, own.id);
      else updateEntry(actor, own.id, { duration: own.duration_s! + delta });
      return;
    }
    if (delta < 0) throw new TimeError(409, "CELL_HAS_DETAILS", "This day has timer entries; change them in the Timer list, or clear the day");
    createEntry({ ...actor, via: "timesheet" }, {
      startedAt: new Date(zonedToUtc(`${input.day}T09:00`, tz)).toISOString(), duration: delta, projectId: project?.id ?? null,
      target: target ?? null, tz, source: "timesheet"
    });
  })();
  return { timesheet: timesheet(actor.userId, input.day, tz), ...(undoTicket ? { undoTicket } : {}) };
}

// ---------------------------------------------------------------------------
// Summaries

export type SummaryInput = EntryFilters & { groupBy?: SummaryGroup[]; rounding?: RoundingMinutes; roundingMode?: "up" | "nearest" };

type Keyed = { key: string; label: string; href?: string | null; color?: string | null };

const SUMMARY_ROW_CAP = 50_000;

function summaryRows(viewerId: string, input: SummaryInput): ViewRow[] {
  const { sql, params } = entryWhere(viewerId, { ...input, user: input.user ?? "all" });
  params.cap = SUMMARY_ROW_CAP + 1;
  const rows = db.query(`${entrySelect()} WHERE ${sql} ORDER BY e.started_at LIMIT $cap`).all(params) as ViewRow[];
  if (rows.length > SUMMARY_ROW_CAP) throw new TimeError(400, "TOO_LARGE", "Narrow the range: a summary covers at most 50,000 entries");
  return rows;
}

export function summarize(viewerId: string, input: SummaryInput): Summary {
  const tz = zoneOr(input.tz);
  const groups = (input.groupBy?.length ? input.groupBy : ["project"]).slice(0, 2) as SummaryGroup[];
  const rounding = input.rounding ?? 0;
  const rows = summaryRows(viewerId, input);
  const refs = rows.filter((row) => row.target_kind && row.target_id).map((row) => ({ kind: row.target_kind, id: row.target_id }) as WorkRef);
  const summaries = refs.length ? resolveRefs(refs, { userId: viewerId }) : new Map<string, WorkSummary | null>();
  const weekStart = readUnitPreferences(viewerId).weekStart;
  const keysOf = (row: ViewRow, group: SummaryGroup): Keyed[] => {
    switch (group) {
      // Projects the viewer cannot open share one row, so neither their names nor their number shows (D1143).
      case "project": return [row.project_hidden === 1 ? { key: "hidden", label: row.project_name ?? "" } : row.project_id && row.project_name && !row.project_deleted ? { key: row.project_id, label: row.project_name, color: PROJECT_COLOR_HEX[colorOf(row.project_color)] } : { key: "", label: "No project" }];
      case "client": return [row.client_name ? { key: `c:${row.client_name.toLowerCase()}`, label: row.client_name } : { key: "", label: "No client" }];
      case "user": return [{ key: row.user_id, label: row.user_name ?? "Former member" }];
      case "target": {
        if (!row.target_kind || !row.target_id) return [{ key: "", label: "No work item" }];
        const summary = summaries.get(workRefKey({ kind: row.target_kind, id: row.target_id } as WorkRef));
        return [summary ? { key: `${row.target_kind}:${row.target_id}`, label: `${summary.key ? `${summary.key} ` : ""}${summary.title}`, href: summary.href } : { key: `${row.target_kind}:${row.target_id}`, label: "An item you can't open" }];
      }
      case "tag": {
        const tags = (JSON.parse(row.tags_json) as string[]);
        return tags.length ? tags.map((tag) => ({ key: tag.toLowerCase(), label: tag })) : [{ key: "", label: "No tag" }];
      }
      case "day": { const day = localDate(row.started_at, tz); return [{ key: day, label: day }]; }
      case "week": { const week = weekStartOf(localDate(row.started_at, tz), weekStart); return [{ key: week, label: `Week of ${week}` }]; }
      case "month": { const month = localDate(row.started_at, tz).slice(0, 7); return [{ key: month, label: month }]; }
      case "billable": return [row.billable === 1 ? { key: "1", label: "Billable" } : { key: "0", label: "Non-billable" }];
    }
  };
  const currencies = new Set<string>();
  type Acc = { meta: Keyed; seconds: number; billable: number; amount: number; entries: number; sub: Map<string, Acc> };
  const make = (meta: Keyed): Acc => ({ meta, seconds: 0, billable: 0, amount: 0, entries: 0, sub: new Map() });
  const top = new Map<string, Acc>();
  const totals = { seconds: 0, billableSeconds: 0, amount: 0, entries: 0 };
  for (const row of rows) {
    const seconds = roundDuration(entrySeconds(row), rounding, input.roundingMode ?? "nearest");
    const money = row.money_ok === 1 && row.billable === 1 && row.rate_minor !== null ? Math.round((row.rate_minor * seconds) / 3600) : 0;
    if (row.money_ok === 1 && row.billable === 1 && row.rate_minor !== null && row.currency) currencies.add(row.currency);
    const billable = row.billable === 1 ? seconds : 0;
    totals.seconds += seconds; totals.billableSeconds += billable; totals.amount += money; totals.entries += 1;
    for (const first of keysOf(row, groups[0]!)) {
      const acc = top.get(first.key) ?? make(first);
      top.set(first.key, acc);
      acc.seconds += seconds; acc.billable += billable; acc.amount += money; acc.entries += 1;
      if (groups[1]) for (const second of keysOf(row, groups[1])) {
        const sub = acc.sub.get(second.key) ?? make(second);
        acc.sub.set(second.key, sub);
        sub.seconds += seconds; sub.billable += billable; sub.amount += money; sub.entries += 1;
      }
    }
  }
  const mixed = currencies.size > 1;
  const hasMoney = currencies.size > 0;
  const out = (acc: Acc): SummaryRow => ({
    key: acc.meta.key, label: acc.meta.label, seconds: acc.seconds, billableSeconds: acc.billable, amountMinor: hasMoney && !mixed ? acc.amount : null, entries: acc.entries,
    ...(acc.meta.href ? { href: acc.meta.href } : {}), ...(acc.meta.color ? { color: acc.meta.color } : {}),
    ...(acc.sub.size ? { sub: [...acc.sub.values()].map(out).sort(order) } : {})
  });
  const chronological = groups[0] === "day" || groups[0] === "week" || groups[0] === "month";
  const order = (a: SummaryRow, b: SummaryRow) => chronological ? a.key.localeCompare(b.key) : b.seconds - a.seconds || a.label.localeCompare(b.label);
  return {
    from: input.from ?? "", to: input.to ?? "", groupBy: groups, rows: [...top.values()].map(out).sort(order),
    totals: { seconds: totals.seconds, billableSeconds: totals.billableSeconds, amountMinor: hasMoney && !mixed ? totals.amount : null, entries: totals.entries },
    currency: hasMoney && !mixed ? [...currencies][0]! : null, mixedCurrency: mixed, rounding
  };
}

/** The detailed export (CSV, formula-safe, T514): one line per entry the viewer may see. */
export function exportCsv(viewerId: string, input: SummaryInput): string {
  const tz = zoneOr(input.tz);
  const rows = summaryRows(viewerId, input);
  const entries = toEntries(rows, viewerId);
  const rounding = input.rounding ?? 0;
  const header = ["Date", "Start", "End", "Duration", "Hours", "Person", "Project", "Client", "Work item", "Description", "Tags", "Billable", "Rate", "Amount", "Currency"];
  const lines = [header.map(csvCell).join(",")];
  for (const entry of entries) {
    const seconds = roundDuration(entry.durationS, rounding, input.roundingMode ?? "nearest");
    const start = new Date(entry.startedAt);
    const local = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
    const target = entry.target && !("hidden" in entry.target) ? `${entry.target.key ? `${entry.target.key} ` : ""}${entry.target.title}` : entry.target ? "An item you can't open" : "";
    const amount = entry.rateMinor !== null && entry.billable ? Math.round((entry.rateMinor * seconds) / 3600) : null;
    const digits = (value: number | null) => value === null ? "" : (value / 100).toFixed(2);
    lines.push([
      localDate(entry.startedAt, tz), local(start.getTime()), entry.endedAt ? local(Date.parse(entry.endedAt)) : "", formatDuration(seconds, "colon"), (seconds / 3600).toFixed(2),
      entry.user.name, entry.project?.name ?? "", entry.project?.client ?? "", target, entry.description, entry.tags.join("; "), entry.billable ? "Yes" : "No",
      digits(entry.rateMinor), digits(amount), entry.currency ?? ""
    ].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Time on one work item (the card's Time section, get_time_for_item)

/**
 * `inReach` narrows everything to entries whose project passes it (a key limited to chosen projects,
 * D1147): the entries, the totals, and the per-person split alike.
 */
export function timeForTarget(viewerId: string, input: TargetInput, inReach?: (projectId: string | null) => boolean): TargetTime {
  const ref = resolveTarget(input, viewerId)!;
  const summary = resolveRefs([ref], { userId: viewerId }).get(workRefKey(ref));
  if (!summary) throw new TimeError(404, "NOT_FOUND", "Work item not found");
  // Totals count every entry on the item (card readers see totals even of private projects, D872).
  const all = (db.query("SELECT user_id, project_id, started_at, duration_s FROM time_entries WHERE target_kind = ? AND target_id = ?").all(ref.kind, ref.id) as Array<{ user_id: string; project_id: string | null; started_at: string; duration_s: number | null }>)
    .filter((row) => !inReach || inReach(row.project_id));
  const total = all.reduce((sum, row) => sum + entrySeconds(row), 0);
  const mine = all.filter((row) => row.user_id === viewerId).reduce((sum, row) => sum + entrySeconds(row), 0);
  const rows = db.query(`${entrySelect()} WHERE e.target_kind = $kind AND e.target_id = $id AND ${visibleEntrySql()} ORDER BY e.started_at DESC LIMIT 200`).all({ kind: ref.kind, id: ref.id, userId: viewerId }) as ViewRow[];
  const entries = toEntries(rows.filter((row) => !inReach || inReach(row.project_id)), viewerId);
  const people = new Map<string, { id: string; name: string; seconds: number }>();
  for (const entry of entries) {
    const person = people.get(entry.user.id) ?? { id: entry.user.id, name: entry.user.name, seconds: 0 };
    person.seconds += entry.durationS;
    people.set(entry.user.id, person);
  }
  let estimateSeconds: number | null = null;
  if (ref.kind === "card") {
    const card = readableCard(ref.id, viewerId);
    const kind = (card?.board as { estimate_kind?: string } | undefined)?.estimate_kind;
    const estimate = (card?.card as { estimate?: number | null } | undefined)?.estimate;
    if (kind === "hours" && typeof estimate === "number") estimateSeconds = Math.round(estimate * 3600);
  }
  const project = defaultProjectFor(ref, viewerId);
  return {
    target: summary, totalSeconds: total, mySeconds: mine, estimateSeconds, entries, byPerson: [...people.values()].sort((a, b) => b.seconds - a.seconds),
    privateEntries: entries.length < all.length, defaultProject: project ? { id: project.id, name: project.name } : null
  };
}

/** Totals for many cards at once (card faces, Timeline bars): readable cards only. */
export function cardTotals(viewerId: string, cardIds: readonly string[]): Record<string, { seconds: number; estimateSeconds: number | null; running: boolean }> {
  const ids = [...new Set(cardIds.map((id) => id.toLowerCase()).filter((id) => /^[0-9a-f-]{36}$/.test(id)))].slice(0, 500);
  if (!ids.length) return {};
  const readable = db.query(`SELECT k.id AS card_id, k.estimate, b.estimate_kind FROM cards k JOIN boards b ON b.id = k.board_id
    WHERE k.id IN (SELECT value FROM json_each($ids)) AND k.deleted_at IS NULL AND ${readableBoardPredicate}`)
    .all({ ids: JSON.stringify(ids), userId: viewerId }) as Array<{ card_id: string; estimate: number | null; estimate_kind: string }>;
  const result: Record<string, { seconds: number; estimateSeconds: number | null; running: boolean }> = {};
  for (const row of readable) result[row.card_id] = { seconds: 0, estimateSeconds: row.estimate_kind === "hours" && row.estimate !== null ? Math.round(row.estimate * 3600) : null, running: false };
  const known = Object.keys(result);
  if (!known.length) return result;
  const at = Date.now();
  for (const row of db.query("SELECT target_id, started_at, duration_s FROM time_entries WHERE target_kind = 'card' AND target_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(known)) as Array<{ target_id: string; started_at: string; duration_s: number | null }>) {
    const entry = result[row.target_id]!;
    entry.seconds += entrySeconds(row, at);
    if (row.duration_s === null) entry.running = true;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Suggestions: the day's calendar events and touched cards not yet logged (C13, suggest_time_entries)

export type Suggestion = { kind: "event" | "card"; ref: WorkRef; title: string; subtitle?: string; start?: string; end?: string; seconds?: number; href?: string };

export function suggestions(userId: string, date: string, tz: string | undefined): Suggestion[] {
  const zone = zoneOr(tz);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TimeError(400, "INVALID", "date is a date");
  const startMs = zonedToUtc(`${date}T00:00`, zone);
  const endMs = zonedToUtc(`${addDays(date, 1)}T00:00`, zone);
  const logged = new Set((db.query("SELECT target_kind || ':' || target_id AS ref FROM time_entries WHERE user_id = ? AND target_kind IS NOT NULL AND started_at >= ? AND started_at < ?")
    .all(userId, new Date(startMs - 86_400_000).toISOString(), new Date(endMs + 86_400_000).toISOString()) as Array<{ ref: string }>).map((row) => row.ref));
  const out: Suggestion[] = [];
  const own = (db.query("SELECT id FROM calendars WHERE owner_id = ? AND deleted_at IS NULL").all(userId) as Array<{ id: string }>).map((row) => row.id);
  if (own.length) {
    const { occurrences } = listOccurrences(userId, { fromDate: date, toDate: addDays(date, 1), startMs, endMs }, own);
    for (const item of occurrences) {
      if (item.allDay || logged.has(`event:${item.eventId}`)) continue;
      const seconds = Math.round((Date.parse(item.end) - Date.parse(item.start)) / 1000);
      if (seconds <= 0 || seconds > 86_400) continue;
      out.push({ kind: "event", ref: { kind: "event", id: item.eventId }, title: item.title || "Untitled event", start: item.start, end: item.end, seconds, href: `/calendar/event/${item.eventId}` });
    }
  }
  const cards = db.query(`SELECT DISTINCT a.card_id FROM card_activity a WHERE a.actor_id = ? AND a.created_at >= ? AND a.created_at < ? ORDER BY a.created_at DESC LIMIT 30`)
    .all(userId, new Date(startMs).toISOString(), new Date(endMs).toISOString()) as Array<{ card_id: string }>;
  const cardRefs = cards.filter((row) => !logged.has(`card:${row.card_id}`)).map((row) => ({ kind: "card", id: row.card_id }) as WorkRef);
  const resolved = cardRefs.length ? resolveRefs(cardRefs, { userId }) : new Map<string, WorkSummary | null>();
  for (const ref of cardRefs) {
    const summary = resolved.get(workRefKey(ref));
    if (summary) out.push({ kind: "card", ref, title: `${summary.key ? `${summary.key} ` : ""}${summary.title}`, subtitle: summary.subtitle, href: summary.href });
  }
  return out.slice(0, 30);
}

/** Today's total and running timer for the Today section and the top bar. */
export function todayTotals(userId: string, tz: string | undefined) {
  const zone = zoneOr(tz);
  const today = localDate(Date.now(), zone);
  const from = new Date(zonedToUtc(`${today}T00:00`, zone)).toISOString();
  // Bounded above too: an entry logged ahead for tomorrow is not today's time (D1147).
  const to = new Date(zonedToUtc(`${addDays(today, 1)}T00:00`, zone)).toISOString();
  const rows = db.query("SELECT started_at, duration_s FROM time_entries WHERE user_id = ? AND started_at >= ? AND started_at < ?").all(userId, from, to) as Array<{ started_at: string; duration_s: number | null }>;
  return { date: today, seconds: rows.reduce((sum, row) => sum + entrySeconds(row), 0), entries: rows.length };
}

export { projectSettings, workKindAdapter };
