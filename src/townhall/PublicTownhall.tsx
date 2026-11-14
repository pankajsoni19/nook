import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicNotFound, PublicPageShell } from "../public/PublicPageShell";
import { QaList, type QaQuestion } from "../ui/live/QaList";
import { appName } from "../appName";
import { authorLabel, type TownhallLiveState } from "../../shared/townhall";
import { TOWNHALL_LIMITS } from "../../shared/townhall";
import { PollView } from "./PollView";
import { useLiveState } from "./useLiveState";
import "../ui/live/live.css";
import "./townhall.css";

/**
 * The audience page (`/p/t/<token>`, §B.8, D1077): no account, no session. A participant token from
 * the server is kept in this browser's storage (per link), so upvotes, poll answers, and "mine" follow
 * the person across reloads. People ask with a name or anonymously (when the host allows), upvote, and
 * vote in the live poll; updates arrive on the same stream as in the app.
 */

type PublicState = TownhallLiveState & { participant: string; renderNonce: string; meta: { appName: string; workspaceName: string; logoUrl: string | null } };

const storageKey = (token: string) => `townhall:participant:${token.slice(0, 12)}`;
const readStored = (token: string) => { try { return window.localStorage.getItem(storageKey(token)); } catch { return null; } };
const writeStored = (token: string, value: string) => { try { window.localStorage.setItem(storageKey(token), value); } catch { /* private mode: this tab only */ } };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/public/townhall/${path}`, body === undefined ? { headers: { Accept: "application/json" } } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(typeof payload.error === "string" ? payload.error : "Something went wrong"), { status: response.status, payload, retryAfter: Number(response.headers.get("Retry-After")) || undefined });
  return payload as T;
}

export default function PublicTownhall({ path }: { path: string }) {
  const token = path.split("/")[3] ?? "";
  const [participant, setParticipant] = useState<string | null>(() => readStored(token));
  const [nonce, setNonce] = useState<string | null>(null);
  const [name, setName] = useState(() => { try { return window.localStorage.getItem("townhall:name") ?? ""; } catch { return ""; } });
  const [sort, setSort] = useState<"top" | "recent">("top");
  const honeypot = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    const stored = readStored(token);
    const state = await call<PublicState>(`${encodeURIComponent(token)}${stored ? `?p=${encodeURIComponent(stored)}` : ""}`);
    if (state.participant !== stored) { writeStored(token, state.participant); setParticipant(state.participant); }
    setNonce(state.renderNonce);
    return state;
  }, [token]);
  const streamUrl = participant ? `/api/public/townhall/${encodeURIComponent(token)}/live?p=${encodeURIComponent(participant)}` : null;
  const live = useLiveState<PublicState>({ load, streamUrl });
  const state = live.state;
  // With the stream open, the change arrives on it; refetching after every vote would cost the room its
  // shared request budget (D1103). Polling (no stream) still refreshes at once.
  const afterAction = () => live.mode === "live" ? Promise.resolve() : live.refresh();
  // The stream sends the plain state; the meta and nonce come from the first load.
  const [meta, setMeta] = useState<PublicState["meta"] | null>(null);
  useEffect(() => { if (state?.meta) setMeta(state.meta); }, [state?.meta]);
  useEffect(() => { try { window.localStorage.setItem("townhall:name", name); } catch { /* ignore */ } }, [name]);
  const questions = useMemo<QaQuestion[]>(() => (state?.questions ?? []).map((question) => ({
    id: question.id, text: question.text, author: authorLabel(question), votes: question.votes, voted: question.voted, status: question.status, pinned: question.pinned, createdAt: question.createdAt, mine: question.mine, mergedCount: question.mergedCount
  })), [state]);

  if (live.gone) return <PublicNotFound appName={appName()} />;
  if (!state || !participant) return <div className="ui-public" aria-busy="true"><p role="status" className="ui-visually-hidden">Loading…</p></div>;
  const session = state.session;
  const pinned = state.questions.find((question) => question.id === session.pinnedQuestionId) ?? null;
  const poll = state.polls.find((entry) => entry.status === "live") ?? state.polls.find((entry) => entry.id === session.activePollId) ?? null;
  const ended = session.state === "ended";

  return <PublicPageShell workspaceName={meta?.workspaceName ?? appName()} appName={meta?.appName ?? appName()} title={session.title}
    footer={<p>Questions you ask here are seen by everyone in this session{session.allowAnonymous ? "; leave the name empty to ask anonymously" : ""}.</p>}>
    <div className="th-public">
      <p className="th-public-state">{ended ? "This session has ended." : session.state === "live" ? <><span className="ui-live-dot" aria-hidden="true" /> Live now</> : session.startsAt ? `Starts ${new Date(session.startsAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : "Ask your questions before it starts."}</p>
      {session.description && <p className="ui-public-text">{session.description}</p>}
      {pinned && <section className="th-public-pinned" aria-label="Now answering"><strong>Now answering</strong><p>{pinned.text}</p></section>}
      {poll && <PollView poll={poll} onVote={async (answer) => { await call(`${encodeURIComponent(token)}/polls/${poll.id}/vote`, { participant, ...answer }); await afterAction(); }} />}
      {state.you.canAsk && <label className="th-public-name">
        <span>Your name {session.allowAnonymous ? <small>(optional)</small> : null}</span>
        <input type="text" value={name} maxLength={TOWNHALL_LIMITS.name} autoComplete="name" placeholder={session.allowAnonymous ? "Anonymous" : "Your name"} onChange={(event) => setName(event.target.value)} />
      </label>}
      <QaList questions={questions} sort={sort} onSort={setSort} closed={ended} maxLength={TOWNHALL_LIMITS.question} anonymousAllowed={false}
        onUpvote={ended ? undefined : (id, voted) => { void call(`${encodeURIComponent(token)}/questions/${id}/vote`, { participant, upvote: voted }).then(afterAction, () => undefined); }}
        onAsk={state.you.canAsk ? async (text) => {
          if (!session.allowAnonymous && !name.trim()) throw new Error("Add your name to ask");
          try {
            const result = await call<{ renderNonce: string }>(`${encodeURIComponent(token)}/questions`, { participant, text, name: name.trim() || null, nonce, website: honeypot.current?.value ?? "" });
            setNonce(result.renderNonce);
            await afterAction();
          } catch (reason) {
            const fresh = (reason as { payload?: { renderNonce?: string } }).payload?.renderNonce;
            if (fresh) setNonce(fresh);
            throw reason;
          }
        } : undefined}
        onWithdraw={(id) => { void call(`${encodeURIComponent(token)}/questions/${id}/withdraw`, { participant }).then(afterAction, () => undefined); }}
        askNote={session.moderation === "review" ? "A host reviews questions before everyone sees them." : undefined} />
      {/* The honeypot: people never see it; bots fill it. */}
      <input ref={honeypot} className="th-hp" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" defaultValue="" />
    </div>
  </PublicPageShell>;
}
