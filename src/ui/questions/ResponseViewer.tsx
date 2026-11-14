import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { relativeTime } from "../../files/format";
import { useModuleShortcuts } from "../moduleKeys";
import { YES_NO_OPTIONS, type AnswerValue, type ContactAnswer, type MultiChoiceAnswer, type Question, type QuestionSet, type ResponseSummary } from "../../../shared/questions";
import { inlineText } from "./inline";
import "./questions.css";

/**
 * One response, read-only (§B.2, §E.3, D839): each question of the version it answered, with its
 * answer as words ("Yes", "3 of 5", "Mon 16 Nov 09:00 – 09:30: Yes"). Prev/Next and J/K step through
 * responses; options renamed since show their current label, removed ones "Removed option".
 */
const optionLabel = (question: Question, id: string) => (question.type === "yes_no" ? YES_NO_OPTIONS : question.options ?? []).find((option) => option.id === id)?.label ?? "Removed option";

/** An answer as words. Pure (exported for tests and CSV previews). */
export function answerText(question: Question, value: AnswerValue | undefined, timeZone?: string): string {
  if (value === undefined || value === null || value === "") return "";
  switch (question.type) {
    case "single_choice": case "dropdown": case "yes_no":
      return typeof value === "string" ? optionLabel(question, value) : typeof value === "object" && "other" in value ? `Other: ${(value as { other: string }).other}` : "";
    case "multi_choice": {
      const answer = value as MultiChoiceAnswer;
      return [...(answer.options ?? []).map((id) => optionLabel(question, id)), ...(answer.other ? [`Other: ${answer.other}`] : [])].join(", ");
    }
    case "ranking": return Array.isArray(value) ? (value as string[]).map((id, index) => `${index + 1}. ${optionLabel(question, id)}`).join("  ") : "";
    case "rating": case "scale": return typeof value === "number" ? `${value} of ${question.scale?.max ?? 5}` : "";
    case "nps": return typeof value === "number" ? `${value} of 10` : "";
    case "number": return typeof value === "number" ? new Intl.NumberFormat().format(value) : "";
    case "datetime": return typeof value === "string" ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone }).format(Date.parse(value)) : "";
    case "matrix": {
      const answer = value as Record<string, string | string[]>;
      const column = (id: string) => question.matrix?.columns.find((item) => item.id === id)?.label ?? "Removed option";
      return (question.matrix?.rows ?? []).filter((row) => answer[row.id] !== undefined).map((row) => `${row.label}: ${([] as string[]).concat(answer[row.id]!).map(column).join(", ")}`).join("; ");
    }
    case "time_slots": {
      const answer = value as Record<string, string>;
      const format = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone });
      const words: Record<string, string> = { yes: "Yes", maybe: "If needed", no: "No" };
      return (question.slots ?? []).filter((slot) => answer[slot.id]).map((slot) => `${format.format(Date.parse(slot.start))}: ${words[answer[slot.id]!] ?? answer[slot.id]}`).join("; ");
    }
    case "contact": { const answer = value as ContactAnswer; return [answer.name, answer.email, answer.phone, answer.company].filter(Boolean).join(" · "); }
    case "file": case "person": case "card": return Array.isArray(value) ? `${value.length} ${question.type === "file" ? (value.length === 1 ? "file" : "files") : question.type === "person" ? (value.length === 1 ? "person" : "people") : (value.length === 1 ? "card" : "cards")}` : "";
    default: return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  }
}

const respondentName = (response: ResponseSummary) => response.respondent.kind === "anonymous" ? "Anonymous" : response.respondent.name ?? response.respondent.email ?? (response.respondent.kind === "user" ? "A member" : "A respondent");

export function ResponseViewer({ set, response, position, total, onPrev, onNext, onDelete, showScore = false, timeZone }: {
  set: QuestionSet;
  response: ResponseSummary;
  /** 1-based position in the list, and its length. */
  position: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
  onDelete?: () => void;
  /** Result readers see the score (§B.2 Scoring). */
  showScore?: boolean;
  timeZone?: string;
}) {
  useModuleShortcuts({ j: onNext ? () => { onNext(); } : undefined, k: onPrev ? () => { onPrev(); } : undefined });
  const questions = set.questions.filter((question) => question.type !== "statement");
  return <article className="ui-response" aria-labelledby={`response-${response.id}`}>
    <header className="ui-response-head">
      <div>
        <h3 id={`response-${response.id}`}>{respondentName(response)}</h3>
        <p><time dateTime={response.submittedAt}>{relativeTime(response.submittedAt)}</time>{response.status === "pending_verification" ? " · Waiting for email confirmation" : ""}{showScore && response.score !== null ? ` · Score ${response.score}` : ""}</p>
      </div>
      <nav className="ui-response-nav" aria-label="Responses">
        <span className="ui-tabular">{position} of {total}</span>
        <button type="button" className="icon-button" onClick={onPrev} disabled={!onPrev} aria-label="Previous response" title="Previous (K)" aria-keyshortcuts="K"><ChevronLeft /></button>
        <button type="button" className="icon-button" onClick={onNext} disabled={!onNext} aria-label="Next response" title="Next (J)" aria-keyshortcuts="J"><ChevronRight /></button>
        {onDelete && <button type="button" className="icon-button" onClick={onDelete} aria-label="Delete response" title="Delete"><Trash2 /></button>}
      </nav>
    </header>
    <dl className="ui-response-answers">
      {questions.map((question) => {
        const text = answerText(question, response.answers[question.id], timeZone);
        return <div key={question.id}>
          <dt>{inlineText(question.title)}</dt>
          <dd className={text ? undefined : "empty"}>{text || "No answer"}</dd>
        </div>;
      })}
    </dl>
  </article>;
}
