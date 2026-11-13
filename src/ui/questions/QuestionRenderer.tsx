import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, CornerDownLeft } from "lucide-react";
import { checkAnswer, evaluateLogic, isAnswered, validateAnswers, type Answers, type AnswerValue, type Audience, type Question, type QuestionSet } from "../../../shared/questions";
import { isEditableTarget } from "../moduleKeys";
import { inlineText } from "./inline";
import { pickByKey, QuestionInput, type QuestionInputProps } from "./QuestionInput";
import "./questions.css";

/**
 * Answering a question set (§B.2, §E.3, D839): every type, two layouts, two themes.
 *
 * - `mode="page"`: every visible question in order under its section's heading, one Submit.
 * - `mode="stepper"`: one question at a time with a progress line; Enter goes on, Shift+Enter goes
 *   back, 1–9 pick a choice, arrows move on scales. A required question must be answered to go on.
 * - `theme="public"`: the light public-page look (§E.6), dark when the visitor's system is.
 *
 * The logic is shared/questions `evaluateLogic` (the server's own): hidden questions disappear as
 * answers change and their answers are dropped on submit. Errors come from `validateAnswers` (the
 * server's) plus any `errors` the server returned.
 */
export type QuestionRendererProps = {
  set: QuestionSet;
  answers: Answers;
  onChange: (answers: Answers) => void;
  onSubmit: (answers: Answers, ending: string | null) => void | Promise<void>;
  mode?: "page" | "stepper";
  theme?: "app" | "public";
  audience?: Audience;
  /** Errors the server returned, by question id. */
  errors?: Record<string, string>;
  submitting?: boolean;
  submitLabel?: string;
  /** Hidden fields' values (URL parameters), by question id. */
  hidden?: Record<string, string>;
  memberField?: QuestionInputProps["memberField"];
  timeZone?: string;
  /** Shown above the questions (a form's title and description, rendered by the host). */
  header?: ReactNode;
};

/** The section headings to show before each visible question (page mode). */
function sectionStarts(set: QuestionSet, visible: readonly string[]) {
  const starts = new Map<string, { title?: string; description?: string }>();
  let current: string | undefined;
  for (const id of visible) {
    const question = set.questions.find((item) => item.id === id);
    const section = question?.sectionId;
    if (section && section !== current) {
      const def = set.sections.find((item) => item.id === section);
      if (def && (def.title || def.description)) starts.set(id, { title: def.title, description: def.description });
    }
    current = section;
  }
  return starts;
}

/** One question's error now: required and empty, or its value does not check. Null when fine. */
export function questionError(question: Question, value: AnswerValue | undefined): string | null {
  if (question.type === "statement" || question.type === "hidden") return null;
  if (!isAnswered(value)) return question.required ? "This question is required" : null;
  const checked = checkAnswer(question, value);
  return "error" in checked ? checked.error : null;
}

function QuestionBlock({ question, number, value, onChange, error, memberField, timeZone, autoFocus }: { question: Question; number: number | null; value: AnswerValue | undefined; onChange: (value: AnswerValue | undefined) => void; error?: string | null; memberField?: QuestionRendererProps["memberField"]; timeZone?: string; autoFocus?: boolean }) {
  const id = useId();
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const target = ref.current?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, button, [role=combobox]");
    target?.focus({ preventScroll: false });
  }, [autoFocus, question.id]);
  if (question.type === "statement") return <div ref={ref} className="ui-q-block statement" data-question={question.id}>
    <p className="ui-q-title" id={labelId}>{inlineText(question.title)}</p>
    {question.help && <p className="ui-q-help" id={helpId}>{inlineText(question.help, "h")}</p>}
  </div>;
  const describedBy = [question.help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return <div ref={ref} className={`ui-q-block${error ? " invalid" : ""}`} data-question={question.id} data-type={question.type}>
    <p className="ui-q-title" id={labelId}>
      {number !== null && <span className="ui-q-number ui-tabular" aria-hidden="true">{number}</span>}
      <span>{inlineText(question.title)}</span>
      {question.required && <span className="ui-q-required" aria-label="required" title="Required">*</span>}
    </p>
    {question.help && <p className="ui-q-help" id={helpId}>{inlineText(question.help, "h")}</p>}
    <QuestionInput question={question} value={value} onChange={onChange} labelId={labelId} describedBy={describedBy} invalid={Boolean(error)} memberField={memberField} timeZone={timeZone} />
    {error && <p className="ui-q-error" id={errorId} role="alert">{error}</p>}
  </div>;
}

export function QuestionRenderer({ set, answers, onChange, onSubmit, mode = "page", theme = "app", audience = "member", errors: serverErrors = {}, submitting = false, submitLabel = "Submit", hidden, memberField, timeZone, header }: QuestionRendererProps) {
  const logic = useMemo(() => evaluateLogic(set, answers), [set, answers]);
  const byId = useMemo(() => new Map(set.questions.map((question) => [question.id, question])), [set]);
  const shown = logic.visible.map((id) => byId.get(id)!).filter((question) => question && question.type !== "hidden");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const [touched, setTouched] = useState(false);
  const allErrors = { ...errors, ...serverErrors };
  const numbered = new Map<string, number>();
  shown.filter((question) => question.type !== "statement").forEach((question, index) => numbered.set(question.id, index + 1));
  const setAnswer = (id: string, value: AnswerValue | undefined) => {
    const next = { ...answers };
    if (value === undefined) delete next[id]; else next[id] = value;
    onChange(next);
    if (errors[id]) setErrors((current) => { const copy = { ...current }; delete copy[id]; return copy; });
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (submitting) return;
    setTouched(true);
    const check = validateAnswers(set, answers, { audience, hidden });
    if (!check.ok) {
      setErrors(check.errors);
      const first = logic.visible.find((id) => check.errors[id]);
      if (mode === "stepper" && first) setStep(Math.max(0, shown.findIndex((question) => question.id === first)));
      else if (first) window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-question="${CSS.escape(first)}"] input, [data-question="${CSS.escape(first)}"] textarea, [data-question="${CSS.escape(first)}"] button`)?.focus());
      return;
    }
    void onSubmit(check.answers, check.ending);
  };

  // Stepper: keep the step in range as logic shows and hides questions.
  const current = mode === "stepper" ? shown[Math.min(step, Math.max(0, shown.length - 1))] : undefined;
  useEffect(() => { if (step > shown.length - 1) setStep(Math.max(0, shown.length - 1)); }, [shown.length, step]);
  const last = step >= shown.length - 1;
  const next = () => {
    if (!current) return;
    const error = questionError(current, answers[current.id]);
    if (error) { setErrors((value) => ({ ...value, [current.id]: error })); return; }
    if (last) submit(); else setStep(step + 1);
  };
  const onStepKey = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (!current || event.defaultPrevented) return;
    const typing = isEditableTarget(event.target) && !(event.target instanceof HTMLInputElement && (event.target.type === "radio" || event.target.type === "checkbox"));
    if (event.key === "Enter" && !event.shiftKey && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); next(); return; }
    if (event.key === "Enter" && event.shiftKey && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); setStep(Math.max(0, step - 1)); return; }
    if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && pickByKey(current, answers[current.id], event.key, (value) => setAnswer(current.id, value))) event.preventDefault();
  };

  const starts = sectionStarts(set, shown.map((question) => question.id));
  const errorCount = Object.keys(allErrors).filter((id) => logic.visible.includes(id)).length;

  return <form className={`ui-questions ${mode}`} data-theme={theme} noValidate onSubmit={mode === "page" ? submit : (event) => { event.preventDefault(); next(); }} onKeyDown={mode === "stepper" ? onStepKey : undefined} aria-busy={submitting || undefined}>
    {header}
    {mode === "page" && <>
      {shown.map((question) => <div key={question.id}>
        {starts.has(question.id) && <div className="ui-q-section">{starts.get(question.id)!.title && <h3>{starts.get(question.id)!.title}</h3>}{starts.get(question.id)!.description && <p>{starts.get(question.id)!.description}</p>}</div>}
        <QuestionBlock question={question} number={numbered.get(question.id) ?? null} value={answers[question.id]} onChange={(value) => setAnswer(question.id, value)} error={allErrors[question.id]} memberField={memberField} timeZone={timeZone} />
      </div>)}
      {touched && errorCount > 0 && <p className="ui-q-error ui-q-summary" role="alert">{errorCount === 1 ? "One answer needs a look." : `${errorCount} answers need a look.`}</p>}
      <div className="ui-q-actions"><button type="submit" className="ui-q-submit" disabled={submitting}>{submitting ? "Sending…" : submitLabel}</button></div>
    </>}
    {mode === "stepper" && current && <>
      <div className="ui-q-progress" aria-hidden="true"><span style={{ width: `${Math.round(((step + 1) / Math.max(1, shown.length)) * 100)}%` }} /></div>
      <p className="ui-q-step ui-tabular" aria-live="polite">Question {step + 1} of {shown.length}</p>
      <QuestionBlock key={current.id} question={current} number={numbered.get(current.id) ?? null} value={answers[current.id]} onChange={(value) => setAnswer(current.id, value)} error={allErrors[current.id]} memberField={memberField} timeZone={timeZone} autoFocus />
      <div className="ui-q-actions">
        <button type="button" className="ui-q-back" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} aria-keyshortcuts="Shift+Enter"><ArrowLeft aria-hidden="true" />Back</button>
        <button type="submit" className="ui-q-submit" disabled={submitting} aria-keyshortcuts="Enter">{last ? <>{submitting ? "Sending…" : submitLabel}<Check aria-hidden="true" /></> : <>Next<ArrowRight aria-hidden="true" /></>}</button>
        <span className="ui-q-hint" aria-hidden="true">press Enter <CornerDownLeft /></span>
      </div>
    </>}
    {shown.length === 0 && <p className="ui-q-note">There are no questions to answer.</p>}
  </form>;
}
