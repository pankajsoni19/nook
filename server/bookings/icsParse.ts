import { addDays, dateToDay, isValidTimeZone, utcToZoned, weekdayIndex, WEEKDAYS, zonedToUtc, type Weekday } from "../../shared/calendarRecurrence";

/**
 * Busy time from an outside calendar's ICS "secret address" (§G.1 Q1, D1008–D1010): a small,
 * tolerant RFC 5545 reader for what Google Calendar and Outlook publish. Only what busy time needs
 * is read (no titles are kept, T575): VEVENT DTSTART / DTEND / DURATION (UTC, TZID, floating, and
 * VALUE=DATE), RRULE (FREQ, INTERVAL, COUNT, UNTIL, BYDAY with or without an ordinal such as 2TU or
 * -1FR, BYMONTHDAY, BYMONTH), EXDATE, RECURRENCE-ID overrides, STATUS:CANCELLED and
 * TRANSP:TRANSPARENT (both free). Recurrences are expanded in the event's zone on wall-clock time,
 * so instances keep their local time across DST (D1120).
 *
 * Bounded: 2 MiB of text, 5000 VEVENTs, 5000 busy intervals in the window.
 */

export const ICS_MAX_BYTES = 2 * 1024 * 1024;
export const ICS_MAX_EVENTS = 5000;
export const ICS_MAX_INTERVALS = 5000;

/** An all-day block also carries its dates (first, day after the last), so a reader can place it in another zone. */
export type BusyInterval = { start: number; end: number; allDay?: boolean; dates?: [string, string] };

type Prop = { name: string; params: Record<string, string>; value: string };
type RawEvent = Prop[];

/** Windows zone names Outlook writes as TZID, mapped to IANA (the common ones). */
const WINDOWS_ZONES: Record<string, string> = {
  "UTC": "UTC", "GMT Standard Time": "Europe/London", "Greenwich Standard Time": "Atlantic/Reykjavik", "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest", "Central European Standard Time": "Europe/Warsaw", "Romance Standard Time": "Europe/Paris",
  "E. Europe Standard Time": "Europe/Chisinau", "FLE Standard Time": "Europe/Kiev", "GTB Standard Time": "Europe/Bucharest", "Russian Standard Time": "Europe/Moscow",
  "Turkey Standard Time": "Europe/Istanbul", "Israel Standard Time": "Asia/Jerusalem", "Arabian Standard Time": "Asia/Dubai", "India Standard Time": "Asia/Kolkata",
  "Singapore Standard Time": "Asia/Singapore", "China Standard Time": "Asia/Shanghai", "Tokyo Standard Time": "Asia/Tokyo", "Korea Standard Time": "Asia/Seoul",
  "AUS Eastern Standard Time": "Australia/Sydney", "E. Australia Standard Time": "Australia/Brisbane", "New Zealand Standard Time": "Pacific/Auckland",
  "Eastern Standard Time": "America/New_York", "Central Standard Time": "America/Chicago", "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix", "Pacific Standard Time": "America/Los_Angeles", "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu", "Atlantic Standard Time": "America/Halifax", "E. South America Standard Time": "America/Sao_Paulo",
  "SA Pacific Standard Time": "America/Bogota", "Mexico Standard Time": "America/Mexico_City", "Central America Standard Time": "America/Guatemala",
  "South Africa Standard Time": "Africa/Johannesburg", "Egypt Standard Time": "Africa/Cairo", "W. Central Africa Standard Time": "Africa/Lagos"
};

/** An IANA zone for a TZID (IANA as is, a Windows name mapped, a `/mozilla.org/…/Europe/Paris` style prefix stripped), else null. */
export function zoneFor(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const clean = tzid.replace(/^"|"$/g, "").trim();
  if (isValidTimeZone(clean)) return clean;
  if (WINDOWS_ZONES[clean]) return WINDOWS_ZONES[clean]!;
  const tail = clean.split("/").slice(-2).join("/");
  return isValidTimeZone(tail) ? tail : null;
}

/** Unfolds and splits the text into properties (name, params, value); VALUE text is not unescaped (it is never kept). */
export function parseProps(text: string): Prop[] {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const props: Prop[] = [];
  for (const line of lines) {
    if (!line) continue;
    let colon = -1;
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === "\"") quoted = !quoted;
      else if (char === ":" && !quoted) { colon = index; break; }
    }
    if (colon < 1) continue;
    const [name, ...paramParts] = line.slice(0, colon).split(";");
    const params: Record<string, string> = {};
    for (const part of paramParts) {
      const eq = part.indexOf("=");
      if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
    }
    props.push({ name: name!.toUpperCase(), params, value: line.slice(colon + 1).trim() });
  }
  return props;
}

type Instant = { ms: number; date: string; allDay: boolean; tz: string; local: string | null };

/** A DTSTART-like value as an instant (all-day values as the date at 00:00 in `fallbackTz`). */
function readTime(prop: Prop, fallbackTz: string): Instant | null {
  const value = prop.value.split(",")[0]!.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date || prop.params.VALUE === "DATE") {
    const match = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!match) return null;
    const day = `${match[1]}-${match[2]}-${match[3]}`;
    return { ms: zonedToUtc(`${day}T00:00`, fallbackTz), date: day, allDay: true, tz: fallbackTz, local: null };
  }
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!time) return null;
  const day = `${time[1]}-${time[2]}-${time[3]}`;
  const local = `${day}T${time[4]}:${time[5]}`;
  if (time[7] === "Z") {
    const ms = Date.UTC(Number(time[1]), Number(time[2]) - 1, Number(time[3]), Number(time[4]), Number(time[5]), Number(time[6]));
    return { ms, date: day, allDay: false, tz: "UTC", local };
  }
  const tz = zoneFor(prop.params.TZID) ?? fallbackTz;
  return { ms: zonedToUtc(local, tz), date: day, allDay: false, tz, local };
}

/** ISO 8601 duration (P1D, PT1H30M, P1W) in minutes, or null. */
export function durationMinutes(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match || match[1] === "-") return null;
  const [, , weeks, days, hours, minutes, seconds] = match;
  return Number(weeks ?? 0) * 10080 + Number(days ?? 0) * 1440 + Number(hours ?? 0) * 60 + Number(minutes ?? 0) + Math.ceil(Number(seconds ?? 0) / 60);
}

type Freq = "daily" | "weekly" | "monthly" | "yearly";
type ByDay = { n: number | null; day: Weekday };
/** An RRULE as read. UNTIL is an instant when written as a time (UTC or local), a date when written as a date (D1120). */
type ParsedRule = {
  freq: Freq; interval: number; count?: number; untilMs?: number; untilDate?: string;
  byDay: ByDay[]; byMonthDay: number[]; byMonth: number[]; unsupported: boolean;
};

function readRule(value: string, start: Instant): ParsedRule | null {
  const parts = Object.fromEntries(value.split(";").map((part) => part.split("=")).filter((pair) => pair.length === 2).map(([key, val]) => [key!.toUpperCase(), val!.trim()]));
  const freq = ({ DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" } as Record<string, Freq>)[(parts.FREQ ?? "").toUpperCase()];
  if (!freq) return null;
  const rule: ParsedRule = { freq, interval: Math.min(99, Math.max(1, Number(parts.INTERVAL ?? 1) || 1)), byDay: [], byMonthDay: [], byMonth: [], unsupported: false };
  if (parts.COUNT) rule.count = Math.min(730, Math.max(1, Number(parts.COUNT) || 1));
  else if (parts.UNTIL) {
    const until = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(parts.UNTIL);
    if (until) {
      const day = `${until[1]}-${until[2]}-${until[3]}`;
      if (until[4] === undefined) rule.untilDate = day;
      // A UTC UNTIL is an instant: instants are compared, not its UTC date with local dates (BK3).
      else if (until[7] === "Z") rule.untilMs = Date.UTC(Number(until[1]), Number(until[2]) - 1, Number(until[3]), Number(until[4]), Number(until[5]), Number(until[6]));
      else {
        try { rule.untilMs = zonedToUtc(`${day}T${until[4]}:${until[5]}`, start.tz) + Number(until[6]) * 1000; } catch { rule.untilDate = day; }
      }
    }
  }
  // Parts that pick times of day or weeks of the year are not read: the rest is expanded and the feed is flagged.
  rule.unsupported = ["BYSETPOS", "BYHOUR", "BYMINUTE", "BYSECOND", "BYWEEKNO", "BYYEARDAY"].some((key) => parts[key] !== undefined);
  if (parts.BYMONTH) {
    rule.byMonth = parts.BYMONTH.split(",").map(Number).filter((month) => Number.isInteger(month) && month >= 1 && month <= 12);
    if (!rule.byMonth.length) rule.unsupported = true;
  }
  if (parts.BYMONTHDAY) {
    rule.byMonthDay = freq === "weekly" ? [] : parts.BYMONTHDAY.split(",").map(Number).filter((day) => Number.isInteger(day) && day !== 0 && day >= -31 && day <= 31);
    if (!rule.byMonthDay.length) rule.unsupported = true;
  }
  if (parts.BYDAY) {
    const days = parts.BYDAY.split(",").map((entry) => /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(entry.trim())).filter((match): match is RegExpExecArray => match !== null);
    rule.byDay = days.map((match) => ({ n: match[1] ? Number(match[1]) || null : null, day: match[2]!.toUpperCase() as Weekday }));
    if (!rule.byDay.length) rule.unsupported = true;
    if (freq === "yearly" && !rule.byMonth.length) {
      // Weekdays of a whole year (BYDAY=20MO) are not read.
      rule.unsupported = true;
      rule.byDay = [];
    } else if (freq === "daily" || freq === "weekly") {
      if (rule.byDay.some((entry) => entry.n !== null)) rule.unsupported = true;
      rule.byDay = rule.byDay.map((entry) => ({ ...entry, n: null }));
    }
  }
  return rule;
}

const monthLength = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The dates of one month that a monthly (or yearly, in its months) rule picks, sorted. `startDay` is DTSTART's day of the month. */
function monthDates(year: number, month: number, rule: ParsedRule, startDay: number): string[] {
  const length = monthLength(year, month);
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const all = Array.from({ length }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`);
  let days: string[];
  if (rule.byMonthDay.length) {
    const picked = new Set(rule.byMonthDay.map((day) => (day > 0 ? day : length + day + 1)));
    days = all.filter((_, index) => picked.has(index + 1));
  } else if (rule.byDay.length) days = all;
  else days = startDay <= length ? [all[startDay - 1]!] : []; // the 31st skips shorter months (RFC 5545)
  if (rule.byDay.length) {
    const keep = new Set<string>();
    for (const entry of rule.byDay) {
      const matches = all.filter((date) => WEEKDAYS[weekdayIndex(dateToDay(date))] === entry.day);
      if (entry.n === null) for (const date of matches) keep.add(date);
      else {
        const date = entry.n > 0 ? matches[entry.n - 1] : matches[matches.length + entry.n];
        if (date) keep.add(date);
      }
    }
    days = days.filter((date) => keep.has(date));
  }
  return days;
}

/** The rule's nth period (a day, a week starting Monday, a month, a year): its first date and the candidate dates in it, sorted. */
function period(rule: ParsedRule, startDate: string, index: number): { first: string; dates: string[] } {
  const [year0, month0, day0] = [Number(startDate.slice(0, 4)), Number(startDate.slice(5, 7)), Number(startDate.slice(8, 10))];
  const inMonths = (date: string) => !rule.byMonth.length || rule.byMonth.includes(Number(date.slice(5, 7)));
  const weekday = (date: string) => WEEKDAYS[weekdayIndex(dateToDay(date))]!;
  if (rule.freq === "daily") {
    const date = addDays(startDate, index * rule.interval);
    const length = monthLength(Number(date.slice(0, 4)), Number(date.slice(5, 7)));
    const dayOfMonth = Number(date.slice(8, 10));
    const ok = inMonths(date)
      && (!rule.byDay.length || rule.byDay.some((entry) => entry.day === weekday(date)))
      && (!rule.byMonthDay.length || rule.byMonthDay.some((day) => (day > 0 ? day : length + day + 1) === dayOfMonth));
    return { first: date, dates: ok ? [date] : [] };
  }
  if (rule.freq === "weekly") {
    const monday = addDays(startDate, -weekdayIndex(dateToDay(startDate)) + index * rule.interval * 7);
    const days = rule.byDay.length ? WEEKDAYS.filter((day) => rule.byDay.some((entry) => entry.day === day)) : [weekday(startDate)];
    return { first: monday, dates: days.map((day) => addDays(monday, WEEKDAYS.indexOf(day))).filter(inMonths) };
  }
  if (rule.freq === "monthly") {
    const months = month0 - 1 + index * rule.interval;
    const year = year0 + Math.floor(months / 12);
    const month = (months % 12) + 1;
    const first = `${year}-${String(month).padStart(2, "0")}-01`;
    return { first, dates: rule.byMonth.length && !rule.byMonth.includes(month) ? [] : monthDates(year, month, rule, day0) };
  }
  const year = year0 + index * rule.interval;
  const months = rule.byMonth.length ? [...rule.byMonth].sort((a, b) => a - b) : [month0];
  // Without BYMONTHDAY or BYDAY a yearly rule keeps DTSTART's day (29 February skips other years).
  return { first: `${year}-01-01`, dates: months.flatMap((month) => monthDates(year, month, rule, day0)) };
}

/**
 * Busy intervals of an ICS text overlapping [fromMs, toMs). `fallbackTz` is the calendar's
 * X-WR-TIMEZONE if any, else the host's zone (floating times and all-day dates).
 */
export function icsBusy(text: string, fromMs: number, toMs: number, hostTz: string): { intervals: BusyInterval[]; truncated: boolean; unsupported: number } {
  if (text.length > ICS_MAX_BYTES) text = text.slice(0, ICS_MAX_BYTES);
  const props = parseProps(text);
  const calendarTz = zoneFor(props.find((prop) => prop.name === "X-WR-TIMEZONE")?.value) ?? hostTz;
  const events: RawEvent[] = [];
  let current: RawEvent | null = null;
  let depth = 0;
  for (const prop of props) {
    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VEVENT") { current = []; depth = 0; continue; }
    if (prop.name === "END" && prop.value.toUpperCase() === "VEVENT") { if (current) events.push(current); current = null; if (events.length >= ICS_MAX_EVENTS) break; continue; }
    if (!current) continue;
    // Nested components (VALARM) are skipped.
    if (prop.name === "BEGIN") { depth += 1; continue; }
    if (prop.name === "END") { depth -= 1; continue; }
    if (depth === 0) current.push(prop);
  }
  const intervals: BusyInterval[] = [];
  let truncated = events.length >= ICS_MAX_EVENTS;
  let unsupported = 0;
  // RECURRENCE-ID overrides: the instant they replace, per UID.
  const replaced = new Map<string, Set<number>>();
  const get = (event: RawEvent, name: string) => event.find((prop) => prop.name === name);
  for (const event of events) {
    const recurrence = get(event, "RECURRENCE-ID");
    const uid = get(event, "UID")?.value ?? "";
    if (recurrence && uid) {
      const at = readTime(recurrence, calendarTz);
      if (at) (replaced.get(uid) ?? replaced.set(uid, new Set()).get(uid)!).add(at.ms);
    }
  }
  const push = (interval: BusyInterval) => {
    if (interval.end <= fromMs || interval.start >= toMs || interval.end <= interval.start) return;
    if (intervals.length >= ICS_MAX_INTERVALS) { truncated = true; return; }
    intervals.push(interval);
  };
  for (const event of events) {
    if ((get(event, "STATUS")?.value ?? "").toUpperCase() === "CANCELLED") continue;
    if ((get(event, "TRANSP")?.value ?? "").toUpperCase() === "TRANSPARENT") continue;
    const startProp = get(event, "DTSTART");
    if (!startProp) continue;
    let start: Instant | null;
    try { start = readTime(startProp, calendarTz); } catch { start = null; }
    if (!start) continue;
    const endProp = get(event, "DTEND");
    let minutes: number | null = null;
    if (endProp) {
      try {
        const end = readTime(endProp, start.allDay ? calendarTz : start.tz);
        if (end) minutes = start.allDay ? Math.max(1, dateToDay(end.date) - dateToDay(start.date)) * 1440 : Math.round((end.ms - start.ms) / 60_000);
      } catch { minutes = null; }
    } else if (get(event, "DURATION")) minutes = durationMinutes(get(event, "DURATION")!.value);
    if (minutes === null) minutes = start.allDay ? 1440 : 0;
    if (minutes <= 0) continue;
    minutes = Math.min(minutes, 10_080);
    const allDayInterval = (date: string) => {
      const days = Math.max(1, Math.round(minutes! / 1440));
      return { start: zonedToUtc(`${date}T00:00`, hostTz), end: zonedToUtc(`${addDays(date, days)}T00:00`, hostTz), allDay: true, dates: [date, addDays(date, days)] as [string, string] };
    };
    const rruleProp = get(event, "RRULE");
    if (!rruleProp || get(event, "RECURRENCE-ID")) {
      push(start.allDay ? allDayInterval(start.date) : { start: start.ms, end: start.ms + minutes * 60_000 });
      continue;
    }
    const uid = get(event, "UID")?.value ?? "";
    const skip = new Set<number>(replaced.get(uid) ?? []);
    for (const exdate of event.filter((prop) => prop.name === "EXDATE")) {
      for (const value of exdate.value.split(",")) {
        try {
          const at = readTime({ ...exdate, value }, start.allDay ? calendarTz : start.tz);
          if (at) skip.add(at.allDay ? zonedToUtc(`${at.date}T00:00`, start.tz) : at.ms);
        } catch { /* a bad EXDATE is ignored */ }
      }
    }
    const parsed = readRule(rruleProp.value, start);
    if (!parsed || parsed.unsupported) unsupported += 1;
    const occurrences = expandRule(start, minutes, parsed, fromMs, toMs);
    for (const occurrence of occurrences) {
      if (skip.has(occurrence)) continue;
      if (start.allDay) push(allDayInterval(utcToZoned(occurrence, start.tz).slice(0, 10)));
      else push({ start: occurrence, end: occurrence + minutes * 60_000 });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  return { intervals, truncated, unsupported };
}

/**
 * Occurrence starts (UTC ms) of one series within the window (D1120). DTSTART is always the first
 * instance; later ones are the rule's dates after DTSTART's date, at DTSTART's wall-clock time in its
 * zone. COUNT counts from DTSTART, so a series with COUNT is walked from its start; one without
 * jumps ahead to just before the window. An unreadable rule keeps the first instance only.
 */
function expandRule(start: Instant, minutes: number, rule: ParsedRule | null, fromMs: number, toMs: number): number[] {
  const tz = start.tz;
  const time = (start.local ?? `${start.date}T00:00`).slice(10);
  const out: number[] = [];
  const fits = (ms: number) => ms < toMs && ms + minutes * 60_000 > fromMs;
  if (fits(start.ms)) out.push(start.ms);
  if (!rule) return out;
  const lastDate = utcToZoned(toMs + 86_400_000, tz).slice(0, 10);
  let index = 0;
  if (rule.count === undefined) {
    const days = dateToDay(utcToZoned(fromMs - minutes * 60_000, tz).slice(0, 10)) - dateToDay(start.date);
    // The longest period (31-day months, 366-day years) so the jump never lands past the window.
    const span = { daily: 1, weekly: 7, monthly: 31, yearly: 366 }[rule.freq] * rule.interval;
    if (days > span) index = Math.floor(days / span) - 1;
  }
  let count = 1;
  for (let guard = 0; guard < 40_000; guard += 1, index += 1) {
    const { first, dates } = period(rule, start.date, index);
    if (first > lastDate || (rule.untilDate !== undefined && first > rule.untilDate) || first > "2100-12-31") return out;
    for (const date of dates) {
      if (date <= start.date) continue;
      let ms: number;
      try { ms = zonedToUtc(`${date}${time}`, tz); } catch { continue; }
      if ((rule.untilDate !== undefined && date > rule.untilDate) || (rule.untilMs !== undefined && ms > rule.untilMs)) return out;
      count += 1;
      if (rule.count !== undefined && count > rule.count) return out;
      if (ms >= toMs) return out;
      if (fits(ms)) out.push(ms);
      if (out.length >= ICS_MAX_INTERVALS) return out;
    }
  }
  return out;
}
