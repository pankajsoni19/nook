import type { ReactNode } from "react";
import { TONE_ICONS, type Tone } from "../tone";
import "../workspace.css";

/**
 * "How far along" (§E.3, D838): one visual for goals, key results, time budgets, the forms funnel,
 * and standup participation. Values are fractions (0–1, may exceed 1 for over budget); the text is
 * always shown with its unit ("62%", "3h 20m of 5h"), tabular, and the bar is a `progressbar` (a
 * `meter` reading when it is a measurement, not a task's progress).
 */

/** 0.624 → 62 (whole percent, never NaN; over 1 stays over 100). */
export function percentOf(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100);
}

const clampFill = (value: number) => Math.min(100, Math.max(0, percentOf(value)));

export function ProgressBar({ value, label, valueText, tone = "warn", target, thin = false, meter = false, children }: {
  /** 0–1; above 1 is shown full in the bad tone ("over"). */
  value: number;
  /** What it measures ("Grow MRR"); the bar's accessible name and, unless thin, its visible caption. */
  label: string;
  /** The text beside it: defaults to the percent ("62%"); "3h 20m of 5h" for a budget. */
  valueText?: string;
  tone?: Tone;
  /** An expected-by-now marker (0–1): where the goal should be today. */
  target?: number;
  thin?: boolean;
  /** A measurement (budget used) rather than progress toward done. */
  meter?: boolean;
  children?: ReactNode;
}) {
  const percent = percentOf(value);
  const text = valueText ?? `${percent}%`;
  const over = value > 1;
  return <div className={`ui-progress${thin ? " thin" : ""}${over ? " over" : ""}`} data-tone={tone}>
    {!thin && <div className="ui-progress-head"><strong>{label}</strong><span className="ui-progress-value">{text}</span></div>}
    <div className="ui-progress-track" role={meter ? "meter" : "progressbar"} aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(percent, 100)} aria-valuetext={over ? `${text}, over` : text}>
      <span className="ui-progress-fill" style={{ width: `${clampFill(value)}%` }} />
      {target !== undefined && Number.isFinite(target) && <span className="ui-progress-target" style={{ left: `calc(${clampFill(target)}% - 1px)` }} title={`Expected by now: ${percentOf(target)}%`} />}
    </div>
    {children}
  </div>;
}

export function ProgressRing({ value, label, size = 40, stroke = 4, tone = "warn", valueText, large = false }: {
  value: number;
  label: string;
  size?: number;
  stroke?: number;
  tone?: Tone;
  /** The center text; defaults to the percent. */
  valueText?: string;
  large?: boolean;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fill = clampFill(value) / 100;
  const text = valueText ?? `${percentOf(value)}%`;
  return <span className={`ui-ring${large ? " large" : ""}`} data-tone={value > 1 ? "bad" : tone} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(percentOf(value), 100)} aria-valuetext={text} style={{ width: size, height: size }}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="ui-ring-track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
      <circle className="ui-ring-fill" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - fill)} />
    </svg>
    <span className="ui-ring-label" aria-hidden="true">{text}</span>
  </span>;
}

/** A health or status chip: icon + words in its tone ("On track", "At risk", "Won"). Never color alone. */
export function HealthChip({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
  const Icon = TONE_ICONS[tone];
  return <span className="ui-health" data-tone={tone} title={title}><Icon aria-hidden="true" />{label}</span>;
}

/** The common health words for goals (§D.3); modules may pass their own labels. */
export const HEALTH_LABELS = { on_track: { tone: "good", label: "On track" }, at_risk: { tone: "warn", label: "At risk" }, off_track: { tone: "bad", label: "Off track" }, done: { tone: "info", label: "Done" }, none: { tone: "neutral", label: "No update" } } as const satisfies Record<string, { tone: Tone; label: string }>;
