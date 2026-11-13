import { useId, useState } from "react";
import { CalendarOff, Copy, Plus, Trash2, X } from "lucide-react";
import { minutesOf, rangesProblem, timeOf, WEEKDAY_KEYS, type TimeRange, type WeekdayKey, type WeeklyRules } from "../../../shared/bookings";
import "./availability.css";

/**
 * Weekly availability with date overrides (§E.3 AvailabilityEditor, owned by lane BOOK, in src/ui for
 * reuse): one row per weekday with a switch, its time ranges (add, remove, "Copy to all days"), and a
 * list of date overrides (closed all day, or other hours). Each row checks its ranges as typed (the
 * shared rangesProblem the server applies). At 375 px a day's ranges wrap to a second line (two rows,
 * nothing hidden, §E.1.5). Controlled: the host saves.
 */

export const WEEKDAY_LABELS: Record<WeekdayKey, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const DEFAULT_RANGE: TimeRange = { from: "09:00", to: "17:00" };

/** The next range after the day's last one (an hour later, an hour long), or null when the day is full. */
export function nextRange(ranges: readonly TimeRange[]): TimeRange | null {
  if (!ranges.length) return DEFAULT_RANGE;
  const end = minutesOf(ranges[ranges.length - 1]!.to);
  if (end >= 23 * 60) return null;
  const from = Math.min(end + 60, 23 * 60);
  return { from: timeOf(from), to: timeOf(Math.min(from + 60, 24 * 60)) };
}

export function AvailabilityEditor({ weekly, onChange, weekStart = 1, disabled = false }: {
  weekly: WeeklyRules;
  onChange: (weekly: WeeklyRules) => void;
  /** 0 Sunday, 1 Monday, 6 Saturday (the viewer's week start). */
  weekStart?: 0 | 1 | 6;
  disabled?: boolean;
}) {
  const days = weekStart === 0 ? ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const : weekStart === 6 ? ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] as const : WEEKDAY_KEYS;
  const set = (day: WeekdayKey, ranges: TimeRange[]) => {
    const next = { ...weekly };
    if (ranges.length) next[day] = ranges;
    else delete next[day];
    onChange(next);
  };
  return <div className="ui-availability" role="group" aria-label="Weekly hours">
    {days.map((day) => {
      const ranges = weekly[day] ?? [];
      const open = ranges.length > 0;
      const problem = open ? rangesProblem(ranges) : null;
      return <div className={`ui-availability-day${open ? "" : " closed"}`} key={day}>
        <label className="ui-availability-switch">
          <input type="checkbox" checked={open} disabled={disabled} onChange={(event) => set(day, event.target.checked ? [DEFAULT_RANGE] : [])} />
          <span>{WEEKDAY_LABELS[day]}</span>
        </label>
        <div className="ui-availability-ranges">
          {!open && <span className="ui-availability-off">Unavailable</span>}
          {ranges.map((range, index) => <RangeRow key={index} label={WEEKDAY_LABELS[day]} index={index} range={range} disabled={disabled}
            onChange={(next) => set(day, ranges.map((item, at) => at === index ? next : item))}
            onRemove={() => set(day, ranges.filter((_, at) => at !== index))} />)}
          {problem && <span className="ui-field-error" role="alert">{problem}</span>}
        </div>
        <div className="ui-availability-tools">
          <button type="button" className="icon-button" disabled={disabled || !nextRange(ranges)} aria-label={`Add hours on ${WEEKDAY_LABELS[day]}`} title="Add hours"
            onClick={() => { const range = nextRange(ranges); if (range) set(day, [...ranges, range]); }}><Plus /></button>
          <button type="button" className="icon-button" disabled={disabled || !open} aria-label={`Copy ${WEEKDAY_LABELS[day]}'s hours to every day`} title="Copy to all days"
            onClick={() => onChange(Object.fromEntries(WEEKDAY_KEYS.map((key) => [key, ranges.map((range) => ({ ...range }))])) as WeeklyRules)}><Copy /></button>
        </div>
      </div>;
    })}
  </div>;
}

function RangeRow({ label, index, range, disabled, onChange, onRemove }: { label: string; index: number; range: TimeRange; disabled: boolean; onChange: (range: TimeRange) => void; onRemove: () => void }) {
  return <span className="ui-availability-range">
    <input type="time" step={300} value={range.from} disabled={disabled} aria-label={`${label} range ${index + 1} from`} onChange={(event) => onChange({ ...range, from: event.target.value })} />
    <span aria-hidden="true">–</span>
    <input type="time" step={300} value={range.to === "24:00" ? "23:59" : range.to} disabled={disabled} aria-label={`${label} range ${index + 1} to`}
      onChange={(event) => onChange({ ...range, to: event.target.value === "23:59" ? "24:00" : event.target.value })} />
    <button type="button" className="icon-button" disabled={disabled} aria-label={`Remove ${label} range ${index + 1}`} onClick={onRemove}><X /></button>
  </span>;
}

export type OverrideRow = { date: string; ranges: TimeRange[] | null; note: string };

/** Date overrides: a list with "closed" or other hours, and a small form to add one. */
export function OverridesEditor({ overrides, onPut, onRemove, today, disabled = false }: {
  overrides: readonly OverrideRow[];
  onPut: (row: OverrideRow) => void | Promise<void>;
  onRemove: (date: string) => void | Promise<void>;
  /** The schedule zone's today (overrides before it are listed as past). */
  today: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [date, setDate] = useState("");
  const [closed, setClosed] = useState(true);
  const [range, setRange] = useState<TimeRange>({ from: "10:00", to: "14:00" });
  const [note, setNote] = useState("");
  const upcoming = overrides.filter((row) => row.date >= today);
  const problem = !closed ? rangesProblem([range]) : null;
  return <div className="ui-overrides">
    {upcoming.length === 0 ? <p className="ui-overrides-empty">No date overrides. Add a day off or different hours for a date.</p>
      : <ul className="ui-overrides-list">
        {upcoming.map((row) => <li key={row.date}>
          <span className="ui-overrides-date">{new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${row.date}T00:00:00Z`))}</span>
          <span className="ui-overrides-hours">{row.ranges === null ? <><CalendarOff aria-hidden="true" />Unavailable</> : row.ranges.map((item) => `${item.from}–${item.to}`).join(", ")}</span>
          {row.note && <span className="ui-overrides-note">{row.note}</span>}
          <button type="button" className="icon-button" disabled={disabled} aria-label={`Remove the override on ${row.date}`} onClick={() => void onRemove(row.date)}><Trash2 /></button>
        </li>)}
      </ul>}
    <form className="ui-overrides-form" noValidate onSubmit={(event) => { event.preventDefault(); if (date && !problem) void Promise.resolve(onPut({ date, ranges: closed ? null : [range], note })).then(() => { setDate(""); setNote(""); }); }}>
      <label className="ui-field"><span>Date</span><input id={`${id}-date`} type="date" required value={date} min={today} disabled={disabled} onChange={(event) => setDate(event.target.value)} /></label>
      <label className="ui-availability-switch"><input type="checkbox" checked={closed} disabled={disabled} onChange={(event) => setClosed(event.target.checked)} /><span>Unavailable all day</span></label>
      {!closed && <span className="ui-availability-range">
        <input type="time" step={300} value={range.from} aria-label="Override from" onChange={(event) => setRange({ ...range, from: event.target.value })} />
        <span aria-hidden="true">–</span>
        <input type="time" step={300} value={range.to} aria-label="Override to" onChange={(event) => setRange({ ...range, to: event.target.value })} />
      </span>}
      <label className="ui-field"><span>Note</span><input value={note} maxLength={100} placeholder="Holiday" disabled={disabled} onChange={(event) => setNote(event.target.value)} /></label>
      {problem && <span className="ui-field-error" role="alert">{problem}</span>}
      <button type="submit" className="secondary-button ui-small-button bk-form-button" disabled={disabled || !date || Boolean(problem)}><Plus aria-hidden="true" />Add override</button>
    </form>
  </div>;
}
