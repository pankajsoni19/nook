import { Play } from "lucide-react";
import { TimerChip } from "../ui/time/Duration";
import { useUnitPreferences } from "../ui/units";
import { formatDuration } from "../../shared/duration";
import { entryLabel } from "../../shared/time";
import type { TodaySectionRenderProps } from "../today/todaySections";
import { startTimer, stopTimer, useTimer } from "./timerStore";
import "./time.css";

/**
 * Today's Time section (§B.11 `timeToday`, D836): today's total, the running timer with Stop, or
 * "Nothing logged yet" with Start. It reads the shared timer store, so it stays live.
 */
export function TodayTimeSection(_props: TodaySectionRenderProps) {
  const prefs = useUnitPreferences();
  const { entry, todaySeconds, busy } = useTimer();
  return <div className="time-today">
    <p className="time-today-total ui-tabular">{todaySeconds > 0 ? <>Today: <strong>{formatDuration(todaySeconds, prefs.durationFormat)}</strong></> : "Nothing logged yet today."}</p>
    {entry
      ? <span className="time-today-running"><span className="time-today-label">{entryLabel(entry) || "No description"}</span><TimerChip running={{ startedAt: entry.startedAt }} onStart={() => undefined} onStop={() => { void stopTimer(); }} disabled={busy} /></span>
      : <button type="button" className="secondary-button ui-small-button" onClick={() => { void startTimer({}); }} disabled={busy}><Play aria-hidden="true" />Start timer</button>}
  </div>;
}
