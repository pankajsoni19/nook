import { useEffect, useId, useRef, useState } from "react";
import { Clock, Pause, Play, Square } from "lucide-react";
import { formatDuration, parseDuration, type BareUnit, type DurationFormat } from "../../../shared/duration";
import { useUnitPreferences } from "../units";
import "../workspace.css";

/**
 * Durations (§E.3, D838): one input, one chip, one timer, all on shared/duration.ts and the person's
 * unit preferences (`1h 30m` or `1:30`; bare numbers as minutes or hours). Tabular figures, units
 * always shown.
 */

/** A duration field: type `1h30`, `90m`, `1.5h`, or `1:30`; it reads back what it understood. */
export function DurationInput({ label, value, onChange, placeholder = "1h 30m", required = false, disabled = false, bare, id, describedBy }: {
  label: string;
  /** Seconds, or null for empty. */
  value: number | null;
  onChange: (seconds: number | null) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** Overrides the person's preference for bare numbers. */
  bare?: BareUnit;
  id?: string;
  describedBy?: string;
}) {
  const prefs = useUnitPreferences();
  const unit = bare ?? prefs.bareDuration;
  const format = prefs.durationFormat;
  const autoId = useId();
  const inputId = id ?? `${autoId}-duration`;
  const hintId = `${inputId}-hint`;
  const [text, setText] = useState(() => value === null ? "" : formatDuration(value, format));
  const [error, setError] = useState<string | null>(null);
  const lastValue = useRef(value);
  // A value set from outside (another field, a reset) replaces the text; the person's own typing stays.
  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    setText(value === null ? "" : formatDuration(value, format));
    setError(null);
  }, [value, format]);

  const parsed = text.trim() ? parseDuration(text, { bare: unit }) : null;
  const commit = () => {
    if (!text.trim()) {
      setError(required ? "Enter a duration" : null);
      lastValue.current = null;
      onChange(null);
      return;
    }
    if (parsed === null) { setError(`Use 1h 30m, 90m, or 1:30${unit === "hours" ? " (a bare number is hours)" : ""}`); return; }
    setError(null);
    lastValue.current = parsed;
    setText(formatDuration(parsed, format));
    onChange(parsed);
  };
  const hint = error ?? (parsed !== null && text.trim() !== formatDuration(parsed, format) ? `= ${formatDuration(parsed, format)}` : null);
  return <div className="ui-field ui-duration-field">
    <label htmlFor={inputId}>{label}</label>
    <span className="ui-duration-input">
      <Clock aria-hidden="true" />
      <input id={inputId} type="text" inputMode="text" autoComplete="off" spellCheck={false} value={text} placeholder={placeholder} disabled={disabled} required={required}
        aria-invalid={error ? true : undefined} aria-describedby={[hint ? hintId : null, describedBy].filter(Boolean).join(" ") || undefined}
        onChange={(event) => { setText(event.target.value); if (error) setError(null); }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} />
    </span>
    {hint && <small id={hintId} className={error ? "ui-field-error" : "ui-field-hint ui-tabular"} role={error ? "alert" : undefined}>{hint}</small>}
  </div>;
}

/** "3h 20m" or "3h 20m of 5h" (a budget or an estimate); over the budget it turns red and says so. */
export function DurationChip({ seconds, of, format, title, label }: { seconds: number; of?: number | null; format?: DurationFormat; title?: string; /** The chip's accessible name prefix ("Logged"). */ label?: string }) {
  const prefs = useUnitPreferences();
  const shown = format ?? prefs.durationFormat;
  const over = of !== undefined && of !== null && seconds > of;
  const text = of !== undefined && of !== null ? `${formatDuration(seconds, shown)} of ${formatDuration(of, shown)}` : formatDuration(seconds, shown);
  const name = `${label ? `${label}: ` : ""}${text}${over ? ", over" : ""}`;
  return <span className={`ui-duration-chip ui-tabular${over ? " over" : ""}`} title={title ?? name} aria-label={name}><Clock aria-hidden="true" /><span aria-hidden="true">{text}</span></span>;
}

/** Seconds since `startedAt` (ISO) at `now`, never negative. */
export const elapsedSeconds = (startedAt: string, now: number) => Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));

/**
 * The timer chip (§E.3; Time fills it in, Wave 2): stopped it is a "Start timer" button; running it
 * shows what it tracks and the live elapsed time (`0:42:10`), with Stop (and Pause when given). It
 * ticks once a second only while running and visible. `shortcut` names the module's key (⌥T).
 */
export function TimerChip({ running, onStart, onStop, onPause, label = "Start timer", shortcut, compact = false, disabled = false }: {
  /** The running timer: when it started and what it tracks ("MYT-12 Ship it"). */
  running: { startedAt: string; label?: string } | null;
  onStart: () => void;
  onStop: () => void;
  onPause?: () => void;
  label?: string;
  shortcut?: string;
  /** Icon-sized (a card header action, the top bar on phones). */
  compact?: boolean;
  disabled?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => { if (document.visibilityState === "visible") setNow(Date.now()); }, 1000);
    return () => window.clearInterval(id);
  }, [running]);
  if (!running) return <button type="button" className={`ui-timer${compact ? " compact" : ""}`} onClick={onStart} disabled={disabled} aria-label={label} title={label} aria-keyshortcuts={shortcut}>
    <Play aria-hidden="true" />{!compact && <span>{label}</span>}
  </button>;
  const elapsed = formatDuration(elapsedSeconds(running.startedAt, now), "colon", { seconds: true });
  const what = running.label ? ` on ${running.label}` : "";
  return <span className={`ui-timer running${compact ? " compact" : ""}`} role="group" aria-label={`Timer running${what}`}>
    <span className="ui-timer-dot" aria-hidden="true" />
    {!compact && running.label && <span className="ui-timer-label" title={running.label}>{running.label}</span>}
    <time className="ui-timer-elapsed ui-tabular" aria-live="off">{elapsed}</time>
    {onPause && <button type="button" className="ui-timer-button" onClick={onPause} aria-label="Pause timer" title="Pause"><Pause aria-hidden="true" /></button>}
    <button type="button" className="ui-timer-button" onClick={onStop} aria-label={`Stop timer${what}`} title="Stop" aria-keyshortcuts={shortcut}><Square aria-hidden="true" /></button>
  </span>;
}
