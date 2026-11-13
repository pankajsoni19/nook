import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BarChart3, Check, Heart, Star } from "lucide-react";
import { REPORT_SERIES } from "../../../shared/reportTheme";
import { ResultBars } from "../questions/QuestionSummary";
import "../questions/questions.css";
import "./live.css";

/**
 * Live session widgets (§G.1 Townhall; also Forms' polls): a live poll, a word cloud, and a rating,
 * each in two sizes — inline (a note embed, the session page) and `presenter` (large, high-contrast,
 * for screen share). They are views: the module polls or streams the counts and passes them in; a
 * change animates the bars (not under reduced motion) and is announced at most every few seconds.
 */

/** Announces a changing total politely, at most once per `everyMs` (a live tally must not chatter). */
function useThrottledAnnouncement(text: string, everyMs = 5000) {
  const [said, setSaid] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + everyMs - Date.now());
    const timer = window.setTimeout(() => { last.current = Date.now(); setSaid(text); }, wait);
    return () => window.clearTimeout(timer);
  }, [text, everyMs]);
  return said;
}

export type LivePollOption = { id: string; label: string };

export function LivePoll({ question, options, counts, myVote = [], multiple = false, onVote, closed = false, resultsHidden = false, presenter = false, live = true }: {
  question: string;
  options: readonly LivePollOption[];
  /** Votes per option id; null while the results are not shown to this person. */
  counts: Readonly<Record<string, number>> | null;
  /** The option ids this person chose. */
  myVote?: readonly string[];
  multiple?: boolean;
  /** Absent: results only (presenter, or no permission to vote). */
  onVote?: (optionIds: string[]) => void | Promise<void>;
  closed?: boolean;
  /** The host hides results until the poll closes. */
  resultsHidden?: boolean;
  presenter?: boolean;
  /** Shows the "Live" marker while counts update. */
  live?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string[]>([...myVote]);
  const [sending, setSending] = useState(false);
  const [changing, setChanging] = useState(false);
  useEffect(() => { setDraft([...myVote]); setChanging(false); }, [myVote.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const voted = myVote.length > 0;
  const total = counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : 0;
  const voters = useThrottledAnnouncement(counts ? `${total} ${total === 1 ? "vote" : "votes"}` : "");
  const canVote = Boolean(onVote) && !closed;
  const showResults = counts !== null && (!canVote || (voted && !changing)) && !resultsHidden;
  const lead = counts ? options.reduce<string | null>((best, option) => best === null || (counts[option.id] ?? 0) > (counts[best] ?? 0) ? option.id : best, null) : null;
  const submit = async (ids: string[]) => {
    if (!onVote || !ids.length) return;
    setSending(true);
    try { await onVote(ids); } finally { setSending(false); }
  };
  return <section className={`ui-live ui-live-poll${presenter ? " presenter" : ""}`} aria-labelledby={`${id}-q`}>
    <header className="ui-live-head">
      <span className="ui-live-kind"><BarChart3 aria-hidden="true" />Poll</span>
      {closed ? <span className="ui-live-state closed">Closed</span> : live && <span className="ui-live-state"><span className="ui-live-dot" aria-hidden="true" />Live</span>}
    </header>
    <h3 id={`${id}-q`} className="ui-live-question">{question}</h3>
    {showResults
      ? <ResultBars rows={options.map((option) => ({ id: option.id, label: option.label + (myVote.includes(option.id) ? " (your vote)" : ""), count: counts![option.id] ?? 0 }))} total={total} highlight={lead} label="Results" />
      : canVote
        ? <div className="ui-q-choices" role={multiple ? "group" : "radiogroup"} aria-labelledby={`${id}-q`}>
          {options.map((option) => <label key={option.id} className="ui-q-choice">
            <input type={multiple ? "checkbox" : "radio"} name={`${id}-vote`} checked={draft.includes(option.id)} disabled={sending}
              onChange={(event) => {
                const next = multiple ? (event.target.checked ? [...draft, option.id] : draft.filter((value) => value !== option.id)) : [option.id];
                setDraft(next);
                if (!multiple) void submit(next);
              }} />
            <span>{option.label}</span>
          </label>)}
          {multiple && <button type="button" className="ui-q-submit" disabled={sending || draft.length === 0} onClick={() => { void submit(draft); }}><Check aria-hidden="true" />Vote</button>}
        </div>
        : <p className="ui-live-note">{resultsHidden ? "Results show when the poll closes." : "Results are not shown yet."}</p>}
    <footer className="ui-live-foot">
      <span className="ui-tabular" aria-hidden="true">{counts ? `${total} ${total === 1 ? "vote" : "votes"}` : ""}</span>
      <span className="ui-visually-hidden" role="status" aria-live="polite">{voters}</span>
      {voted && canVote && !changing && <button type="button" className="ui-text-button" onClick={() => setChanging(true)}>Change vote</button>}
    </footer>
  </section>;
}

export type CloudWord = { text: string; count: number };

/** Font sizes for a cloud: log-scaled between `min` and `max` px. Pure (exported for tests). */
export function cloudSizes(words: readonly CloudWord[], min = 14, max = 56): number[] {
  const counts = words.map((word) => Math.max(1, word.count));
  const low = Math.log(Math.min(...counts, 1));
  const high = Math.log(Math.max(...counts, 1));
  return counts.map((count) => high === low ? (min + max) / 2 : Math.round(min + ((Math.log(count) - low) / (high - low)) * (max - min)));
}

export function WordCloud({ prompt, words, onSubmit, maxLength = 25, presenter = false, closed = false }: {
  prompt: string;
  words: readonly CloudWord[];
  /** Adds this person's word (absent: view only). */
  onSubmit?: (text: string) => void | Promise<void>;
  maxLength?: number;
  presenter?: boolean;
  closed?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const top = useMemo(() => [...words].sort((a, b) => b.count - a.count).slice(0, 60), [words]);
  const sizes = cloudSizes(top, presenter ? 22 : 14, presenter ? 96 : 48);
  // A stable, scattered order: the largest in the middle, the rest around it.
  const placed = top.map((word, index) => ({ word, size: sizes[index]!, order: index % 2 === 0 ? index : -index }));
  const palette = REPORT_SERIES.dark;
  const send = async () => {
    const value = text.trim();
    if (!onSubmit || !value) return;
    setSending(true);
    try { await onSubmit(value.slice(0, maxLength)); setText(""); } finally { setSending(false); }
  };
  return <section className={`ui-live ui-word-cloud${presenter ? " presenter" : ""}`} aria-labelledby={`${id}-q`}>
    <header className="ui-live-head"><span className="ui-live-kind">Word cloud</span>{closed && <span className="ui-live-state closed">Closed</span>}</header>
    <h3 id={`${id}-q`} className="ui-live-question">{prompt}</h3>
    <div className="ui-cloud" aria-hidden="true">
      {placed.map(({ word, size, order }, index) => <span key={word.text} style={{ fontSize: size, order, color: palette[index % palette.length] }} title={`${word.text}: ${word.count}`}>{word.text}</span>)}
      {top.length === 0 && <span className="ui-live-note" style={{ fontSize: 14 }}>No words yet.</span>}
    </div>
    <ol className="ui-visually-hidden" aria-label="Words, most frequent first">{top.map((word) => <li key={word.text}>{word.text}, {word.count}</li>)}</ol>
    {onSubmit && !closed && <form className="ui-cloud-form" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <label className="ui-visually-hidden" htmlFor={`${id}-word`}>Your word</label>
      <input id={`${id}-word`} type="text" value={text} maxLength={maxLength} placeholder="Add a word or two" disabled={sending} onChange={(event) => setText(event.target.value)} />
      <button type="submit" className="ui-q-submit" disabled={sending || !text.trim()}>Send</button>
    </form>}
  </section>;
}

export function RatingWidget({ prompt, max = 5, icon = "star", value = null, onRate, average = null, count = 0, distribution, presenter = false, closed = false }: {
  prompt: string;
  max?: number;
  icon?: "star" | "heart" | "number";
  /** This person's rating. */
  value?: number | null;
  onRate?: (value: number) => void | Promise<void>;
  average?: number | null;
  count?: number;
  /** Ratings per value (1…max), for the histogram. */
  distribution?: Readonly<Record<number, number>>;
  presenter?: boolean;
  closed?: boolean;
}) {
  const id = useId();
  const values = Array.from({ length: max }, (_, index) => index + 1);
  const Icon = icon === "heart" ? Heart : Star;
  const said = useThrottledAnnouncement(average !== null ? `Average ${average.toFixed(1)} of ${max}, ${count} ${count === 1 ? "rating" : "ratings"}` : "");
  const peak = Math.max(1, ...values.map((entry) => distribution?.[entry] ?? 0));
  return <section className={`ui-live ui-rating${presenter ? " presenter" : ""}`} aria-labelledby={`${id}-q`}>
    <header className="ui-live-head"><span className="ui-live-kind"><Star aria-hidden="true" />Rating</span>{closed && <span className="ui-live-state closed">Closed</span>}</header>
    <h3 id={`${id}-q`} className="ui-live-question">{prompt}</h3>
    {onRate && !closed && <div className={`ui-q-scale${icon === "number" ? "" : " icons"}`}>
      <div className="ui-q-scale-row" role="radiogroup" aria-labelledby={`${id}-q`}>
        {values.map((number) => <label key={number} className={`ui-q-scale-option${value !== null && (icon === "number" ? number === value : number <= value) ? " filled" : ""}${number === value ? " chosen" : ""}`}>
          <input type="radio" name={`${id}-rate`} checked={number === value} onChange={() => { void onRate(number); }} />
          <span aria-hidden="true">{icon === "number" ? number : <Icon />}</span><span className="ui-visually-hidden">{number} of {max}</span>
        </label>)}
      </div>
    </div>}
    {average !== null && <div className="ui-rating-result">
      <p className="ui-rating-average"><strong className="ui-tabular">{average.toFixed(1)}</strong><span> of {max}</span></p>
      <p className="ui-live-note ui-tabular">{count} {count === 1 ? "rating" : "ratings"}</p>
      {distribution && <ol className="ui-rating-bars" aria-label="Ratings by value">
        {[...values].reverse().map((entry) => <li key={entry}><span className="ui-tabular">{entry}</span><span className="ui-result-track"><span style={{ width: `${((distribution[entry] ?? 0) / peak) * 100}%` }} /></span><span className="ui-tabular">{distribution[entry] ?? 0}</span></li>)}
      </ol>}
    </div>}
    <span className="ui-visually-hidden" role="status" aria-live="polite">{said}</span>
  </section>;
}
