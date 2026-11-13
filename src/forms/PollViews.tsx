import { useMemo, useState } from "react";
import { Check, CircleHelp, Minus, Star } from "lucide-react";
import { LivePoll } from "../ui/live/LiveWidgets";
import type { PollResults, RespondView } from "../../shared/forms";
import type { Question, SlotVote } from "../../shared/questions";
import "./forms.css";

/**
 * A poll and a time poll as a respondent sees them (§D.1 UI "Poll", "Time poll"): the shared live poll
 * widget (W1-UI LivePoll, the same as Townhall's) with "N votes · closes in 2h", named voters for those
 * who may see results; and the find-a-time grid (slots as columns grouped by day, participants as rows,
 * yes ✓ / if need be (✓) / no, the best slot marked), a list of slots with three-state toggles on phones.
 */

export function closesText(closesAt: string | null, accepting: boolean) {
  if (!accepting) return "Closed";
  if (!closesAt) return null;
  const ms = Date.parse(closesAt) - Date.now();
  if (ms <= 0) return "Closing";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `closes in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `closes in ${hours} h`;
  return `closes ${new Date(closesAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

export function PollCard({ view, onVote, compact = false }: { view: RespondView; onVote?: (optionIds: string[]) => Promise<void>; compact?: boolean }) {
  const question = view.set?.questions.find((item) => item.type === "single_choice" || item.type === "multi_choice");
  if (!question) return <p className="forms-muted">This poll has no question yet.</p>;
  const results = view.results;
  const counts = results?.summary?.kind === "choice" ? Object.fromEntries(results.summary.options.map((option) => [option.optionId, option.count])) : null;
  const mineAnswer = view.mine?.answers?.[question.id];
  const myVote = typeof mineAnswer === "string" ? [mineAnswer] : mineAnswer && typeof mineAnswer === "object" && "options" in mineAnswer ? (mineAnswer as { options: string[] }).options : [];
  const canVote = view.form.canRespond && view.form.accepting && (view.closedReason === null || view.closedReason === "answered") && Boolean(onVote);
  const closes = closesText(view.form.closesAt, view.form.accepting);
  const hidden = view.form.resultsVisibility === "after_close" && view.form.accepting && results === null;
  return <div className={`forms-poll${compact ? " compact" : ""}`}>
    <LivePoll question={question.title} options={(question.options ?? []).map((option) => ({ id: option.id, label: option.label }))} counts={counts}
      myVote={view.form.anonymous ? [] : myVote} multiple={question.type === "multi_choice"} onVote={canVote ? onVote : undefined} closed={!view.form.accepting} resultsHidden={hidden} live={view.form.accepting} />
    <p className="forms-poll-meta">
      {view.form.anonymous && <span>Anonymous</span>}
      {question.type === "multi_choice" && <span>Choose any</span>}
      {closes && <span>{closes}</span>}
      {view.form.anonymous && view.mine && <span><Check aria-hidden="true" />You voted</span>}
    </p>
    {!compact && results && results.voters.length > 0 && <Voters question={question} results={results} />}
  </div>;
}

function Voters({ question, results }: { question: Question; results: PollResults }) {
  return <details className="forms-voters">
    <summary>Who voted</summary>
    <ul>{(question.options ?? []).map((option) => {
      const people = results.voters.find((entry) => entry.optionId === option.id)?.people ?? [];
      return <li key={option.id}><strong>{option.label}</strong><span>{people.length ? people.map((person) => person.name).join(", ") : "No votes"}</span></li>;
    })}</ul>
  </details>;
}

// ---------------------------------------------------------------- time poll grid

const ZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
const dayKey = (iso: string, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const dayLabel = (iso: string, tz: string) => new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
export const timeLabel = (iso: string, tz = ZONE) => new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
export const slotText = (slot: { start: string; end: string }, tz = ZONE) => `${dayLabel(slot.start, tz)}, ${timeLabel(slot.start, tz)}–${timeLabel(slot.end, tz)}`;

const VOTES: Array<{ value: SlotVote; label: string }> = [{ value: "yes", label: "Yes" }, { value: "maybe", label: "If need be" }, { value: "no", label: "No" }];

function VoteIcon({ vote }: { vote: SlotVote | undefined }) {
  if (vote === "yes") return <span className="forms-vote yes" title="Yes"><Check aria-hidden="true" /><span className="ui-visually-hidden">Yes</span></span>;
  if (vote === "maybe") return <span className="forms-vote maybe" title="If need be"><CircleHelp aria-hidden="true" /><span className="ui-visually-hidden">If need be</span></span>;
  if (vote === "no") return <span className="forms-vote no" title="No"><Minus aria-hidden="true" /><span className="ui-visually-hidden">No</span></span>;
  return <span className="forms-vote none" aria-label="No answer">·</span>;
}

/**
 * The find-a-time grid. `votes`/`onChange` are the viewer's own row (editable while open); other
 * participants come from `results.participants`. Times show in the viewer's zone (D846).
 */
export function TimePollGrid({ question, results, votes, onChange, editable, finalizedSlotId, tz = ZONE, organizer = false, onPick }: {
  question: Question;
  results: PollResults | null;
  votes: Record<string, SlotVote>;
  onChange?: (votes: Record<string, SlotVote>) => void;
  editable: boolean;
  finalizedSlotId: string | null;
  tz?: string;
  organizer?: boolean;
  onPick?: (slotId: string) => void;
}) {
  const slots = question.slots ?? [];
  const allowMaybe = question.allowMaybe !== false;
  const days = useMemo(() => {
    const groups: Array<{ key: string; label: string; slots: typeof slots }> = [];
    for (const slot of slots) {
      const key = dayKey(slot.start, tz);
      const group = groups.find((item) => item.key === key) ?? groups[groups.push({ key, label: dayLabel(slot.start, tz), slots: [] }) - 1]!;
      group.slots.push(slot);
    }
    return groups;
  }, [slots, tz]);
  const tally = (slotId: string) => {
    const summary = results?.summary?.kind === "slots" ? results.summary.slots.find((item) => item.slotId === slotId) : undefined;
    return { yes: summary?.yes ?? 0, maybe: summary?.maybe ?? 0 };
  };
  const best = results?.summary?.kind === "slots" ? results.summary.best : null;
  const others = (results?.participants ?? []).filter((person) => !(editable && person.you));
  const cycle = (slotId: string) => {
    if (!onChange) return;
    const order: SlotVote[] = allowMaybe ? ["yes", "maybe", "no"] : ["yes", "no"];
    const current = votes[slotId];
    const next = current ? order[(order.indexOf(current) + 1) % order.length]! : "yes";
    onChange({ ...votes, [slotId]: next });
  };
  const [focusDay, setFocusDay] = useState(0);
  return <div className="forms-timepoll">
    <p className="forms-muted forms-zone">Times in {tz.replace(/_/g, " ")}.</p>
    <div className="forms-grid-wrap" role="region" aria-label="Proposed times" tabIndex={0}>
      <table className="forms-grid">
        <thead>
          <tr><th scope="col" rowSpan={2} className="forms-grid-name">Participant</th>{days.map((day) => <th key={day.key} scope="colgroup" colSpan={day.slots.length} className="forms-grid-day">{day.label}</th>)}</tr>
          <tr>{days.flatMap((day) => day.slots.map((slot) => <th key={slot.id} scope="col" className={`forms-grid-slot${slot.id === best ? " best" : ""}${slot.id === finalizedSlotId ? " final" : ""}`}>
            <span className="ui-tabular">{timeLabel(slot.start, tz)}</span><small className="ui-tabular">–{timeLabel(slot.end, tz)}</small>
            {slot.id === finalizedSlotId ? <em className="forms-grid-badge"><Star aria-hidden="true" />Chosen</em> : slot.id === best ? <em className="forms-grid-badge">Best</em> : null}
          </th>))}</tr>
        </thead>
        <tbody>
          {others.map((person) => <tr key={person.key}><th scope="row" className="forms-grid-name">{person.name}</th>
            {days.flatMap((day) => day.slots.map((slot) => <td key={slot.id} className={slot.id === best ? "best" : ""}><VoteIcon vote={person.votes[slot.id]} /></td>))}</tr>)}
          {editable && <tr className="forms-grid-you"><th scope="row" className="forms-grid-name">You</th>
            {days.flatMap((day) => day.slots.map((slot) => <td key={slot.id}>
              <button type="button" className={`forms-vote-button ${votes[slot.id] ?? "unset"}`} onClick={() => cycle(slot.id)} aria-label={`${slotText(slot, tz)}: ${VOTES.find((item) => item.value === votes[slot.id])?.label ?? "no answer"}. Change`}>
                <VoteIcon vote={votes[slot.id]} />
              </button>
            </td>))}</tr>}
        </tbody>
        <tfoot>
          <tr><th scope="row" className="forms-grid-name">Total</th>{days.flatMap((day) => day.slots.map((slot) => {
            const count = tally(slot.id);
            return <td key={slot.id} className={`ui-tabular${slot.id === best ? " best" : ""}`}>{count.yes}{count.maybe ? <small> +{count.maybe}</small> : null}
              {organizer && onPick && !finalizedSlotId && <button type="button" className="ui-text-button forms-pick" onClick={() => onPick(slot.id)}>Pick</button>}</td>;
          }))}</tr>
        </tfoot>
      </table>
    </div>
    {/* Phones: one day at a time, a list of slots with three-state toggles. */}
    <div className="forms-slot-list">
      {days.length > 1 && <div className="ui-segmented forms-day-strip" role="group" aria-label="Day">
        {days.map((day, index) => <button key={day.key} type="button" aria-pressed={index === focusDay} onClick={() => setFocusDay(index)}>{day.label}</button>)}
      </div>}
      <ul>{(days[Math.min(focusDay, days.length - 1)]?.slots ?? []).map((slot) => {
        const count = tally(slot.id);
        return <li key={slot.id} className={slot.id === best ? "best" : slot.id === finalizedSlotId ? "final" : ""}>
          <div><strong className="ui-tabular">{timeLabel(slot.start, tz)}–{timeLabel(slot.end, tz)}</strong><span className="forms-muted ui-tabular">{count.yes} yes{count.maybe ? ` · ${count.maybe} if need be` : ""}{slot.id === best ? " · Best" : ""}{slot.id === finalizedSlotId ? " · Chosen" : ""}</span></div>
          {editable ? <div className="ui-segmented" role="radiogroup" aria-label={slotText(slot, tz)}>
            {VOTES.filter((item) => allowMaybe || item.value !== "maybe").map((item) => <button key={item.value} type="button" role="radio" aria-checked={votes[slot.id] === item.value} aria-pressed={votes[slot.id] === item.value} onClick={() => onChange?.({ ...votes, [slot.id]: item.value })}>{item.label}</button>)}
          </div> : organizer && onPick && !finalizedSlotId ? <button type="button" className="secondary-button ui-small-button" onClick={() => onPick(slot.id)}>Pick</button> : null}
        </li>;
      })}</ul>
    </div>
  </div>;
}
