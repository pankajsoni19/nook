import { CalendarClock, Repeat } from "lucide-react";
import { relativeTime } from "../files/format";
import { FEED_DETAIL_WORDS, type AccessSummary, type FeedAccessRow, type RoutineAccessRow } from "./memberAccessApi";

/**
 * The calendar feed links and routines of the member access page and Settings → My access (v0.32),
 * one row each. On the admin page a feed has Revoke and an enabled routine has Pause (reductions
 * only, D268: an admin never resumes). On your own page you also Resume a paused routine, when your
 * role may write (viewers' routines stay paused, D152). The confirm and the request belong to the page.
 */
export function FeedsAndRoutines({ summary, mode, canResume = false, busy = false, onRevokeFeed, onPauseRoutine, onResumeRoutine }: {
  summary: Pick<AccessSummary, "feeds" | "routines">;
  mode: "admin" | "self";
  canResume?: boolean;
  busy?: boolean;
  onRevokeFeed: (row: FeedAccessRow) => void;
  onPauseRoutine: (row: RoutineAccessRow) => void;
  onResumeRoutine?: (row: RoutineAccessRow) => void;
}) {
  const feeds = summary.feeds.items ?? [];
  const routines = summary.routines.items ?? [];
  const whose = mode === "self" ? "your" : "their";
  return <>
    <h4 className="ma-subheading" id={`ma-feeds-${mode}`}>Calendar feed links</h4>
    {feeds.length === 0 ? <p className="team-muted">No live calendar feed links.</p> : <ul className="ma-key-list" aria-labelledby={`ma-feeds-${mode}`}>
      {feeds.map((feed) => <li key={feed.id} className="ma-key-row">
        <span className="team-row-copy">
          <span className="team-row-title"><CalendarClock aria-hidden="true" className="group-item-hidden" /><strong className={feed.calendar.titleHidden ? "ma-hidden-title" : undefined}>{feed.calendar.title}</strong></span>
          <span className="team-row-meta"><code>{feed.prefix}…</code><span>{FEED_DETAIL_WORDS[feed.detail]}</span><span>{feed.lastUsedAt ? `Fetched ${relativeTime(feed.lastUsedAt)}` : "Never fetched"}</span></span>
        </span>
        <button type="button" className="team-action danger" aria-haspopup="dialog" disabled={busy}
          aria-label={`Revoke the feed link ${feed.prefix}… for ${feed.calendar.title}`} onClick={() => onRevokeFeed(feed)}>Revoke</button>
      </li>)}
    </ul>}
    <h4 className="ma-subheading" id={`ma-routines-${mode}`}>Routines</h4>
    {routines.length === 0 ? <p className="team-muted">No routines.</p> : <ul className="ma-key-list" aria-labelledby={`ma-routines-${mode}`}>
      {routines.map((routine) => <li key={routine.id} className="ma-key-row">
        <span className="team-row-copy">
          <span className="team-row-title"><Repeat aria-hidden="true" className="group-item-hidden" /><strong>{routine.name}</strong>
            {!routine.enabled && <span className="team-status-chip">Paused</span>}</span>
          <span className="team-row-meta"><span>{routine.schedule}</span>{routine.keyName && <span>Key “{routine.keyName}”</span>}<span>{routine.lastRunAt ? `Ran ${relativeTime(routine.lastRunAt)}` : "Never ran"}</span></span>
        </span>
        {routine.enabled
          ? <button type="button" className="team-action" aria-haspopup={mode === "admin" ? "dialog" : undefined} disabled={busy || (mode === "self" && !canResume)} aria-label={`Pause the routine ${routine.name}`} onClick={() => onPauseRoutine(routine)}>Pause</button>
          : mode === "self" && onResumeRoutine
            ? <button type="button" className="team-action" disabled={busy || !canResume} title={canResume ? undefined : "Your team role is read-only"} aria-label={`Resume the routine ${routine.name}`} onClick={() => onResumeRoutine(routine)}>Resume</button>
            : null}
      </li>)}
    </ul>}
    {mode === "admin" && routines.some((routine) => !routine.enabled) && <p className="team-muted">Only the owner can resume {whose} routines.</p>}
  </>;
}
