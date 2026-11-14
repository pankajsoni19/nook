import { useEffect, useState } from "react";
import { Presentation } from "lucide-react";
import { EmbedCard } from "../ui/embeds/EmbedCard";
import type { EmbedCardProps } from "../editor/moduleEmbedRegistry";
import type { TownhallLiveState } from "../../shared/townhall";
import { getState } from "./api";

/**
 * A townhall session's live card in a note or a card description (§B.4.4, W3-WIRE D1059): title, when,
 * state (upcoming, live now, ended), question count, and Join / Open. Fetched as the reader; the
 * Markdown says "Townhall" only, and a reader who cannot open the session sees "Townhall
 * unavailable" (T513). A live session refreshes every 20 s while the note is visible.
 */
const STATE_WORD: Record<string, string> = { upcoming: "Upcoming", live: "Live now", ended: "Ended" };

export default function TownhallEmbed({ path }: EmbedCardProps) {
  const ref = path.split(/[?#]/)[0]!.split("/").filter(Boolean)[1] ?? "";
  const [state, setState] = useState<TownhallLiveState | null | "gone">(null);
  useEffect(() => {
    let live = true;
    const load = () => getState(ref).then((body) => { if (live) setState(body); }, () => { if (live) setState("gone"); });
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [ref]);
  if (state === null) return <EmbedCard icon={Presentation} word="Townhall" loading />;
  if (state === "gone") return <EmbedCard icon={Presentation} word="Townhall" unavailable />;
  const { session, stats } = state;
  const when = session.startsAt ? new Date(session.startsAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;
  const subtitle = [STATE_WORD[session.state] ?? session.state, session.state === "upcoming" ? when : null, `${stats.questions} question${stats.questions === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  const open = () => window.dispatchEvent(new CustomEvent("nook:open-path", { detail: { path: session.href } }));
  return <EmbedCard icon={Presentation} word="Townhall" title={session.title} subtitle={subtitle}
    action={{ label: session.state === "live" ? "Join" : session.state === "upcoming" && session.questionsOpen ? "Ask a question" : "Open", onClick: open, primary: session.state === "live" }} />;
}
