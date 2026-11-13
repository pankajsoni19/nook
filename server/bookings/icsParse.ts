import { addDays, dateToDay, expandSeries, isValidTimeZone, normalizeRule, rangeFor, utcToZoned, weekdayIndex, WEEKDAYS, zonedToUtc, type RecurrenceRule, type Weekday } from "../../shared/calendarRecurrence";

/**
 * Busy time from an outside calendar's ICS "secret address" (§G.1 Q1, D1008–D1010): a small,
 * tolerant RFC 5545 reader for what Google Calendar and Outlook publish. Only what busy time needs
 * is read (no titles are kept, T575): VEVENT DTSTART / DTEND / DURATION (UTC, TZID, floating, and
 * VALUE=DATE), RRULE (FREQ, INTERVAL, COUNT, UNTIL, BYDAY; monthly BYDAY with an ordinal such as 2TU
 * or -1FR), EXDATE, RECURRENCE-ID overrides, STATUS:CANCELLED and TRANSP:TRANSPARENT (both free).
 * Recurrences are expanded with the calendar module's DST-correct expansion in the event's zone.
 *
 * Bounded: 2 MiB of text, 5000 VEVENTs, 5000 busy intervals in the window.
 */

export const ICS_MAX_BYTES = 2 * 1024 * 1024;
export const ICS_MAX_EVENTS = 5000;
export const ICS_MAX_INTERVALS = 5000;

export type BusyInterval = { start: number; end: number; allDay?: boolean };

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

type ParsedRule = { rule: RecurrenceRule | null; monthlyNth: Array<{ n: number; day: Weekday }> | null; unsupported: boolean };

function readRule(value: string, start: Instant): ParsedRule {
  const parts = Object.fromEntries(value.split(";").map((part) => part.split("=")).filter((pair) => pair.length === 2).map(([key, val]) => [key!.toUpperCase(), val!]));
  const freq = ({ DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" } as Record<string, RecurrenceRule["freq"]>)[parts.FREQ ?? ""];
  if (!freq) return { rule: null, monthlyNth: null, unsupported: true };
  const rule: RecurrenceRule = { freq, interval: Math.min(99, Math.max(1, Number(parts.INTERVAL ?? 1) || 1)) };
  if (parts.COUNT) rule.count = Math.min(730, Math.max(1, Number(parts.COUNT) || 1));
  else if (parts.UNTIL) {
    const until = /^(\d{4})(\d{2})(\d{2})/.exec(parts.UNTIL);
    if (until) rule.until = `${until[1]}-${until[2]}-${until[3]}`;
  }
  let monthlyNth: ParsedRule["monthlyNth"] = null;
  let unsupported = Boolean(parts.BYMONTHDAY && freq !== "monthly") || Boolean(parts.BYSETPOS) || Boolean(parts.BYHOUR) || Boolean(parts.BYMONTH && freq !== "yearly");
  if (parts.BYDAY) {
    const days = parts.BYDAY.split(",").map((entry) => /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(entry.trim())).filter((match): match is RegExpExecArray => match !== null);
    if (freq === "weekly") {
      const set = new Set(days.map((match) => match[2] as Weekday));
      set.add(WEEKDAYS[weekdayIndex(dateToDay(start.date))]!);
      rule.byDay = WEEKDAYS.filter((day) => set.has(day));
    } else if (freq === "monthly" && days.length && days.every((match) => match[1])) {
      monthlyNth = days.map((match) => ({ n: Number(match[1]), day: match[2] as Weekday }));
    } else if (freq === "daily") {
      // FREQ=DAILY;BYDAY=MO,TU…: the same as weekly on those days.
      rule.freq = "weekly";
      const set = new Set(days.map((match) => match[2] as Weekday));
      set.add(WEEKDAYS[weekdayIndex(dateToDay(start.date))]!);
      rule.byDay = WEEKDAYS.filter((day) => set.has(day));
    } else unsupported = true;
  }
  return { rule, monthlyNth, unsupported };
}

/** The nth (1-based, negative from the end) weekday of a month as a date, or null. */
function nthWeekday(year: number, month: number, n: number, day: Weekday): string | null {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const target = WEEKDAYS.indexOf(day);
  const matches: string[] = [];
  for (let index = 0; index < days; index += 1) {
    const date = addDays(first, index);
    if (weekdayIndex(dateToDay(date)) === target) matches.push(date);
  }
  return (n > 0 ? matches[n - 1] : matches[matches.length + n]) ?? null;
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
      return { start: zonedToUtc(`${date}T00:00`, hostTz), end: zonedToUtc(`${addDays(date, days)}T00:00`, hostTz), allDay: true };
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
    if (parsed.unsupported || !parsed.rule) unsupported += 1;
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

/** Occurrence starts (UTC ms) of one series within the window; an unreadable rule keeps the first instance only. */
function expandRule(start: Instant, minutes: number, parsed: ParsedRule, fromMs: number, toMs: number): number[] {
  const tz = start.tz;
  const local = start.local ?? `${start.date}T00:00`;
  if (!parsed.rule) return [start.ms];
  if (parsed.monthlyNth) {
    const out: number[] = [];
    const rule = parsed.rule;
    const [year0, month0] = [Number(start.date.slice(0, 4)), Number(start.date.slice(5, 7))];
    let count = 0;
    for (let step = 0; step < 1200; step += rule.interval) {
      const monthIndex = month0 - 1 + step;
      const year = year0 + Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      const dates = parsed.monthlyNth.map((entry) => nthWeekday(year, month, entry.n, entry.day)).filter((date): date is string => date !== null && date >= start.date).sort();
      for (const date of dates) {
        if (rule.until && date > rule.until) return out;
        count += 1;
        if (rule.count && count > rule.count) return out;
        const ms = zonedToUtc(`${date}${local.slice(10)}`, tz);
        if (ms >= toMs) return out;
        if (ms + minutes * 60_000 > fromMs) out.push(ms);
      }
    }
    return out;
  }
  let rule: RecurrenceRule;
  const timing = { allDay: false as const, startLocal: local, tz, durationMinutes: Math.max(1, minutes) };
  try {
    rule = normalizeRule(parsed.rule, timing);
  } catch {
    return [start.ms];
  }
  const out: number[] = [];
  // rangeFor allows 100 days at a time: walk the window in chunks.
  let cursor = utcToZoned(Math.max(fromMs - minutes * 60_000, start.ms) - 86_400_000, tz).slice(0, 10);
  const lastDate = utcToZoned(toMs + 86_400_000, tz).slice(0, 10);
  const seen = new Set<number>();
  for (let guard = 0; cursor < lastDate && guard < 10; guard += 1) {
    const next = addDays(cursor, 90) < lastDate ? addDays(cursor, 90) : lastDate;
    const { occurrences } = expandSeries({ ...timing, rule }, rangeFor(cursor, next, tz), 2000);
    for (const occurrence of occurrences) if (!occurrence.allDay && !seen.has(occurrence.startMs)) { seen.add(occurrence.startMs); out.push(occurrence.startMs); }
    cursor = next;
  }
  return out;
}
