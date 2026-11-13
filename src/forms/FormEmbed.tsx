import { useCallback, useEffect, useState } from "react";
import { CalendarClock, ClipboardList, Vote } from "lucide-react";
import { ApiError } from "../api";
import { EmbedCard } from "../ui/embeds/EmbedCard";
import type { EmbedCardProps } from "../editor/moduleEmbedRegistry";
import { shortIdOfSegment } from "../../shared/friendlyUrls";
import type { RespondView } from "../../shared/forms";
import { respondView, submitResponse } from "./formsApi";
import { PollCard, slotText } from "./PollViews";

/**
 * The live card of a form, poll, or time poll in a note or a card description (§B.4.4, §C C18). It is
 * fetched as the reader: a poll votes inline (live results, named voters only for result readers); a
 * form or time poll shows its title, state, and one button that opens it. Unreadable or deleted reads
 * "Poll unavailable" with nothing about it (T513). While the note is being edited, the poll is a
 * preview without voting.
 */
export default function FormEmbed({ path, kind, editable }: EmbedCardProps) {
  const ref = shortIdOfSegment(path.split(/[?#]/)[0]!.split("/").filter(Boolean)[1] ?? "") ?? path.split("/")[2] ?? "";
  const [view, setView] = useState<RespondView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const word = kind === "poll" ? "Poll" : kind === "time_poll" ? "Time poll" : "Form";
  const load = useCallback(async () => {
    try {
      setView(await respondView(ref));
      setState("ready");
    } catch (error) {
      setState(error instanceof ApiError && error.status !== 404 && error.status !== 403 ? "ready" : "missing");
    }
  }, [ref]);
  useEffect(() => { void load(); }, [load]);
  // Live results: poll every 15 s while visible.
  useEffect(() => {
    if (state !== "ready" || view?.form.kind !== "poll" || !view.form.accepting) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [state, view?.form.kind, view?.form.accepting, load]);
  // An in-app navigation of its own (the whiteboard embed's event, D208), so Back returns to the note.
  const open = () => { if (view) window.dispatchEvent(new CustomEvent("nook:open-path", { detail: { path: view.form.href } })); };
  if (state === "loading") return <EmbedCard icon={ClipboardList} word={word} loading />;
  if (state === "missing" || !view) return <EmbedCard icon={ClipboardList} word={word} unavailable />;
  if (view.form.kind === "poll") {
    return <EmbedCard icon={Vote} word="Poll" title={view.form.title} subtitle={view.form.accepting ? "Poll" : "Poll · closed"} action={{ label: "Open", onClick: open }}>
      <PollCard compact view={view} onVote={editable ? undefined : async (optionIds) => {
        const question = view.set!.questions.find((item) => item.type === "single_choice" || item.type === "multi_choice")!;
        const answer = question.type === "multi_choice" ? { options: optionIds } : optionIds[0];
        const result = await submitResponse(view.form.id, { [question.id]: answer });
        setView(result.view);
      }} />
    </EmbedCard>;
  }
  if (view.form.kind === "time_poll") {
    const question = view.set?.questions.find((item) => item.type === "time_slots");
    const final = question?.slots?.find((slot) => slot.id === view.form.finalizedSlotId);
    const best = view.results?.summary?.kind === "slots" && view.results.summary.best ? question?.slots?.find((slot) => slot.id === (view.results!.summary as { best: string }).best) : null;
    const subtitle = final ? `Chosen: ${slotText(final)}` : best ? `Best so far: ${slotText(best)}` : `${question?.slots?.length ?? 0} proposed times`;
    return <EmbedCard icon={CalendarClock} word="Time poll" title={view.form.title} subtitle={subtitle} action={{ label: view.form.accepting && view.form.canRespond ? (view.mine ? "Change votes" : "Vote") : "Open", onClick: open, primary: view.form.accepting && !view.mine }} />;
  }
  const answered = view.mine !== null;
  const label = !view.form.accepting ? "Open" : answered ? (view.form.allowEdit ? "Edit response" : "Open") : "Respond";
  return <EmbedCard icon={ClipboardList} word="Form" title={view.form.title} subtitle={!view.form.accepting ? "Closed" : answered ? "You responded" : view.form.closesAt ? `Open until ${new Date(view.form.closesAt).toLocaleDateString()}` : "Open"}
    action={{ label, onClick: open, primary: label === "Respond" }} />;
}
