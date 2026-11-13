import { useId, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { LivePoll, RatingWidget, WordCloud } from "../ui/live/LiveWidgets";
import type { TownhallPollView } from "../../shared/townhall";
import { TOWNHALL_LIMITS } from "../../shared/townhall";
import type { PollAnswer } from "./api";

/**
 * One poll, as the shared live widgets draw it (W1-UI D839: LivePoll, WordCloud, RatingWidget), plus
 * open text (a module-only shape: an answer box and the latest answers). `presenter` is the large,
 * high-contrast size. Without `onVote` it shows results only.
 */
export function PollView({ poll, presenter = false, onVote }: { poll: TownhallPollView; presenter?: boolean; onVote?: (answer: PollAnswer) => Promise<void> }) {
  const closed = poll.status === "closed";
  const live = poll.status === "live";
  const vote = onVote && live ? onVote : undefined;
  if (poll.kind === "single" || poll.kind === "multi") {
    return <LivePoll question={poll.title} options={poll.options} counts={poll.counts} myVote={poll.myVote} multiple={poll.kind === "multi"}
      onVote={vote ? (optionIds) => vote({ optionIds }) : undefined} closed={closed} resultsHidden={poll.resultsHidden && poll.counts === null} presenter={presenter} live={live} />;
  }
  if (poll.kind === "rating") {
    return <RatingWidget prompt={poll.title} max={poll.max} value={poll.myRating} onRate={vote ? (rating) => vote({ rating }) : undefined}
      average={poll.average} count={poll.total} distribution={poll.counts === null ? undefined : poll.distribution} presenter={presenter} closed={closed} />;
  }
  if (poll.kind === "word_cloud") {
    const canAdd = vote && poll.myWords.length < TOWNHALL_LIMITS.wordsPerPerson;
    return <div className="th-poll-wrap">
      <WordCloud prompt={poll.title} words={poll.words} onSubmit={canAdd ? (text) => vote({ text }) : undefined} maxLength={TOWNHALL_LIMITS.word} presenter={presenter} closed={closed} />
      {!presenter && poll.myWords.length > 0 && <p className="th-poll-note">Your words: {poll.myWords.join(", ")}{canAdd ? "" : ` (that's ${TOWNHALL_LIMITS.wordsPerPerson})`}</p>}
      {!presenter && poll.counts === null && <p className="th-poll-note">Results show when the poll closes.</p>}
    </div>;
  }
  return <OpenText poll={poll} presenter={presenter} onVote={vote} />;
}

function OpenText({ poll, presenter, onVote }: { poll: TownhallPollView; presenter: boolean; onVote?: (answer: PollAnswer) => Promise<void> }) {
  const id = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const mine = poll.myWords[0] ?? null;
  const send = async () => {
    if (!onVote || !text.trim()) return;
    setSending(true);
    try { await onVote({ text: text.trim() }); setText(""); } finally { setSending(false); }
  };
  return <section className={`ui-live th-open-text${presenter ? " presenter" : ""}`} aria-labelledby={`${id}-q`}>
    <header className="ui-live-head">
      <span className="ui-live-kind"><MessageSquareText aria-hidden="true" />Open text</span>
      {poll.status === "closed" ? <span className="ui-live-state closed">Closed</span> : <span className="ui-live-state"><span className="ui-live-dot" aria-hidden="true" />Live</span>}
    </header>
    <h3 id={`${id}-q`} className="ui-live-question">{poll.title}</h3>
    {onVote && <form className="ui-cloud-form" noValidate onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <label className="ui-visually-hidden" htmlFor={`${id}-answer`}>Your answer</label>
      <input id={`${id}-answer`} type="text" value={text} maxLength={TOWNHALL_LIMITS.openText} placeholder={mine ? "Change your answer" : "Your answer"} disabled={sending} onChange={(event) => setText(event.target.value)} />
      <button type="submit" className="ui-q-submit" disabled={sending || !text.trim()}>{mine ? "Update" : "Send"}</button>
    </form>}
    {mine && !presenter && <p className="ui-live-note">Your answer: {mine}</p>}
    {poll.counts === null
      ? <p className="ui-live-note">Answers show when the poll closes.</p>
      : poll.entries.length === 0
        ? <p className="ui-live-note">No answers yet.</p>
        : <ul className="th-open-list" aria-label="Latest answers">{poll.entries.slice(0, presenter ? 12 : 50).map((entry, index) => <li key={`${index}:${entry}`}>{entry}</li>)}</ul>}
    <footer className="ui-live-foot"><span className="ui-tabular">{poll.total} {poll.total === 1 ? "answer" : "answers"}</span></footer>
  </section>;
}
