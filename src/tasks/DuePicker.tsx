import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CalendarDays, Clock, X } from "lucide-react";
import { DropdownSurface, useOutsideClose, useSheet, type Presentation } from "../ui/Listbox";
import { committableDueDate, committableDueTime, dueStatus, dueTimeNote, instantParts, localDateString, viewerTimeZone } from "./taskActions";
import type { CardChange } from "./tasksApi";

// The card's Due field (operator QA 0.9.1): a trigger that shows the value and opens a popover
// (desktop) or a bottom sheet (≤ 760 px) with the date, an optional time, quick picks, and explicit
// Apply and Cancel. Nothing saves until Apply, which sends one change (one PATCH with the revision);
// Cancel, Escape, a click outside, and Back discard the draft (D69, D91).
//
// The same picker edits the card's Start (D720, `kind="start"`): a date with an optional time, with
// the due date's rules. The start fields are read as due-shaped fields (`startAsDue`) so every
// helper here serves both, and the change is renamed to `startOn`/`startTime`/`startTz` on Apply.

export type DueFields = { due_on: string | null; due_time?: string | null; due_tz?: string | null; due_at?: string | null };
export type StartFields = { start_on?: string | null; start_time?: string | null; start_tz?: string | null; start_at?: string | null };
/** Which of the card's dates a picker edits (D720). */
export type DateKind = "due" | "start";

/** The start fields as due-shaped fields, so the start reuses every due helper (D720). */
export function startAsDue(card: StartFields): DueFields {
  return { due_on: card.start_on ?? null, due_time: card.start_time ?? null, due_tz: card.start_tz ?? null, due_at: card.start_at ?? null };
}

/** A due-shaped change as the start's: `dueOn`, `dueTime`, `dueTz` become `startOn`, `startTime`, `startTz`. */
export function changeAsStart(change: CardChange): CardChange {
  const renamed: CardChange = {};
  if (change.dueOn !== undefined) renamed.startOn = change.dueOn;
  if (change.dueTime !== undefined) renamed.startTime = change.dueTime;
  if (change.dueTz !== undefined) renamed.startTz = change.dueTz;
  return renamed;
}
export type DueDraft = { date: string; time: string; withTime: boolean };
export type QuickPick = "today" | "tomorrow" | "next-week";

export const QUICK_PICKS: { kind: QuickPick; label: string }[] = [
  { kind: "today", label: "Today" },
  { kind: "tomorrow", label: "Tomorrow" },
  { kind: "next-week", label: "Next week" }
];

export function initialDueDraft(card: DueFields): DueDraft {
  return { date: card.due_on ?? "", time: card.due_time ?? "", withTime: Boolean(card.due_on && card.due_time) };
}

/** A quick pick's date from the viewer's today (YYYY-MM-DD): today, tomorrow, or a week from today. */
export function quickPickDate(kind: QuickPick, today: string) {
  const [year, month, day] = today.split("-").map(Number);
  const offset = kind === "today" ? 0 : kind === "tomorrow" ? 1 : 7;
  const date = new Date(Date.UTC(year!, month! - 1, day! + offset));
  return date.toISOString().slice(0, 10);
}

/** The draft's date is empty (no due date) or a real date; Apply waits for one of those. */
export function draftDateValid(draft: DueDraft) {
  return draft.date === "" || committableDueDate(draft.date, null) !== null;
}

/**
 * The one change Apply sends, with the toast's words, or null when nothing changed. An untouched
 * time keeps its zone (a card timed elsewhere is not moved into the viewer's zone); a new or edited
 * time is set in the viewer's zone (D101). Clearing the date clears the time.
 */
export function dueChange(card: DueFields, draft: DueDraft, zone: string): { change: CardChange; success: string } | null {
  if (!draftDateValid(draft)) return null;
  if (!draft.date) return card.due_on ? { change: { dueOn: null }, success: "Due date removed" } : null;
  const change: CardChange = {};
  const dateChanged = draft.date !== card.due_on;
  if (dateChanged) change.dueOn = draft.date;
  const savedTime = card.due_on ? card.due_time ?? "" : "";
  let timeWords: "saved" | "removed" | null = null;
  if (draft.withTime && draft.time) {
    const time = draft.time === savedTime ? null : committableDueTime(draft.time, { time: null, zone: null }, zone);
    if (time) {
      Object.assign(change, { dueTime: time, dueTz: zone });
      timeWords = "saved";
    }
  } else if (savedTime) {
    change.dueTime = null;
    timeWords = "removed";
  }
  if (!dateChanged && !timeWords) return null;
  const success = dateChanged
    ? timeWords === "saved" ? "Due date and time saved" : timeWords === "removed" ? "Due date saved, time removed" : "Due date saved"
    : timeWords === "saved" ? "Due time saved" : "Due time removed";
  return { change, success };
}

/** The one change Apply sends for the start (D720), worded for it; `dueChange`'s rules. */
export function startChange(card: StartFields, draft: DueDraft, zone: string): { change: CardChange; success: string } | null {
  const pending = dueChange(startAsDue(card), draft, zone);
  return pending && { change: changeAsStart(pending.change), success: pending.success.replace(/^Due/, "Start") };
}

/**
 * Why the draft would put the start after the due date (D721), or null. Civil dates compare here;
 * the server also compares the instants when both have a time (400 START_AFTER_DUE).
 */
export function dateOrderError(kind: DateKind, card: DueFields & StartFields, draft: DueDraft) {
  if (!draft.date) return null;
  if (kind === "start" && card.due_on && draft.date > card.due_on) return "The start must be on or before the due date.";
  if (kind === "due" && card.start_on && draft.date < card.start_on) return "The due date must be on or after the start.";
  return null;
}

/** The trigger's words: "No due date", "3 Oct", or "3 Oct at 18:45" (the viewer's local day and time). */
export function dueTriggerLabel(card: DueFields, today: string, zone = viewerTimeZone()) {
  if (!card.due_on) return "No due date";
  const at = card.due_time && card.due_at ? Date.parse(card.due_at) : Number.NaN;
  const local = Number.isFinite(at) ? instantParts(at, zone) : null;
  const day = local?.date ?? card.due_on;
  const [year, month, date] = day.split("-").map(Number);
  const words = new Date(year!, month! - 1, date!).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) });
  const time = local?.time ?? card.due_time;
  return time ? `${words} at ${time}` : words;
}

/** The Start trigger's words (D720): "No start date", "3 Oct", or "3 Oct at 09:00". */
export function startTriggerLabel(card: StartFields, today: string, zone = viewerTimeZone()) {
  return card.start_on ? dueTriggerLabel(startAsDue(card), today, zone) : "No start date";
}

type DuePickerProps = {
  card: DueFields & StartFields;
  /** The due date (the default) or the start (D720). */
  kind?: DateKind;
  idPrefix: string;
  /** The card sits in a done column: no due status. */
  done: boolean;
  disabled: boolean;
  /** Saves the change; resolves once it settled (false when not saved). */
  onApply: (change: CardChange, success: string) => Promise<boolean>;
  presentation?: Presentation;
  /** Opens on mount (tests). */
  defaultOpen?: boolean;
};

export function DuePicker({ card, kind = "due", idPrefix, done, disabled, onApply, presentation = "auto", defaultOpen = false }: DuePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const sheet = useSheet(presentation);
  const [open, setOpen] = useState(defaultOpen);
  const start = kind === "start";
  // The start reads as due-shaped fields, so the rest of the picker is the same for both (D720).
  const fields = start ? startAsDue(card) : card;
  const [draft, setDraft] = useState<DueDraft>(() => initialDueDraft(fields));
  const [applying, setApplying] = useState(false);
  const [focusTime, setFocusTime] = useState(false);
  const zone = viewerTimeZone();
  const today = localDateString();
  const due = start ? null : dueStatus(fields.due_on, today, done, { dueAt: fields.due_at });
  const note = dueTimeNote(fields, zone);
  const otherZone = Boolean(fields.due_time) && fields.due_tz !== zone;
  const pending = start ? startChange(card, draft, zone) : dueChange(card, draft, zone);
  const orderError = dateOrderError(kind, card, draft);
  const valid = draftDateValid(draft) && !orderError;
  const noun = start ? "Start date" : "Due date";
  const ids = { date: `${idPrefix}-${kind}-date`, time: `${idPrefix}-${kind}-time`, input: `${idPrefix}-${kind}-input`, text: `${idPrefix}-${kind}` };

  function show() {
    if (disabled) return;
    setDraft(initialDueDraft(fields));
    setOpen(true);
  }

  function cancel(returnFocus = true) {
    setOpen(false);
    if (returnFocus) window.setTimeout(() => { if (triggerRef.current?.isConnected) triggerRef.current.focus(); }, 0);
  }

  async function apply() {
    if (applying || !valid) return;
    if (!pending) {
      cancel();
      return;
    }
    setApplying(true);
    try {
      await onApply(pending.change, pending.success);
    } finally {
      setApplying(false);
      cancel();
    }
  }

  // Back closes the popover without saving: the popup and the phone sheet (DropdownSurface) each
  // register their own history layer, so the picker adds none.
  useOutsideClose(open && !sheet, rootRef, () => cancel(false));
  // Focus moves into the editor: the date field on desktop (once the popup is placed and visible, so
  // not autoFocus), the first quick pick in the phone sheet (the date field would raise a picker).
  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>(sheet ? ".task-due-quick-pick" : `#${CSS.escape(ids.date)}`)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, sheet, ids.date]);
  useEffect(() => {
    if (!focusTime) return;
    timeRef.current?.focus();
    setFocusTime(false);
  }, [focusTime]);

  const onKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      void apply();
    }
  };

  const editor = <div className="task-due-editor" role={sheet ? undefined : "dialog"} aria-label={sheet ? undefined : noun} onKeyDown={onKey}>
    <div className="task-due-quick" role="group" aria-label="Quick picks">
      {QUICK_PICKS.map((pick) => {
        const value = quickPickDate(pick.kind, today);
        return <button key={pick.kind} type="button" className={`task-due-quick-pick${draft.date === value ? " on" : ""}`} aria-pressed={draft.date === value}
          onClick={() => setDraft({ ...draft, date: value })}>{pick.label}</button>;
      })}
      <button type="button" className="task-due-quick-pick" disabled={!draft.date} onClick={() => setDraft({ date: "", time: "", withTime: false })}>Clear</button>
    </div>
    <label className="task-due-editor-row">
      <span><CalendarDays aria-hidden="true" />Date</span>
      <input id={ids.date} type="date" value={draft.date} min="1900-01-01" max="2999-12-31"
        aria-invalid={valid ? undefined : true} onChange={(event) => setDraft({ ...draft, date: event.target.value, ...(event.target.value ? {} : { withTime: false, time: "" }) })} />
    </label>
    {draft.withTime
      ? <div className="task-due-editor-row">
        <label htmlFor={ids.time}><Clock aria-hidden="true" />Time</label>
        <span className="task-due-editor-control">
          <input ref={timeRef} id={ids.time} type="time" step={60} value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} />
          <button type="button" className="secondary-button task-small-button" onClick={() => setDraft({ ...draft, withTime: false, time: "" })}><X aria-hidden="true" />Remove time</button>
        </span>
      </div>
      : <button type="button" className="task-add-time" disabled={!draft.date} onClick={() => { setDraft({ ...draft, withTime: true }); setFocusTime(true); }}><Clock aria-hidden="true" />Add time</button>}
    {otherZone && note && <p className="task-due-text">{`Set as ${note}. Changing the time uses your zone (${zone}).`}</p>}
    {!draftDateValid(draft) ? <p className="file-dialog-error" role="alert">Use a real date between 1900 and 2999.</p>
      : orderError && <p className="file-dialog-error" role="alert">{orderError}</p>}
    {!sheet && footer()}
  </div>;

  function footer() {
    return <footer className="task-due-actions">
      <button type="button" className="secondary-button" onClick={() => cancel()} disabled={applying}>Cancel</button>
      <button type="button" className="primary-button" onClick={() => { void apply(); }} disabled={applying || !valid}>{applying ? "Saving…" : "Apply"}</button>
    </footer>;
  }

  return <div ref={rootRef} className="task-due-picker">
    <button ref={triggerRef} id={ids.input} type="button" className={`task-due-trigger${fields.due_on ? "" : " empty"}`} disabled={disabled}
      aria-haspopup="dialog" aria-expanded={open} aria-describedby={ids.text} onClick={() => { if (open) cancel(); else show(); }}>
      <CalendarDays aria-hidden="true" /><span>{start ? startTriggerLabel(card, today, zone) : dueTriggerLabel(card, today, zone)}</span>
    </button>
    <small id={ids.text} className={due ? `task-due-text ${due.tone}` : "task-due-text"}>
      {start ? fields.due_on ? `Starts ${dueTriggerLabel(fields, today, zone)}` : "No start date"
        : due ? due.description : card.due_on ? "In a done column" : "No due date"}
      {otherZone && note && <><br />{`Set as ${note}.`}</>}
    </small>
    {open && <DropdownSurface sheet={sheet} anchorRef={triggerRef} title={noun} onClose={() => cancel()}
      footer={sheet ? <div className="ui-sheet-footer task-due-sheet-footer" onKeyDown={onKey}>{footer()}</div> : undefined}>
      {editor}
    </DropdownSurface>}
  </div>;
}
