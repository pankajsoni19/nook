import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CalendarClock, ClipboardList, Loader2, Plus, Trash2, Vote, X } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { ApiError } from "../api";
import { SelectField } from "./fields";
import { EmptyState } from "../ui/EmptyState";
import { FORM_TEMPLATE_LABELS, FORM_TEMPLATES, type FormDetail, type FormListItem, type FormTemplate, type ResultsVisibility } from "../../shared/forms";
import { busyTimes, createForm, createPoll, createTimePoll, getTargets, listForms, type BusyItem } from "./formsApi";
import { slotText, timeLabel } from "./PollViews";
import "./forms.css";

/**
 * Quick create (§D.1 UI "New ▾"): a poll in one sheet (question, options, single or multiple,
 * anonymous, results visibility, closing time), find a time (pick days and times with your busy
 * times beside them), and a form from a template. The editor's `/poll` and `/form` use the poll
 * sheet and a form picker.
 */

const ZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const errorText = (error: unknown) => error instanceof ApiError ? error.message : "Something went wrong. Try again.";

export function NewPollSheet({ onClose, onCreated, title = "New poll" }: { onClose: () => void; onCreated: (form: FormDetail) => void; title?: string }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [visibility, setVisibility] = useState<ResultsVisibility>("live");
  const [closes, setCloses] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filled = options.map((option) => option.trim()).filter(Boolean);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim() || filled.length < 2) { setError("Ask a question and give at least two options"); return; }
    setBusy(true);
    setError(null);
    try {
      const { form } = await createPoll({ question: question.trim(), options: filled, multiple, anonymous, resultsVisibility: visibility, closesAt: closes ? new Date(closes).toISOString() : null });
      onCreated(form);
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };
  return <ModalDialog title={title} eyebrow="Forms" onClose={onClose} variant="sheet" busy={busy} className="forms-sheet">
    <form className="file-dialog-form forms-sheet-body" onSubmit={submit}>
      <label className="ui-field"><span>Question</span><input autoFocus value={question} maxLength={200} onChange={(event) => setQuestion(event.target.value)} placeholder="Where should we go for lunch?" /></label>
      <fieldset className="forms-fieldset">
        <legend>Options</legend>
        <ol className="forms-option-list">{options.map((option, index) => <li key={index}>
          <input aria-label={`Option ${index + 1}`} value={option} maxLength={200} placeholder={`Option ${index + 1}`} onChange={(event) => setOptions(options.map((item, at) => at === index ? event.target.value : item))}
            onKeyDown={(event) => { if (event.key === "Enter" && index === options.length - 1 && option.trim() && options.length < 20) { event.preventDefault(); setOptions([...options, ""]); } }} />
          <button type="button" className="icon-button" aria-label={`Remove option ${index + 1}`} disabled={options.length <= 2} onClick={() => setOptions(options.filter((_, at) => at !== index))}><X /></button>
        </li>)}</ol>
        <button type="button" className="secondary-button ui-small-button" disabled={options.length >= 20} onClick={() => setOptions([...options, ""])}><Plus aria-hidden="true" />Add option</button>
      </fieldset>
      <div className="forms-switches">
        <label className="forms-check"><input type="checkbox" checked={multiple} onChange={(event) => setMultiple(event.target.checked)} />People can choose more than one</label>
        <label className="forms-check"><input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} />Anonymous votes</label>
      </div>
      <div className="forms-two">
        <SelectField label="Results" value={visibility} onChange={(value) => setVisibility(value as ResultsVisibility)} options={[
          { value: "live", label: "Everyone sees them live" }, { value: "after_vote", label: "After voting" }, { value: "after_close", label: "When the poll closes" }, { value: "owner_only", label: "Only me" }
        ]} />
        <label className="ui-field"><span>Closes (optional)</span><input type="datetime-local" value={closes} min={localInput(new Date())} onChange={(event) => setCloses(event.target.value)} /></label>
      </div>
      {error && <p className="ui-field-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? <Loader2 className="spin" aria-hidden="true" /> : <Vote aria-hidden="true" />}Create poll</button>
      </footer>
    </form>
  </ModalDialog>;
}

/** `/poll` in a note: the same sheet; its result is embedded where the slash was. */
export function SlashPollDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (form: FormDetail) => void }) {
  return <NewPollSheet onClose={onClose} onCreated={onCreated} title="Add a poll" />;
}

/** `/form` in a note: one of your forms, polls, or time polls. */
export function FormPickerDialog({ onClose, onPick }: { onClose: () => void; onPick: (form: FormListItem) => void }) {
  const [items, setItems] = useState<FormListItem[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { listForms({ tab: "all", q }, controller.signal).then((page) => setItems(page.items)).catch(() => setItems([])); }, 150);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [q]);
  return <ModalDialog title="Add a form" eyebrow="Forms" onClose={onClose} variant="sheet" className="forms-sheet">
    <div className="file-dialog-body forms-sheet-body">
      <label className="ui-field"><span>Search your forms</span><input autoFocus type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Title" /></label>
      {items === null ? <p className="ui-panel-loading">Loading…</p> : items.length === 0
        ? <EmptyState icon={ClipboardList} title="No forms found" compact>Create one in Forms first.</EmptyState>
        : <ul className="forms-pick-list">{items.map((item) => <li key={item.id}>
          <button type="button" onClick={() => onPick(item)}><KindIcon kind={item.kind} /><span>{item.title}</span><small>{item.kind === "poll" ? "Poll" : item.kind === "time_poll" ? "Find a time" : "Form"} · {item.status}</small></button>
        </li>)}</ul>}
    </div>
  </ModalDialog>;
}

export function KindIcon({ kind }: { kind: string }) {
  return kind === "poll" ? <Vote aria-hidden="true" /> : kind === "time_poll" ? <CalendarClock aria-hidden="true" /> : <ClipboardList aria-hidden="true" />;
}

// ---------------------------------------------------------------- find a time

type Slot = { start: string; end: string };
const addDays = (date: string, days: number) => { const value = new Date(`${date}T12:00:00`); value.setDate(value.getDate() + days); return localInput(value).slice(0, 10); };

export function NewTimePollSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (form: FormDetail) => void }) {
  const today = localInput(new Date()).slice(0, 10);
  const [title, setTitle] = useState("");
  const [day, setDay] = useState(addDays(today, 1));
  const [time, setTime] = useState("10:00");
  const [minutes, setMinutes] = useState(60);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [allowMaybe, setAllowMaybe] = useState(true);
  const [calendars, setCalendars] = useState<Array<{ id: string; name: string }>>([]);
  const [calendarId, setCalendarId] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyItem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getTargets().then((targets) => { setCalendars(targets.calendars); setCalendarId(targets.calendars[0]?.id ?? null); }).catch(() => undefined); }, []);
  useEffect(() => {
    setBusy(null);
    busyTimes(day, addDays(day, 1), ZONE).then((result) => setBusy(result.occurrences.filter((item) => !item.allDay ? item.start.slice(0, 10) <= day : true))).catch(() => setBusy([]));
  }, [day]);
  const add = () => {
    const start = new Date(`${day}T${time}:00`);
    if (Number.isNaN(start.getTime())) return;
    const slot = { start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString() };
    if (slots.some((item) => item.start === slot.start)) return;
    setSlots([...slots, slot].sort((a, b) => a.start.localeCompare(b.start)).slice(0, 60));
    // The next likely slot: the same time on the next day.
    setDay(addDays(day, 1));
  };
  const overlaps = (slot: Slot) => (busy ?? []).some((item) => !item.allDay && Date.parse(item.start) < Date.parse(slot.end) && Date.parse(item.end) > Date.parse(slot.start));
  const preview = useMemo(() => { const start = new Date(`${day}T${time}:00`); return Number.isNaN(start.getTime()) ? null : { start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString() }; }, [day, time, minutes]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!slots.length) { setError("Add at least one time"); return; }
    setSaving(true);
    setError(null);
    try {
      const { form } = await createTimePoll({ title: title.trim() || "Find a time", slots, allowMaybe, calendarId });
      onCreated(form);
    } catch (caught) { setError(errorText(caught)); setSaving(false); }
  };
  return <ModalDialog title="Find a time" eyebrow="Forms" onClose={onClose} variant="sheet" busy={saving} className="forms-sheet wide">
    <form className="file-dialog-form forms-sheet-body" onSubmit={submit}>
      <label className="ui-field"><span>What is it for?</span><input autoFocus value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="Quarterly planning" /></label>
      <fieldset className="forms-fieldset">
        <legend>Propose times <span className="forms-muted">({ZONE.replace(/_/g, " ")})</span></legend>
        <div className="forms-slot-adder">
          <label className="ui-field"><span>Day</span><input type="date" value={day} min={today} onChange={(event) => setDay(event.target.value)} /></label>
          <label className="ui-field"><span>Start</span><input type="time" value={time} step={900} onChange={(event) => setTime(event.target.value)} /></label>
          <SelectField label="Length" value={String(minutes)} onChange={(value) => setMinutes(Number(value))} options={[15, 30, 45, 60, 90, 120, 180, 240].map((value) => ({ value: String(value), label: value < 60 ? `${value} min` : `${value / 60} h` }))} />
          <button type="button" className="secondary-button forms-slot-add" onClick={add}><Plus aria-hidden="true" />Add time</button>
        </div>
        <div className="forms-busy" aria-live="polite">
          <strong>Your calendar that day</strong>
          {busy === null ? <span className="forms-muted">Loading…</span> : busy.length === 0 ? <span className="forms-muted">Free all day</span>
            : <ul>{busy.slice(0, 8).map((item) => <li key={`${item.eventId}:${item.start}`}><span className="ui-tabular">{item.allDay ? "All day" : `${timeLabel(item.start)}–${timeLabel(item.end)}`}</span> {item.title || "Busy"}</li>)}</ul>}
          {preview && overlaps(preview) && <span className="forms-warn">This time overlaps something on your calendar.</span>}
        </div>
        {slots.length === 0 ? <p className="forms-muted">No times yet. Add a few options for people to vote on.</p>
          : <ol className="forms-slot-chosen">{slots.map((slot) => <li key={slot.start}><span className="ui-tabular">{slotText(slot, ZONE)}</span>{overlaps(slot) && <span className="forms-warn">busy</span>}
            <button type="button" className="icon-button" aria-label={`Remove ${slotText(slot, ZONE)}`} onClick={() => setSlots(slots.filter((item) => item !== slot))}><Trash2 /></button></li>)}</ol>}
      </fieldset>
      <div className="forms-two">
        <label className="forms-check"><input type="checkbox" checked={allowMaybe} onChange={(event) => setAllowMaybe(event.target.checked)} />Allow “if need be”</label>
        {calendars.length > 0 && <SelectField label="Book it in" value={calendarId} onChange={(value) => setCalendarId(value)} options={calendars.map((calendar) => ({ value: calendar.id, label: calendar.name }))} />}
      </div>
      {error && <p className="ui-field-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="submit" className="primary-button" disabled={saving || !slots.length}>{saving ? <Loader2 className="spin" aria-hidden="true" /> : <CalendarClock aria-hidden="true" />}Create time poll{slots.length ? ` · ${slots.length}` : ""}</button>
      </footer>
    </form>
  </ModalDialog>;
}

// ---------------------------------------------------------------- form from a template

export function NewFormSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (form: FormDetail) => void }) {
  const [busy, setBusy] = useState<FormTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (template: FormTemplate) => {
    setBusy(template);
    setError(null);
    try {
      const { form } = await createForm({ kind: FORM_TEMPLATE_LABELS[template].kind, template });
      onCreated(form);
    } catch (caught) { setError(errorText(caught)); setBusy(null); }
  };
  return <ModalDialog title="New form" eyebrow="Forms" onClose={onClose} variant="sheet" busy={busy !== null} className="forms-sheet">
    <div className="file-dialog-body forms-sheet-body">
      <ul className="forms-templates">{FORM_TEMPLATES.map((template) => <li key={template}>
        <button type="button" onClick={() => { void pick(template); }} disabled={busy !== null}>
          <KindIcon kind={FORM_TEMPLATE_LABELS[template].kind} />
          <span><strong>{FORM_TEMPLATE_LABELS[template].label}</strong><small>{FORM_TEMPLATE_LABELS[template].description}</small></span>
          {busy === template && <Loader2 className="spin" aria-hidden="true" />}
        </button>
      </li>)}</ul>
      {error && <p className="ui-field-error" role="alert">{error}</p>}
    </div>
  </ModalDialog>;
}
