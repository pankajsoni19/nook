import { useEffect, useMemo, useRef, useState } from "react";
import { PublicDone, PublicNotFound, PublicPageShell } from "../public/PublicPageShell";
import { QuestionRenderer } from "../ui/questions/QuestionRenderer";
import { inlineText } from "../ui/questions/inline";
import { LivePoll } from "../ui/live/LiveWidgets";
import { appName } from "../appName";
import type { FormDisplay, FormEnding, FormKind, PollResults, ResultsVisibility } from "../../shared/forms";
import type { Answers, QuestionSet, SlotVote } from "../../shared/questions";
import { HONEYPOT_FIELD, NONCE_FIELD } from "../../shared/publicPages";
import { TimePollGrid } from "./PollViews";
import "../ui/questions/questions.css";
import "../ui/live/live.css";
import "./forms.css";

/**
 * A public form, poll, or time poll (`/p/f/<token>`, §B.8, §D.1 UI "Public page", D831): no session,
 * the light public shell (dark when the visitor's system is), the shared renderer in its public
 * theme (page or one question at a time, with progress), inline validation, the honeypot and the
 * signed render nonce the server checks, email verification when the form asks for it, the ending
 * screen, and poll results when the owner shows them. "One per browser" uses a random id kept in
 * this browser (best effort; T515).
 */

type PublicForm = {
  kind: FormKind; title: string; description: string; display: FormDisplay; theme: { accent: string | null }; ending: FormEnding; showProgress: boolean; anonymous: boolean;
  verifyEmail: boolean; limitPer: string; resultsVisibility: ResultsVisibility; closesAt: string | null; accepting: boolean; closedReason: string | null; finalizedSlotId: string | null; responseCount: number | null;
};
type Loaded = { form: PublicForm; set: QuestionSet; renderNonce: string | null; meta: { appName: string; workspaceName: string; logoUrl: string | null }; results: PollResults | null };

const BROWSER_KEY = "nook-public-browser";
function browserId() {
  try {
    let value = localStorage.getItem(BROWSER_KEY);
    if (!value || !/^[A-Za-z0-9_-]{16,64}$/.test(value)) {
      value = Array.from(crypto.getRandomValues(new Uint8Array(18)), (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 32);
      localStorage.setItem(BROWSER_KEY, value);
    }
    return value;
  } catch { return undefined; }
}
const doneKey = (token: string) => `nook-public-done:${token.slice(0, 12)}`;

async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "omit", referrerPolicy: "no-referrer" });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, payload };
}

export default function PublicFormPage({ path, search }: { path: string; search: string }) {
  const token = path.split("/")[3] ?? "";
  const browser = useMemo(browserId, []);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [missing, setMissing] = useState(false);
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ ending: string | null; results: PollResults | null } | null>(null);
  const [verify, setVerify] = useState<{ id: string; mailQueued: boolean } | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [votes, setVotes] = useState<Record<string, SlotVote>>({});
  const honeypot = useRef<HTMLInputElement>(null);
  const started = useRef(false);
  const api = `/api/public/forms/${encodeURIComponent(token)}`;

  useEffect(() => {
    fetch(`${api}${browser ? `?browser=${browser}` : ""}`, { credentials: "omit" }).then(async (response) => {
      if (!response.ok) { setMissing(true); return; }
      const body = await response.json() as Loaded;
      setLoaded(body);
      document.title = `${body.form.title} · ${body.meta.appName}`;
    }).catch(() => setMissing(true));
  }, [api, browser]);
  const hidden = useMemo(() => {
    const params = new URLSearchParams(search);
    const out: Record<string, string> = {};
    for (const question of loaded?.set.questions ?? []) if (question.type === "hidden" && question.hiddenKey && params.get(question.hiddenKey)) out[question.id] = params.get(question.hiddenKey)!.slice(0, 500);
    return out;
  }, [loaded, search]);

  if (missing) return <PublicNotFound appName={appName()} />;
  if (!loaded) return <div className="ui-public" aria-busy="true"><p role="status" className="ui-visually-hidden">Loading…</p></div>;
  const { form, set, meta } = loaded;
  const answeredHere = (() => { try { return localStorage.getItem(doneKey(token)) === "1"; } catch { return false; } })();

  const submit = async (checked: Answers) => {
    setBusy(true);
    setErrors({});
    setMessage(null);
    const result = await post(`${api}/responses`, {
      answers: checked, hidden, browser, ...(name.trim() || email.trim() ? { respondent: { name: name.trim() || undefined, email: email.trim() || undefined } } : {}),
      [NONCE_FIELD]: loaded.renderNonce, [HONEYPOT_FIELD]: honeypot.current?.value ?? ""
    }).catch(() => ({ status: 0, payload: {} as Record<string, unknown> }));
    setBusy(false);
    if (result.status === 201) {
      try { localStorage.setItem(doneKey(token), "1"); } catch { /* private mode */ }
      setDone({ ending: (result.payload.ending as string | null) ?? null, results: (result.payload.results as PollResults | null) ?? null });
      return;
    }
    if (result.status === 202) { setVerify({ id: String(result.payload.verificationId), mailQueued: Boolean(result.payload.mailQueued) }); return; }
    if (result.payload.errors && typeof result.payload.errors === "object") setErrors(result.payload.errors as Record<string, string>);
    const code = String(result.payload.code ?? "");
    setMessage(code === "TOO_FAST" ? "That was quick! Take a moment to check your answers, then send again." : code === "REPLAY" || code === "INVALID" ? "This page is out of date. Reload it and try again." : String(result.payload.error ?? "Could not send. Check your connection and try again."));
    if (code === "TOO_FAST" || code === "REPLAY" || code === "INVALID") {
      // A fresh nonce for the next try.
      fetch(api, { credentials: "omit" }).then((response) => response.ok ? response.json() : null).then((body: Loaded | null) => { if (body) setLoaded({ ...loaded, renderNonce: body.renderNonce }); }).catch(() => undefined);
    }
  };
  const confirm = async () => {
    if (!verify) return;
    setBusy(true);
    const result = await post(`${api}/verify`, { id: verify.id, code: code.trim() }).catch(() => ({ status: 0, payload: {} as Record<string, unknown> }));
    setBusy(false);
    if (result.status === 201) { setVerify(null); setDone({ ending: (result.payload.ending as string | null) ?? null, results: (result.payload.results as PollResults | null) ?? null }); return; }
    setMessage(String(result.payload.error ?? "That code did not work"));
  };

  const honeypotField = <div className="forms-hp" aria-hidden="true"><label>Website<input ref={honeypot} name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" defaultValue="" /></label></div>;
  const header = <header className="forms-public-head">
    <h1 className="ui-public-title">{form.title}</h1>
    {form.description && <p className="ui-public-text">{inlineText(form.description)}</p>}
    {form.anonymous && <p className="ui-public-text">Anonymous: your name is not saved with your answers.</p>}
  </header>;
  const shell = (children: React.ReactNode) => <PublicPageShell workspaceName={meta.workspaceName} logoUrl={meta.logoUrl} appName={meta.appName} accent={form.theme.accent}
    footer={<p>Your answers go to the people who run this {form.kind === "form" ? "form" : "poll"}.</p>}>{children}</PublicPageShell>;

  if (done) {
    const ending = set.endings.find((item) => item.id === done.ending);
    const pollQuestion = set.questions[0];
    return shell(<>
      <PublicDone title={ending?.title ?? form.ending.title}>{(ending?.body ?? form.ending.body) ? <p>{inlineText(ending?.body ?? form.ending.body)}</p> : null}</PublicDone>
      {form.kind === "poll" && done.results && pollQuestion && <LivePoll question={pollQuestion.title} options={(pollQuestion.options ?? []).map((option) => ({ id: option.id, label: option.label }))} counts={done.results.summary?.kind === "choice" ? Object.fromEntries(done.results.summary.options.map((option) => [option.optionId, option.count])) : null} closed={!form.accepting} />}
    </>);
  }
  if (verify) return shell(<>
    {header}
    <div className="forms-verify">
      <p className="ui-public-text">{verify.mailQueued ? "We sent a 6-digit code to your email. Enter it to send your response." : "Email is not set up here, so no code can be sent. Ask the form's owner."}</p>
      <label className="forms-public-field"><span>Code</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} /></label>
      {message && <p className="forms-public-error" role="alert">{message}</p>}
      <button type="button" className="ui-q-submit" disabled={busy || code.length !== 6} onClick={() => { void confirm(); }}>Confirm</button>
    </div>
  </>);
  if (!form.accepting) return shell(<>
    {header}
    <p className="ui-public-text forms-public-closed">{form.closedReason === "not_open_yet" ? "This form is not open yet." : form.finalizedSlotId ? "The time has been chosen. Thanks for voting." : "This form is closed."}</p>
    {form.kind === "time_poll" && loaded.results && set.questions[0] && <TimePollGrid question={set.questions[0]} results={loaded.results} votes={{}} editable={false} finalizedSlotId={form.finalizedSlotId} />}
  </>);
  if (answeredHere && form.limitPer !== "none") return shell(<>{header}<PublicDone title="You already responded">You can close this page.</PublicDone></>);

  if (form.kind === "poll") {
    const question = set.questions[0]!;
    return shell(<>
      {honeypotField}
      <LivePoll question={question.title} options={(question.options ?? []).map((option) => ({ id: option.id, label: option.label }))} multiple={question.type === "multi_choice"}
        counts={loaded.results?.summary?.kind === "choice" ? Object.fromEntries(loaded.results.summary.options.map((option) => [option.optionId, option.count])) : null}
        resultsHidden={form.resultsVisibility === "after_close"} onVote={async (ids) => { await submit({ [question.id]: question.type === "multi_choice" ? { options: ids } : ids[0]! } as Answers); }} />
      {form.description && <p className="ui-public-text">{inlineText(form.description)}</p>}
      {message && <p className="forms-public-error" role="alert">{message}</p>}
    </>);
  }
  if (form.kind === "time_poll") {
    const question = set.questions[0]!;
    return shell(<>
      {header}
      {honeypotField}
      <div className="forms-public-who">
        <label className="forms-public-field"><span>Your name</span><input value={name} maxLength={120} autoComplete="name" onChange={(event) => setName(event.target.value)} aria-invalid={errors._name ? true : undefined} /></label>
        <label className="forms-public-field"><span>Email (optional, to hear the final time)</span><input type="email" value={email} maxLength={254} autoComplete="email" onChange={(event) => setEmail(event.target.value)} /></label>
      </div>
      {errors._name && <p className="forms-public-error" role="alert">{errors._name}</p>}
      <TimePollGrid question={question} results={loaded.results} votes={votes} onChange={setVotes} editable finalizedSlotId={null} />
      {message && <p className="forms-public-error" role="alert">{message}</p>}
      <button type="button" className="ui-q-submit" disabled={busy || !name.trim()} onClick={() => { void submit({ [question.id]: Object.fromEntries((question.slots ?? []).map((slot) => [slot.id, votes[slot.id] ?? "no"])) } as Answers); }}>{busy ? "Sending…" : "Send my times"}</button>
    </>);
  }
  return shell(<>
    {honeypotField}
    {message && <p className="forms-public-error" role="alert">{message}</p>}
    <QuestionRenderer set={set} answers={answers} errors={errors} submitting={busy} hidden={hidden} mode={form.display} theme="public" audience="public" header={header}
      onChange={(next) => { setAnswers(next); if (!started.current) { started.current = true; void post(`${api}/visit`, {}).catch(() => undefined); } }}
      onSubmit={(checked) => submit(checked)} submitLabel={form.verifyEmail ? "Continue" : "Submit"} />
  </>);
}
