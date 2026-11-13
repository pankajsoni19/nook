import { useEffect, useState } from "react";
import { AlertTriangle, BellRing, CheckCircle2, Contact, KanbanSquare, Plus, RotateCcw, Trash2, Workflow } from "lucide-react";
import { ApiError } from "../api";
import { EmptyState } from "../ui/EmptyState";
import { PersonPicker } from "../ui/people/People";
import { notify } from "../ui/notify";
import { relativeTime } from "../files/format";
import type { FormAction, FormActionKind, FormDetail } from "../../shared/forms";
import type { QuestionSet } from "../../shared/questions";
import type { PersonSummary } from "../../shared/people";
import { createAction, createBook, deleteAction, getTargets, listActions, retryAction, updateAction, type Targets } from "./formsApi";
import { SelectField, Toggle } from "./fields";

/**
 * Response actions (§C C2, C3, D845): what each new response does. "Create a card" (board, column,
 * title and description templates with {{question}} tokens, a due date from a date question), "Save
 * as a contact" (a contact book; name, email, phone, and company from the questions with those roles),
 * and "Notify people". Each shows its last run; failed runs are retried automatically and can be
 * retried here.
 */
const KIND_LABEL: Record<FormActionKind, string> = { create_card: "Create a card", save_contact: "Save as a contact", notify: "Notify people", create_deal: "Create a deal" };
const KIND_ICON = { create_card: KanbanSquare, save_contact: Contact, notify: BellRing, create_deal: Workflow } as const;
const errorText = (error: unknown, fallback: string) => error instanceof ApiError ? error.message : fallback;

export function ActionsPanel({ form, set }: { form: FormDetail; set: QuestionSet }) {
  const [actions, setActions] = useState<FormAction[] | null>(null);
  const [targets, setTargets] = useState<Targets | null>(null);
  const [adding, setAdding] = useState<FormActionKind | null>(null);
  useEffect(() => {
    listActions(form.id).then((result) => setActions(result.actions)).catch(() => setActions([]));
    getTargets().then(setTargets).catch(() => setTargets({ boards: [], books: [], calendars: [] }));
  }, [form.id]);
  const describe = (action: FormAction) => {
    const config = action.config as Record<string, string | string[]>;
    if (action.kind === "create_card") {
      const board = targets?.boards.find((item) => item.id === config.boardId);
      return `${board?.name ?? "A board"} → ${board?.columns.find((column) => column.id === config.columnId)?.name ?? "a column"} · “${config.title}”`;
    }
    if (action.kind === "save_contact") return `Into ${targets?.books.find((book) => book.id === config.bookId)?.name ?? "a contact book"}`;
    if (action.kind === "notify") return `${(config.userIds as string[] | undefined)?.length ?? 0} people`;
    return "";
  };
  if (actions === null) return <p className="ui-panel-loading">Loading actions…</p>;
  return <section className="forms-panel forms-actions" aria-labelledby="forms-actions-title">
    <header className="ui-panel-header"><h3 id="forms-actions-title"><Workflow aria-hidden="true" />When someone responds</h3></header>
    {actions.length === 0 && !adding && <EmptyState icon={Workflow} title="No actions yet" compact>Turn responses into cards on a board, contacts in a book, or a ping to your team.</EmptyState>}
    <ul className="forms-action-list">{actions.map((action) => {
      const Icon = KIND_ICON[action.kind];
      return <li key={action.id} className={action.enabled ? "" : "off"}>
        <Icon aria-hidden="true" />
        <div className="forms-action-copy"><strong>{KIND_LABEL[action.kind]}</strong><span>{describe(action)}</span>
          {action.lastRun && <small className={`forms-run ${action.lastRun.status}`}>{action.lastRun.status === "failed" ? <AlertTriangle aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
            {action.lastRun.status === "failed" ? `Failed ${relativeTime(action.lastRun.at)}: ${action.lastRun.error ?? ""}` : `Last ran ${relativeTime(action.lastRun.at)}`}{action.failed ? ` · ${action.failed} failed` : ""}</small>}
        </div>
        {action.failed > 0 && <button type="button" className="secondary-button ui-small-button" onClick={() => { void retryAction(form.id, action.id).then(() => listActions(form.id)).then((result) => setActions(result.actions)); }}><RotateCcw aria-hidden="true" />Retry</button>}
        <Toggle label={action.enabled ? "On" : "Off"} checked={action.enabled} onChange={(enabled) => { void updateAction(form.id, action.id, { enabled }).then(({ action: next }) => setActions(actions.map((item) => item.id === next.id ? next : item))); }} />
        <button type="button" className="icon-button" aria-label={`Remove ${KIND_LABEL[action.kind]}`} onClick={() => { void deleteAction(form.id, action.id).then(() => setActions(actions.filter((item) => item.id !== action.id))); }}><Trash2 /></button>
      </li>;
    })}</ul>
    {adding ? <ActionForm kind={adding} form={form} set={set} targets={targets} onCancel={() => setAdding(null)} onSaved={(action) => { setActions([...actions, action]); setAdding(null); }} onTargets={setTargets} />
      : <div className="forms-row-actions">
        <button type="button" className="secondary-button" onClick={() => setAdding("create_card")}><Plus aria-hidden="true" />Create a card</button>
        <button type="button" className="secondary-button" onClick={() => setAdding("save_contact")}><Plus aria-hidden="true" />Save as a contact</button>
        <button type="button" className="secondary-button" onClick={() => setAdding("notify")}><Plus aria-hidden="true" />Notify people</button>
      </div>}
    <p className="forms-muted">Tokens: <code>{"{{Question title}}"}</code> or <code>{"{{answers}}"}</code> for every answer. Answers are inserted as plain text.</p>
  </section>;
}

function ActionForm({ kind, form, set, targets, onCancel, onSaved, onTargets }: { kind: FormActionKind; form: FormDetail; set: QuestionSet; targets: Targets | null; onCancel: () => void; onSaved: (action: FormAction) => void; onTargets: (targets: Targets) => void }) {
  const firstText = set.questions.find((question) => question.type === "short_text");
  const [boardId, setBoardId] = useState<string | null>(targets?.boards[0]?.id ?? null);
  const board = targets?.boards.find((item) => item.id === boardId);
  const [columnId, setColumnId] = useState<string | null>(board?.columns[0]?.id ?? null);
  const [title, setTitle] = useState(firstText ? `{{${firstText.title}}}` : `Response to ${form.title}`);
  const [description, setDescription] = useState("{{answers}}");
  const [due, setDue] = useState<string>("__none");
  const [bookId, setBookId] = useState<string | null>(targets?.books[0]?.id ?? null);
  const [newBook, setNewBook] = useState("");
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setColumnId(board?.columns[0]?.id ?? null); }, [boardId]); // eslint-disable-line react-hooks/exhaustive-deps
  const dates = set.questions.filter((question) => question.type === "date" || question.type === "datetime");
  const save = async () => {
    setBusy(true);
    try {
      let config: Record<string, unknown>;
      if (kind === "create_card") config = { boardId, columnId, title, description, ...(due !== "__none" ? { dueQuestionId: due } : {}) };
      else if (kind === "save_contact") {
        let book = bookId;
        if (!book && newBook.trim()) {
          const created = await createBook(newBook.trim());
          book = created.book.id;
          onTargets({ ...(targets ?? { boards: [], books: [], calendars: [] }), books: [...(targets?.books ?? []), created.book] });
        }
        config = { bookId: book };
      } else config = { userIds: people.filter((person) => person.kind === "user").map((person) => (person as { id: string }).id) };
      onSaved((await createAction(form.id, kind, config)).action);
    } catch (error) { notify.error(errorText(error, "Could not add the action")); }
    finally { setBusy(false); }
  };
  return <div className="forms-action-form">
    <h4 className="forms-subhead">{KIND_LABEL[kind]}</h4>
    {kind === "create_card" && (targets?.boards.length ? <>
      <div className="forms-two">
        <SelectField label="Board" value={boardId} onChange={setBoardId} options={targets.boards.map((item) => ({ value: item.id, label: item.name }))} />
        <SelectField label="Column" value={columnId} onChange={setColumnId} options={(board?.columns ?? []).map((column) => ({ value: column.id, label: column.name }))} />
      </div>
      <label className="ui-field"><span>Card title</span><input value={title} maxLength={500} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="ui-field"><span>Description</span><textarea rows={3} value={description} maxLength={5000} onChange={(event) => setDescription(event.target.value)} /><span className="ui-field-hint">A link back to the response is added.</span></label>
      {dates.length > 0 && <SelectField label="Due date from" value={due} onChange={setDue} options={[{ value: "__none", label: "No due date" }, ...dates.map((question) => ({ value: question.id, label: question.title || "Untitled question" }))]} />}
    </> : <p className="forms-muted">You have no board you can add cards to yet.</p>)}
    {kind === "save_contact" && <>
      {targets?.books.length ? <SelectField label="Contact book" value={bookId} onChange={setBookId} options={targets.books.map((book) => ({ value: book.id, label: book.name }))} />
        : <label className="ui-field"><span>New contact book</span><input value={newBook} placeholder="Form leads" maxLength={120} onChange={(event) => setNewBook(event.target.value)} /></label>}
      <p className="forms-muted">Uses the questions marked as contact email, name, phone, and company (or the first email question). An existing contact is only filled in, never overwritten.</p>
      {!set.questions.some((question) => question.type === "email" || question.type === "contact") && <p className="forms-warn">Add an email question first: contacts are matched by email.</p>}
    </>}
    {kind === "notify" && <PersonPicker label="Who to notify" allow={["user"]} value={people} onChange={setPeople} />}
    <div className="forms-row-actions">
      <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="button" className="primary-button" onClick={() => { void save(); }} disabled={busy || (kind === "create_card" && (!boardId || !columnId)) || (kind === "notify" && !people.length) || (kind === "save_contact" && !bookId && !newBook.trim())}>Add action</button>
    </div>
  </div>;
}
