import { useEffect, useState } from "react";
import { ArrowBigUp, MessageCircleQuestion, UserRound } from "lucide-react";
import QRCode from "qrcode";
import { PresenterView } from "../ui/live/PresenterView";
import { authorLabel, type TownhallLiveState } from "../../shared/townhall";
import { PollView } from "./PollView";

/** A QR code (data URL) for a join link, black on white for any projector. */
export function useQrCode(url: string | null) {
  const [data, setData] = useState<string | null>(null);
  useEffect(() => {
    if (!url) { setData(null); return; }
    let live = true;
    QRCode.toDataURL(url, { width: 360, margin: 2, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } }).then((value) => { if (live) setData(value); }, () => { if (live) setData(null); });
    return () => { live = false; };
  }, [url]);
  return data;
}

/**
 * The presenter view of a session (§G.1): what the host screen-shares. It follows the session live:
 * the poll on screen (with its results), else the pinned question ("Now answering"), else the join
 * screen with a QR code and the top questions. Hosts step through polls with ←/→ (which also moves
 * what every presenter shows); anyone else sees what the host chose.
 */
export function Presenter({ state, joinUrl, onExit, onShow }: { state: TownhallLiveState; joinUrl: string; onExit: () => void; onShow?: (pollId: string | null) => void }) {
  const qr = useQrCode(joinUrl);
  const session = state.session;
  const polls = state.polls.filter((poll) => poll.status !== "draft");
  const poll = polls.find((entry) => entry.id === session.activePollId) ?? null;
  const pinned = state.questions.find((question) => question.id === session.pinnedQuestionId) ?? null;
  const slides: Array<string | null> = [null, ...polls.map((entry) => entry.id)];
  const index = Math.max(0, slides.indexOf(poll?.id ?? null));
  const step = onShow && slides.length > 1 ? (by: number) => onShow(slides[(index + by + slides.length) % slides.length] ?? null) : undefined;
  const top = state.questions.filter((question) => question.status === "approved" && question.id !== pinned?.id).sort((a, b) => b.votes - a.votes).slice(0, 3);
  const joinText = `Join at ${joinUrl.replace(/^https?:\/\//, "")}`;

  return <PresenterView title={session.title} joinText={joinText} onExit={onExit} live={session.state === "live"}
    onNext={step ? () => step(1) : undefined} onPrev={step ? () => step(-1) : undefined} position={step ? `${index + 1} / ${slides.length}` : undefined}>
    {poll
      ? <PollView poll={poll} presenter />
      : pinned
        ? <section className="th-present-question" aria-live="polite">
          <p className="th-present-label"><MessageCircleQuestion aria-hidden="true" />Now answering</p>
          <p className="th-present-text">{pinned.text}</p>
          <p className="th-present-meta">
            {pinned.author ? <span>{authorLabel(pinned)}</span> : <span className="th-present-anon"><UserRound aria-hidden="true" />Anonymous</span>}
            <span className="th-present-votes"><ArrowBigUp aria-hidden="true" /><span className="ui-tabular">{pinned.votes}</span></span>
          </p>
        </section>
        : <section className="th-present-join">
          <div className="th-present-join-copy">
            <p className="th-present-label"><MessageCircleQuestion aria-hidden="true" />{session.state === "ended" ? "Thanks for joining" : "Ask your questions"}</p>
            <p className="th-present-url">{joinUrl.replace(/^https?:\/\//, "")}</p>
            {top.length > 0 && <ol className="th-present-top" aria-label="Top questions">
              {top.map((question) => <li key={question.id}><span className="th-present-votes"><ArrowBigUp aria-hidden="true" /><span className="ui-tabular">{question.votes}</span></span><span>{question.text}</span></li>)}
            </ol>}
          </div>
          {qr && <img className="th-present-qr" src={qr} alt={`QR code for ${joinUrl}`} width={320} height={320} />}
        </section>}
  </PresenterView>;
}
