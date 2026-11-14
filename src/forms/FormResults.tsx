import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Download, Inbox, ListFilter, Rows3, X } from "lucide-react";
import { ApiError } from "../api";
import { QuestionSummary } from "../ui/questions/QuestionSummary";
import { ResponseViewer, answerText } from "../ui/questions/ResponseViewer";
import { ItemTimeline } from "../ui/activity/ItemTimeline";
import { KpiRow, KpiTile, InsightChart } from "../ui/insights/Insights";
import { EmptyState } from "../ui/EmptyState";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { YES_NO_OPTIONS, type QuestionSet } from "../../shared/questions";
import type { FormSummaryView } from "../../shared/forms";
import { deleteResponse, exportUrl, getResponse, getSummary, listResponses, respondView, undo, type ResponseFilterInput, type ResponseRow } from "./formsApi";
import { FormFrame, MissingForm, useFormDetail, type FormsNav } from "./FormsApp";
import { SelectField } from "./fields";
import { TimePollGrid } from "./PollViews";
import { module as formsModule } from "./module";

/**
 * Results (§D.1 UI "Results"): Summary (KPIs, the completion funnel, responses per day, one summary per
 * question from the shared QuestionSummary), Responses (a table with a column picker; one response
 * in the shared ResponseViewer with J/K, delete with Undo, and comments), a filter "where <question> is
 * <answer>" that applies to both and to the CSV export.
 */
const ZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
type Tab = "summary" | "responses";

/**
 * Results a person cannot read (D1111): someone asked to answer the form is told the results are its
 * owners' and gets a way to it, instead of "not shared with you"; anyone else sees the usual not-found.
 */
function ResultsNotShared({ nav, formRef }: { nav: FormsNav; formRef: string }) {
  const [respondent, setRespondent] = useState<{ href: string; title: string } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    respondView(formRef).then((view) => { if (live) setRespondent({ href: view.form.href, title: view.form.title }); }, () => { if (live) setRespondent(null); });
    return () => { live = false; };
  }, [formRef]);
  if (respondent === undefined) return <p className="ui-panel-loading" role="status">Loading…</p>;
  if (respondent === null) return <MissingForm nav={nav} />;
  const segment = respondent.href.split("/").filter(Boolean).pop() ?? formRef;
  return <FormFrame nav={nav} form={null} view="respond" title={respondent.title}>
    <EmptyState icon={BarChart3} title="Results are for the form's owners" action={{ label: "Open the form", onClick: () => nav.go([segment]) }}>You were asked to answer this form. When its owner shares results with people who answered, they show after you respond.</EmptyState>
  </FormFrame>;
}

export default function FormResults({ nav, formRef, search }: { nav: FormsNav; formRef: string; search: string }) {
  const { form, state } = useFormDetail(formRef, nav, "results");
  const params = new URLSearchParams(search);
  const [tab, setTab] = useState<Tab>(params.get("response") || params.get("tab") === "responses" ? "responses" : "summary");
  const [filter, setFilter] = useState<ResponseFilterInput>({ question: params.get("question"), option: params.get("option") });
  const [summary, setSummary] = useState<FormSummaryView | null>(null);
  const [rows, setRows] = useState<ResponseRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(params.get("response"));
  const [columns, setColumns] = useState<string[] | null>(null);
  const reload = useCallback(async () => {
    if (!form) return;
    try {
      const [loadedSummary, page] = await Promise.all([getSummary(form.id, filter), listResponses(form.id, filter)]);
      setSummary(loadedSummary);
      setRows(page.items);
      setCursor(page.nextCursor);
    } catch (error) { notify.error(error instanceof ApiError ? error.message : "Could not load results"); }
  }, [form?.id, filter.question, filter.option]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [reload]);
  const set = summary?.set ?? null;
  const answerable = useMemo(() => (set?.questions ?? []).filter((question) => !["statement"].includes(question.type)), [set]);
  const shown = columns ?? answerable.slice(0, 4).map((question) => question.id);
  const filterable = (set?.questions ?? []).filter((question) => ["single_choice", "dropdown", "yes_no", "multi_choice", "hidden"].includes(question.type));
  const filterQuestion = filterable.find((question) => question.id === filter.question);
  const openIndex = rows?.findIndex((row) => row.id === openId) ?? -1;

  if (state === "missing") return <ResultsNotShared nav={nav} formRef={formRef} />;
  const timePoll = form?.kind === "time_poll";
  return <FormFrame nav={nav} form={form} view="results"
    primary={form ? { label: "Export CSV", icon: Download, shortcut: false, onClick: () => { window.location.assign(exportUrl(form.id, filter)); } } : undefined}>
    {!form || !summary || !rows ? <p className="ui-panel-loading" role="status">Loading…</p> : <>
      <div className="forms-editor-bar">
        <div className="ui-segmented" role="tablist" aria-label="Results">
          <button type="button" role="tab" aria-selected={tab === "summary"} aria-pressed={tab === "summary"} onClick={() => setTab("summary")}><BarChart3 aria-hidden="true" />Summary</button>
          <button type="button" role="tab" aria-selected={tab === "responses"} aria-pressed={tab === "responses"} onClick={() => setTab("responses")}><Rows3 aria-hidden="true" />Responses <span className="ui-tabular">{summary.responses}</span></button>
        </div>
        {filterable.length > 0 && <div className="forms-filter">
          <ListFilter aria-hidden="true" />
          <SelectField label="Where" value={filter.question ?? "__all"} onChange={(question) => setFilter(question === "__all" ? {} : { question, option: null })} options={[{ value: "__all", label: "All responses" }, ...filterable.map((question) => ({ value: question.id, label: question.title || "Untitled question" }))]} />
          {filterQuestion && <SelectField label="is" value={filter.option ?? null} onChange={(option) => setFilter({ question: filterQuestion.id, option })}
            options={filterQuestion.type === "yes_no" ? YES_NO_OPTIONS.map((option) => ({ value: option.id, label: option.label })) : filterQuestion.type === "hidden" ? (summary.questions.find((item) => item.questionId === filterQuestion.id && item.kind === "choice") as { options?: Array<{ optionId: string; label: string }> } | undefined)?.options?.map((option) => ({ value: option.optionId, label: option.label })) ?? [] : (filterQuestion.options ?? []).map((option) => ({ value: option.id, label: option.label }))} />}
          {filter.question && <button type="button" className="icon-button" aria-label="Clear the filter" onClick={() => setFilter({})}><X /></button>}
        </div>}
      </div>
      {summary.responses === 0 && !filter.question ? <EmptyState icon={Inbox} title="No responses yet" action={form.kind === "form" ? { label: "Share the form", onClick: () => nav.go([form.href.split("/")[2]!, "edit"]) } : undefined}>Responses show here as soon as people answer.</EmptyState>
        : tab === "summary" ? <SummaryTab summary={summary} anonymous={form.anonymous} timePoll={timePoll} finalizedSlotId={form.finalizedSlotId} />
          : <ResponsesTab rows={rows} set={set} shown={shown} answerable={answerable} onColumns={setColumns} onOpen={setOpenId} more={cursor ? async () => { const page = await listResponses(form.id, filter, cursor); setRows([...rows, ...page.items]); setCursor(page.nextCursor); } : null} anonymous={form.anonymous} />}
      {openId && openIndex >= 0 && <ResponseSheet formId={form.id} row={rows[openIndex]!} position={openIndex + 1} total={rows.length} canComment={form.level !== "view" && form.level !== null} anonymous={form.anonymous}
        onClose={() => setOpenId(null)} onPrev={openIndex > 0 ? () => setOpenId(rows[openIndex - 1]!.id) : undefined} onNext={openIndex < rows.length - 1 ? () => setOpenId(rows[openIndex + 1]!.id) : undefined}
        onDeleted={(ticket) => {
          setOpenId(null);
          void reload();
          notify.success("Response deleted", { action: { label: "Undo", onClick: () => { void undo(ticket).then(() => reload()).catch(() => notify.error("Could not undo")); } } });
        }} />}
    </>}
  </FormFrame>;
}

function SummaryTab({ summary, anonymous, timePoll, finalizedSlotId }: { summary: FormSummaryView; anonymous: boolean; timePoll: boolean; finalizedSlotId: string | null }) {
  const completion = summary.funnel.views ? Math.min(1, summary.funnel.submits / summary.funnel.views) : null;
  const slotsQuestion = timePoll ? summary.set?.questions.find((question) => question.type === "time_slots") : undefined;
  return <div className="forms-summary">
    <KpiRow>
      <KpiTile label="Responses" value={summary.responses} />
      <KpiTile label="Views" value={summary.funnel.views} hint="Times the form was opened" />
      <KpiTile label="Started" value={summary.funnel.starts} />
      <KpiTile label="Completion" value={completion} unit="percent" hint="Submitted ÷ viewed" />
    </KpiRow>
    {summary.byDay.length > 1 && <InsightChart title="Responses per day" kind="bar" categories={summary.byDay.map((item) => item.day)} series={[{ name: "Responses", values: summary.byDay.map((item) => item.count) }]} height={200} />}
    {summary.textHidden && <p className="forms-note">This form is anonymous: text answers show once there are at least 3 responses, so no one can be recognized.</p>}
    {anonymous && <p className="forms-muted">Anonymous: no names, emails, or times of day are kept with these answers.</p>}
    {slotsQuestion && <TimePollGrid question={slotsQuestion} results={{ total: summary.responses, summary: summary.questions.find((item) => item.questionId === slotsQuestion.id) ?? null, voters: [], participants: [] }} votes={{}} editable={false} finalizedSlotId={finalizedSlotId} />}
    {summary.set && <QuestionSummary set={summary.set} summary={summary} />}
  </div>;
}

function ResponsesTab({ rows, set, shown, answerable, onColumns, onOpen, more, anonymous }: { rows: ResponseRow[]; set: QuestionSet | null; shown: string[]; answerable: QuestionSet["questions"]; onColumns: (ids: string[]) => void; onOpen: (id: string) => void; more: (() => Promise<void>) | null; anonymous: boolean }) {
  const [picking, setPicking] = useState(false);
  const columns = answerable.filter((question) => shown.includes(question.id));
  if (!set) return null;
  return <div className="forms-responses">
    <div className="forms-row-actions"><button type="button" className="secondary-button ui-small-button" aria-expanded={picking} onClick={() => setPicking(!picking)}><Rows3 aria-hidden="true" />Columns · {columns.length}</button></div>
    {picking && <fieldset className="forms-columns"><legend className="ui-visually-hidden">Columns</legend>{answerable.map((question) => <label key={question.id} className="forms-check">
      <input type="checkbox" checked={shown.includes(question.id)} onChange={(event) => onColumns(event.target.checked ? [...shown, question.id] : shown.filter((id) => id !== question.id))} />{question.title || "Untitled question"}
    </label>)}</fieldset>}
    <div className="forms-table-wrap" role="region" aria-label="Responses" tabIndex={0}>
      <table className="forms-table">
        <thead><tr><th scope="col">{anonymous ? "Submitted" : "Respondent"}</th>{columns.map((question) => <th key={question.id} scope="col">{question.title || "Untitled question"}</th>)}<th scope="col">Actions</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id} onClick={() => onOpen(row.id)}>
          <th scope="row"><button type="button" className="forms-link" onClick={(event) => { event.stopPropagation(); onOpen(row.id); }}>{anonymous ? row.submittedAt.slice(0, 10) : row.respondentName}</button>{!anonymous && <small>{new Date(row.submittedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}{row.setVersion ? ` · v${row.setVersion}` : ""}</small>}</th>
          {columns.map((question) => <td key={question.id}>{answerText(question, row.answers[question.id] as never, ZONE) || <span className="forms-muted">—</span>}</td>)}
          <td>{row.actions.length ? row.actions.map((action) => <span key={action.kind} className={`forms-run ${action.status}`}>{action.kind === "create_card" ? "Card" : action.kind === "save_contact" ? "Contact" : action.kind === "create_deal" ? "Deal" : "Notified"}</span>) : <span className="forms-muted">—</span>}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {more && <button type="button" className="secondary-button forms-more" onClick={() => { void more(); }}>Show more</button>}
  </div>;
}

function ResponseSheet({ formId, row, position, total, canComment, anonymous, onClose, onPrev, onNext, onDeleted }: { formId: string; row: ResponseRow; position: number; total: number; canComment: boolean; anonymous: boolean; onClose: () => void; onPrev?: () => void; onNext?: () => void; onDeleted: (ticket: string) => void }) {
  const [detail, setDetail] = useState<{ set: QuestionSet | null; canDelete: boolean; response: ResponseRow } | null>(null);
  useEffect(() => { setDetail(null); getResponse(formId, row.id).then(setDetail).catch(() => setDetail(null)); }, [formId, row.id]);
  return <ModalDialog title={anonymous ? "Anonymous response" : `Response from ${row.respondentName}`} eyebrow={`${position} of ${total}`} onClose={onClose} variant="sheet" className="forms-sheet wide">
    <div className="file-dialog-body forms-sheet-body">
      {!detail || !detail.set ? <p className="ui-panel-loading">Loading…</p> : <>
        <ResponseViewer set={detail.set} response={detail.response} position={position} total={total} onPrev={onPrev} onNext={onNext} showScore timeZone={ZONE}
          onDelete={detail.canDelete ? () => { void deleteResponse(formId, row.id).then((result) => onDeleted(result.undoTicket)).catch((error) => notify.error(error instanceof ApiError ? error.message : "Could not delete")); } : undefined} />
        {detail.response.actions.length > 0 && <p className="forms-muted">Actions: {detail.response.actions.map((action) => `${action.kind === "create_card" ? "card" : action.kind === "save_contact" ? "contact" : action.kind === "create_deal" ? "deal" : "notification"} ${action.status}`).join(", ")}</p>}
        {!anonymous && <ItemTimeline kind="response" id={row.id} canComment={canComment} title="Comments" renderers={formsModule.activityRenderers} />}
      </>}
    </div>
  </ModalDialog>;
}
