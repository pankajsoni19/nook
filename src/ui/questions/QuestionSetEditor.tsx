import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowDown, ArrowUp, Check, Copy, Eye, GitBranch, GripVertical, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { ModalDialog } from "../../files/Dialog";
import { MoreMenu } from "../MoreMenu";
import { Select } from "../Select";
import { EmptyState } from "../EmptyState";
import { useHistoryDialogGuard } from "../useHistoryDialogGuard";
import {
  newQuestionItemId, QUESTION_TYPES, QUESTION_TYPE_NAMES, questionSetProblems,
  type Answers, type Audience, type Condition, type ConditionOp, type LogicRule, type Question, type QuestionRole, type QuestionSet, type QuestionType, type SetProblem
} from "../../../shared/questions";
import { plainText } from "./inline";
import { optionsOf } from "./QuestionInput";
import { QuestionRenderer } from "./QuestionRenderer";
import "./questions.css";

/**
 * Building a question set (§B.2, §E.3, D839): Forms, Standups, Booking intake, and Townhall share it.
 * A list of question blocks: click one to edit it (title, type, required, help, and its type's
 * settings: options, scale, grid, slots, validation, the role other modules read). Keys: `/` in an
 * empty title (or Add question) opens the type menu; ⌘/Ctrl+↑/↓ moves a block; ⌘/Ctrl+D duplicates;
 * Backspace in an empty title deletes it. Drag a block by its handle. Logic opens a sheet of rules;
 * Preview answers it as a respondent would. Problems come from `questionSetProblems` (the server's).
 */

export type SaveState = "saving" | "saved" | "error" | null;

/** A fresh question of a type, with the settings that type needs. Pure (exported for tests). */
export function newQuestion(type: QuestionType): Question {
  const id = newQuestionItemId();
  const base: Question = { id, type, title: "" };
  if (QUESTION_TYPES[type].options) return { ...base, options: [{ id: newQuestionItemId(), label: "Option 1" }, { id: newQuestionItemId(), label: "Option 2" }] };
  if (type === "rating") return { ...base, scale: { min: 1, max: 5, icon: "star" } };
  if (type === "scale") return { ...base, scale: { min: 1, max: 5, minLabel: "", maxLabel: "" } };
  if (type === "matrix") return { ...base, matrix: { rows: [{ id: newQuestionItemId(), label: "Row 1" }], columns: [{ id: newQuestionItemId(), label: "Column 1" }, { id: newQuestionItemId(), label: "Column 2" }] } };
  if (type === "hidden") return { ...base, title: "Hidden field", hiddenKey: "source" };
  if (type === "time_slots") return { ...base, slots: [], allowMaybe: true };
  return base;
}

/** The set with question `index` moved by `by` places (clamped). Pure. */
export function moveQuestion(set: QuestionSet, index: number, by: number): QuestionSet {
  const to = Math.max(0, Math.min(set.questions.length - 1, index + by));
  if (to === index) return set;
  const questions = [...set.questions];
  const [question] = questions.splice(index, 1);
  questions.splice(to, 0, question!);
  return { ...set, questions };
}

/** A copy of a question with fresh ids (options, rows, and columns too). Pure. */
export function duplicateQuestion(question: Question): Question {
  return {
    ...question,
    id: newQuestionItemId(),
    ...(question.options ? { options: question.options.map((option) => ({ ...option, id: newQuestionItemId() })) } : {}),
    ...(question.matrix ? { matrix: { ...question.matrix, rows: question.matrix.rows.map((row) => ({ ...row, id: newQuestionItemId() })), columns: question.matrix.columns.map((column) => ({ ...column, id: newQuestionItemId() })) } } : {})
  };
}

/** Removes a question and every logic rule that names it. Pure. */
export function removeQuestion(set: QuestionSet, id: string): QuestionSet {
  const names = (rule: LogicRule) => [...(rule.when.all ?? []), ...(rule.when.any ?? [])].some((condition) => condition.questionId === id) || ("show" in rule.then && rule.then.show.includes(id)) || ("hide" in rule.then && rule.then.hide.includes(id));
  return { ...set, questions: set.questions.filter((question) => question.id !== id), logic: set.logic.filter((rule) => !names(rule)) };
}

/** Problems by question index ("questions.3.options" → 3), for the block they belong to. */
export function problemsByQuestion(problems: readonly SetProblem[]) {
  const map = new Map<number, string[]>();
  for (const problem of problems) {
    const match = /^questions\.(\d+)/.exec(problem.path);
    if (match) map.set(Number(match[1]), [...(map.get(Number(match[1])) ?? []), problem.message]);
  }
  return map;
}

const ROLE_LABELS: Record<QuestionRole, string> = {
  done: "What I did (Standups)", plan: "What I'll do (Standups)", blockers: "Blockers (Standups)", mood: "Mood", goal_update: "Goal update",
  contact_name: "Contact name", contact_email: "Contact email", contact_phone: "Contact phone", company: "Company"
};

function TypeMenu({ audience, allowed, onPick, onClose }: { audience: Audience; allowed?: readonly QuestionType[]; onPick: (type: QuestionType) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useHistoryDialogGuard(true, onClose);
  const types = QUESTION_TYPE_NAMES.filter((type) => (!allowed || allowed.includes(type)) && QUESTION_TYPES[type].label.toLowerCase().includes(query.trim().toLowerCase()));
  const enabled = (type: QuestionType) => audience === "member" || QUESTION_TYPES[type].public;
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => (index + 1) % Math.max(1, types.length)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => (index - 1 + types.length) % Math.max(1, types.length)); }
    if (event.key === "Enter" && types[active] && enabled(types[active]!)) { event.preventDefault(); onPick(types[active]!); }
  };
  return <ModalDialog title="Add a question" onClose={onClose} variant="sheet" className="nook-picker ui-q-type-menu">
    <label className="nook-picker-search"><Search aria-hidden="true" /><span className="ui-visually-hidden">Question type</span>
      <input type="search" autoFocus value={query} placeholder="Short text, rating, NPS…" onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKey} role="combobox" aria-expanded="true" aria-controls="ui-q-types" aria-activedescendant={types[active] ? `ui-q-type-${types[active]}` : undefined} />
    </label>
    <div className="nook-picker-body">
      <ul id="ui-q-types" className="nook-picker-list" role="listbox" aria-label="Question types">
        {types.map((type, index) => <li key={type} id={`ui-q-type-${type}`} role="option" aria-selected={index === active} aria-disabled={!enabled(type) || undefined}>
          <button type="button" className={index === active ? "active" : undefined} disabled={!enabled(type)} tabIndex={-1} onClick={() => onPick(type)} onMouseEnter={() => setActive(index)}>
            <span><strong>{QUESTION_TYPES[type].label}</strong>{!enabled(type) && <small>Members only: not on public pages</small>}</span>
          </button>
        </li>)}
        {types.length === 0 && <li className="nook-picker-empty">No question type matches.</li>}
      </ul>
    </div>
  </ModalDialog>;
}

function OptionsEditor({ question, onChange }: { question: Question; onChange: (question: Question) => void }) {
  const options = question.options ?? [];
  const lastRef = useRef<HTMLInputElement>(null);
  const [focusLast, setFocusLast] = useState(false);
  useEffect(() => { if (focusLast) { lastRef.current?.focus(); setFocusLast(false); } }, [focusLast]);
  const set = (next: typeof options) => onChange({ ...question, options: next });
  const add = () => { set([...options, { id: newQuestionItemId(), label: `Option ${options.length + 1}` }]); setFocusLast(true); };
  return <fieldset className="ui-q-options-editor">
    <legend>Options</legend>
    <ol>
      {options.map((option, index) => <li key={option.id}>
        <input ref={index === options.length - 1 ? lastRef : undefined} type="text" value={option.label} maxLength={200} aria-label={`Option ${index + 1}`}
          onChange={(event) => set(options.map((item) => item.id === option.id ? { ...item, label: event.target.value } : item))}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } if (event.key === "Backspace" && !option.label && options.length > 1) { event.preventDefault(); set(options.filter((item) => item.id !== option.id)); } }} />
        <button type="button" className="icon-button" onClick={() => { const next = [...options]; next.splice(index, 1); next.splice(index - 1, 0, option); set(next); }} disabled={index === 0} aria-label={`Move ${option.label || "option"} up`}><ArrowUp /></button>
        <button type="button" className="icon-button" onClick={() => set(options.filter((item) => item.id !== option.id))} disabled={options.length <= 1} aria-label={`Remove ${option.label || "option"}`}><X /></button>
      </li>)}
    </ol>
    <div className="ui-q-inline-actions">
      <button type="button" className="secondary-button ui-small-button" onClick={add}><Plus aria-hidden="true" />Add option</button>
      {question.type !== "ranking" && question.type !== "dropdown" && <label className="ui-q-check"><input type="checkbox" checked={Boolean(question.allowOther)} onChange={(event) => onChange({ ...question, allowOther: event.target.checked || undefined })} />Allow “Other”</label>}
    </div>
  </fieldset>;
}

function QuestionSettings({ question, onChange, roles, audience }: { question: Question; onChange: (question: Question) => void; roles?: readonly QuestionRole[]; audience: Audience }) {
  const id = useId();
  const type = QUESTION_TYPES[question.type];
  const numberField = (label: string, value: number | undefined, set: (value: number | undefined) => void, min?: number, max?: number) => <label className="ui-field">
    <span>{label}</span><input type="number" value={value ?? ""} min={min} max={max} onChange={(event) => set(event.target.value === "" ? undefined : Number(event.target.value))} />
  </label>;
  return <div className="ui-q-settings">
    <label className="ui-field"><span>Help text</span><input type="text" value={question.help ?? ""} maxLength={1000} placeholder="Optional: a line under the question" onChange={(event) => onChange({ ...question, help: event.target.value || undefined })} /></label>
    {type.options && <OptionsEditor question={question} onChange={onChange} />}
    {question.type === "multi_choice" && <div className="ui-q-settings-row">
      {numberField("At least", question.minSelect, (value) => onChange({ ...question, minSelect: value }), 0, question.options?.length)}
      {numberField("At most", question.maxSelect, (value) => onChange({ ...question, maxSelect: value }), 1, question.options?.length)}
    </div>}
    {(question.type === "rating" || question.type === "scale") && <div className="ui-q-settings-row">
      <div className="ui-field"><span id={`${id}-max`}>Out of</span><Select labelledBy={`${id}-max`} value={String(question.scale?.max ?? 5)} onChange={(max) => onChange({ ...question, scale: { min: question.scale?.min ?? 1, ...question.scale, max: Number(max) } })} options={[3, 4, 5, 6, 7, 8, 9, 10].map((value) => ({ value: String(value), label: String(value) }))} /></div>
      {question.type === "rating" && <div className="ui-field"><span id={`${id}-icon`}>Shape</span><Select labelledBy={`${id}-icon`} value={question.scale?.icon ?? "star"} onChange={(icon) => onChange({ ...question, scale: { min: 1, max: 5, ...question.scale, icon } })} options={[{ value: "star", label: "Stars" }, { value: "heart", label: "Hearts" }, { value: "emoji", label: "Faces" }, { value: "number", label: "Numbers" }]} /></div>}
      {question.type === "scale" && <>
        <label className="ui-field"><span>Low label</span><input type="text" value={question.scale?.minLabel ?? ""} maxLength={60} onChange={(event) => onChange({ ...question, scale: { min: 1, max: 5, ...question.scale, minLabel: event.target.value } })} /></label>
        <label className="ui-field"><span>High label</span><input type="text" value={question.scale?.maxLabel ?? ""} maxLength={60} onChange={(event) => onChange({ ...question, scale: { min: 1, max: 5, ...question.scale, maxLabel: event.target.value } })} /></label>
      </>}
    </div>}
    {question.type === "number" && <div className="ui-q-settings-row">
      {numberField("Minimum", question.validation?.min, (min) => onChange({ ...question, validation: { ...question.validation, min } }))}
      {numberField("Maximum", question.validation?.max, (max) => onChange({ ...question, validation: { ...question.validation, max } }))}
    </div>}
    {question.type === "matrix" && question.matrix && <div className="ui-q-settings-row ui-q-matrix-editor">
      {(["rows", "columns"] as const).map((part) => <fieldset key={part}><legend>{part === "rows" ? "Rows" : "Columns"}</legend>
        {question.matrix![part].map((item, index) => <div key={item.id} className="ui-q-inline-actions">
          <input type="text" aria-label={`${part === "rows" ? "Row" : "Column"} ${index + 1}`} value={item.label} maxLength={200} onChange={(event) => onChange({ ...question, matrix: { ...question.matrix!, [part]: question.matrix![part].map((entry) => entry.id === item.id ? { ...entry, label: event.target.value } : entry) } })} />
          <button type="button" className="icon-button" disabled={question.matrix![part].length <= 1} onClick={() => onChange({ ...question, matrix: { ...question.matrix!, [part]: question.matrix![part].filter((entry) => entry.id !== item.id) } })} aria-label={`Remove ${item.label}`}><X /></button>
        </div>)}
        <button type="button" className="secondary-button ui-small-button" onClick={() => onChange({ ...question, matrix: { ...question.matrix!, [part]: [...question.matrix![part], { id: newQuestionItemId(), label: `${part === "rows" ? "Row" : "Column"} ${question.matrix![part].length + 1}` }] } })}><Plus aria-hidden="true" />Add</button>
      </fieldset>)}
      <label className="ui-q-check"><input type="checkbox" checked={Boolean(question.matrix.multiple)} onChange={(event) => onChange({ ...question, matrix: { ...question.matrix!, multiple: event.target.checked || undefined } })} />Several per row</label>
    </div>}
    {question.type === "time_slots" && <label className="ui-q-check"><input type="checkbox" checked={Boolean(question.allowMaybe)} onChange={(event) => onChange({ ...question, allowMaybe: event.target.checked || undefined })} />Offer “If needed”</label>}
    {question.type === "hidden" && <label className="ui-field"><span>URL parameter</span><input type="text" value={question.hiddenKey ?? ""} maxLength={40} pattern="[A-Za-z0-9_-]+" onChange={(event) => onChange({ ...question, hiddenKey: event.target.value })} /></label>}
    {roles && roles.length > 0 && type.answers && <div className="ui-field"><span id={`${id}-role`}>Used as</span>
      <Select labelledBy={`${id}-role`} value={question.role ?? "none"} onChange={(role) => onChange({ ...question, role: role === "none" ? undefined : role as QuestionRole })} options={[{ value: "none", label: "Nothing special" }, ...roles.map((role) => ({ value: role, label: ROLE_LABELS[role] }))]} />
    </div>}
    {audience === "public" && !type.public && <p className="ui-field-error">This type can't be answered on a public page.</p>}
  </div>;
}

const OPS: Array<{ value: ConditionOp; label: string }> = [
  { value: "eq", label: "is" }, { value: "neq", label: "is not" }, { value: "includes", label: "includes" }, { value: "answered", label: "is answered" },
  { value: "not_answered", label: "is not answered" }, { value: "gt", label: "is more than" }, { value: "lt", label: "is less than" }
];

function LogicSheet({ set, onChange, onClose }: { set: QuestionSet; onChange: (set: QuestionSet) => void; onClose: () => void }) {
  useHistoryDialogGuard(true, onClose);
  const answerable = set.questions.filter((question) => QUESTION_TYPES[question.type].answers);
  const titleOf = (id: string) => plainText(set.questions.find((question) => question.id === id)?.title || "Untitled question");
  const update = (rule: LogicRule) => onChange({ ...set, logic: set.logic.map((item) => item.id === rule.id ? rule : item) });
  const addRule = () => {
    const first = answerable[0];
    const target = set.questions.find((question) => question.id !== first?.id);
    if (!first || !target) return;
    onChange({ ...set, logic: [...set.logic, { id: newQuestionItemId(), when: { all: [{ questionId: first.id, op: "answered" }] }, then: { show: [target.id] } }] });
  };
  return <ModalDialog title="Logic" onClose={onClose} variant="sheet" className="ui-q-logic">
    <div className="ui-q-logic-body">
      <p className="ui-field-hint">Show or hide questions, or skip ahead, based on earlier answers. Rules run in order; a skip only goes forward.</p>
      {set.logic.length === 0 && <EmptyState compact icon={GitBranch} title="No rules yet" as="h3">Every question shows to everyone.</EmptyState>}
      <ol className="ui-q-rules">
        {set.logic.map((rule, index) => {
          const condition = (rule.when.all ?? rule.when.any ?? [])[0] ?? { questionId: answerable[0]?.id ?? "", op: "answered" as ConditionOp };
          const source = set.questions.find((question) => question.id === condition.questionId);
          const setCondition = (patch: Partial<Condition>) => update({ ...rule, when: { all: [{ ...condition, ...patch }] } });
          const action = "show" in rule.then ? "show" : "hide" in rule.then ? "hide" : "jump";
          const target = "show" in rule.then ? rule.then.show[0] : "hide" in rule.then ? rule.then.hide[0] : rule.then.jumpTo;
          const needsValue = !["answered", "not_answered"].includes(condition.op);
          return <li key={rule.id} className="ui-q-rule">
            <span className="ui-q-rule-n ui-tabular">{index + 1}</span>
            <div className="ui-q-rule-parts">
              <span>When</span>
              <Select label="Question" value={condition.questionId} onChange={(questionId) => setCondition({ questionId, value: undefined })} options={answerable.map((question) => ({ value: question.id, label: titleOf(question.id) }))} />
              <Select label="Condition" value={condition.op} onChange={(op) => setCondition({ op })} options={OPS} />
              {needsValue && (source && QUESTION_TYPES[source.type].options || source?.type === "yes_no"
                ? <Select label="Value" value={typeof condition.value === "string" ? condition.value : null} onChange={(value) => setCondition({ value })} options={optionsOf(source).map((option) => ({ value: option.id, label: option.label }))} />
                : <input type="text" aria-label="Value" value={condition.value === undefined ? "" : String(condition.value)} onChange={(event) => setCondition({ value: event.target.value === "" || Number.isNaN(Number(event.target.value)) ? event.target.value : Number(event.target.value) })} />)}
              <span>then</span>
              <Select label="Action" value={action} onChange={(next) => update({ ...rule, then: next === "show" ? { show: [target ?? ""] } : next === "hide" ? { hide: [target ?? ""] } : { jumpTo: set.sections[0]?.id ?? set.endings[0]?.id ?? "" } })}
                options={[{ value: "show", label: "show" }, { value: "hide", label: "hide" }, ...(set.sections.length || set.endings.length ? [{ value: "jump", label: "skip to" }] : [])]} />
              {action === "jump"
                ? <Select label="Skip to" value={target ?? null} onChange={(jumpTo) => update({ ...rule, then: { jumpTo } })} options={[...set.sections.map((section) => ({ value: section.id, label: section.title || "Untitled section" })), ...set.endings.map((ending) => ({ value: ending.id, label: `Ending: ${ending.title}` }))]} />
                : <Select label="Target question" value={target ?? null} onChange={(id) => update({ ...rule, then: action === "show" ? { show: [id] } : { hide: [id] } })} options={set.questions.filter((question) => question.id !== condition.questionId).map((question) => ({ value: question.id, label: titleOf(question.id) }))} />}
            </div>
            <button type="button" className="icon-button" onClick={() => onChange({ ...set, logic: set.logic.filter((item) => item.id !== rule.id) })} aria-label={`Remove rule ${index + 1}`}><Trash2 /></button>
          </li>;
        })}
      </ol>
    </div>
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={addRule} disabled={answerable.length === 0 || set.questions.length < 2}><Plus />Add rule</button>
      <button type="button" className="primary-button" onClick={onClose}>Done</button>
    </footer>
  </ModalDialog>;
}

export function QuestionSetEditor({ set, onChange, audience = "member", allowedTypes, roles, saveState = null, onPublish, publishLabel = "Publish", publishing = false, title = "Questions" }: {
  set: QuestionSet;
  onChange: (set: QuestionSet) => void;
  /** "public": members-only types are offered disabled and flagged (T516). */
  audience?: Audience;
  allowedTypes?: readonly QuestionType[];
  /** Roles this host reads (Standups: done, plan, blockers, mood; Bookings: contact fields). */
  roles?: readonly QuestionRole[];
  /** The autosave indicator ("Saving…", "Saved"). */
  saveState?: SaveState;
  onPublish?: () => void;
  publishLabel?: string;
  publishing?: boolean;
  title?: string;
}) {
  const [selected, setSelected] = useState<string | null>(set.questions[0]?.id ?? null);
  const [typeMenu, setTypeMenu] = useState<{ replace?: string; after?: number } | null>(null);
  const [logicOpen, setLogicOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [previewAnswers, setPreviewAnswers] = useState<Answers>({});
  const [dragging, setDragging] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const problems = useMemo(() => problemsByQuestion(questionSetProblems(set, { audience })), [set, audience]);
  const focusTitle = (id: string) => window.requestAnimationFrame(() => listRef.current?.querySelector<HTMLTextAreaElement>(`[data-q-title="${CSS.escape(id)}"]`)?.focus());

  const replace = (question: Question) => onChange({ ...set, questions: set.questions.map((item) => item.id === question.id ? question : item) });
  const insert = (type: QuestionType, at: number) => {
    const question = newQuestion(type);
    const questions = [...set.questions];
    questions.splice(at, 0, question);
    onChange({ ...set, questions });
    setSelected(question.id);
    focusTitle(question.id);
  };
  const pickType = (type: QuestionType) => {
    const menu = typeMenu;
    setTypeMenu(null);
    if (!menu) return;
    if (menu.replace) {
      const current = set.questions.find((question) => question.id === menu.replace);
      if (current) { replace({ ...newQuestion(type), id: current.id, title: current.title.replace(/^\/$/, ""), required: current.required }); focusTitle(current.id); }
    } else insert(type, menu.after ?? set.questions.length);
  };
  const onBlockKey = (event: ReactKeyboardEvent, index: number, question: Question) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); onChange(moveQuestion(set, index, event.key === "ArrowUp" ? -1 : 1)); focusTitle(question.id); }
    else if (mod && event.key.toLowerCase() === "d") {
      event.preventDefault();
      const copy = duplicateQuestion(question);
      const questions = [...set.questions];
      questions.splice(index + 1, 0, copy);
      onChange({ ...set, questions });
      setSelected(copy.id);
      focusTitle(copy.id);
    }
  };

  if (preview) return <div className="ui-q-editor">
    <div className="ui-q-editor-bar">
      <h2>Preview</h2>
      <button type="button" className="secondary-button ui-small-button" onClick={() => setPreview(false)}><Pencil aria-hidden="true" />Back to editing</button>
    </div>
    <QuestionRenderer set={set} answers={previewAnswers} onChange={setPreviewAnswers} onSubmit={() => setPreviewAnswers({})} audience={audience} submitLabel="Submit (preview)" />
  </div>;

  return <div className="ui-q-editor">
    <div className="ui-q-editor-bar">
      <h2>{title}<span className="ui-panel-count ui-tabular"> · {set.questions.length}</span></h2>
      <span className="ui-q-save" role="status" aria-live="polite">{saveState === "saving" ? <><Loader2 className="spin" aria-hidden="true" />Saving…</> : saveState === "saved" ? <><Check aria-hidden="true" />Saved</> : saveState === "error" ? <span className="ui-field-error">Not saved</span> : null}</span>
      <button type="button" className="secondary-button ui-small-button" onClick={() => setLogicOpen(true)} aria-haspopup="dialog" disabled={set.questions.length < 2}><GitBranch aria-hidden="true" />Logic{set.logic.length > 0 && <span className="ui-tabular"> · {set.logic.length}</span>}</button>
      <button type="button" className="secondary-button ui-small-button" onClick={() => setPreview(true)} disabled={set.questions.length === 0}><Eye aria-hidden="true" />Preview</button>
      {onPublish && <button type="button" className="action-button ui-small-action" onClick={onPublish} disabled={publishing || problems.size > 0 || set.questions.length === 0}>{publishing ? "Publishing…" : publishLabel}</button>}
    </div>
    {set.questions.length === 0
      ? <EmptyState icon={Plus} title="No questions yet" action={{ label: "Add question", icon: Plus, onClick: () => setTypeMenu({ after: 0 }) }}>Add the first question. Type / in a question to change its type.</EmptyState>
      : <ol ref={listRef} className="ui-q-blocks" aria-label="Questions">
        {set.questions.map((question, index) => {
          const open = selected === question.id;
          const issues = problems.get(index);
          return <li key={question.id} className={`ui-q-edit${open ? " open" : ""}${issues ? " invalid" : ""}${dragging === index ? " dragging" : ""}`}
            onDragOver={(event) => { if (dragging !== null) event.preventDefault(); }}
            onDrop={(event) => { event.preventDefault(); if (dragging !== null && dragging !== index) onChange(moveQuestion(set, dragging, index - dragging)); setDragging(null); }}
            onKeyDown={(event) => onBlockKey(event, index, question)}
            onFocusCapture={() => setSelected(question.id)}>
            <div className="ui-q-edit-head">
              <span className="ui-q-grip" draggable onDragStart={(event) => { setDragging(index); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", question.id); }} onDragEnd={() => setDragging(null)} aria-hidden="true" title="Drag to reorder"><GripVertical /></span>
              <span className="ui-q-number ui-tabular" aria-hidden="true">{index + 1}</span>
              <textarea data-q-title={question.id} className="ui-q-title-input" rows={1} value={question.title} maxLength={500} aria-label={`Question ${index + 1}`} placeholder={question.type === "statement" ? "Text to show" : "Type a question, or / for a type"}
                aria-keyshortcuts="Meta+ArrowUp Meta+ArrowDown Meta+D" aria-invalid={issues ? true : undefined}
                onChange={(event) => {
                  const text = event.target.value.replace(/\n/g, " ");
                  if (text === "/" && !question.title) { setTypeMenu({ replace: question.id }); return; }
                  replace({ ...question, title: text });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); setTypeMenu({ after: index + 1 }); }
                  if (event.key === "Backspace" && !question.title && !event.metaKey && !event.ctrlKey) {
                    event.preventDefault();
                    const previous = set.questions[index - 1];
                    onChange(removeQuestion(set, question.id));
                    if (previous) { setSelected(previous.id); focusTitle(previous.id); }
                  }
                }} />
              <span className="ui-q-type-chip">{QUESTION_TYPES[question.type].label}</span>
              {QUESTION_TYPES[question.type].answers && <label className="ui-q-check ui-q-required-toggle"><input type="checkbox" checked={Boolean(question.required)} onChange={(event) => replace({ ...question, required: event.target.checked || undefined })} />Required</label>}
              <MoreMenu label={`Question ${index + 1} actions`} items={[
                { id: "type", label: "Change type", icon: Pencil, onSelect: () => setTypeMenu({ replace: question.id }) },
                { id: "up", label: "Move up", icon: ArrowUp, disabled: index === 0, onSelect: () => onChange(moveQuestion(set, index, -1)) },
                { id: "down", label: "Move down", icon: ArrowDown, disabled: index === set.questions.length - 1, onSelect: () => onChange(moveQuestion(set, index, 1)) },
                { id: "copy", label: "Duplicate", icon: Copy, onSelect: () => { const copy = duplicateQuestion(question); const questions = [...set.questions]; questions.splice(index + 1, 0, copy); onChange({ ...set, questions }); } },
                { id: "delete", label: "Delete", icon: Trash2, danger: true, onSelect: () => onChange(removeQuestion(set, question.id)) }
              ]} />
            </div>
            {issues && <ul className="ui-q-problems">{issues.map((message) => <li key={message} className="ui-field-error">{message}</li>)}</ul>}
            {open && <QuestionSettings question={question} onChange={replace} roles={roles} audience={audience} />}
          </li>;
        })}
      </ol>}
    {set.questions.length > 0 && <button type="button" className="secondary-button ui-q-add" onClick={() => setTypeMenu({ after: set.questions.length })}><Plus aria-hidden="true" />Add question</button>}
    {typeMenu && <TypeMenu audience={audience} allowed={allowedTypes} onPick={pickType} onClose={() => setTypeMenu(null)} />}
    {logicOpen && <LogicSheet set={set} onChange={onChange} onClose={() => setLogicOpen(false)} />}
  </div>;
}
