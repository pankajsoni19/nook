import { useId, useMemo } from "react";
import { CalendarClock } from "lucide-react";
import { isValidTimeZone } from "../../../shared/calendarRecurrence";
import { nextFires, scheduleRuleProblem, type CadenceRule } from "../../../shared/schedules";
import { Select } from "../Select";
import { useUnitPreferences } from "../units";
import "../workspace.css";

/**
 * When something repeats (§E.3, D838): Standups' rounds, Goals' check-in cadence, Forms' open and
 * close, Time's reminders. Weekdays, a time of day, every N weeks, and whose clock it follows —
 * one zone for everyone (a team standup at 09:00 Berlin) or each person's own (09:00 wherever they
 * are). The preview lists the next fires from shared/schedules.ts `nextFires`, the dispatcher's own
 * rule, in the viewer's zone: "Next: Mon 16 Nov 09:00, Tue 17 Nov 09:00, …".
 */
export type ScheduleValue = {
  weekdays: number[];
  /** HH:MM. */
  at: string;
  everyNWeeks: number;
  /** The zone the time is in when `zoneMode` is "fixed". */
  tz: string;
  zoneMode: "fixed" | "each";
};

/** 0 = Sunday … 6 = Saturday (shared/schedules.ts); shown from the person's week start. */
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const weekOrder = (weekStart: 0 | 1 | 6) => Array.from({ length: 7 }, (_, index) => (weekStart + index) % 7);

export const viewerZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

/** The cadence rule a value stands for (what a module stores with `upsertSchedule`). */
export const scheduleRule = (value: ScheduleValue): { cadence: CadenceRule } => ({ cadence: { weekdays: [...value.weekdays].sort(), at: value.at, ...(value.everyNWeeks > 1 ? { everyNWeeks: value.everyNWeeks } : {}) } });

/** "Weekdays at 09:00", "Mon, Wed at 16:30, every 2 weeks". */
export function scheduleSummary(value: ScheduleValue, weekStart: 0 | 1 | 6 = 1) {
  const days = weekOrder(weekStart).filter((day) => value.weekdays.includes(day));
  const set = days.join(",");
  const daysText = days.length === 7 ? "Every day" : set === "1,2,3,4,5" ? "Weekdays" : days.length === 1 ? `${DAY_LONG[days[0]!]}s` : days.map((day) => DAY_SHORT[day]).join(", ");
  const zone = value.zoneMode === "each" ? " in each person's time zone" : "";
  return `${daysText} at ${value.at}${value.everyNWeeks > 1 ? `, every ${value.everyNWeeks} weeks` : ""}${zone}`;
}

/** The next `count` fires as the viewer reads them ("Mon 16 Nov, 09:00"). */
export function previewFires(value: ScheduleValue, now: number, count = 3, viewerTz = viewerZone()): string[] {
  const tz = value.zoneMode === "each" ? viewerTz : value.tz;
  const format = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: viewerTz });
  return nextFires(scheduleRule(value), tz, now, count).map((at) => format.format(at));
}

const ZONES = (() => {
  try { return (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { return []; }
})();

export function SchedulePicker({ value, onChange, label = "Schedule", allowEachZone = true, disabled = false, now }: {
  value: ScheduleValue;
  onChange: (value: ScheduleValue) => void;
  label?: string;
  /** Offer "Each person's time zone" (Standups yes; a poll's close time no). */
  allowEachZone?: boolean;
  disabled?: boolean;
  /** The clock for the preview (tests). */
  now?: number;
}) {
  const prefs = useUnitPreferences();
  const id = useId();
  const problem = scheduleRuleProblem(scheduleRule(value), value.zoneMode === "each" ? viewerZone() : value.tz);
  const preview = useMemo(() => problem ? [] : previewFires(value, now ?? Date.now()), [value, problem, now]);
  const zones = useMemo(() => [...new Set([value.tz, viewerZone(), "UTC", ...ZONES])].filter(isValidTimeZone), [value.tz]);
  const set = (patch: Partial<ScheduleValue>) => onChange({ ...value, ...patch });
  const toggle = (day: number) => set({ weekdays: value.weekdays.includes(day) ? value.weekdays.filter((item) => item !== day) : [...value.weekdays, day].sort() });

  return <fieldset className="ui-schedule" disabled={disabled}>
    <legend className="ui-schedule-legend"><CalendarClock aria-hidden="true" />{label}</legend>
    <div className="ui-schedule-days" role="group" aria-label="Days">
      {weekOrder(prefs.weekStart).map((day) => <button key={day} type="button" className="ui-day-toggle" aria-pressed={value.weekdays.includes(day)} aria-label={DAY_LONG[day]} title={DAY_LONG[day]} onClick={() => toggle(day)}>{DAY_SHORT[day]!.slice(0, 2)}</button>)}
    </div>
    <div className="ui-schedule-row">
      <label className="ui-field ui-schedule-time" htmlFor={`${id}-at`}>
        <span>Time</span>
        <input id={`${id}-at`} type="time" value={value.at} step={300} required onChange={(event) => { if (event.target.value) set({ at: event.target.value.slice(0, 5) }); }} />
      </label>
      <div className="ui-field ui-schedule-every">
        <span id={`${id}-every`}>Repeat</span>
        <Select labelledBy={`${id}-every`} value={String(value.everyNWeeks)} onChange={(next) => set({ everyNWeeks: Number(next) })}
          options={[1, 2, 3, 4].map((weeks) => ({ value: String(weeks), label: weeks === 1 ? "Every week" : `Every ${weeks} weeks` }))} />
      </div>
    </div>
    {allowEachZone && <div className="ui-segmented" role="group" aria-label="Whose time">
      <button type="button" aria-pressed={value.zoneMode === "fixed"} onClick={() => set({ zoneMode: "fixed" })}>One time zone</button>
      <button type="button" aria-pressed={value.zoneMode === "each"} onClick={() => set({ zoneMode: "each" })}>Each person's time zone</button>
    </div>}
    {value.zoneMode === "fixed" && <div className="ui-field">
      <span id={`${id}-tz`}>Time zone</span>
      <Select labelledBy={`${id}-tz`} value={value.tz} onChange={(tz) => set({ tz })} searchable options={zones.map((zone) => ({ value: zone, label: zone.replace(/_/g, " ") }))} />
    </div>}
    <p className="ui-schedule-preview" aria-live="polite">
      {problem ? <span className="ui-field-error">{problem}</span>
        : <><strong>{scheduleSummary(value, prefs.weekStart)}.</strong> Next: <span className="ui-tabular">{preview.join(" · ")}</span>{value.zoneMode === "fixed" && value.tz !== viewerZone() ? " (your time)" : ""}</>}
    </p>
  </fieldset>;
}
