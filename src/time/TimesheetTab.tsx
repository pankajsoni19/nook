import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CopyPlus, Lock, Plus, Send, Sheet } from "lucide-react";
import { EmptyState } from "../ui/EmptyState";
import { WorkRefChip } from "../ui/links/WorkLinks";
import { notify } from "../ui/notify";
import { useUnitPreferences } from "../ui/units";
import { formatDuration, parseDuration } from "../../shared/duration";
import { addDays, type ProjectColor, type Timesheet, type TimesheetRow } from "../../shared/time";
import { timeApi } from "./api";
import { ProjectSelect, WorkItemField, projectDot, type PickedTarget } from "./fields";
import { localDay, shortDay, weekdayName } from "./format";
import { errorText, onTimeChanged, timeChanged } from "./timerStore";

/**
 * The week timesheet (§D.2): rows are project × work item, columns are days. Type `1:30`, `90m`, or
 * `1h30` in a cell; Enter or leaving the cell saves it (the cell's own timesheet entry absorbs the
 * difference), arrows move between cells, Escape puts the value back. Locked days (an approved
 * week) are read-only. Each project's week can be submitted for approval. On phones it is a strip of
 * the week's days and a list of rows for the chosen day ("two rows, nothing hidden", §E.1.5).
 */

const rowTarget = (row: TimesheetRow) => row.target ? { kind: row.target.kind, id: row.target.id } : null;

export function TimesheetTab({ week, onWeek, onOpen, readOnly }: { week: string | null; onWeek: (week: string | null) => void; onOpen: (href: string) => void; readOnly: boolean }) {
  const prefs = useUnitPreferences();
  const [sheet, setSheet] = useState<Timesheet | null>(null);
  const [extra, setExtra] = useState<TimesheetRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [day, setDay] = useState(() => localDay());
  const [carry, setCarry] = useState(false);

  const load = useCallback(() => {
    timeApi.timesheet(week, carry).then((body) => { setSheet(body); setError(null); }, (reason) => setError(errorText(reason, "Could not load the timesheet")));
  }, [week, carry]);
  useEffect(() => { load(); return onTimeChanged(load); }, [load]);
  useEffect(() => { setExtra([]); setCarry(false); }, [week]);
  useEffect(() => { if (sheet && !sheet.days.includes(day)) setDay(sheet.days.includes(localDay()) ? localDay() : sheet.days[0]!); }, [sheet, day]);

  const rows = useMemo(() => {
    if (!sheet) return [];
    const keys = new Set(sheet.rows.map((row) => row.key));
    return [...sheet.rows, ...extra.filter((row) => !keys.has(row.key))];
  }, [sheet, extra]);

  const save = async (row: TimesheetRow, dayIndex: number, seconds: number | null) => {
    if (!sheet) return false;
    try {
      const result = await timeApi.setCell({ day: sheet.days[dayIndex]!, projectId: row.project?.id ?? null, target: rowTarget(row), duration: seconds });
      setSheet(result.timesheet);
      timeChanged();
      if (result.undoTicket) {
        const ticket = result.undoTicket;
        notify.success("Day cleared", { action: { label: "Undo", onClick: () => { void timeApi.undo(ticket).then(() => timeChanged(), (reason) => notify.error(errorText(reason, "Could not undo"))); } } });
      }
      return true;
    } catch (reason) {
      notify.warning(errorText(reason, "Could not save that cell"));
      return false;
    }
  };

  const submitWeek = async (projectId: string, name: string) => {
    if (!sheet) return;
    try {
      await timeApi.submitWeek(projectId, sheet.weekStart);
      notify.success(`Week submitted for approval on ${name}`);
      load();
    } catch (reason) {
      notify.error(errorText(reason, "Could not submit the week"));
    }
  };

  if (error) return <p className="ui-field-error" role="alert">{error}</p>;
  if (!sheet) return <p className="time-loading" role="status">Loading the timesheet…</p>;
  const thisWeek = sheet.days.includes(localDay());
  const weekTotal = sheet.totals.reduce((sum, value) => sum + value, 0);
  const projects = [...new Map(rows.filter((row) => row.project).map((row) => [row.project!.id, row.project!])).values()];
  const status = (projectId: string) => sheet.approvals.find((approval) => approval.projectId === projectId)?.status ?? null;

  return <div className="time-tab time-sheet-tab">
    <div className="time-week-nav">
      <div className="time-week-buttons">
        <button type="button" className="icon-button" aria-label="Previous week" onClick={() => onWeek(addDays(sheet.weekStart, -7))}><ChevronLeft /></button>
        <h2 className="time-week-title">{shortDay(sheet.days[0]!)} – {shortDay(sheet.days[6]!)}</h2>
        <button type="button" className="icon-button" aria-label="Next week" onClick={() => onWeek(addDays(sheet.weekStart, 7))}><ChevronRight /></button>
        {!thisWeek && <button type="button" className="ui-text-button" onClick={() => onWeek(null)}>This week</button>}
      </div>
      <p className="time-week-sum ui-tabular">Week total <strong>{formatDuration(weekTotal, prefs.durationFormat)}</strong></p>
      {!readOnly && <div className="time-week-actions">
        <button type="button" className="secondary-button ui-small-button" onClick={() => setAdding(true)}><Plus aria-hidden="true" />Add row</button>
        <button type="button" className="secondary-button ui-small-button" onClick={() => setCarry(true)} disabled={carry}><CopyPlus aria-hidden="true" />Copy last week</button>
      </div>}
    </div>
    {adding && <AddRow onClose={() => setAdding(false)} onOpen={onOpen} onAdd={(projectId, project, target) => {
      const key = `${projectId ?? ""}|${target ? `${target.kind}:${target.id}` : ""}`;
      setExtra((current) => [...current, { key, project: project ? { id: project.id, name: project.name, color: project.color } : null, target: target?.summary ?? null, days: [0, 0, 0, 0, 0, 0, 0], locked: [false, false, false, false, false, false, false] }]);
      setAdding(false);
    }} />}
    {rows.length === 0
      ? <EmptyState icon={Sheet} title="Nothing logged this week." action={readOnly ? undefined : { label: "Add row", icon: Plus, onClick: () => setAdding(true) }}>Add a row for a project or card, then type hours into the days.</EmptyState>
      : <>
        <WeekGrid sheet={sheet} rows={rows} readOnly={readOnly} onSave={save} onOpen={onOpen} />
        <DayList sheet={sheet} rows={rows} day={day} onDay={setDay} readOnly={readOnly} onSave={save} onOpen={onOpen} />
      </>}
    {projects.length > 0 && !readOnly && <section className="time-approvals-strip" aria-labelledby="time-approval-title">
      <h3 id="time-approval-title">Approval</h3>
      <ul>
        {projects.map((project) => {
          const current = status(project.id);
          return <li key={project.id}>
            <span className="time-project-label">{projectDot(project.color)}{project.name}</span>
            {current === "approved" ? <span className="ui-health" data-tone="success"><Lock aria-hidden="true" />Approved, locked</span>
              : current === "submitted" ? <span className="ui-health" data-tone="info">Waiting for approval</span>
              : <button type="button" className="secondary-button ui-small-button" onClick={() => { void submitWeek(project.id, project.name); }}><Send aria-hidden="true" />{current === "rejected" ? "Submit again" : "Submit week"}</button>}
          </li>;
        })}
      </ul>
    </section>}
  </div>;
}

type SaveCell = (row: TimesheetRow, dayIndex: number, seconds: number | null) => Promise<boolean>;

function RowLabel({ row, onOpen }: { row: TimesheetRow; onOpen: (href: string) => void }) {
  return <span className="time-row-label">
    {row.project ? <span className="time-project-label">{projectDot(row.project.color)}{row.project.name}</span> : <span className="time-project-label muted">No project</span>}
    {row.target && <WorkRefChip summary={row.target} onOpen={onOpen} />}
  </span>;
}

function CellInput({ seconds, locked, readOnly, label, onSave, onMove, cellId }: { seconds: number; locked: boolean; readOnly: boolean; label: string; onSave: (value: number | null) => Promise<boolean>; onMove: (rowStep: number, dayStep: number) => void; cellId: string }) {
  const prefs = useUnitPreferences();
  const shown = seconds ? formatDuration(seconds, prefs.durationFormat) : "";
  const [text, setText] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  const saving = useRef(false);
  useEffect(() => { setText(shown); setInvalid(false); }, [shown]);
  const commit = async () => {
    if (saving.current || text === shown) return true;
    const value = text.trim() ? parseDuration(text, { bare: prefs.bareDuration }) : 0;
    if (value === null || value > 86_400) { setInvalid(true); notify.warning("Use 1h 30m, 90m, or 1:30 (at most 24 hours)"); return false; }
    if (value === seconds) { setText(shown); return true; }
    saving.current = true;
    const ok = await onSave(value === 0 ? null : value);
    saving.current = false;
    if (!ok) setText(shown);
    return ok;
  };
  return <input id={cellId} className={`time-cell${invalid ? " invalid" : ""}${seconds ? " filled" : ""}`} value={text} disabled={locked || readOnly} inputMode="text" autoComplete="off" spellCheck={false}
    aria-label={`${label}${locked ? ", locked" : ""}`} aria-invalid={invalid || undefined} placeholder={locked || readOnly ? "" : "0:00"}
    onChange={(event) => { setText(event.target.value); setInvalid(false); }}
    onFocus={(event) => event.currentTarget.select()}
    onBlur={() => { void commit(); }}
    onKeyDown={(event) => {
      const atStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
      const atEnd = event.currentTarget.selectionStart === text.length;
      if (event.key === "Enter") { event.preventDefault(); void commit().then((ok) => { if (ok) onMove(event.shiftKey ? -1 : 1, 0); }); }
      else if (event.key === "Escape") { event.preventDefault(); setText(shown); setInvalid(false); }
      else if (event.key === "ArrowDown") { event.preventDefault(); onMove(1, 0); }
      else if (event.key === "ArrowUp") { event.preventDefault(); onMove(-1, 0); }
      else if (event.key === "ArrowLeft" && (atStart || event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === text.length)) { event.preventDefault(); onMove(0, -1); }
      else if (event.key === "ArrowRight" && (atEnd || event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === text.length)) { event.preventDefault(); onMove(0, 1); }
    }} />;
}

function WeekGrid({ sheet, rows, readOnly, onSave, onOpen }: { sheet: Timesheet; rows: TimesheetRow[]; readOnly: boolean; onSave: SaveCell; onOpen: (href: string) => void }) {
  const prefs = useUnitPreferences();
  const today = localDay();
  const totals = sheet.days.map((_, index) => rows.reduce((sum, row) => sum + row.days[index]!, 0));
  const focusCell = (row: number, day: number) => {
    const target = document.getElementById(`time-cell-${Math.max(0, Math.min(rows.length - 1, row))}-${Math.max(0, Math.min(6, day))}`) as HTMLInputElement | null;
    target?.focus();
  };
  return <div className="time-grid-wrap">
    <table className="time-grid">
      <caption className="ui-visually-hidden">Timesheet for the week of {sheet.weekStart}</caption>
      <thead><tr>
        <th scope="col" className="time-grid-label">Project and work item</th>
        {sheet.days.map((value) => <th key={value} scope="col" className={value === today ? "today" : ""}><span>{weekdayName(value)}</span><small>{Number(value.slice(8))}</small></th>)}
        <th scope="col" className="time-grid-total">Total</th>
      </tr></thead>
      <tbody>
        {rows.map((row, rowIndex) => <tr key={row.key}>
          <th scope="row" className="time-grid-label"><RowLabel row={row} onOpen={onOpen} /></th>
          {sheet.days.map((value, dayIndex) => <td key={value} className={value === today ? "today" : ""}>
            <CellInput cellId={`time-cell-${rowIndex}-${dayIndex}`} seconds={row.days[dayIndex]!} locked={row.locked[dayIndex]!} readOnly={readOnly}
              label={`${row.project?.name ?? "No project"}${row.target ? `, ${row.target.title}` : ""}, ${weekdayName(value)} ${value}`}
              onSave={(seconds) => onSave(row, dayIndex, seconds)} onMove={(dr, dd) => focusCell(rowIndex + dr, dayIndex + dd)} />
          </td>)}
          <td className="time-grid-total ui-tabular">{formatDuration(row.days.reduce((sum, value) => sum + value, 0), prefs.durationFormat)}</td>
        </tr>)}
      </tbody>
      <tfoot><tr>
        <th scope="row" className="time-grid-label">Total</th>
        {totals.map((value, index) => <td key={sheet.days[index]} className="ui-tabular">{value ? formatDuration(value, prefs.durationFormat) : "—"}</td>)}
        <td className="time-grid-total ui-tabular"><strong>{formatDuration(totals.reduce((sum, value) => sum + value, 0), prefs.durationFormat)}</strong></td>
      </tr></tfoot>
    </table>
  </div>;
}

function DayList({ sheet, rows, day, onDay, readOnly, onSave, onOpen }: { sheet: Timesheet; rows: TimesheetRow[]; day: string; onDay: (day: string) => void; readOnly: boolean; onSave: SaveCell; onOpen: (href: string) => void }) {
  const prefs = useUnitPreferences();
  const index = Math.max(0, sheet.days.indexOf(day));
  return <div className="time-daylist">
    <div className="time-daystrip" role="tablist" aria-label="Days of the week">
      {sheet.days.map((value, dayIndex) => {
        const total = rows.reduce((sum, row) => sum + row.days[dayIndex]!, 0);
        return <button key={value} type="button" role="tab" aria-selected={value === day} className={value === localDay() ? "today" : ""} onClick={() => onDay(value)}>
          <span>{weekdayName(value)}</span><small className="ui-tabular">{total ? formatDuration(total, prefs.durationFormat) : "—"}</small>
        </button>;
      })}
    </div>
    <ul className="time-daylist-rows" role="tabpanel" aria-label={day}>
      {rows.map((row, rowIndex) => <li key={row.key}>
        <RowLabel row={row} onOpen={onOpen} />
        <CellInput cellId={`time-daycell-${rowIndex}`} seconds={row.days[index]!} locked={row.locked[index]!} readOnly={readOnly} label={`${row.project?.name ?? "No project"}${row.target ? `, ${row.target.title}` : ""}, ${day}`}
          onSave={(seconds) => onSave(row, index, seconds)} onMove={(dr) => (document.getElementById(`time-daycell-${rowIndex + dr}`) as HTMLInputElement | null)?.focus()} />
      </li>)}
    </ul>
  </div>;
}

type RowProject = { id: string; name: string; color: ProjectColor };

function AddRow({ onClose, onAdd, onOpen }: { onClose: () => void; onAdd: (projectId: string | null, project: RowProject | null, target: PickedTarget) => void; onOpen: (href: string) => void }) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<RowProject | null>(null);
  const [target, setTarget] = useState<PickedTarget>(null);
  return <div className="time-addrow" role="group" aria-label="Add a timesheet row">
    <ProjectSelect value={projectId} onChange={(id, chosen) => { setProjectId(id); setProject(chosen ? { id: chosen.id, name: chosen.name, color: chosen.color } : null); }} />
    <WorkItemField value={target} onChange={setTarget} onOpen={onOpen} />
    <div className="time-addrow-actions">
      <button type="button" className="secondary-button ui-small-action" onClick={onClose}>Cancel</button>
      <button type="button" className="action-button ui-small-action" onClick={() => onAdd(projectId, project, target)}>Add row</button>
    </div>
  </div>;
}
