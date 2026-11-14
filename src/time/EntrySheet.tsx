import { useId, useMemo, useState } from "react";
import { Copy, Lock, Play, Scissors, Trash2 } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { DurationInput } from "../ui/time/Duration";
import { notify } from "../ui/notify";
import { MoneyText } from "../ui/money/Money";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { TimeEntry } from "../../shared/time";
import { timeApi } from "./api";
import { BillableSwitch, ProjectSelect, TagsField, WorkItemField, type PickedTarget } from "./fields";
import { clock, instantOf, localDay } from "./format";
import { errorText, setRunning, startTimer, timeChanged } from "./timerStore";

/**
 * Create or edit one entry (§E.4 "Sheets for quick create/edit"): description, project, work item,
 * day, start and end (or a typed duration: `1h30`, `90m`, `1:30`), billable, tags. An existing entry
 * also offers Continue (start the timer with the same fields), Duplicate, Split, and Delete (with
 * Undo). A running timer edits its description, project, item, tags, and start only.
 */

export type EntryDraft = Partial<Pick<TimeEntry, "description" | "billable" | "tags">> & {
  project?: { id: string; name: string; color?: string } | null;
  target?: PickedTarget;
  startedAt?: string;
  durationS?: number;
};

const targetOf = (entry: TimeEntry | null | undefined): PickedTarget => entry?.target && !("hidden" in entry.target) ? { kind: entry.target.kind, id: entry.target.id, summary: entry.target } : null;

export function EntrySheet({ entry, draft, onClose, onOpen }: { entry: TimeEntry | null; draft?: EntryDraft; onClose: () => void; onOpen?: (href: string) => void }) {
  const running = entry?.running === true;
  const start = entry?.startedAt ?? draft?.startedAt ?? new Date(Date.now() - (draft?.durationS ?? 3600) * 1000).toISOString();
  const [description, setDescription] = useState(entry?.description ?? draft?.description ?? "");
  const [projectId, setProjectId] = useState<string | null>(entry?.project?.id ?? draft?.project?.id ?? null);
  const [target, setTargetState] = useState<PickedTarget>(entry ? targetOf(entry) : draft?.target ?? null);
  // An existing entry sends its work item only once the person changes it: a target they cannot open
  // shows as empty here, and sending that empty value would unlink the entry from it (TG1, D1140).
  const [targetTouched, setTargetTouched] = useState(entry === null);
  const setTarget = (next: PickedTarget) => { setTargetState(next); setTargetTouched(true); };
  const [billable, setBillable] = useState(entry?.billable ?? draft?.billable ?? false);
  const [billableTouched, setBillableTouched] = useState(entry !== null || draft?.billable !== undefined);
  const [tags, setTags] = useState<string[]>(entry?.tags ?? draft?.tags ?? []);
  const [day, setDay] = useState(localDay(start));
  const [startText, setStartText] = useState(clock(start));
  const [duration, setDuration] = useState<number | null>(entry ? entry.durationS : draft?.durationS ?? 3600);
  const [endText, setEndText] = useState(() => clock(Date.parse(start) + (entry ? entry.durationS : draft?.durationS ?? 3600) * 1000));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [splitAt, setSplitAt] = useState<string | null>(null);
  const formId = useId();
  const readOnly = entry !== null && !entry.canEdit;
  const dirty = useMemo(() => !entry || description !== entry.description || projectId !== (entry.project?.id ?? null) || billable !== entry.billable || tags.join() !== entry.tags.join()
    || (target?.id ?? null) !== (targetOf(entry)?.id ?? null) || startText !== clock(entry.startedAt) || day !== localDay(entry.startedAt) || (!running && duration !== entry.durationS), [entry, description, projectId, billable, tags, target, startText, day, duration, running]);
  useHistoryDialogGuard(true, onClose, { blocked: busy });

  const startMs = instantOf(day, startText);
  const syncEnd = (seconds: number | null) => { if (seconds !== null && startMs !== null) setEndText(clock(startMs + seconds * 1000)); };
  const fromEnd = (text: string) => {
    setEndText(text);
    if (startMs === null) return;
    let endMs = instantOf(day, text);
    if (endMs === null) return;
    if (endMs < startMs) endMs += 86_400_000;
    setDuration(Math.round((endMs - startMs) / 1000));
  };

  const save = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (startMs === null) { setError("Write the day as YYYY-MM-DD and the start as HH:MM"); return; }
    if (!running && (duration === null || duration <= 0)) { setError("Enter a duration, such as 1h 30m"); return; }
    setBusy(true);
    setError(null);
    try {
      // The start goes only when the day or start changed: the fields hold minutes, so resending them
      // would drop an entry's seconds on every save (TG8, D1141).
      const startChanged = !entry || day !== localDay(entry.startedAt) || startText !== clock(entry.startedAt);
      const body = {
        description, projectId, tags,
        ...(targetTouched ? { target: target ? { kind: target.kind, id: target.id } : null } : {}),
        ...(billableTouched ? { billable } : {}),
        ...(startChanged ? { startedAt: new Date(startMs).toISOString() } : {}),
        ...(running ? {} : { duration: duration! })
      };
      if (entry) {
        const result = await timeApi.update(entry.id, { ...body, expectedRevision: entry.revision } as never);
        if (result.entry.running) setRunning(result.entry);
        notify.success("Entry saved");
      } else {
        await timeApi.create({ ...body, startedAt: new Date(startMs).toISOString(), duration: duration!, source: "manual" });
        notify.success("Time logged");
      }
      timeChanged();
      onClose();
    } catch (reason) {
      setError(errorText(reason, "Could not save the entry"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      const { undoTicket } = await timeApi.remove(entry.id);
      if (entry.running) setRunning(null);
      timeChanged();
      onClose();
      notify.success("Entry deleted", { action: { label: "Undo", onClick: () => { void timeApi.undo(undoTicket).then(() => { timeChanged(); notify.success("Entry restored"); }, (reason) => notify.error(errorText(reason, "Could not restore it"))); } } });
    } catch (reason) {
      setError(errorText(reason, "Could not delete the entry"));
      setBusy(false);
    }
  };

  const duplicate = async () => {
    if (!entry || startMs === null) return;
    setBusy(true);
    try {
      await timeApi.create({ startedAt: new Date(startMs + entry.durationS * 1000).toISOString(), duration: entry.durationS, description: entry.description, projectId: entry.project?.id ?? null, target: target ? { kind: target.kind, id: target.id } : null, billable: entry.billable, tags: entry.tags });
      timeChanged();
      notify.success("Entry duplicated after this one");
      onClose();
    } catch (reason) {
      setError(errorText(reason, "Could not duplicate it"));
      setBusy(false);
    }
  };

  const split = async () => {
    if (!entry || splitAt === null) return;
    const at = instantOf(day, splitAt);
    if (at === null) { setError("Split at a time as HH:MM"); return; }
    setBusy(true);
    try {
      await timeApi.split(entry.id, new Date(at).toISOString());
      timeChanged();
      notify.success("Entry split in two");
      onClose();
    } catch (reason) {
      setError(errorText(reason, "Could not split it"));
      setBusy(false);
    }
  };

  const title = entry ? (running ? "Running timer" : readOnly ? "Time entry" : "Edit time entry") : "Log time";
  return <ModalDialog title={title} onClose={onClose} variant="sheet" busy={busy} className="time-sheet">
    <form noValidate id={formId} className="time-sheet-body" onSubmit={(event) => { void save(event); }}>
      {entry?.locked && <p className="time-note" role="note"><Lock aria-hidden="true" />This week is approved and locked{entry.canEdit ? "; you can still change it as a project manager." : "."}</p>}
      {entry && entry.user && !entry.canEdit && <p className="time-note" role="note">Logged by {entry.user.name}.</p>}
      <div className="ui-field">
        <label htmlFor={`${formId}-description`}>What did you work on?</label>
        <input id={`${formId}-description`} value={description} maxLength={500} autoFocus={!entry} disabled={readOnly} placeholder="Description" onChange={(event) => setDescription(event.target.value)} />
      </div>
      <div className="time-sheet-grid">
        <ProjectSelect value={projectId} current={entry?.project ?? draft?.project ?? null} onChange={(id, project) => { setProjectId(id); if (!billableTouched) setBillable(project?.billableDefault ?? false); }} />
        <WorkItemField value={target} onChange={setTarget} onOpen={onOpen} />
      </div>
      <div className="time-sheet-times">
        <div className="ui-field">
          <label htmlFor={`${formId}-day`}>Day</label>
          <input id={`${formId}-day`} value={day} inputMode="numeric" placeholder="YYYY-MM-DD" disabled={readOnly} onChange={(event) => setDay(event.target.value)} />
        </div>
        <div className="ui-field">
          <label htmlFor={`${formId}-start`}>Start</label>
          <input id={`${formId}-start`} value={startText} inputMode="numeric" placeholder="09:00" disabled={readOnly} onChange={(event) => setStartText(event.target.value)} onBlur={() => syncEnd(duration)} />
        </div>
        {!running && <div className="ui-field">
          <label htmlFor={`${formId}-end`}>End</label>
          <input id={`${formId}-end`} value={endText} inputMode="numeric" placeholder="10:30" disabled={readOnly} onChange={(event) => fromEnd(event.target.value)} />
        </div>}
        {!running && <DurationInput label="Duration" value={duration} disabled={readOnly} onChange={(seconds) => { setDuration(seconds); syncEnd(seconds); }} />}
      </div>
      <div className="time-sheet-row">
        <BillableSwitch value={billable} disabled={readOnly} onChange={(value) => { setBillable(value); setBillableTouched(true); }} />
        {entry?.amountMinor !== null && entry?.amountMinor !== undefined && entry.currency && <span className="time-amount"><MoneyText money={{ amount: entry.amountMinor, currency: entry.currency }} /></span>}
      </div>
      {!readOnly && <TagsField value={tags} onChange={setTags} />}
      {readOnly && tags.length > 0 && <p className="time-note">Tags: {tags.join(", ")}</p>}
      {splitAt !== null && <div className="time-split ui-field">
        <label htmlFor={`${formId}-split`}>Split at</label>
        <div className="time-sheet-row">
          <input id={`${formId}-split`} value={splitAt} placeholder="HH:MM" onChange={(event) => setSplitAt(event.target.value)} />
          <button type="button" className="secondary-button ui-small-action" onClick={() => { void split(); }}>Split here</button>
        </div>
      </div>}
      {error && <p className="ui-field-error" role="alert">{error}</p>}
    </form>
    <footer className="time-sheet-footer">
      {entry && entry.canEdit && <button type="button" className="icon-button danger" onClick={() => { void remove(); }} disabled={busy} aria-label={running ? "Discard timer" : "Delete entry"} title={running ? "Discard timer" : "Delete entry"}><Trash2 /></button>}
      {entry && !running && <button type="button" className="icon-button" onClick={() => { void startTimer({ description: entry.description, projectId: entry.project?.id ?? null, target: target ? { kind: target.kind, id: target.id } : null, billable: entry.billable, tags: entry.tags }).then((started) => { if (started) onClose(); }); }} aria-label="Continue: start the timer with these details" title="Continue"><Play /></button>}
      {entry && !running && entry.canEdit && <button type="button" className="icon-button" onClick={() => { void duplicate(); }} aria-label="Duplicate entry" title="Duplicate"><Copy /></button>}
      {entry && !running && entry.canEdit && <button type="button" className="icon-button" onClick={() => setSplitAt(splitAt === null ? clock(Date.parse(entry.startedAt) + entry.durationS * 500) : null)} aria-label="Split entry" title="Split" aria-pressed={splitAt !== null}><Scissors /></button>}
      <span className="time-sheet-spacer" />
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{readOnly ? "Close" : "Cancel"}</button>
      {!readOnly && <button type="submit" form={formId} className="action-button" disabled={busy || (entry !== null && !dirty)}>{entry ? "Save" : "Log time"}</button>}
    </footer>
  </ModalDialog>;
}
