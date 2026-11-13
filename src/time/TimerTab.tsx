import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, CircleDollarSign, Clock, KanbanSquare, Lock, PenLine, Play, Plus, Timer } from "lucide-react";
import { EmptyState } from "../ui/EmptyState";
import { DurationInput, TimerChip } from "../ui/time/Duration";
import { WorkRefChip } from "../ui/links/WorkLinks";
import { notify } from "../ui/notify";
import { useModuleShortcuts } from "../ui/moduleKeys";
import { useUnitPreferences } from "../ui/units";
import { formatDuration } from "../../shared/duration";
import { addDays, entryLabel, type TimeEntry } from "../../shared/time";
import { timeApi, type Suggestion } from "./api";
import { BillableSwitch, ProjectSelect, WorkItemField, projectDot, type PickedTarget } from "./fields";
import { EntrySheet, type EntryDraft } from "./EntrySheet";
import { clock, dayLabel, localDay } from "./format";
import { errorText, onTimeChanged, startTimer, stopTimer, timeChanged, useTimer } from "./timerStore";

/**
 * The Timer tab (§D.2 "Time home"): a Toggl-like bar to start the timer or log a block by typing a
 * duration, the day's calendar events and touched cards to log in one click (C13), and the last
 * weeks of entries grouped by day with day totals; each row continues (▶) or opens for editing.
 * Keys: `n` focuses the bar, `j`/`k` move between rows, Enter opens one.
 */

export function TimerTab({ onOpen, readOnly, focusEntry }: { onOpen: (href: string) => void; readOnly: boolean; focusEntry?: string | null }) {
  const timer = useTimer();
  const prefs = useUnitPreferences();
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ entry: TimeEntry | null; draft?: EntryDraft } | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const from = useMemo(() => addDays(localDay(), -27), []);

  const load = useCallback(() => {
    timeApi.entries({ from, limit: "200" }).then((body) => { setEntries(body.entries); setCursor(body.nextCursor); setError(null); }, (reason) => setError(errorText(reason, "Could not load your time")));
    timeApi.suggestions(localDay()).then((body) => setSuggestions(body.suggestions), () => setSuggestions([]));
  }, [from]);
  useEffect(() => { load(); return onTimeChanged(load); }, [load]);
  useEffect(() => {
    if (!focusEntry || !entries) return;
    const found = entries.find((entry) => entry.id === focusEntry);
    if (found) setEditing({ entry: found });
  }, [focusEntry, entries]);

  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const body = await timeApi.entries({ cursor, limit: "200" });
      setEntries((current) => [...(current ?? []), ...body.entries]);
      setCursor(body.nextCursor);
    } catch (reason) {
      notify.error(errorText(reason, "Could not load more"));
    } finally {
      setLoadingMore(false);
    }
  };

  const days = useMemo(() => {
    const groups = new Map<string, TimeEntry[]>();
    for (const entry of entries ?? []) {
      if (entry.running) continue;
      const day = localDay(entry.startedAt);
      groups.set(day, [...(groups.get(day) ?? []), entry]);
    }
    return [...groups.entries()];
  }, [entries]);
  const weekTotal = useMemo(() => {
    const start = addDays(localDay(), -6);
    return (entries ?? []).filter((entry) => localDay(entry.startedAt) >= start).reduce((sum, entry) => sum + entry.durationS, 0);
  }, [entries]);

  const rows = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-entry-row]") ?? [])];
  const move = (step: number) => {
    const list = rows();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + step))]!.focus();
  };
  useModuleShortcuts({ j: () => move(1), k: () => move(-1) }, editing === null);

  const logSuggestion = async (item: Suggestion) => {
    if (item.kind === "event" && item.start && item.seconds) {
      try {
        await timeApi.create({ startedAt: item.start, duration: item.seconds, description: item.title, target: item.ref, source: "calendar" });
        timeChanged();
        notify.success(`Logged ${formatDuration(item.seconds, prefs.durationFormat)} for ${item.title}`);
      } catch (reason) {
        notify.error(errorText(reason, "Could not log it"));
      }
      return;
    }
    setEditing({ entry: null, draft: { description: "", target: { kind: item.ref.kind, id: item.ref.id, summary: { kind: item.ref.kind, id: item.ref.id, title: item.title, href: item.href ?? "", icon: "square-check" } }, durationS: 1800 } });
  };

  return <div className="time-tab time-timer-tab">
    {!readOnly && <TimeBar running={timer.entry} busy={timer.busy} onOpen={onOpen} onEditRunning={() => timer.entry && setEditing({ entry: timer.entry })} />}
    {!readOnly && suggestions.length > 0 && <section className="time-suggestions" aria-labelledby="time-suggestions-title">
      <h2 id="time-suggestions-title">From your day</h2>
      <ul>
        {suggestions.slice(0, 8).map((item) => <li key={`${item.kind}:${item.ref.id}`}>
          <button type="button" className="time-suggestion" onClick={() => { void logSuggestion(item); }}>
            {item.kind === "event" ? <CalendarDays aria-hidden="true" /> : <KanbanSquare aria-hidden="true" />}
            <span><strong>{item.title}</strong><small>{item.kind === "event" && item.start && item.end ? `${clock(item.start)}–${clock(item.end)} · ${formatDuration(item.seconds ?? 0, prefs.durationFormat)}` : item.subtitle ?? "Card you worked on"}</small></span>
            <span className="time-suggestion-action">Log</span>
          </button>
        </li>)}
      </ul>
    </section>}
    {error && <p className="ui-field-error" role="alert">{error}</p>}
    {entries === null && !error && <p className="time-loading" role="status">Loading your time…</p>}
    {entries !== null && days.length === 0 && !timer.entry && <EmptyState icon={Timer} title="No time logged in the last four weeks." action={readOnly ? undefined : { label: "Log time", icon: Plus, onClick: () => setEditing({ entry: null }) }}>
      Start the timer above, or log a block by typing a duration such as 1h30.
    </EmptyState>}
    {days.length > 0 && <div className="time-days" ref={listRef}>
      <p className="time-week-total ui-tabular">Last 7 days: <strong>{formatDuration(weekTotal, prefs.durationFormat)}</strong></p>
      {days.map(([day, list]) => {
        const total = list.reduce((sum, entry) => sum + entry.durationS, 0);
        return <section key={day} className="time-day" aria-label={dayLabel(day)}>
          <header className="time-day-header"><h2>{dayLabel(day)}</h2><span className="ui-tabular">{formatDuration(total, prefs.durationFormat)}</span></header>
          <ul className="time-entries">
            {list.map((entry) => <EntryRow key={entry.id} entry={entry} readOnly={readOnly} onOpen={onOpen} onEdit={() => setEditing({ entry })} />)}
          </ul>
        </section>;
      })}
      {cursor && <button type="button" className="secondary-button time-more" onClick={() => { void more(); }} disabled={loadingMore}>{loadingMore ? "Loading…" : "Show older entries"}</button>}
    </div>}
    {editing && <EntrySheet entry={editing.entry} draft={editing.draft} onOpen={onOpen} onClose={() => setEditing(null)} />}
  </div>;
}

function EntryRow({ entry, readOnly, onOpen, onEdit }: { entry: TimeEntry; readOnly: boolean; onOpen: (href: string) => void; onEdit: () => void }) {
  const prefs = useUnitPreferences();
  const range = `${clock(entry.startedAt)}–${entry.endedAt ? clock(entry.endedAt) : "now"}`;
  const name = entryLabel(entry) || "No description";
  return <li className="time-entry">
    <button type="button" className="time-entry-main" data-entry-row onClick={onEdit} aria-label={`${name}, ${formatDuration(entry.durationS, prefs.durationFormat)}, ${range}${entry.project ? `, ${entry.project.name}` : ""}. Open`}>
      <span className="time-entry-text">
        <strong className={entry.description ? "" : "muted"}>{entry.description || "No description"}</strong>
        <span className="time-entry-meta">
          {entry.project && <span className="time-project-label">{projectDot(entry.project.color)}{entry.project.name}{entry.project.client && <em> · {entry.project.client}</em>}</span>}
          {entry.tags.map((tag) => <span key={tag} className="time-tag small">{tag}</span>)}
          {entry.user && <span className="time-entry-user sr-only">{entry.user.name}</span>}
        </span>
      </span>
    </button>
    {entry.target && <span className="time-entry-target"><WorkRefChip summary={entry.target} onOpen={onOpen} /></span>}
    <span className="time-entry-flags">
      {entry.billable && <CircleDollarSign className="time-billable-icon" aria-label="Billable" />}
      {entry.locked && <Lock className="time-locked-icon" aria-label="Approved and locked" />}
    </span>
    <span className="time-entry-range ui-tabular">{range}</span>
    <span className="time-entry-duration ui-tabular">{formatDuration(entry.durationS, prefs.durationFormat)}</span>
    {!readOnly && <button type="button" className="icon-button time-continue" title="Continue" aria-label={`Continue ${name}`}
      onClick={() => { void startTimer({ description: entry.description, projectId: entry.project?.id ?? null, target: entry.target && !("hidden" in entry.target) ? { kind: entry.target.kind, id: entry.target.id } : null, billable: entry.billable, tags: entry.tags }); }}>
      <Play />
    </button>}
  </li>;
}

/** The bar at the top: timer mode (description → Start) or manual mode (description + duration → Log). */
function TimeBar({ running, busy, onOpen, onEditRunning }: { running: TimeEntry | null; busy: boolean; onOpen: (href: string) => void; onEditRunning: () => void }) {
  const [mode, setMode] = useState<"timer" | "manual">("timer");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [billable, setBillable] = useState(false);
  const [target, setTarget] = useState<PickedTarget>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useModuleShortcuts({ n: () => { inputRef.current?.focus(); } });

  const reset = () => { setDescription(""); setTarget(null); setDuration(null); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (mode === "timer") {
      if (running) { await stopTimer(); return; }
      const started = await startTimer({ description, projectId, target: target ? { kind: target.kind, id: target.id } : null, billable });
      if (started) reset();
      return;
    }
    if (!duration) { notify.warning("Type how long, such as 1h30 or 45m"); return; }
    setSaving(true);
    try {
      await timeApi.create({ startedAt: new Date(Date.now() - duration * 1000).toISOString(), duration, description, projectId, target: target ? { kind: target.kind, id: target.id } : null, billable });
      timeChanged();
      notify.success(`Logged ${formatDuration(duration)}`);
      reset();
    } catch (reason) {
      notify.error(errorText(reason, "Could not log it"));
    } finally {
      setSaving(false);
    }
  };

  if (running && mode === "timer") {
    return <div className="time-bar running">
      <button type="button" className="time-bar-running-text" onClick={onEditRunning} aria-label="Edit the running timer">
        <strong>{entryLabel(running) || "No description"}</strong>
        {running.project && <small>{projectDot(running.project.color)}{running.project.name}</small>}
      </button>
      <TimerChip running={{ startedAt: running.startedAt }} onStart={() => undefined} onStop={() => { void stopTimer(); }} shortcut="Alt+T" disabled={busy} />
    </div>;
  }
  return <form className="time-bar" onSubmit={(event) => { void submit(event); }}>
    <div className="time-bar-row">
      <label className="time-bar-input">
        <span className="ui-visually-hidden">What are you working on?</span>
        <input ref={inputRef} value={description} maxLength={500} placeholder="What are you working on?" aria-keyshortcuts="n" onChange={(event) => setDescription(event.target.value)} />
      </label>
      {mode === "manual" && <div className="time-bar-duration" onKeyDown={(event) => { if (event.key === "Enter") { const form = event.currentTarget.closest("form"); window.setTimeout(() => form?.requestSubmit(), 0); } }}><DurationInput label="Duration" value={duration} onChange={setDuration} placeholder="1h 30m" /></div>}
      <button type="submit" className={`action-button time-bar-go${mode === "timer" ? " round" : ""}`} disabled={busy || saving} aria-label={mode === "timer" ? "Start timer" : "Log time"}>
        {mode === "timer" ? <Play aria-hidden="true" /> : <Plus aria-hidden="true" />}<span>{mode === "timer" ? "Start" : "Log"}</span>
      </button>
    </div>
    <div className="time-bar-row secondary">
      <ProjectSelect value={projectId} variant="chip" onChange={(id, project) => { setProjectId(id); setBillable(project?.billableDefault ?? false); }} />
      <WorkItemField value={target} onChange={setTarget} onOpen={onOpen} label="" />
      <BillableSwitch value={billable} onChange={setBillable} />
      <div className="ui-segmented time-mode" role="group" aria-label="Mode">
        <button type="button" aria-pressed={mode === "timer"} onClick={() => setMode("timer")}><Clock aria-hidden="true" />Timer</button>
        <button type="button" aria-pressed={mode === "manual"} onClick={() => setMode("manual")}><PenLine aria-hidden="true" />Manual</button>
      </div>
    </div>
  </form>;
}
