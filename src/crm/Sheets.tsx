import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { MoneyInput } from "../ui/money/Money";
import { PersonPicker } from "../ui/people/People";
import type { PersonSummary } from "../../shared/people";
import type { Money } from "../../shared/money";
import { BUILTIN_FILTER_FIELDS, INTERACTION_KINDS, INTERACTION_LABELS, type CrmBook, type CrmEntity, type CrmFilter, type CrmPipeline, type InteractionKind } from "../../shared/crm";
import {
  boardColumns, createCompany, createContact, createDeal, createFollowup, createList, createTask, errorCode, errorMessage, errorPayload, listBoardsForTask, listPipelines, logInteraction
} from "./crmApi";
import { todayLocal } from "./format";
import { cachedPerson, relationName, rememberPerson } from "./relationNames";

/**
 * The quick sheets of Contacts (§E.4: max 560 px on desktop, full screen on phones; Esc closes):
 * new contact, company, deal, list; log an interaction; remind me; create a task; a deal's lost
 * reason; a filter.
 */

function Sheet({ title, eyebrow, busy, error, onClose, onSubmit, submitLabel, children, submitDisabled = false }: {
  title: string; eyebrow?: string; busy: boolean; error: string | null; onClose: () => void; onSubmit: () => void; submitLabel: string; children: ReactNode; submitDisabled?: boolean;
}) {
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy && !submitDisabled) onSubmit(); };
  return <ModalDialog title={title} eyebrow={eyebrow} onClose={onClose} variant="sheet" busy={busy} className="crm-sheet">
    <form className="crm-sheet-form" noValidate onSubmit={submit}>
      <div className="crm-sheet-body">{children}</div>
      {error && <p className="file-dialog-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || submitDisabled}>{busy ? "Saving…" : submitLabel}</button>
      </footer>
    </form>
  </ModalDialog>;
}

function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId();
  return <div className="ui-field"><label htmlFor={id}>{label}</label>{children(id)}{hint && <small className="ui-field-hint">{hint}</small>}</div>;
}

type Created = { href: string; id: string; name: string };

export function NewRecordSheet({ entity, book, onClose, onCreated, onOpenExisting }: { entity: "contact" | "company"; book: CrmBook; onClose: () => void; onCreated: (created: Created) => void; onOpenExisting: (id: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const set = (key: string) => (event: { target: { value: string } }) => { const value = event.target.value; setValues((current) => ({ ...current, [key]: value })); };
  const save = async () => {
    setBusy(true); setError(null); setExisting(null);
    try {
      if (entity === "contact") {
        const { contact } = await createContact({ bookId: book.id, name: values.name ?? "", email: values.email || null, phone: values.phone || null, companyName: values.company || undefined, jobTitle: values.jobTitle || null });
        onCreated({ href: contact.href, id: contact.id, name: contact.displayName });
      } else {
        const { company } = await createCompany({ bookId: book.id, name: values.name ?? "", domain: values.domain || null });
        onCreated({ href: company.href, id: company.id, name: company.name });
      }
    } catch (reason) {
      setError(errorMessage(reason, "Could not save"));
      if (errorCode(reason) === "EXISTS") setExisting(errorPayload<{ contactId?: string; companyId?: string }>(reason)?.contactId ?? errorPayload<{ companyId?: string }>(reason)?.companyId ?? null);
      setBusy(false);
    }
  };
  return <Sheet title={entity === "contact" ? "New contact" : "New company"} eyebrow={book.name} busy={busy} error={error} onClose={onClose} onSubmit={() => void save()} submitLabel={entity === "contact" ? "Add contact" : "Add company"} submitDisabled={!values.name?.trim() && !values.email?.trim()}>
    <Field label="Name">{(id) => <input id={id} autoFocus maxLength={160} value={values.name ?? ""} onChange={set("name")} placeholder={entity === "contact" ? "Ana Silva" : "Acme"} />}</Field>
    {entity === "contact" ? <>
      <Field label="Email">{(id) => <input id={id} type="email" maxLength={254} value={values.email ?? ""} onChange={set("email")} placeholder="ana@acme.com" />}</Field>
      <div className="crm-sheet-row">
        <Field label="Phone">{(id) => <input id={id} type="tel" maxLength={60} value={values.phone ?? ""} onChange={set("phone")} />}</Field>
        <Field label="Job title">{(id) => <input id={id} maxLength={120} value={values.jobTitle ?? ""} onChange={set("jobTitle")} />}</Field>
      </div>
      <Field label="Company" hint={book.settings.linkCompaniesByDomain ? "Left empty, the email's domain picks the company." : undefined}>{(id) => <input id={id} maxLength={200} value={values.company ?? ""} onChange={set("company")} />}</Field>
    </> : <Field label="Domain" hint="Contacts with this email domain join the company.">{(id) => <input id={id} maxLength={253} value={values.domain ?? ""} onChange={set("domain")} placeholder="acme.com" />}</Field>}
    {existing && <button type="button" className="ui-text-button" onClick={() => onOpenExisting(existing)}>Open the existing one</button>}
  </Sheet>;
}

export function NewDealSheet({ book, pipelineId, stageId, initialContact, initialCompany, onClose, onCreated }: {
  book: CrmBook; pipelineId?: string | null; stageId?: string | null; initialContact?: PersonSummary | null; initialCompany?: { id: string; name: string } | null; onClose: () => void; onCreated: (created: Created) => void;
}) {
  const [pipelines, setPipelines] = useState<CrmPipeline[]>([]);
  const [pipeline, setPipeline] = useState<string | null>(pipelineId ?? null);
  const [stage, setStage] = useState<string | null>(stageId ?? null);
  const [title, setTitle] = useState("");
  const [value, setValue] = useState<Money | null>(null);
  const [close, setClose] = useState("");
  const [contacts, setContacts] = useState<PersonSummary[]>(initialContact ? [initialContact] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listPipelines(book.id).then(({ pipelines: list }) => {
      setPipelines(list);
      const chosen = list.find((item) => item.id === pipeline) ?? list[0];
      if (chosen) { setPipeline(chosen.id); setStage((current) => chosen.stages.some((item) => item.id === current) ? current : chosen.stages.find((item) => item.kind === "open")?.id ?? null); }
    }, (reason) => setError(errorMessage(reason, "Could not load pipelines")));
    // Loaded once per book.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);
  const current = pipelines.find((item) => item.id === pipeline);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const { deal } = await createDeal({ bookId: book.id, pipelineId: pipeline, stageId: stage, title, value: value?.amount ?? null, currency: value?.currency, expectedCloseOn: close || null,
        contactIds: contacts.filter((person) => person.kind === "contact").map((person) => (person as { id: string }).id), companyId: initialCompany?.id ?? null });
      onCreated({ href: deal.href, id: deal.id, name: deal.title });
    } catch (reason) { setError(errorMessage(reason, "Could not save the deal")); setBusy(false); }
  };
  return <Sheet title="New deal" eyebrow={initialCompany ? `${book.name} · ${initialCompany.name}` : book.name} busy={busy} error={error} onClose={onClose} onSubmit={() => void save()} submitLabel="Add deal" submitDisabled={!title.trim()}>
    <Field label="Title">{(id) => <input id={id} autoFocus maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Acme renewal" />}</Field>
    <div className="crm-sheet-row">
      {pipelines.length > 1 && <div className="ui-field"><span>Pipeline</span><Select label="Pipeline" value={pipeline} options={pipelines.map((item) => ({ value: item.id, label: item.name }))} onChange={(next) => { setPipeline(next); setStage(pipelines.find((item) => item.id === next)?.stages[0]?.id ?? null); }} /></div>}
      <div className="ui-field"><span>Stage</span><Select label="Stage" value={stage} options={(current?.stages ?? []).map((item) => ({ value: item.id, label: `${item.name} · ${item.probability}%` }))} onChange={setStage} /></div>
    </div>
    <div className="crm-sheet-row">
      <MoneyInput label="Value" value={value} currencyEditable onChange={(money) => setValue(money)} />
      <Field label="Expected close">{(id) => <input id={id} type="date" value={close} onChange={(event) => setClose(event.target.value)} />}</Field>
    </div>
    <PersonPicker label="Contacts" value={contacts} onChange={setContacts} allow={["contact"]} bookId={book.id} />
  </Sheet>;
}

export function NewListSheet({ book, entity, onClose, onCreated }: { book: CrmBook; entity: CrmEntity; onClose: () => void; onCreated: (list: { id: string; shortId: string; name: string }) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CrmEntity>(entity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try { const { list } = await createList({ bookId: book.id, name, entity: kind }); onCreated(list); } catch (reason) { setError(errorMessage(reason, "Could not create the list")); setBusy(false); }
  };
  return <Sheet title="New list" eyebrow={book.name} busy={busy} error={error} onClose={onClose} onSubmit={() => void save()} submitLabel="Create list" submitDisabled={!name.trim()}>
    <Field label="Name">{(id) => <input id={id} autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Conference leads" />}</Field>
    <div className="ui-field"><span>Holds</span>
      <div className="ui-segmented" role="group" aria-label="The list holds">{(["contact", "company", "deal"] as const).map((item) => <button key={item} type="button" aria-pressed={kind === item} onClick={() => setKind(item)}>{item === "contact" ? "Contacts" : item === "company" ? "Companies" : "Deals"}</button>)}</div>
    </div>
  </Sheet>;
}

const nowLocalInput = () => { const now = new Date(); now.setSeconds(0, 0); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

/** Log a note, call, meeting, or email. Without `subjects`, the person picks a contact first (the "Log a call" quick action). */
export function LogInteractionSheet({ subjects, book, initialKind = "call", onClose, onLogged }: {
  subjects?: Array<{ kind: CrmEntity; id: string; name: string }>; book: CrmBook | null; initialKind?: InteractionKind; onClose: () => void; onLogged: () => void;
}) {
  const [kind, setKind] = useState<InteractionKind>(initialKind);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [when, setWhen] = useState(nowLocalInput());
  const [minutes, setMinutes] = useState("");
  const [picked, setPicked] = useState<PersonSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targets = subjects ?? picked.filter((person): person is Extract<PersonSummary, { kind: "contact"; hidden?: false }> => person.kind === "contact" && !("hidden" in person && person.hidden)).map((person) => ({ kind: "contact" as const, id: person.id, name: person.name }));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await logInteraction({ kind, title, body, occurredAt: new Date(when).toISOString(), durationS: minutes ? Math.round(Number(minutes) * 60) : null, subjects: targets.map(({ kind: subjectKind, id }) => ({ kind: subjectKind, id })) });
      onLogged();
    } catch (reason) { setError(errorMessage(reason, "Could not log it")); setBusy(false); }
  };
  return <Sheet title={`Log a ${INTERACTION_LABELS[kind].toLowerCase()}`} eyebrow={subjects?.map((item) => item.name).join(", ")} busy={busy} error={error} onClose={onClose} onSubmit={() => void save()} submitLabel="Log it" submitDisabled={!targets.length || (!title.trim() && !body.trim())}>
    {!subjects && <PersonPicker label="With" value={picked} onChange={setPicked} allow={["contact"]} bookId={book?.id} placeholder="Find a contact" />}
    <div className="ui-segmented crm-kinds" role="group" aria-label="Kind">{INTERACTION_KINDS.filter((item) => ["note", "call", "meeting", "email", "message"].includes(item)).map((item) =>
      <button key={item} type="button" aria-pressed={kind === item} onClick={() => setKind(item)}>{INTERACTION_LABELS[item]}</button>)}</div>
    <Field label="Summary">{(id) => <input id={id} autoFocus={Boolean(subjects)} maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={kind === "call" ? "Discovery call" : "What happened"} />}</Field>
    <Field label="Notes">{(id) => <textarea id={id} maxLength={20000} value={body} onChange={(event) => setBody(event.target.value)} rows={5} />}</Field>
    <div className="crm-sheet-row">
      <Field label="When">{(id) => <input id={id} type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />}</Field>
      {(kind === "call" || kind === "meeting") && <Field label="Minutes">{(id) => <input id={id} type="number" min={0} max={1440} inputMode="numeric" value={minutes} onChange={(event) => setMinutes(event.target.value)} />}</Field>}
    </div>
  </Sheet>;
}

const PRESETS = [
  { id: "tomorrow", label: "Tomorrow 9:00", at: () => { const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); return date; } },
  { id: "3days", label: "In 3 days", at: () => { const date = new Date(); date.setDate(date.getDate() + 3); date.setHours(9, 0, 0, 0); return date; } },
  { id: "week", label: "Next week", at: () => { const date = new Date(); date.setDate(date.getDate() + 7); date.setHours(9, 0, 0, 0); return date; } }
];

export function FollowupSheet({ subject, onClose, onSaved }: { subject: { kind: CrmEntity; id: string; name: string }; onClose: () => void; onSaved: () => void }) {
  const [when, setWhen] = useState(() => { const date = PRESETS[0]!.at(); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try { await createFollowup({ subject: { kind: subject.kind, id: subject.id }, dueAt: new Date(when).toISOString(), note }); onSaved(); } catch (reason) { setError(errorMessage(reason, "Could not set the reminder")); setBusy(false); }
  };
  return <Sheet title="Remind me" eyebrow={subject.name} busy={busy} error={error} onClose={onClose} onSubmit={() => void save()} submitLabel="Set reminder">
    <div className="crm-chips" role="group" aria-label="When">{PRESETS.map((preset) => <button key={preset.id} type="button" className="ui-filter-chip" onClick={() => { const date = preset.at(); setWhen(new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)); }}>{preset.label}</button>)}</div>
    <Field label="When">{(id) => <input id={id} type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />}</Field>
    <Field label="Note" hint="Only you get this reminder, in your inbox.">{(id) => <input id={id} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Send the proposal" />}</Field>
  </Sheet>;
}

export function TaskSheet({ subject, onClose, onCreated }: { subject: { kind: CrmEntity; id: string; name: string }; onClose: () => void; onCreated: () => void }) {
  const [boards, setBoards] = useState<Array<{ id: string; name: string }>>([]);
  const [board, setBoard] = useState<string | null>(null);
  const [columns, setColumns] = useState<Array<{ id: string; name: string }>>([]);
  const [column, setColumn] = useState<string | null>(null);
  const [title, setTitle] = useState(`Follow up with ${subject.name}`);
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { listBoardsForTask().then(({ boards: list }) => { setBoards(list); setBoard(list[0]?.id ?? null); }, (reason) => setError(errorMessage(reason, "Could not load boards"))); }, []);
  useEffect(() => { if (!board) return; boardColumns(board).then(({ columns: list }) => { setColumns(list); setColumn(list[0]?.id ?? null); }, () => setColumns([])); }, [board]);
  const save = async () => {
    if (!board || !column) return;
    setBusy(true); setError(null);
    try { await createTask({ subject: { kind: subject.kind, id: subject.id }, boardId: board, columnId: column, title, dueOn: due || null }); onCreated(); } catch (reason) { setError(errorMessage(reason, "Could not create the task")); setBusy(false); }
  };
  return <Sheet title="Create task" eyebrow={subject.name} busy={busy} error={error} onClose={onClose} onSubmit={() => void save()} submitLabel="Create task" submitDisabled={!board || !column || !title.trim()}>
    <Field label="Title">{(id) => <input id={id} autoFocus maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />}</Field>
    {boards.length === 0 ? <p className="ui-field-hint">You have no boards to add a card to. Create one in Tasks first.</p> : <div className="crm-sheet-row">
      <div className="ui-field"><span>Board</span><Select label="Board" value={board} options={boards.map((item) => ({ value: item.id, label: item.name }))} onChange={setBoard} /></div>
      <div className="ui-field"><span>Column</span><Select label="Column" value={column} options={columns.map((item) => ({ value: item.id, label: item.name }))} onChange={setColumn} /></div>
    </div>}
    <Field label="Due">{(id) => <input id={id} type="date" min={todayLocal()} value={due} onChange={(event) => setDue(event.target.value)} />}</Field>
  </Sheet>;
}

export function LostReasonSheet({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return <Sheet title="Why was it lost?" eyebrow={title} busy={false} error={null} onClose={onClose} onSubmit={() => onSave(reason)} submitLabel="Mark as lost">
    <div className="crm-chips" role="group" aria-label="Common reasons">{["Price", "Timing", "Went with a competitor", "No budget", "No response"].map((item) => <button key={item} type="button" className="ui-filter-chip" aria-pressed={reason === item} onClick={() => setReason(item)}>{item}</button>)}</div>
    <Field label="Reason">{(id) => <input id={id} autoFocus maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} />}</Field>
  </Sheet>;
}

const FIELD_LABELS: Record<string, string> = {
  name: "Name", email: "Email", company: "Company", owner: "Owner", lifecycle: "Lifecycle", tag: "Tag", source: "Source", job_title: "Job title", last_interaction: "Last interaction", created: "Created", updated: "Updated",
  domain: "Domain", title: "Title", pipeline: "Pipeline", stage: "Stage", status: "Status", value: "Value (cents)", expected_close: "Expected close", next_step: "Next step date", last_activity: "Last activity"
};
const OP_LABELS: Record<CrmFilter["op"], string> = { eq: "is", neq: "is not", contains: "contains", empty: "is empty", not_empty: "is not empty", gt: "after / more than", lt: "before / less than", in: "is one of" };

export function FilterSheet({ entity, book, onClose, onAdd }: { entity: CrmEntity; book: CrmBook | null; onClose: () => void; onAdd: (filter: CrmFilter) => void }) {
  const custom = book?.fields[entity] ?? [];
  const fields = [...BUILTIN_FILTER_FIELDS[entity].filter((field) => field !== "pipeline" && field !== "stage").map((field) => ({ value: field, label: FIELD_LABELS[field] ?? field })), ...custom.map((field) => ({ value: field.id, label: field.name }))];
  const [field, setField] = useState<string>(fields[0]?.value ?? "name");
  const [op, setOp] = useState<CrmFilter["op"]>("contains");
  const [value, setValue] = useState("");
  const definition = custom.find((item) => item.id === field);
  const dateLike = ["last_interaction", "created", "updated", "expected_close", "next_step", "last_activity"].includes(field) || definition?.type === "date";
  const numeric = field === "value" || definition?.type === "number";
  const relation = definition?.type === "person" || definition?.type === "contact" ? definition.type : null;
  const [picked, setPicked] = useState<PersonSummary[]>([]);
  useEffect(() => { setPicked([]); setValue(""); }, [field]);
  const ops: Array<CrmFilter["op"]> = dateLike || numeric ? ["gt", "lt", "empty", "not_empty"] : definition?.type === "select" || definition?.type === "checkbox" || field === "owner" || relation ? ["eq", "neq", "empty", "not_empty"] : ["contains", "eq", "neq", "empty", "not_empty"];
  useEffect(() => { if (!ops.includes(op)) setOp(ops[0]!); }, [field]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsValue = op !== "empty" && op !== "not_empty";
  const add = () => {
    let typed: CrmFilter["value"] = value;
    if (numeric) typed = Number(value);
    if (definition?.type === "checkbox") typed = value === "true";
    onAdd({ field, op, ...(needsValue ? { value: typed } : {}) });
  };
  return <Sheet title="Add a filter" busy={false} error={null} onClose={onClose} onSubmit={add} submitLabel="Add filter" submitDisabled={needsValue && !value}>
    <div className="ui-field"><span>Field</span><Select label="Field" value={field} options={fields} onChange={setField} /></div>
    <div className="ui-field"><span>Condition</span><Select label="Condition" value={op} options={ops.map((item) => ({ value: item, label: OP_LABELS[item] }))} onChange={setOp} /></div>
    {needsValue && (relation
      ? <PersonPicker label="Value" value={picked} allow={[relation === "person" ? "user" : "contact"]} bookId={relation === "contact" ? book?.id : undefined} multiple={false}
        onChange={(people) => { setPicked(people); const next = people[0]; if (next) rememberPerson(next); setValue(next && "id" in next ? next.id : ""); }} />
      : definition?.type === "select"
      ? <div className="ui-field"><span>Value</span><Select label="Value" value={value || null} options={(definition.options ?? []).map((option) => ({ value: option.id, label: option.label }))} onChange={setValue} /></div>
      : definition?.type === "checkbox" ? <div className="ui-field"><span>Value</span><Select label="Value" value={value || null} options={[{ value: "true", label: "Checked" }]} onChange={setValue} /></div>
      : field === "owner" ? <div className="ui-field"><span>Value</span><Select label="Owner" value={value || null} options={[{ value: "me", label: "Me" }]} onChange={setValue} /></div>
      : <Field label="Value">{(id) => <input id={id} type={dateLike ? "date" : numeric ? "number" : "text"} value={value} onChange={(event) => setValue(event.target.value)} />}</Field>)}
  </Sheet>;
}

export const filterLabel = (filter: CrmFilter, book: CrmBook | null, entity: CrmEntity) => {
  const custom = book?.fields[entity].find((field) => field.id === filter.field);
  const name = custom?.name ?? FIELD_LABELS[filter.field] ?? filter.field;
  const value = custom?.type === "select" ? custom.options?.find((option) => option.id === filter.value)?.label
    : (custom?.type === "person" || custom?.type === "contact") && typeof filter.value === "string" ? relationName(cachedPerson(filter.value)) ?? (custom.type === "person" ? "a team member" : "a contact")
    : filter.value === "me" ? "me" : filter.value;
  return `${name} ${OP_LABELS[filter.op]}${value !== undefined ? ` ${String(value)}` : ""}`;
};
