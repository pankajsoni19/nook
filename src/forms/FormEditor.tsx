import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Eye, Globe2, Link2, ListOrdered, Plus, QrCode, RefreshCw, Send, Settings2, Share2, Trash2, Users, Workflow, X } from "lucide-react";
import QRCode from "qrcode";
import { ApiError } from "../api";
import { QuestionSetEditor, type SaveState } from "../ui/questions/QuestionSetEditor";
import { QuestionRenderer } from "../ui/questions/QuestionRenderer";
import { PersonPicker } from "../ui/people/People";
import { notify } from "../ui/notify";
import { embedMarkdown } from "../../shared/embeds";
import { FORM_ACCENTS, type FormDetail } from "../../shared/forms";
import { newQuestionItemId, type Answers, type QuestionSet, type QuestionType } from "../../shared/questions";
import type { PersonSummary } from "../../shared/people";
import { createPublicLink, discardDraft, getDraft, patchForm, publishForm, revokePublicLink, saveDraft } from "./formsApi";
import { FormFrame, MissingForm, useFormDetail, type FormsNav } from "./FormsApp";
import { ActionsPanel } from "./ActionsPanel";
import { WorkspaceAccess } from "../access/WorkspaceAccess";
import { SelectField, Toggle } from "./fields";

/**
 * The form editor (§D.1 UI "Form editor", §E.4 "Editors"): the shared question editor (blocks, `/` to
 * insert, drag and ⌘↑/↓ to reorder, logic, preview) with autosave of the draft ("Saved"), an explicit
 * **Publish changes** (D841), and a live preview on wide screens; sections and endings; Settings
 * (display, limits, dates, anonymity, results, theme, ending); Sharing (who answers, the public link
 * with a QR code, the embed line, who sees results); and Actions (cards, contacts, notifications).
 */

type Panel = "questions" | "settings" | "sharing" | "actions";
const ZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
const errorText = (error: unknown, fallback: string) => error instanceof ApiError ? error.message : fallback;
const ALLOWED: Record<string, readonly QuestionType[] | undefined> = { poll: ["single_choice", "multi_choice"], time_poll: ["time_slots"], form: undefined };

export default function FormEditor({ nav, formRef }: { nav: FormsNav; formRef: string }) {
  const { form, setForm, state } = useFormDetail(formRef, nav, "edit");
  const [set, setSet] = useState<QuestionSet | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>(null);
  const [publishing, setPublishing] = useState(false);
  const [panel, setPanel] = useState<Panel>("questions");
  const [preview, setPreview] = useState<Answers>({});
  const timer = useRef<number | null>(null);
  const pending = useRef<QuestionSet | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!form) return;
    getDraft(form.id).then((draft) => { setSet(draft.set); setHasDraft(draft.hasDraft || form.status === "draft"); }).catch(() => undefined);
  }, [form?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = useCallback(async () => {
    if (!form || !pending.current) return;
    const next = pending.current;
    pending.current = null;
    controller.current?.abort();
    controller.current = new AbortController();
    setSaveState("saving");
    try {
      const saved = await saveDraft(form.id, next, controller.current.signal);
      setHasDraft(saved.hasDraft || form.status === "draft");
      setSaveState("saved");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSaveState("error");
      // A problem the server found (it checks what the editor shows) stays visible on the block.
    }
  }, [form]);
  const change = (next: QuestionSet) => {
    setSet(next);
    pending.current = next;
    setSaveState("saving");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flush(); }, 700);
  };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); if (pending.current) void flush(); }, [flush]);
  useEffect(() => {
    if (saveState !== "saving") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  if (state === "missing") return <MissingForm nav={nav} />;
  if (form && form.level && !["owner", "manage", "edit"].includes(form.level)) return <MissingForm nav={nav} />;
  const publish = async () => {
    if (!form) return;
    if (timer.current) { window.clearTimeout(timer.current); await flush(); }
    setPublishing(true);
    try {
      const { form: next } = await publishForm(form.id);
      setForm(next);
      setHasDraft(false);
      notify.success(form.status === "draft" ? "Published. People can respond now." : "Changes published. Earlier responses keep the questions they answered.");
    } catch (error) { notify.error(errorText(error, "Could not publish")); }
    finally { setPublishing(false); }
  };
  const patch = async (body: Record<string, unknown>) => {
    if (!form) return;
    try { setForm((await patchForm(form.id, body)).form); }
    catch (error) { notify.error(errorText(error, "Could not save")); }
  };
  const published = (form?.version ?? 0) > 0;
  return <FormFrame nav={nav} form={form} view="edit"
    primary={form && (hasDraft || form.status === "draft") ? { label: form.status === "draft" ? "Publish" : "Publish changes", icon: Send, onClick: () => { void publish(); }, disabled: publishing || !set?.questions.length, shortcut: false } : form ? { label: "Share", icon: Share2, onClick: () => setPanel("sharing"), shortcut: false } : undefined}
    menuExtra={form && hasDraft && published ? [{ id: "discard", label: "Discard changes", icon: Trash2, onSelect: () => { void discardDraft(form.id).then(async ({ form: next }) => { setForm(next); const draft = await getDraft(form.id); setSet(draft.set); setHasDraft(false); notify.success("Back to the published version"); }); } }] : []}
    detail={panel === "questions" && set && set.questions.length > 0 ? <div className="forms-preview" aria-label="Live preview">
      <p className="forms-preview-label"><Eye aria-hidden="true" />Preview</p>
      <QuestionRenderer set={set} answers={preview} onChange={setPreview} onSubmit={() => setPreview({})} mode={form?.display ?? "page"} audience={form?.audience === "public" ? "public" : "member"} submitLabel="Submit (preview)" timeZone={ZONE}
        header={<header className="forms-respond-head"><h2>{form?.title}</h2></header>} />
    </div> : undefined}>
    {!form || !set ? <p className="ui-panel-loading" role="status">Loading…</p> : <>
      <div className="forms-editor-bar">
        <div className="ui-segmented forms-panels" role="tablist" aria-label="Edit">
          {([["questions", "Questions", ListOrdered], ["settings", "Settings", Settings2], ["sharing", "Sharing", Share2], ["actions", "Actions", Workflow]] as const)
            .filter(([id]) => id !== "actions" || form.kind === "form")
            .map(([id, label, Icon]) => <button key={id} type="button" role="tab" aria-selected={panel === id} aria-pressed={panel === id} onClick={() => setPanel(id)}><Icon aria-hidden="true" />{label}</button>)}
        </div>
        <span className="forms-status-line">{form.status === "draft" ? "Draft · not published" : hasDraft ? `Unpublished changes · v${form.version} is live` : `Published · v${form.version}`}</span>
      </div>
      {panel === "questions" && <>
        <TitleEditor form={form} onSave={patch} />
        <QuestionSetEditor set={set} onChange={change} audience={form.audience === "public" ? "public" : "member"} allowedTypes={ALLOWED[form.kind]}
          roles={form.kind === "form" ? ["contact_name", "contact_email", "contact_phone", "company"] : []} saveState={saveState}
          onPublish={hasDraft || form.status === "draft" ? () => { void publish(); } : undefined} publishLabel={form.status === "draft" ? "Publish" : "Publish changes"} publishing={publishing} />
        {form.kind === "form" && <SectionsPanel set={set} onChange={change} />}
      </>}
      {panel === "settings" && <SettingsPanel form={form} onSave={patch} />}
      {panel === "sharing" && <SharingPanel form={form} onSave={patch} setForm={setForm} />}
      {panel === "actions" && <ActionsPanel form={form} set={set} />}
    </>}
  </FormFrame>;
}

function TitleEditor({ form, onSave }: { form: FormDetail; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [title, setTitle] = useState(form.title);
  const [description, setDescription] = useState(form.description);
  useEffect(() => { setTitle(form.title); setDescription(form.description); }, [form.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="forms-title-editor">
    <input className="forms-title-input" aria-label="Form title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} onBlur={() => { if (title.trim() && title !== form.title) void onSave({ title: title.trim() }); }} />
    <textarea className="forms-description-input" aria-label="Description" placeholder="Add a description (optional)" rows={2} value={description} maxLength={20000} onChange={(event) => setDescription(event.target.value)} onBlur={() => { if (description !== form.description) void onSave({ description }); }} />
  </div>;
}

/** Sections (page breaks with a heading) and custom endings; logic's "skip to" targets them. */
function SectionsPanel({ set, onChange }: { set: QuestionSet; onChange: (set: QuestionSet) => void }) {
  if (set.questions.length === 0) return null;
  const sectionOptions = [{ value: "__none", label: "No section" }, ...set.sections.map((section, index) => ({ value: section.id, label: section.title || `Section ${index + 1}` }))];
  return <section className="forms-panel" aria-labelledby="forms-sections">
    <header className="ui-panel-header"><h3 id="forms-sections"><ListOrdered aria-hidden="true" />Sections and endings</h3></header>
    <p className="forms-muted">Sections group questions under a heading (one page each in one-question-at-a-time mode). Endings are the thank-you screens logic can send people to.</p>
    <ul className="forms-sections">{set.sections.map((section, index) => <li key={section.id}>
      <input aria-label={`Section ${index + 1} title`} value={section.title ?? ""} placeholder={`Section ${index + 1}`} maxLength={500} onChange={(event) => onChange({ ...set, sections: set.sections.map((item) => item.id === section.id ? { ...item, title: event.target.value } : item) })} />
      <button type="button" className="icon-button" aria-label={`Remove section ${index + 1}`} onClick={() => onChange({ ...set, sections: set.sections.filter((item) => item.id !== section.id), questions: set.questions.map((question) => question.sectionId === section.id ? { ...question, sectionId: undefined } : question), logic: set.logic.filter((rule) => !("jumpTo" in rule.then && rule.then.jumpTo === section.id)) })}><X /></button>
    </li>)}</ul>
    <button type="button" className="secondary-button ui-small-button" disabled={set.sections.length >= 50} onClick={() => onChange({ ...set, sections: [...set.sections, { id: newQuestionItemId(), title: `Section ${set.sections.length + 1}` }] })}><Plus aria-hidden="true" />Add section</button>
    {set.sections.length > 0 && <ol className="forms-section-map">{set.questions.map((question, index) => <li key={question.id}>
      <span className="ui-tabular">{index + 1}.</span><span className="forms-section-q">{question.title || "Untitled question"}</span>
      <SelectField label={`Section of question ${index + 1}`} value={question.sectionId ?? "__none"} options={sectionOptions} onChange={(value) => onChange({ ...set, questions: set.questions.map((item) => item.id === question.id ? { ...item, sectionId: value === "__none" ? undefined : value } : item) })} />
    </li>)}</ol>}
    <h4 className="forms-subhead">Endings</h4>
    <ul className="forms-endings">{set.endings.map((ending, index) => <li key={ending.id}>
      <input aria-label={`Ending ${index + 1} title`} value={ending.title} maxLength={500} onChange={(event) => onChange({ ...set, endings: set.endings.map((item) => item.id === ending.id ? { ...item, title: event.target.value } : item) })} />
      <textarea aria-label={`Ending ${index + 1} text`} rows={2} value={ending.body ?? ""} maxLength={5000} placeholder="Text under the title (optional)" onChange={(event) => onChange({ ...set, endings: set.endings.map((item) => item.id === ending.id ? { ...item, body: event.target.value || undefined } : item) })} />
      <button type="button" className="icon-button" aria-label={`Remove ending ${index + 1}`} onClick={() => onChange({ ...set, endings: set.endings.filter((item) => item.id !== ending.id), logic: set.logic.filter((rule) => !("jumpTo" in rule.then && rule.then.jumpTo === ending.id)) })}><X /></button>
    </li>)}</ul>
    <button type="button" className="secondary-button ui-small-button" disabled={set.endings.length >= 10} onClick={() => onChange({ ...set, endings: [...set.endings, { id: newQuestionItemId(), title: "Thanks!" }] })}><Plus aria-hidden="true" />Add ending</button>
  </section>;
}

const toLocal = (iso: string | null) => iso ? new Date(Date.parse(iso) - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
const fromLocal = (value: string) => value ? new Date(value).toISOString() : null;

function SettingsPanel({ form, onSave }: { form: FormDetail; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [endingTitle, setEndingTitle] = useState(form.ending.title);
  const [endingBody, setEndingBody] = useState(form.ending.body);
  const [max, setMax] = useState(form.maxResponses ? String(form.maxResponses) : "");
  return <div className="forms-settings">
    <section className="forms-panel" aria-labelledby="forms-s-respond">
      <header className="ui-panel-header"><h3 id="forms-s-respond">Responding</h3></header>
      {form.kind === "form" && <SelectField label="Layout" value={form.display} onChange={(display) => { void onSave({ display }); }} options={[{ value: "page", label: "All questions on one page" }, { value: "stepper", label: "One question at a time" }]} />}
      <SelectField label="Responses per person" value={form.limitPer} onChange={(limitPer) => { void onSave({ limitPer }); }} options={[{ value: "person", label: "One per person" }, { value: "browser", label: "One per person or browser (public link)" }, { value: "none", label: "Unlimited" }]} />
      <Toggle label="Anonymous responses" checked={form.anonymous} disabled={form.responseCount > 0} onChange={(anonymous) => { void onSave({ anonymous }); }} hint={form.responseCount > 0 ? "Can't change once there are responses." : "No name, email, or exact time is kept with the answers."} />
      {form.kind === "form" && <Toggle label="People can edit their response" checked={form.allowEdit} disabled={form.anonymous} onChange={(allowEdit) => { void onSave({ allowEdit }); }} />}
      {form.kind === "form" && <Toggle label="Offer “Submit another response”" checked={form.settings.allowAnother} onChange={(allowAnother) => { void onSave({ settings: { allowAnother } }); }} hint="When responses per person is unlimited." />}
      <Toggle label="Confirm email before a public response counts" checked={form.verifyEmail} onChange={(verifyEmail) => { void onSave({ verifyEmail }); }} hint={form.mailEnabled ? "Public link only: a 6-digit code goes to the email in the form." : "Email is not set up on this server, so no code can be sent: public responses count without confirming their email."} />
    </section>
    <section className="forms-panel" aria-labelledby="forms-s-dates">
      <header className="ui-panel-header"><h3 id="forms-s-dates">Opening and closing</h3></header>
      <div className="forms-two">
        <label className="ui-field"><span>Opens</span><input type="datetime-local" defaultValue={toLocal(form.opensAt)} onBlur={(event) => { if (fromLocal(event.target.value) !== form.opensAt) void onSave({ opensAt: fromLocal(event.target.value) }); }} /><span className="ui-field-hint">Empty: as soon as it is published.</span></label>
        <label className="ui-field"><span>Closes</span><input type="datetime-local" defaultValue={toLocal(form.closesAt)} onBlur={(event) => { if (fromLocal(event.target.value) !== form.closesAt) void onSave({ closesAt: fromLocal(event.target.value) }); }} /><span className="ui-field-hint">You get a reminder a day before.</span></label>
      </div>
      <label className="ui-field forms-narrow"><span>Close after this many responses</span><input type="number" min={1} max={100000} value={max} onChange={(event) => setMax(event.target.value)} onBlur={() => { const value = max ? Number(max) : null; if (value !== form.maxResponses) void onSave({ maxResponses: value }); }} /></label>
      <div className="forms-row-actions">
        {form.status === "open" && <button type="button" className="secondary-button" onClick={() => { void onSave({ status: "closed" }); }}>Close now</button>}
        {form.status === "closed" && <button type="button" className="secondary-button" onClick={() => { void onSave({ status: "open" }); }}>Reopen</button>}
      </div>
    </section>
    <section className="forms-panel" aria-labelledby="forms-s-results">
      <header className="ui-panel-header"><h3 id="forms-s-results">Results and notifications</h3></header>
      <SelectField label="Respondents see results" value={form.resultsVisibility} onChange={(resultsVisibility) => { void onSave({ resultsVisibility }); }} options={[
        { value: "owner_only", label: "Never (only people with access)" }, { value: "live", label: "Live, before and after answering" }, { value: "after_vote", label: "After they answer" }, { value: "after_close", label: "When it closes" }
      ]} hint="Respondents see totals only, never other people's text answers." />
      <Toggle label="Tell me about new responses" checked={form.settings.notifyOnResponse} onChange={(notifyOnResponse) => { void onSave({ settings: { notifyOnResponse } }); }} hint="One notification that updates, and at most one email per 15 minutes." />
      {form.kind === "form" && <Toggle label="Show a progress line" checked={form.settings.showProgress} onChange={(showProgress) => { void onSave({ settings: { showProgress } }); }} />}
    </section>
    <section className="forms-panel" aria-labelledby="forms-s-look">
      <header className="ui-panel-header"><h3 id="forms-s-look">Look and ending</h3></header>
      <div className="forms-accents" role="radiogroup" aria-label="Accent color">
        <button type="button" role="radio" aria-checked={form.theme.accent === null} className="forms-accent none" onClick={() => { void onSave({ theme: { accent: null } }); }}><span>Default</span></button>
        {FORM_ACCENTS.map((accent) => <button key={accent} type="button" role="radio" aria-checked={form.theme.accent === accent} aria-label={`Accent ${accent}`} className="forms-accent" style={{ background: accent }} onClick={() => { void onSave({ theme: { accent } }); }} />)}
      </div>
      <label className="ui-field"><span>Thank-you title</span><input value={endingTitle} maxLength={200} onChange={(event) => setEndingTitle(event.target.value)} onBlur={() => { if (endingTitle.trim() && endingTitle !== form.ending.title) void onSave({ ending: { title: endingTitle.trim() } }); }} /></label>
      <label className="ui-field"><span>Thank-you text</span><textarea rows={3} value={endingBody} maxLength={5000} onChange={(event) => setEndingBody(event.target.value)} onBlur={() => { if (endingBody !== form.ending.body) void onSave({ ending: { body: endingBody } }); }} /></label>
    </section>
  </div>;
}


function SharingPanel({ form, onSave, setForm }: { form: FormDetail; onSave: (body: Record<string, unknown>) => Promise<void>; setForm: (form: FormDetail) => void }) {
  const manager = form.level === "owner" || form.level === "manage";
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen: PersonSummary[] = [...form.audienceUsers.map((user) => ({ kind: "user" as const, id: user.id, name: user.name })), ...form.audienceGroups.map((group) => ({ kind: "group" as const, id: group.id, name: group.name }))];
  const url = link ? `${window.location.origin}${link}` : null;
  useEffect(() => { if (url) QRCode.toDataURL(url, { margin: 1, width: 200 }).then(setQr).catch(() => setQr(null)); else setQr(null); }, [url]);
  const copy = async (text: string, what: string) => { try { await navigator.clipboard.writeText(text); notify.success(`${what} copied`); } catch { notify.info(text, { selectable: true }); } };
  const makeLink = async () => {
    setBusy(true);
    try {
      const created = await createPublicLink(form.id);
      setLink(created.path);
      setForm({ ...form, audience: "public", publicLink: created.link });
    } catch (error) { notify.error(errorText(error, "Could not make a link")); }
    finally { setBusy(false); }
  };
  const embed = embedMarkdown(form.kind === "poll" ? "poll" : form.kind === "time_poll" ? "time_poll" : "form", form.href);
  return <div className="forms-settings">
    <section className="forms-panel" aria-labelledby="forms-share-who">
      <header className="ui-panel-header"><h3 id="forms-share-who"><Users aria-hidden="true" />Who can answer</h3></header>
      <div className="ui-segmented" role="radiogroup" aria-label="Who can answer">
        {([["workspace", "Everyone in the workspace"], ["selected", "People I choose"], ["public", "Anyone with the link"]] as const).map(([value, label]) =>
          <button key={value} type="button" role="radio" aria-checked={form.audience === value} aria-pressed={form.audience === value} disabled={!manager || (value === "public" && !form.publicAllowed)}
            onClick={() => { if (value === "selected" && !chosen.length) { setForm({ ...form, audience: "selected" }); return; } if (value === "public") void makeLink(); else void onSave({ audience: value }); }}>{label}</button>)}
      </div>
      {!form.publicAllowed && <p className="forms-muted">Public links are turned off for this workspace (Settings → Workspace).</p>}
      {form.audience === "selected" && <PersonPicker label="People and groups who can answer" allow={["user", "group"]} value={chosen} disabled={!manager}
        onChange={(people) => { void onSave({ audience: "selected", audienceUsers: people.filter((person) => person.kind === "user").map((person) => (person as { id: string }).id), audienceGroups: people.filter((person) => person.kind === "group").map((person) => (person as { id: string }).id) }); }} />}
      {form.audience === "public" && <div className="forms-public">
        <p><Globe2 aria-hidden="true" />Anyone with the link can answer, without an account. Files, people, and cards can't be asked.</p>
        {url ? <>
          <div className="forms-link-row"><input readOnly value={url} aria-label="Public link" onFocus={(event) => event.target.select()} /><button type="button" className="secondary-button" onClick={() => { void copy(url, "Link"); }}><Copy aria-hidden="true" />Copy</button></div>
          {qr && <figure className="forms-qr"><img src={qr} alt="QR code of the public link" width={160} height={160} /><figcaption><QrCode aria-hidden="true" />Scan to open</figcaption></figure>}
          <p className="forms-muted">Copy it now: for safety the full link is shown only once. You can make a new one at any time.</p>
        </> : form.publicLink ? <p className="forms-muted"><Link2 aria-hidden="true" />A link starting “{form.publicLink.prefix}…” is live since {new Date(form.publicLink.createdAt).toLocaleDateString()} · {form.publicLink.useCount} {form.publicLink.useCount === 1 ? "response" : "responses"}.</p> : null}
        {manager && <div className="forms-row-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { void makeLink(); }}><RefreshCw aria-hidden="true" />{form.publicLink ? "Make a new link" : "Make the link"}</button>
          {form.publicLink && <button type="button" className="secondary-button danger" disabled={busy} onClick={() => { void revokePublicLink(form.id).then(() => { setLink(null); setForm({ ...form, audience: "workspace", publicLink: null }); notify.success("The public link no longer works"); }); }}><X aria-hidden="true" />Turn off</button>}
        </div>}
      </div>}
    </section>
    <section className="forms-panel" aria-labelledby="forms-share-embed">
      <header className="ui-panel-header"><h3 id="forms-share-embed"><Link2 aria-hidden="true" />In notes and cards</h3></header>
      <p className="forms-muted">Paste this line in a note or a card description to show the {form.kind === "poll" ? "poll (people vote right there)" : "form with a Respond button"}. In a note you can also type <kbd>/poll</kbd> or <kbd>/form</kbd>.</p>
      <div className="forms-link-row"><input readOnly value={embed} aria-label="Embed line" onFocus={(event) => event.target.select()} /><button type="button" className="secondary-button" onClick={() => { void copy(embed, "Embed line"); }}><Copy aria-hidden="true" />Copy</button></div>
      <div className="forms-link-row"><input readOnly value={`${window.location.origin}${form.href}`} aria-label="In-app link" onFocus={(event) => event.target.select()} /><button type="button" className="secondary-button" onClick={() => { void copy(`${window.location.origin}${form.href}`, "Link"); }}><Copy aria-hidden="true" />Copy</button></div>
    </section>
    <ResultsAccess form={form} />
  </div>;
}

/** Who reads results and edits: the form's access through the shared Access sheet (`/api/access/form/:id`, D842, D1050). */
function ResultsAccess({ form }: { form: FormDetail }) {
  if (form.level !== "owner" && form.level !== "manage") return null;
  return <section className="forms-panel" aria-labelledby="forms-share-results">
    <header className="ui-panel-header"><h3 id="forms-share-results"><Eye aria-hidden="true" />Who sees results</h3></header>
    <p className="forms-muted">Answering is not access: people who answer never see other people's responses unless you add them here.</p>
    <WorkspaceAccess kind="form" id={form.id} title={form.title} canManage onSaved={() => notify.success("Access saved")} />
  </section>;
}
