/**
 * Interactive report parameters (spec v3, D489, docs/plan/REPORT_THEME.md § Parameters): a date range,
 * single and multi selects whose options come from a guarded query, and number and text inputs. The
 * report's queries read them only through ClickHouse's typed query parameters (`{period_from:Date}`,
 * `{routes:Array(String)}`), which the server binds over HTTP (`param_<name>`); nothing a viewer picks
 * is ever pasted into SQL text.
 *
 * Pure: no server or client imports, so the client (the control bar, the URL), the server (binding,
 * the cache key), and tests share it.
 */

export const PARAM_TYPES = ["date_range", "select", "multi_select", "number", "text", "number_range"] as const;
export type ParamType = typeof PARAM_TYPES[number];

/**
 * The date range's presets, in the picker's order. Days are calendar days in the report's zone
 * (server/reports/paramZone.ts); `to` is included. D537 (lane FILTERS) added yesterday, this and last
 * week (ISO, Monday to Sunday), last month, last quarter, year to date, and the last 12 months.
 */
export const DATE_PRESETS = ["today", "yesterday", "7d", "30d", "90d", "this_week", "last_week", "mtd", "last_month", "qtd", "last_quarter", "ytd", "12m", "custom"] as const;
export type DatePreset = typeof DATE_PRESETS[number];
export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: "Today", yesterday: "Yesterday", "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", this_week: "This week", last_week: "Last week",
  mtd: "Month to date", last_month: "Last month", qtd: "Quarter to date", last_quarter: "Last quarter", ytd: "Year to date", "12m": "Last 12 months", custom: "Custom"
};

/** The ClickHouse types each parameter type may bind as (never Identifier: a parameter can never name a table or column). */
export const SCALAR_SELECT_TYPES = ["String", "Int32", "Int64", "UInt32", "UInt64"] as const;
export const MULTI_SELECT_TYPES = ["Array(String)", "Array(Int32)", "Array(Int64)", "Array(UInt32)", "Array(UInt64)"] as const;
export const NUMBER_TYPES = ["Int32", "Int64", "UInt32", "UInt64", "Float64"] as const;
export const CH_TYPES_BY_PARAM: Record<ParamType, readonly string[]> = {
  date_range: ["Date"], select: SCALAR_SELECT_TYPES, multi_select: MULTI_SELECT_TYPES, number: NUMBER_TYPES, text: ["String"], number_range: NUMBER_TYPES
};
/** Every type a placeholder may carry (D568: a multi-select's `<id>_not` flag is UInt8). */
export const PLACEHOLDER_TYPES: ReadonlySet<string> = new Set([...Object.values(CH_TYPES_BY_PARAM).flat(), "UInt8"]);

export const PARAM_LIMITS = {
  /** Parameters one spec may declare. */
  parameters: 8,
  label: 60,
  /** Options a select shows (its options query is cut there). */
  options: 200,
  /** One option's text. */
  optionChars: 200,
  /** A text parameter's value. */
  text: 200,
  /** Values one multi-select may hold. */
  selected: 50,
  /** An options query's SQL. */
  optionsSql: 4000
} as const;

/** A parameter id: `[a-z][a-z0-9_]{0,29}` (a date range binds `<id>_from` and `<id>_to`). */
export const PARAM_ID = /^[a-z][a-z0-9_]{0,29}$/;
export const ISO_DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

export type DateRangeValue = { preset: Exclude<DatePreset, "custom"> } | { preset: "custom"; from: string; to: string };

type ParamBase = { id: string; label: string };
export type DateRangeParameter = ParamBase & { type: "date_range"; chType: "Date"; default: DateRangeValue };
export type SelectParameter = ParamBase & { type: "select"; chType: string; default: string; optionsQuery: string };
/** An empty array is "All": the SQL handles it (`empty({p:Array(String)}) OR col IN {p:Array(String)}`). */
export type MultiSelectParameter = ParamBase & { type: "multi_select"; chType: string; default: string[]; optionsQuery: string };
export type NumberParameter = ParamBase & { type: "number"; chType: string; default: number; min?: number; max?: number };
export type TextParameter = ParamBase & { type: "text"; chType: "String"; default: string; maxLength?: number };
/** D567: a number range; a missing end (null) is open (bound as the type's lowest or highest value). */
export type NumberRangeValue = { min: number | null; max: number | null };
export type NumberRangeParameter = ParamBase & { type: "number_range"; chType: string; default: NumberRangeValue };
export type ReportParameter = DateRangeParameter | SelectParameter | MultiSelectParameter | NumberParameter | TextParameter | NumberRangeParameter;

/**
 * D568: a multi-select's picks to leave out (`{ not: [...] }`), where the report's SQL reads the
 * companion flag `{<id>_not:UInt8}`: `(empty({p:Array(T)}) OR (col IN {p:Array(T)}) != {p_not:UInt8})`.
 */
export type ExcludeValue = { not: string[] };
export type ParamValue = DateRangeValue | string | string[] | number | NumberRangeValue | ExcludeValue;

/** D568: a multi-select's picked values, whether it keeps or leaves them out. */
export const multiPicks = (value: unknown): string[] => Array.isArray(value) ? value as string[] : value && typeof value === "object" && Array.isArray((value as ExcludeValue).not) ? (value as ExcludeValue).not : [];
/** D568: whether a multi-select's value leaves its picks out. */
export const isExcluded = (value: unknown): value is ExcludeValue => Boolean(value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as ExcludeValue).not) && (value as ExcludeValue).not.length > 0);

/**
 * D568: the multi-selects readers may exclude with: every query that reads the parameter also reads
 * its `<id>_not` flag (else excluding would leave some blocks keeping the picks).
 */
export function excludableIds(params: ReadonlyArray<Pick<ReportParameter, "id" | "type">>, queries: ReadonlyArray<{ sql: string }>): Set<string> {
  const out = new Set<string>();
  for (const param of params) {
    if (param.type !== "multi_select") continue;
    const readers = queries.map((query) => new Set(placeholdersIn(query.sql).map((item) => item.name))).filter((names) => names.has(param.id) || names.has(`${param.id}_not`));
    if (readers.length && readers.every((names) => names.has(param.id) && names.has(`${param.id}_not`))) out.add(param.id);
  }
  return out;
}
export type ParamValues = Record<string, ParamValue>;

/** One bound ClickHouse parameter: its name in the SQL, its type, and the value as sent (`param_<name>`). */
export type BoundParam = { name: string; type: string; value: string };

/** A placeholder `{name:Type}` a parameter provides. */
export function placeholdersOf(param: Pick<ReportParameter, "id" | "type" | "chType">): Array<{ name: string; type: string }> {
  if (param.type === "date_range") return [{ name: `${param.id}_from`, type: "Date" }, { name: `${param.id}_to`, type: "Date" }];
  // D567: a number range binds both ends; D568: a multi-select also offers its exclude flag.
  if (param.type === "number_range") return [{ name: `${param.id}_min`, type: param.chType }, { name: `${param.id}_max`, type: param.chType }];
  if (param.type === "multi_select") return [{ name: param.id, type: param.chType }, { name: `${param.id}_not`, type: "UInt8" }];
  return [{ name: param.id, type: param.chType }];
}

/** Every placeholder a parameter list provides, by name. */
export function declaredPlaceholders(params: readonly ReportParameter[]): Map<string, { type: string; param: string }> {
  const out = new Map<string, { type: string; param: string }>();
  for (const param of params) for (const item of placeholdersOf(param)) out.set(item.name, { type: item.type, param: param.id });
  return out;
}

/** The `{name:Type}` placeholders written in SQL text (outside strings and comments is the guard's job; this is a quick scan). */
export function placeholdersIn(sql: string): Array<{ name: string; type: string }> {
  return [...sql.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_(), ]+?)\s*\}/g)].map((match) => ({ name: match[1]!, type: normalizeType(match[2]!) }));
}

/**
 * The parameters a query reads (D532, D533): those whose placeholders its SQL holds (a date range by
 * `<id>_from` or `<id>_to`), in the parameters' order. A quick scan shared by the server's per-query
 * result keys and the client's "Not filtered by"; a placeholder in a comment counts too (it can only
 * make a query re-run when it need not).
 */
export function readsOf(sql: string, params: ReadonlyArray<Pick<ReportParameter, "id" | "type" | "chType">>): string[] {
  const names = new Set(placeholdersIn(sql).map((item) => item.name));
  return params.filter((param) => placeholdersOf(param).some((item) => names.has(item.name))).map((param) => param.id);
}

/**
 * D560 (linked filters): the parameters a select's options query reads. Only parameters declared before
 * it count (array order, so there is never a cycle); spec checks refuse a placeholder of any other.
 */
export function optionParentsOf(param: ReportParameter, params: readonly ReportParameter[]): string[] {
  if (param.type !== "select" && param.type !== "multi_select") return [];
  const at = params.findIndex((item) => item.id === param.id);
  return at <= 0 ? [] : readsOf(param.optionsQuery, params.slice(0, at));
}

/** D560: linked lists cached per report (the most recently used are kept). */
export const LINKED_OPTIONS = { listsPerReport: 50 } as const;

/** Which queries each parameter reaches (D533): `{ paramId: queryKey[] }`, every parameter listed. */
export function reachOf(params: ReadonlyArray<Pick<ReportParameter, "id" | "type" | "chType">>, queries: ReadonlyArray<{ key: string; sql: string }>): Record<string, string[]> {
  const reach: Record<string, string[]> = Object.fromEntries(params.map((param) => [param.id, [] as string[]]));
  for (const query of queries) for (const id of readsOf(query.sql, params)) reach[id]!.push(query.key);
  return reach;
}

/** A type as written, with its spaces taken out (`Array( String )` is `Array(String)`). */
export const normalizeType = (type: string) => type.replace(/\s+/g, "");

const isInteger = (type: string) => /^U?Int(?:8|16|32|64)$/.test(type);
const elementType = (type: string) => /^Array\((.*)\)$/.exec(type)?.[1] ?? type;

// ------------------------------------------------------------------------------------ dates

/** Today's UTC day (`YYYY-MM-DD`). */
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

/** Today's calendar day (`YYYY-MM-DD`) in an IANA zone (the report's, D489); UTC for a zone this runtime does not know. */
export function todayIn(timeZone: string, now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return todayUtc(now);
  }
}

/** A zone's short name for labels ("IST", "EDT", "UTC"), else its GMT offset ("GMT+4"). */
export function zoneLabel(timeZone: string, now = new Date()): string {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return "UTC";
  const short = (locale: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" }).formatToParts(now).find((part) => part.type === "timeZoneName")?.value ?? "";
    } catch {
      return "";
    }
  };
  const us = short("en-US");
  if (us && !/^(GMT|UTC)[+-]/.test(us)) return us;
  // en-US names few zones outside the Americas ("GMT+5:30"); en-IN names IST, en-GB the European ones.
  for (const locale of ["en-IN", "en-GB", "en-AU"]) {
    const name = short(locale);
    if (name && !/^(GMT|UTC)[+-]/.test(name)) return name;
  }
  return us || timeZone;
}

function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A real calendar day (not 2026-02-31). */
export const validDay = (day: string) => ISO_DAY.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

/** The last day of a month (`month` 1–12). */
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const dayOf = (year: number, month: number, day: number) => `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** The from and to days (both included) a date range stands for on `today`. */
export function resolveDateRange(value: DateRangeValue, today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  // ISO weeks start on Monday (getUTCDay() is 0 on Sunday).
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  switch (value.preset) {
    case "today": return { from: today, to: today };
    case "yesterday": { const day = shiftDay(today, -1); return { from: day, to: day }; }
    case "this_week": return { from: shiftDay(today, -weekday), to: today };
    case "last_week": { const monday = shiftDay(today, -weekday - 7); return { from: monday, to: shiftDay(monday, 6) }; }
    case "last_month": {
      const [y, m] = month === 1 ? [year - 1, 12] : [year, month - 1];
      return { from: dayOf(y, m, 1), to: dayOf(y, m, lastDayOf(y, m)) };
    }
    case "last_quarter": {
      const first = month - ((month - 1) % 3);
      const [y, m] = first === 1 ? [year - 1, 10] : [year, first - 3];
      return { from: dayOf(y, m, 1), to: dayOf(y, m + 2, lastDayOf(y, m + 2)) };
    }
    case "ytd": return { from: dayOf(year, 1, 1), to: today };
    case "12m": {
      // The twelve months up to today: from the day after the same day a year ago (29 February: 1 March).
      const day = Number(today.slice(8, 10));
      return { from: shiftDay(dayOf(year - 1, month, Math.min(day, lastDayOf(year - 1, month))), 1), to: today };
    }
    case "7d": return { from: shiftDay(today, -6), to: today };
    case "30d": return { from: shiftDay(today, -29), to: today };
    case "90d": return { from: shiftDay(today, -89), to: today };
    case "mtd": return { from: `${today.slice(0, 8)}01`, to: today };
    case "qtd": {
      const month = Number(today.slice(5, 7));
      const first = month - ((month - 1) % 3);
      return { from: `${today.slice(0, 5)}${String(first).padStart(2, "0")}-01`, to: today };
    }
    default: return { from: value.from, to: value.to };
  }
}

/** A date range as one line: "Last 30 days", or "2026-09-01 – 2026-09-30". */
export const dateRangeLabel = (value: DateRangeValue) => value.preset === "custom" ? `${value.from} – ${value.to}` : DATE_PRESET_LABELS[value.preset];

// ------------------------------------------------------------------------------------ values

/** Why a value does not fit its parameter (null: it fits). Options are checked by the caller. */
export function valueProblem(param: ReportParameter, value: unknown): string | null {
  switch (param.type) {
    case "date_range": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return "must be a date range";
      const range = value as Record<string, unknown>;
      if (!(DATE_PRESETS as readonly unknown[]).includes(range.preset)) return `preset must be one of ${DATE_PRESETS.join(", ")}`;
      if (range.preset !== "custom") return Object.keys(range).length === 1 ? null : "a preset range takes no from or to";
      if (typeof range.from !== "string" || typeof range.to !== "string" || !validDay(range.from) || !validDay(range.to)) return "a custom range needs from and to as YYYY-MM-DD";
      if (Object.keys(range).length !== 3) return "a custom range takes only preset, from, and to";
      return range.from <= range.to ? null : "from must not be after to";
    }
    case "select": return scalarProblem(param.chType, value);
    case "multi_select": {
      // D568: `{ not: [...] }` leaves the picks out (the server checks the report's SQL reads `<id>_not`).
      const exclude = value && typeof value === "object" && !Array.isArray(value);
      if (exclude && (Object.keys(value).length !== 1 || !Array.isArray((value as ExcludeValue).not))) return "must be a list, or { not: [values] } to leave them out";
      const items = exclude ? (value as ExcludeValue).not : value;
      if (!Array.isArray(items)) return "must be a list (empty for All)";
      if (items.length > PARAM_LIMITS.selected) return `may hold at most ${PARAM_LIMITS.selected} values`;
      for (const item of items) { const problem = scalarProblem(elementType(param.chType), item); if (problem) return problem; }
      return new Set(items).size === items.length ? null : "lists a value twice";
    }
    case "number_range": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return "must be { min, max } (null for an open end)";
      const range = value as Record<string, unknown>;
      if (Object.keys(range).length !== 2 || !("min" in range) || !("max" in range)) return "takes only min and max";
      for (const end of [range.min, range.max]) {
        if (end === null) continue;
        if (typeof end !== "number" || !Number.isFinite(end)) return "min and max must be numbers or null";
        if (isInteger(param.chType) && !Number.isSafeInteger(end)) return "must be whole numbers";
        if (param.chType.startsWith("U") && end < 0) return "must not be negative";
      }
      return typeof range.min === "number" && typeof range.max === "number" && range.min > range.max ? "min must not be more than max" : null;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (isInteger(param.chType) && !Number.isSafeInteger(value)) return "must be a whole number";
      if (param.chType.startsWith("U") && value < 0) return "must not be negative";
      if (param.min !== undefined && value < param.min) return `must be at least ${param.min}`;
      if (param.max !== undefined && value > param.max) return `must be at most ${param.max}`;
      return null;
    }
    case "text": {
      if (typeof value !== "string") return "must be text";
      if (value.length > Math.min(param.maxLength ?? PARAM_LIMITS.text, PARAM_LIMITS.text)) return `may be at most ${Math.min(param.maxLength ?? PARAM_LIMITS.text, PARAM_LIMITS.text)} characters`;
      return /[\u0000-\u001f\u007f\u2028\u2029]/.test(value) ? "must be one line of plain text" : null;
    }
  }
}

function scalarProblem(type: string, value: unknown): string | null {
  if (typeof value !== "string") return "must be text";
  if (value.length > PARAM_LIMITS.optionChars) return `must be at most ${PARAM_LIMITS.optionChars} characters`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return "must not hold control characters";
  if (isInteger(type)) {
    if (!/^-?\d{1,20}$/.test(value)) return `must be a whole number (${type})`;
    if (type.startsWith("U") && value.startsWith("-")) return "must not be negative";
  }
  return null;
}

/** Each parameter's default, by id. */
export const defaultValues = (params: readonly ReportParameter[]): ParamValues => Object.fromEntries(params.map((param) => [param.id, param.default]));

/** A value in canonical form (keys sorted, a multi-select's values sorted), for comparing and keying. */
function canonical(param: ReportParameter, value: ParamValue): unknown {
  if (param.type === "date_range") {
    const range = value as DateRangeValue;
    return range.preset === "custom" ? { from: range.from, preset: "custom", to: range.to } : { preset: range.preset };
  }
  if (param.type === "multi_select") {
    const picks = [...multiPicks(value)].sort();
    // An empty exclusion is All, like [].
    return isExcluded(value) ? { not: picks } : picks;
  }
  if (param.type === "number_range") {
    const range = value as NumberRangeValue;
    return { max: range.max, min: range.min };
  }
  return value;
}

/** The values as one canonical string (parameters by id; a missing or invalid value reads as its default). */
export function canonicalValues(params: readonly ReportParameter[], values: ParamValues): string {
  const entries = [...params].sort((a, b) => a.id.localeCompare(b.id)).map((param) => {
    const value = Object.hasOwn(values, param.id) && valueProblem(param, values[param.id]) === null ? values[param.id]! : param.default;
    return [param.id, canonical(param, value)];
  });
  return JSON.stringify(entries);
}

/** Whether the values are every parameter's default (the set Refresh all and schedules run). */
export const isDefaultSet = (params: readonly ReportParameter[], values: ParamValues) => canonicalValues(params, values) === canonicalValues(params, defaultValues(params));

/**
 * The values to use: each given one that fits its parameter, else the default. `problems` names what
 * was dropped (the server refuses them; the URL reader ignores them).
 */
export function resolveValues(params: readonly ReportParameter[], given: Record<string, unknown> | null | undefined): { values: ParamValues; problems: string[] } {
  const values: ParamValues = {};
  const problems: string[] = [];
  const known = new Set(params.map((param) => param.id));
  for (const key of Object.keys(given ?? {})) if (!known.has(key)) problems.push(`${key.slice(0, 40)} is not one of this report's parameters`);
  for (const param of params) {
    const value = given?.[param.id];
    if (value === undefined) { values[param.id] = param.default; continue; }
    const problem = valueProblem(param, value);
    if (problem) { problems.push(`${param.id}: ${problem}`); values[param.id] = param.default; }
    // Canonical (a multi-select sorted), so the same choice binds and caches as one set.
    else values[param.id] = param.type === "date_range" || param.type === "multi_select" || param.type === "number_range" ? canonical(param, value as ParamValue) as ParamValue : value as ParamValue;
  }
  return { values, problems };
}

// ------------------------------------------------------------------------------------ binding

/** A String value as ClickHouse reads a query parameter (the escaped text format: backslash, tab, line breaks). */
export const escapeParamString = (value: string) => value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
/** One element of an Array(String) parameter: single-quoted, backslash-escaped. */
export const quotedElement = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}'`;

/** D567: what an open end of a number range binds as, per type (the type's lowest and highest; Float64's infinities). */
export const RANGE_ENDS: Record<string, readonly [string, string]> = {
  Int32: ["-2147483648", "2147483647"], Int64: ["-9223372036854775808", "9223372036854775807"],
  UInt32: ["0", "4294967295"], UInt64: ["0", "18446744073709551615"], Float64: ["-inf", "inf"]
};

/**
 * The bound parameters for a set of values on `today`: a date range binds `<id>_from` and `<id>_to`,
 * every other parameter its id. Values are encoded as ClickHouse parses `param_<name>` (they are typed
 * by the placeholder, so a value that is not of its type is refused by ClickHouse, never run as SQL).
 */
export function bindValues(params: readonly ReportParameter[], values: ParamValues, today: string): BoundParam[] {
  const out: BoundParam[] = [];
  for (const param of params) {
    const value = values[param.id] ?? param.default;
    switch (param.type) {
      case "date_range": {
        const range = resolveDateRange(value as DateRangeValue, today);
        out.push({ name: `${param.id}_from`, type: "Date", value: range.from }, { name: `${param.id}_to`, type: "Date", value: range.to });
        break;
      }
      case "multi_select": {
        const items = multiPicks(value);
        const element = elementType(param.chType);
        out.push({ name: param.id, type: param.chType, value: `[${items.map((item) => element === "String" ? quotedElement(item) : String(BigInt(item))).join(",")}]` },
          { name: `${param.id}_not`, type: "UInt8", value: isExcluded(value) ? "1" : "0" });
        break;
      }
      case "number_range": {
        const range = value as NumberRangeValue;
        const [low, high] = RANGE_ENDS[param.chType] ?? ["-inf", "inf"];
        out.push({ name: `${param.id}_min`, type: param.chType, value: range.min === null ? low : String(range.min) }, { name: `${param.id}_max`, type: param.chType, value: range.max === null ? high : String(range.max) });
        break;
      }
      case "select":
        out.push({ name: param.id, type: param.chType, value: param.chType === "String" ? escapeParamString(value as string) : String(BigInt(value as string)) });
        break;
      case "number":
        out.push({ name: param.id, type: param.chType, value: String(value) });
        break;
      case "text":
        out.push({ name: param.id, type: "String", value: escapeParamString(value as string) });
        break;
    }
  }
  return out;
}

// ------------------------------------------------------------------------- the SQL console

/** The SQL console's limits for a placeholder's value (D490). */
export const CONSOLE_PARAM_LIMITS = { values: 16, chars: 1000, items: PARAM_LIMITS.selected } as const;

/** A bound String value back as typed (the inverse of escapeParamString), to prefill the console. */
export const unescapeParamString = (value: string) => value.replace(/\\([\\tnr])/g, (_match, char: string) => char === "t" ? "\t" : char === "n" ? "\n" : char === "r" ? "\r" : "\\");

/**
 * Reads an array literal as the console takes it (`['a', 'b']`, `[1, 2]`, `[]`): single-quoted strings
 * with backslash escapes, or whole numbers. Null when it is not one.
 */
export function parseArrayLiteral(text: string, element: string): string[] | null {
  const source = text.trim();
  if (!source.startsWith("[") || !source.endsWith("]")) return null;
  const items: string[] = [];
  let index = 1;
  const end = source.length - 1;
  const skip = () => { while (index < end && /\s/.test(source[index]!)) index += 1; };
  skip();
  if (index === end) return items;
  for (;;) {
    skip();
    if (element === "String") {
      if (source[index] !== "'") return null;
      let value = "";
      index += 1;
      for (;;) {
        if (index >= end) return null;
        const char = source[index]!;
        if (char === "\\") {
          const next = source[index + 1];
          if (next === undefined || index + 1 >= end) return null;
          value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
          index += 2;
          continue;
        }
        if (char === "'") { index += 1; break; }
        value += char;
        index += 1;
      }
      items.push(value);
    } else {
      const match = /^-?\d{1,20}/.exec(source.slice(index, end));
      if (!match) return null;
      items.push(match[0]);
      index += match[0].length;
    }
    skip();
    if (index === end) return items;
    if (source[index] !== ",") return null;
    index += 1;
  }
}

/**
 * A console value for a placeholder `{name:Type}` (D490): what the person typed, checked against the
 * type and encoded as ClickHouse parses `param_<name>` (the same encoding report parameters use), so a
 * value is never SQL text. Dates are `YYYY-MM-DD`, numbers plain, text as typed, arrays as a literal.
 */
export function placeholderValue(type: string, raw: string): { value: string } | { problem: string } {
  if (raw.length > CONSOLE_PARAM_LIMITS.chars) return { problem: `may be at most ${CONSOLE_PARAM_LIMITS.chars} characters` };
  if (!PLACEHOLDER_TYPES.has(type)) return { problem: `the type ${type} is not supported` };
  const text = type === "String" ? raw : raw.trim();
  if (type === "Date") return validDay(text) ? { value: text } : { problem: "must be a day, YYYY-MM-DD" };
  if (type === "Float64") return text !== "" && Number.isFinite(Number(text)) ? { value: String(Number(text)) } : { problem: "must be a number" };
  if (type === "String") return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? { problem: "must not hold control characters" } : { value: escapeParamString(text) };
  if (isInteger(type)) {
    const problem = scalarProblem(type, text);
    return problem ? { problem } : { value: String(BigInt(text)) };
  }
  const element = elementType(type);
  const items = parseArrayLiteral(text, element);
  if (!items) return { problem: element === "String" ? "must be a list such as ['a', 'b'] (or [] for none)" : "must be a list such as [1, 2] (or [] for none)" };
  if (items.length > CONSOLE_PARAM_LIMITS.items) return { problem: `may hold at most ${CONSOLE_PARAM_LIMITS.items} values` };
  for (const item of items) {
    if (element === "String") { if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item)) return { problem: "must not hold control characters" }; }
    else { const problem = scalarProblem(element, item); if (problem) return { problem }; }
  }
  return { value: `[${items.map((item) => element === "String" ? quotedElement(item) : String(BigInt(item))).join(",")}]` };
}

/** A bound value back as the console's input shows it (a String unescaped; the rest as sent). */
export const placeholderInput = (type: string, bound: string) => type === "String" ? unescapeParamString(bound) : bound;

/** The bound values as the inspect panel shows them (`name` → value as sent). */
export const boundRecord = (bound: readonly BoundParam[]) => Object.fromEntries(bound.map((item) => [item.name, item.value]));

// ------------------------------------------------------------------------------------ the URL

/** The URL query key of a parameter (`?p.period=30d&p.route=%2Fapi`). */
export const paramSearchKey = (id: string) => `p.${id}`;

/**
 * The values as URL entries, for the parameters whose value is not the default (a report with only
 * defaults keeps a clean URL). A multi-select repeats its key; an empty one (All) is one empty entry.
 */
export function valuesToSearch(params: readonly ReportParameter[], values: ParamValues): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const param of params) {
    const value = values[param.id];
    if (value === undefined || JSON.stringify(canonical(param, value)) === JSON.stringify(canonical(param, param.default))) continue;
    if (param.type === "date_range") {
      const range = value as DateRangeValue;
      out[param.id] = [range.preset === "custom" ? `${range.from}..${range.to}` : range.preset];
    } else if (param.type === "multi_select") {
      // D568: left-out values ride as `p.<id>.not`.
      if (isExcluded(value)) out[`${param.id}.not`] = [...value.not];
      else out[param.id] = multiPicks(value).length ? [...multiPicks(value)] : [""];
    } else if (param.type === "number_range") {
      const range = value as NumberRangeValue;
      out[param.id] = [`${range.min ?? ""}..${range.max ?? ""}`];
    } else out[param.id] = [String(value)];
  }
  return out;
}

/** URL entries back as values; anything that does not fit its parameter is dropped (the default shows). */
export function valuesFromSearch(params: readonly ReportParameter[], entries: Record<string, string[]> | undefined): ParamValues {
  const given: Record<string, unknown> = {};
  for (const param of params) {
    const excluded = param.type === "multi_select" ? entries?.[`${param.id}.not`]?.filter((item) => item !== "") : undefined;
    if (excluded?.length) { given[param.id] = { not: excluded }; continue; }
    const raw = entries?.[param.id];
    if (!raw?.length) continue;
    if (param.type === "date_range") {
      const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(raw[0]!);
      given[param.id] = range ? { preset: "custom", from: range[1], to: range[2] } : { preset: raw[0] };
    } else if (param.type === "multi_select") given[param.id] = raw.filter((item) => item !== "");
    else if (param.type === "number") given[param.id] = raw[0]!.trim() === "" ? NaN : Number(raw[0]);
    else if (param.type === "number_range") {
      // D567: `10..500`, `10..`, `..500`.
      const range = /^([^.]*(?:\.\d+)?)\.\.(.*)$/.exec(raw[0]!.trim());
      const end = (text: string | undefined) => text === undefined || text.trim() === "" ? null : Number(text);
      given[param.id] = range ? { min: end(range[1]), max: end(range[2]) } : null;
    } else given[param.id] = raw[0];
  }
  return resolveValues(params, given).values;
}

/** A number as a range label shows it (grouped). */
const rangeNumber = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });

/** A value as the control bar and Inspect show it. */
export function valueLabel(param: ReportParameter, value: ParamValue): string {
  if (param.type === "date_range") return dateRangeLabel(value as DateRangeValue);
  if (param.type === "multi_select") {
    const items = multiPicks(value);
    const list = items.length <= 2 ? items.join(", ") : `${items.length} selected`;
    return items.length === 0 ? "All" : isExcluded(value) ? `All but ${list}` : list;
  }
  if (param.type === "number_range") {
    const range = value as NumberRangeValue;
    if (range.min === null && range.max === null) return "Any";
    if (range.min === null) return `≤ ${rangeNumber(range.max!)}`;
    if (range.max === null) return `≥ ${rangeNumber(range.min)}`;
    return range.min === range.max ? rangeNumber(range.min) : `${rangeNumber(range.min)}–${rangeNumber(range.max)}`;
  }
  return String(value);
}

/** What a parameter set's results answer with (GET …/results with values, the param run). */
export type ParamSetInfo = {
  /** Whether these are every default (the stored results Refresh all and schedules keep). */
  isDefault: boolean;
  values: ParamValues;
  /** The ClickHouse parameters as sent. */
  bound: Record<string, string>;
  /** Queries with no fresh cached result for this set (a run fills them). */
  missing: string[];
};

/** A select's options (GET …/parameters/:id/options); with `query`, the values that hold it (D491 search). */
/** D560: a linked select's list names the parents' values it was read for (`parents`). */
export type ParamOptions = { paramId: string; options: string[]; truncated: boolean; error: string | null; at: string | null; query?: string; parents?: ParamValues };
