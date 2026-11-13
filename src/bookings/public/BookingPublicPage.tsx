import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, CalendarPlus, Clock, MapPin, Phone, Video, Users, PencilLine, CircleHelp } from "lucide-react";
import { PublicDone, PublicNotFound, PublicPageShell } from "../../public/PublicPageShell";
import { QuestionRenderer } from "../../ui/questions/QuestionRenderer";
import { appName } from "../../appName";
import { SlotPicker } from "../SlotPicker";
import { durationLabel, viewerZone, type SlotDays } from "../api";
import { HONEYPOT_FIELD } from "../../../shared/publicPages";
import type { LocationKind, PublicTypeSummary } from "../../../shared/bookings";
import type { Answers, QuestionSet } from "../../../shared/questions";
import "./bookingPublic.css";

/**
 * Public booking pages (§D.6 UI, §B.8): `/p/book/<handle>` (the host and their types),
 * `/p/book/<handle>/<slug>` and `/p/book/link/<token>` (pick a date and time in your zone, your
 * details and the intake questions, then the confirmation with "Add to calendar" and the manage
 * link), `/p/book/manage/<token>` (the booking, Reschedule, Cancel). No session; one 404 for
 * anything that does not open. Single-column steps at 375 px.
 */

type Meta = { appName: string; workspaceName: string; logoUrl: string | null; renderNonce?: string };
type Host = { name: string; welcome: string; handle: string | null; tz: string };
type TypePage = { meta: Meta; host: Host; type: PublicTypeSummary & { locationLabel: string; location: string; needsLocation: boolean; confirm: "auto" | "manual" }; questions: QuestionSet | null; verifyEmail: boolean; mail: boolean };
type Confirmation = { status: string; mailQueued: boolean; manageUrl: string; booking: { typeTitle: string; hostName: string; start: string; end: string; tz: string; when: string; location: string; locationKind: LocationKind } };
type ManageView = { meta: Meta; booking: { typeTitle: string; hostName: string; start: string; end: string; durationMin: number; tz: string; when: string; status: string; location: string; locationKind: LocationKind; locationLabel: string; bookerName: string; guests: string[]; cancelReason: string | null }; canCancel: boolean; canReschedule: boolean; color: string | null; manageUrl?: string };

class PublicError extends Error { constructor(message: string, readonly status: number, readonly code?: string, readonly body?: Record<string, unknown>) { super(message); } }

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/public${path}`, { ...init, credentials: "omit", referrerPolicy: "no-referrer", headers: init.body ? { "Content-Type": "application/json" } : undefined });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new PublicError(typeof body.error === "string" ? body.error : "Something went wrong", response.status, typeof body.code === "string" ? body.code : undefined, body);
  return body as T;
}

const LOCATION_ICONS: Record<LocationKind, typeof Video> = { video_link: Video, phone: Phone, in_person: MapPin, custom: PencilLine, ask: CircleHelp };

export default function BookingPublicPage({ path }: { path: string; search: string }) {
  const parts = path.split("/").filter(Boolean).slice(2).map(decodeURIComponent);
  if (parts[0] === "manage" && parts[1]) return <ManagePage token={parts[1]} />;
  if (parts[0] === "link" && parts[1]) return <TypePageView base={`/book/link/${encodeURIComponent(parts[1])}`} />;
  if (parts.length === 1) return <ProfilePage handle={parts[0]!} />;
  if (parts.length === 2) return <TypePageView base={`/book/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}`} />;
  return <PublicNotFound appName={appName()} />;
}

function useLoad<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ data: T | null; error: PublicError | null }>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ data: null, error: null });
    load().then((data) => live && setState({ data, error: null })).catch((error: unknown) => live && setState({ data: null, error: error instanceof PublicError ? error : new PublicError("Could not load the page", 0) }));
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

function Loading() {
  return <div className="ui-public" aria-busy="true"><p role="status" className="ui-visually-hidden">Loading…</p></div>;
}

function Shell({ meta, accent, children, title }: { meta: Meta; accent?: string | null; children: ReactNode; title?: string }) {
  return <PublicPageShell workspaceName={meta.workspaceName} logoUrl={meta.logoUrl} appName={meta.appName} width="booking" accent={accent} title={title}
    footer={<p>Times are shown in your time zone. Your details go only to the host.</p>}>{children}</PublicPageShell>;
}

function ProfilePage({ handle }: { handle: string }) {
  const { data, error } = useLoad(() => call<{ meta: Meta; host: Host; types: PublicTypeSummary[] }>(`/book/${encodeURIComponent(handle)}`), handle);
  if (error) return <PublicNotFound appName={appName()} />;
  if (!data) return <Loading />;
  return <Shell meta={data.meta}>
    <header className="bk-pub-host">
      <span className="bk-pub-avatar" aria-hidden="true">{data.host.name.trim()[0]?.toUpperCase() ?? "?"}</span>
      <div><h1 className="ui-public-title">{data.host.name}</h1>{data.host.welcome && <p className="ui-public-text">{data.host.welcome}</p>}</div>
    </header>
    {data.types.length === 0 ? <p className="ui-public-text">There is nothing to book here right now.</p>
      : <ul className="bk-pub-types">
        {data.types.map((type) => {
          const Icon = LOCATION_ICONS[type.locationKind];
          return <li key={type.slug}><a href={`/p/book/${encodeURIComponent(handle)}/${encodeURIComponent(type.slug)}`} rel="noreferrer" style={{ "--type-color": type.color } as React.CSSProperties}>
            <strong>{type.title}</strong>
            {type.description && <span className="bk-pub-desc">{type.description}</span>}
            <span className="bk-pub-meta"><Clock aria-hidden="true" />{type.durations.map(durationLabel).join(" · ")}<Icon aria-hidden="true" /></span>
          </a></li>;
        })}
      </ul>}
  </Shell>;
}

function TypeSummary({ page, duration, start, tz }: { page: TypePage; duration: number; start?: string | null; tz: string }) {
  const Icon = LOCATION_ICONS[page.type.locationKind];
  return <aside className="bk-pub-summary">
    <p className="bk-pub-hostname">{page.host.name}</p>
    <h1 className="ui-public-title">{page.type.title}</h1>
    <ul className="bk-pub-facts">
      <li><Clock aria-hidden="true" />{durationLabel(duration)}</li>
      <li><Icon aria-hidden="true" />{page.type.location || page.type.locationLabel}</li>
      {start && <li className="bk-pub-chosen"><CalendarPlus aria-hidden="true" />{new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(new Date(start))}</li>}
    </ul>
    {page.type.description && <p className="ui-public-text bk-pub-description">{page.type.description}</p>}
    {page.type.confirm === "manual" && <p className="bk-pub-note">The host confirms each request.</p>}
  </aside>;
}

function TypePageView({ base }: { base: string }) {
  const { data, error } = useLoad(() => call<TypePage>(base), base);
  const [tz, setTz] = useState(viewerZone);
  const [duration, setDuration] = useState<number | null>(null);
  const [start, setStart] = useState<string | null>(null);
  const [step, setStep] = useState<"pick" | "details" | "verify" | "done">("pick");
  const [done, setDone] = useState<Confirmation | null>(null);
  const [verify, setVerify] = useState<{ id: string } | null>(null);
  if (error) return <PublicNotFound appName={appName()} />;
  if (!data) return <Loading />;
  const minutes = duration ?? data.type.durations[0]!;
  const load = (from: string, to: string, zone: string) => call<SlotDays>(`${base}/slots?${new URLSearchParams({ from, to, tz: zone, duration: String(minutes) })}`);

  if (step === "done" && done) return <Shell meta={data.meta} accent={data.type.color}><Confirmed done={done} mail={data.mail} /></Shell>;
  return <Shell meta={data.meta} accent={data.type.color}>
    <div className={`bk-pub-layout ${step}`}>
      <TypeSummary page={data} duration={minutes} start={step === "pick" ? null : start} tz={tz} />
      <section className="bk-pub-main" aria-label={step === "pick" ? "Choose a time" : "Your details"}>
        {step === "pick" && <>
          {data.type.durations.length > 1 && <div className="bk-pub-durations" role="radiogroup" aria-label="Length">
            {data.type.durations.map((value) => <button key={value} type="button" role="radio" aria-checked={value === minutes} className={value === minutes ? "selected" : ""} onClick={() => { setDuration(value); setStart(null); }}>{durationLabel(value)}</button>)}
          </div>}
          <SlotPicker key={`${minutes}`} load={load} tz={tz} onTz={setTz} picked={start} onPick={(iso) => { setStart(iso); setStep("details"); }} />
        </>}
        {step === "details" && start && <Details page={data} base={base} start={start} duration={minutes} tz={tz} onBack={() => setStep("pick")}
          onDone={(result) => { setDone(result); setStep("done"); }} onVerify={(id) => { setVerify({ id }); setStep("verify"); }} />}
        {step === "verify" && verify && <Verify base={base} id={verify.id} onDone={(result) => { setDone(result); setStep("done"); }} />}
      </section>
    </div>
  </Shell>;
}

function Details({ page, base, start, duration, tz, onBack, onDone, onVerify }: { page: TypePage; base: string; start: string; duration: number; tz: string; onBack: () => void; onDone: (result: Confirmation) => void; onVerify: (id: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [guests, setGuests] = useState("");
  const [location, setLocation] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const questions = page.questions && page.questions.questions.length ? page.questions : null;

  const submit = async (checked: Answers) => {
    const problems: Record<string, string> = {};
    if (!name.trim()) problems.name = "Enter your name";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) problems.email = "Enter an email address";
    if (page.type.needsLocation && !location.trim()) problems.location = page.type.locationKind === "phone" ? "Enter the number to call" : "Tell the host where to meet";
    const guestList = guests.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
    if (guestList.length > 10 || guestList.some((guest) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest))) problems.guests = "Up to 10 email addresses, separated by commas";
    setErrors(problems);
    if (Object.keys(problems).length) return;
    setSending(true);
    setFailure(null);
    try {
      const result = await call<Confirmation & { status: string; verificationId?: string }>(`${base}/bookings`, { method: "POST", body: JSON.stringify({
        start, duration, tz, name: name.trim(), email: email.trim(), guests: guestList, location: page.type.needsLocation ? location.trim() : null, answers: checked,
        nonce: page.meta.renderNonce, [HONEYPOT_FIELD]: honeypot
      }) });
      if (result.status === "verify" && result.verificationId) onVerify(result.verificationId);
      else onDone(result);
    } catch (error) {
      if (error instanceof PublicError && error.code === "INVALID_ANSWERS" && error.body?.errors) setErrors(error.body.errors as Record<string, string>);
      setFailure(error instanceof PublicError && error.code === "SLOT_TAKEN" ? "That time was just taken. Go back and choose another." : error instanceof Error ? error.message : "Could not book");
    } finally {
      setSending(false);
    }
  };

  const fields = <div className="bk-pub-fields">
    <button type="button" className="bk-pub-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Change the time</button>
    <Field label="Your name" error={errors.name}><input autoComplete="name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} aria-invalid={Boolean(errors.name)} autoFocus /></Field>
    <Field label="Email" error={errors.email}><input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={Boolean(errors.email)} /></Field>
    {page.type.needsLocation && <Field label={page.type.locationKind === "phone" ? "Phone number to call" : "Where should you meet?"} error={errors.location}>
      <input type={page.type.locationKind === "phone" ? "tel" : "text"} maxLength={500} value={location} onChange={(event) => setLocation(event.target.value)} aria-invalid={Boolean(errors.location)} /></Field>}
    <Field label="Guests (optional)" hint="Email addresses, separated by commas" error={errors.guests}><input value={guests} onChange={(event) => setGuests(event.target.value)} aria-invalid={Boolean(errors.guests)} /></Field>
    <div className="bk-pub-trap" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={honeypot} onChange={(event) => setHoneypot(event.target.value)} name={HONEYPOT_FIELD} /></label></div>
    {failure && <p className="bk-pub-error" role="alert">{failure}</p>}
  </div>;

  const label = page.type.confirm === "manual" ? "Request booking" : "Confirm booking";
  if (questions) return <QuestionRenderer set={questions} answers={answers} onChange={setAnswers} onSubmit={(checked) => submit(checked)} theme="public" audience="public" errors={errors}
    submitting={sending} submitLabel={label} header={fields} timeZone={tz} />;
  return <form className="ui-questions page" data-theme="public" noValidate onSubmit={(event: FormEvent) => { event.preventDefault(); void submit({}); }}>
    {fields}
    <div className="ui-q-actions"><button type="submit" className="ui-q-submit" disabled={sending}>{sending ? "Booking…" : label}</button></div>
  </form>;
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return <label className="bk-pub-field"><span>{label}</span>{children}{hint && !error && <small>{hint}</small>}{error && <small className="bk-pub-error" role="alert">{error}</small>}</label>;
}

function Verify({ base, id, onDone }: { base: string; id: string; onDone: (result: Confirmation) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  return <form className="bk-pub-fields" noValidate onSubmit={(event) => { event.preventDefault(); call<Confirmation>(`${base}/verify`, { method: "POST", body: JSON.stringify({ id, code: code.trim() }) }).then(onDone, (reason: unknown) => setError(reason instanceof Error ? reason.message : "That code did not work")); }}>
    <h2 className="bk-pub-h2">Check your email</h2>
    <p className="ui-public-text">We sent a 6-digit code to confirm your address. Enter it to finish booking.</p>
    <Field label="Code" error={error ?? undefined}><input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} autoFocus /></Field>
    <div className="ui-q-actions"><button type="submit" className="ui-q-submit">Confirm</button></div>
  </form>;
}

function Confirmed({ done, mail }: { done: Confirmation; mail: boolean }) {
  const token = done.manageUrl.split("/").pop() ?? "";
  const pending = done.status === "pending";
  return <PublicDone title={pending ? "Request sent" : "You're booked"}>
    <div className="bk-pub-done">
      <p><strong>{done.booking.typeTitle}</strong> with {done.booking.hostName}</p>
      <p>{done.booking.when}</p>
      {done.booking.location && <p>{done.booking.location}</p>}
      {pending && <p>The host will confirm it. You'll get an email when they do.</p>}
      <p>{done.mailQueued ? "A confirmation is on its way to your inbox." : mail ? "We could not email you this time; keep this page's link." : "No email will be sent: save the link below to change or cancel."}</p>
      <div className="bk-pub-actions">
        <a className="bk-pub-button" href={`/api/public/bookings/manage/${encodeURIComponent(token)}/ics`} rel="noreferrer" download="booking.ics"><CalendarPlus aria-hidden="true" />Add to calendar</a>
        <a className="bk-pub-link" href={done.manageUrl} rel="noreferrer">Reschedule or cancel</a>
      </div>
    </div>
  </PublicDone>;
}

function ManagePage({ token }: { token: string }) {
  const { data, error } = useLoad(() => call<ManageView>(`/bookings/manage/${encodeURIComponent(token)}`), token);
  const [view, setView] = useState<ManageView | null>(null);
  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [tz, setTz] = useState(viewerZone);
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const current = view ?? data;
  const nonce = useMemo(() => current?.meta.renderNonce, [current]);
  if (error) return <PublicNotFound appName={appName()} />;
  if (!current) return <Loading />;
  const booking = current.booking;
  const Icon = LOCATION_ICONS[booking.locationKind];
  const act = async (action: "cancel" | "reschedule") => {
    setFailure(null);
    try {
      const result = await call<ManageView>(`/bookings/manage/${encodeURIComponent(token)}/${action}`, { method: "POST", body: JSON.stringify({ reason: reason || undefined, start: action === "reschedule" ? picked : undefined, nonce, website: "" }) });
      if (result.manageUrl) { window.history.replaceState(null, "", result.manageUrl); window.location.reload(); return; }
      setView(result);
      setMode("view");
    } catch (reasonError) {
      setFailure(reasonError instanceof PublicError && reasonError.code === "SLOT_TAKEN" ? "That time is no longer free. Choose another." : reasonError instanceof Error ? reasonError.message : "Could not change the booking");
    }
  };
  const cancelled = ["cancelled", "declined", "expired"].includes(booking.status);
  return <Shell meta={current.meta} accent={current.color}>
    <div className="bk-pub-manage">
      <p className="bk-pub-hostname">{booking.hostName}</p>
      <h1 className="ui-public-title">{booking.typeTitle}</h1>
      <p className={`bk-pub-status ${booking.status}`}>{cancelled ? "Cancelled" : booking.status === "pending" ? "Awaiting the host's confirmation" : booking.status === "confirmed" ? "Confirmed" : booking.status === "completed" ? "Completed" : booking.status}</p>
      <ul className="bk-pub-facts">
        <li><Clock aria-hidden="true" />{booking.when}</li>
        <li><Icon aria-hidden="true" />{booking.location || booking.locationLabel}</li>
        <li><Users aria-hidden="true" />{[booking.bookerName, ...booking.guests].join(", ")}</li>
      </ul>
      {booking.cancelReason && cancelled && <p className="ui-public-text">Reason: {booking.cancelReason}</p>}
      {mode === "view" && !cancelled && <div className="bk-pub-actions">
        <a className="bk-pub-button secondary" href={`/api/public/bookings/manage/${encodeURIComponent(token)}/ics`} rel="noreferrer" download="booking.ics"><CalendarPlus aria-hidden="true" />Add to calendar</a>
        {current.canReschedule && <button type="button" className="bk-pub-button secondary" onClick={() => setMode("reschedule")}>Reschedule</button>}
        {current.canCancel && <button type="button" className="bk-pub-button danger" onClick={() => setMode("cancel")}>Cancel booking</button>}
      </div>}
      {mode === "reschedule" && <section className="bk-pub-reschedule" aria-label="Choose a new time">
        <SlotPicker load={(from, to, zone) => call<SlotDays>(`/bookings/manage/${encodeURIComponent(token)}/slots?${new URLSearchParams({ from, to, tz: zone })}`)} tz={tz} onTz={setTz} picked={picked} onPick={setPicked} label="Choose a new time" />
        <Field label="Message to the host (optional)"><textarea maxLength={500} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
        <div className="bk-pub-actions">
          <button type="button" className="bk-pub-button" disabled={!picked} onClick={() => void act("reschedule")}>{picked ? `Move to ${new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(picked))}` : "Pick a new time"}</button>
          <button type="button" className="bk-pub-link" onClick={() => setMode("view")}>Keep the current time</button>
        </div>
      </section>}
      {mode === "cancel" && <form className="bk-pub-fields" noValidate onSubmit={(event) => { event.preventDefault(); void act("cancel"); }}>
        <Field label="Reason (optional)"><textarea maxLength={500} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></Field>
        <div className="bk-pub-actions">
          <button type="submit" className="bk-pub-button danger">Cancel booking</button>
          <button type="button" className="bk-pub-link" onClick={() => setMode("view")}>Keep it</button>
        </div>
      </form>}
      {failure && <p className="bk-pub-error" role="alert">{failure}</p>}
    </div>
  </Shell>;
}
