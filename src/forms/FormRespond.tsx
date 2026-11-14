import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarCheck, CheckCircle2, Clock, Lock, Pencil, RotateCcw } from "lucide-react";
import { ApiError } from "../api";
import { QuestionRenderer } from "../ui/questions/QuestionRenderer";
import { inlineText } from "../ui/questions/inline";
import { EmptyState } from "../ui/EmptyState";
import { notify } from "../ui/notify";
import { ModalDialog } from "../files/Dialog";
import type { RespondView } from "../../shared/forms";
import type { Answers, SlotVote } from "../../shared/questions";
import { countStart, finalize, getTargets, respondView, retractVote, submitResponse } from "./formsApi";
import { FormFrame, MissingForm, type FormsNav } from "./FormsApp";
import { closesText, PollCard, slotText, TimePollGrid } from "./PollViews";
import { SelectField, Toggle } from "./fields";

/**
 * Answering a form, voting on a poll, or marking times on a time poll in the app (§D.1 UI "Respond",
 * "Poll", "Time poll"): the shared renderer in the app theme (page or one question at a time), hidden
 * fields from the URL, the form's ending after submitting, editing your response when the form allows
 * it, and the organizer's "Pick this time".
 */
const ZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
const REASONS: Record<NonNullable<RespondView["closedReason"]>, string> = {
  closed: "This form is closed.", not_open_yet: "This form is not open yet.", full: "This form has all the responses it needs.", answered: "You already responded.",
  not_invited: "This form is not open to you.", draft: "This form is not published yet."
};

export default function FormRespond({ nav, formRef }: { nav: FormsNav; formRef: string }) {
  const [view, setView] = useState<RespondView | null>(null);
  const [missing, setMissing] = useState(false);
  const load = useCallback(async () => {
    try {
      const loaded = await respondView(formRef);
      setView(loaded);
      const segment = loaded.form.href.split("/")[2];
      if (segment && segment !== formRef) nav.go([segment], nav.props.route.search, true);
    } catch (error) { if (error instanceof ApiError && error.status === 404) setMissing(true); }
  }, [formRef]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  // Live polls refresh every 15 s while the page is visible.
  useEffect(() => {
    if (!view || view.form.kind === "form" || !view.form.accepting) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [view?.form.kind, view?.form.accepting, load]); // eslint-disable-line react-hooks/exhaustive-deps
  if (missing) return <MissingForm nav={nav} />;
  if (!view) return <FormFrame nav={nav} form={null} view="respond"><p className="ui-panel-loading" role="status">Loading…</p></FormFrame>;
  const form = { ...view.form, level: view.form.level };
  return <FormFrame nav={nav} form={form} view="respond">
    <div className="forms-respond">
      {view.form.kind === "poll" ? <PollPage view={view} setView={setView} />
        : view.form.kind === "time_poll" ? <TimePollPage view={view} setView={setView} reload={load} />
          : <FormPage view={view} reload={load} nav={nav} />}
    </div>
  </FormFrame>;
}

function Header({ view }: { view: RespondView }) {
  const closes = closesText(view.form.closesAt, view.form.accepting);
  return <header className="forms-respond-head" style={view.form.theme.accent ? { borderTopColor: view.form.theme.accent } : undefined}>
    <h2>{view.form.title}</h2>
    {view.form.description && <p className="forms-description">{inlineText(view.form.description)}</p>}
    <p className="forms-muted forms-respond-meta">
      <span>By {view.form.owner.name}</span>
      {view.form.anonymous && <span><Lock aria-hidden="true" />Anonymous: your name is not saved with your answers</span>}
      {closes && <span><Clock aria-hidden="true" />{closes}</span>}
    </p>
  </header>;
}

function hiddenFromUrl(view: RespondView): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  const out: Record<string, string> = {};
  for (const question of view.set?.questions ?? []) if (question.type === "hidden" && question.hiddenKey && params.get(question.hiddenKey)) out[question.id] = params.get(question.hiddenKey)!.slice(0, 500);
  return out;
}

function FormPage({ view, reload, nav }: { view: RespondView; reload: () => Promise<void>; nav: FormsNav }) {
  const editing = view.mine && view.mine.id && view.form.allowEdit && view.form.accepting;
  const [answers, setAnswers] = useState<Answers>(() => (editing ? view.mine!.answers : {}) as Answers);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ ending: string | null } | null>(null);
  const started = useRef(false);
  const hidden = useMemo(() => hiddenFromUrl(view), [view]);
  if (!view.set) return <EmptyState icon={Clock} title="Nothing to answer yet">The owner has not published questions.</EmptyState>;
  if (done) {
    const ending = view.set.endings.find((item) => item.id === done.ending);
    const title = ending?.title ?? view.form.ending.title;
    const body = ending?.body ?? view.form.ending.body;
    return <div className="forms-done" role="status">
      <CheckCircle2 aria-hidden="true" />
      <h2>{title}</h2>
      {body && <p>{inlineText(body)}</p>}
      <div className="forms-done-actions">
        {view.form.allowEdit && <button type="button" className="secondary-button" onClick={() => { setDone(null); void reload(); }}><Pencil aria-hidden="true" />Edit your response</button>}
        {view.form.limitPer === "none" && view.form.settings.allowAnother && <button type="button" className="secondary-button" onClick={() => { setAnswers({}); setDone(null); void reload(); }}><RotateCcw aria-hidden="true" />Submit another response</button>}
        <button type="button" className="secondary-button" onClick={() => nav.go(["answer"])}>More to answer</button>
      </div>
    </div>;
  }
  const closed = view.closedReason && !(view.closedReason === "answered" && editing);
  return <>
    <Header view={view} />
    {closed ? <div className="forms-closed" role="status"><Lock aria-hidden="true" /><p>{REASONS[view.closedReason!]}</p></div>
      : <>
        {editing && <p className="forms-note"><Pencil aria-hidden="true" />You are editing the response you sent {new Date(view.mine!.submittedAt).toLocaleString()}.</p>}
        <QuestionRenderer set={view.set} answers={answers} errors={errors} submitting={busy} hidden={hidden} mode={view.form.display} theme="app" audience="member" timeZone={ZONE}
          submitLabel={editing ? "Save changes" : "Submit"}
          onChange={(next) => { setAnswers(next); if (!started.current) { started.current = true; void countStart(view.form.id); } }}
          onSubmit={async (checked) => {
            setBusy(true);
            setErrors({});
            try {
              const result = await submitResponse(view.form.id, checked, { responseId: editing ? view.mine!.id : null, hidden });
              setDone({ ending: result.ending });
            } catch (error) {
              const payload = error instanceof ApiError ? error.payload as { errors?: Record<string, string>; error?: string } : null;
              if (payload?.errors) setErrors(payload.errors);
              notify.error(error instanceof ApiError ? error.message : "Could not send. Try again.");
            } finally { setBusy(false); }
          }} />
      </>}
  </>;
}

function PollPage({ view, setView }: { view: RespondView; setView: (view: RespondView) => void }) {
  const question = view.set?.questions.find((item) => item.type === "single_choice" || item.type === "multi_choice");
  return <>
    <Header view={view} />
    <PollCard view={view} onVote={view.form.canRespond && question ? async (optionIds) => {
      try {
        const answer = question.type === "multi_choice" ? { options: optionIds } : optionIds[0];
        setView((await submitResponse(view.form.id, { [question.id]: answer })).view);
      } catch (error) { notify.error(error instanceof ApiError ? error.message : "Could not vote"); }
    } : undefined} />
    {view.mine && !view.form.anonymous && view.form.accepting && <button type="button" className="ui-text-button" onClick={() => { void retractVote(view.form.id).then((result) => setView(result.view)); }}>Remove my vote</button>}
  </>;
}

function TimePollPage({ view, setView, reload }: { view: RespondView; setView: (view: RespondView) => void; reload: () => Promise<void> }) {
  const question = view.set?.questions.find((item) => item.type === "time_slots");
  const initial = (view.mine?.answers?.[question?.id ?? ""] ?? {}) as Record<string, SlotVote>;
  const [votes, setVotes] = useState<Record<string, SlotVote>>(initial);
  const [saving, setSaving] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => { setVotes(initial); }, [view.mine?.submittedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!question) return <EmptyState icon={Clock} title="No times proposed yet" />;
  const organizer = view.form.level === "owner" || view.form.level === "manage" || view.form.level === "edit";
  const editable = view.form.canRespond && view.form.accepting;
  const final = question.slots?.find((slot) => slot.id === view.form.finalizedSlotId);
  const dirty = JSON.stringify(votes) !== JSON.stringify(initial);
  const save = async () => {
    const complete = Object.fromEntries((question.slots ?? []).map((slot) => [slot.id, votes[slot.id] ?? "no"]));
    setSaving(true);
    try { setView((await submitResponse(view.form.id, { [question.id]: complete })).view); notify.success("Your times are saved"); }
    catch (error) { notify.error(error instanceof ApiError ? error.message : "Could not save"); }
    finally { setSaving(false); }
  };
  return <>
    <Header view={view} />
    {final && <p className="forms-final"><CalendarCheck aria-hidden="true" />The time is set: <strong>{slotText(final)}</strong></p>}
    {editable && <p className="forms-muted">Tap a time to mark it: yes, {question.allowMaybe !== false ? "if need be, " : ""}or no.</p>}
    <TimePollGrid question={question} results={view.results} votes={votes} onChange={editable ? setVotes : undefined} editable={editable} finalizedSlotId={view.form.finalizedSlotId} organizer={organizer} onPick={organizer && !final ? setPick : undefined} />
    {editable && <div className="forms-sticky-actions"><button type="button" className="primary-button" disabled={saving || (!dirty && view.mine !== null)} onClick={() => { void save(); }}>{saving ? "Saving…" : view.mine ? "Save changes" : "Send my times"}</button></div>}
    {pick && <FinalizeSheet view={view} slotId={pick} onClose={() => setPick(null)} onDone={async () => { setPick(null); await reload(); }} />}
  </>;
}

function FinalizeSheet({ view, slotId, onClose, onDone }: { view: RespondView; slotId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const slot = view.set?.questions.find((item) => item.type === "time_slots")?.slots?.find((item) => item.id === slotId);
  const [calendars, setCalendars] = useState<Array<{ id: string; name: string }>>([]);
  const [calendarId, setCalendarId] = useState<string | null>(null);
  const [emailGuests, setEmailGuests] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { getTargets().then((targets) => { setCalendars(targets.calendars); setCalendarId(targets.calendars[0]?.id ?? null); }).catch(() => undefined); }, []);
  if (!slot) return null;
  return <ModalDialog title="Pick this time" eyebrow="Find a time" onClose={onClose} busy={busy} className="forms-sheet">
    <div className="file-dialog-body forms-sheet-body">
      <p className="forms-final"><CalendarCheck aria-hidden="true" /><strong>{slotText(slot)}</strong></p>
      <SelectField label="Add it to" value={calendarId} onChange={setCalendarId} options={calendars.map((calendar) => ({ value: calendar.id, label: calendar.name }))} hint="Participants are notified; the poll closes." />
      <Toggle label="Email voters from outside the workspace" checked={emailGuests} onChange={setEmailGuests} hint="Only people who voted on the public link and left an email." />
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            const result = await finalize(view.form.id, { slotId, calendarId, tz: ZONE, emailGuests });
            notify.success(result.eventId ? `Booked ${result.when}` : `Time set: ${result.when}`);
            await onDone();
          } catch (error) { notify.error(error instanceof ApiError ? error.message : "Could not set the time"); setBusy(false); }
        }}>Set the time</button>
      </footer>
    </div>
  </ModalDialog>;
}
