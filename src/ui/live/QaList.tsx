import { useId, useState } from "react";
import { ArrowBigUp, CheckCheck, CircleCheck, EyeOff, Eye, Merge, MessageCircleQuestion, Pin, PinOff, Send, UserRound } from "lucide-react";
import { relativeTime } from "../../files/format";
import { EmptyState } from "../EmptyState";
import { MoreMenu, type MoreMenuItem } from "../MoreMenu";
import "../workspace.css";
import "./live.css";

/**
 * Questions and answers for a Townhall session (§G.1): people ask (named, or anonymously when the
 * host allows), upvote, and moderators approve, hide, mark answered, pin the current one, and merge
 * duplicates. Sorted by votes (Top) or time (Recent); the pinned question leads. Upvote is a toggle
 * button (`aria-pressed`) with the count in its name. The module owns the data; this is the view.
 */
export type QaStatus = "pending" | "approved" | "answered" | "hidden";
export type QaQuestion = {
  id: string;
  text: string;
  /** Null: asked anonymously. */
  author: string | null;
  votes: number;
  /** This person upvoted it. */
  voted: boolean;
  status: QaStatus;
  pinned?: boolean;
  createdAt: string;
  /** This person asked it (they may see it while pending). */
  mine?: boolean;
};
export type QaModeration = "approve" | "hide" | "unhide" | "answered" | "pin" | "unpin" | "merge";

/** The list as shown: hidden ones only to moderators, pinned first, then by votes or time. Pure. */
export function orderQuestions(questions: readonly QaQuestion[], sort: "top" | "recent", moderator: boolean): QaQuestion[] {
  const shown = questions.filter((question) => moderator || question.status === "approved" || question.status === "answered" || (question.mine && question.status === "pending"));
  return [...shown].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    // Answered questions sink below open ones.
    if ((a.status === "answered") !== (b.status === "answered")) return a.status === "answered" ? 1 : -1;
    if (sort === "top" && a.votes !== b.votes) return b.votes - a.votes;
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });
}

const STATUS_WORDS: Record<QaStatus, string> = { pending: "Waiting for review", approved: "", answered: "Answered", hidden: "Hidden" };

export function QaList({ questions, sort, onSort, onUpvote, onAsk, anonymousAllowed = true, moderator = false, onModerate, closed = false, maxLength = 300 }: {
  questions: readonly QaQuestion[];
  sort: "top" | "recent";
  onSort: (sort: "top" | "recent") => void;
  onUpvote?: (id: string, voted: boolean) => void;
  /** Asks a question (absent: no asking here, e.g. the presenter view). */
  onAsk?: (text: string, anonymous: boolean) => Promise<void>;
  anonymousAllowed?: boolean;
  moderator?: boolean;
  onModerate?: (id: string, action: QaModeration) => void;
  closed?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ordered = orderQuestions(questions, sort, moderator);
  const ask = async () => {
    if (!onAsk || !text.trim()) return;
    setSending(true);
    setError(null);
    try { await onAsk(text.trim(), anonymous); setText(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not send the question"); }
    finally { setSending(false); }
  };
  const menu = (question: QaQuestion): MoreMenuItem[] => [
    ...(question.status === "pending" ? [{ id: "approve", label: "Approve", icon: CircleCheck, onSelect: () => onModerate?.(question.id, "approve") }] : []),
    ...(question.status !== "answered" && question.status !== "hidden" ? [{ id: "answered", label: "Mark answered", icon: CheckCheck, onSelect: () => onModerate?.(question.id, "answered") }] : []),
    question.pinned ? { id: "unpin", label: "Unpin", icon: PinOff, onSelect: () => onModerate?.(question.id, "unpin") } : { id: "pin", label: "Pin as current", icon: Pin, onSelect: () => onModerate?.(question.id, "pin") },
    { id: "merge", label: "Merge into…", icon: Merge, onSelect: () => onModerate?.(question.id, "merge") },
    question.status === "hidden" ? { id: "unhide", label: "Show again", icon: Eye, onSelect: () => onModerate?.(question.id, "unhide") } : { id: "hide", label: "Hide", icon: EyeOff, danger: true, onSelect: () => onModerate?.(question.id, "hide") }
  ];
  return <section className="ui-qa" aria-labelledby={`${id}-title`}>
    <header className="ui-panel-header">
      <h3 id={`${id}-title`}><MessageCircleQuestion aria-hidden="true" />Questions<span className="ui-panel-count ui-tabular"> · {ordered.length}</span></h3>
      <div className="ui-segmented" role="group" aria-label="Sort questions">
        <button type="button" aria-pressed={sort === "top"} onClick={() => onSort("top")}>Top</button>
        <button type="button" aria-pressed={sort === "recent"} onClick={() => onSort("recent")}>Recent</button>
      </div>
    </header>
    {onAsk && !closed && <form className="ui-qa-ask" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
      <label className="ui-visually-hidden" htmlFor={`${id}-ask`}>Your question</label>
      <textarea id={`${id}-ask`} rows={2} value={text} maxLength={maxLength} placeholder="Ask a question" disabled={sending}
        onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ask(); } }} />
      <div className="ui-qa-ask-row">
        {anonymousAllowed && <label className="ui-q-check"><input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} />Ask anonymously</label>}
        <span className="ui-qa-left ui-tabular" aria-hidden="true">{maxLength - text.length}</span>
        <button type="submit" className="action-button ui-small-action" disabled={sending || !text.trim()}><Send aria-hidden="true" />{sending ? "Sending…" : "Ask"}</button>
      </div>
      {error && <p className="ui-field-error" role="alert">{error}</p>}
    </form>}
    {ordered.length === 0
      ? <EmptyState compact as="h4" icon={MessageCircleQuestion} title="No questions yet">{onAsk && !closed ? "Be the first to ask." : undefined}</EmptyState>
      : <ol className="ui-qa-list">
        {ordered.map((question) => <li key={question.id} className={`ui-qa-item${question.pinned ? " pinned" : ""}${question.status !== "approved" ? ` ${question.status}` : ""}`}>
          <button type="button" className="ui-qa-vote" aria-pressed={question.voted} disabled={!onUpvote || closed || question.status === "hidden"}
            aria-label={`${question.voted ? "Remove your upvote" : "Upvote"}, ${question.votes} ${question.votes === 1 ? "vote" : "votes"}`} onClick={() => onUpvote?.(question.id, !question.voted)}>
            <ArrowBigUp aria-hidden="true" /><span className="ui-tabular" aria-hidden="true">{question.votes}</span>
          </button>
          <div className="ui-qa-body">
            {question.pinned && <span className="ui-qa-flag"><Pin aria-hidden="true" />Now answering</span>}
            <p className="ui-qa-text">{question.text}</p>
            <p className="ui-qa-meta">
              {question.author ? <span>{question.author}</span> : <span className="ui-qa-anon"><UserRound aria-hidden="true" />Anonymous</span>}
              {" · "}<time dateTime={question.createdAt}>{relativeTime(question.createdAt)}</time>
              {STATUS_WORDS[question.status] && <> · <span className={`ui-qa-status ${question.status}`}>{STATUS_WORDS[question.status]}</span></>}
            </p>
          </div>
          {moderator && onModerate && <MoreMenu label="Moderate question" items={menu(question)} />}
        </li>)}
      </ol>}
  </section>;
}
