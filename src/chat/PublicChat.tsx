import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Check, Globe, TriangleAlert, User, Wrench, X } from "lucide-react";
import { appName } from "../appName";
import { ModalDialog } from "../files/Dialog";
import { popStateClosedDialog } from "../historyDialogs";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { PublicChatSnapshot } from "../../shared/agents";
import { Markdown, type RenderContext } from "./markdown/render";
import "./chat.css";

/** The token a `/share/c/<token>` path carries, or null (a malformed path shows "not available"). */
export function publicTokenFrom(pathname: string): string | null {
  const match = /^\/share\/c\/([A-Za-z0-9_-]{43})\/?$/.exec(pathname);
  return match ? match[1]! : null;
}

export type PublicLoad = { state: "loading" } | { state: "ready"; snapshot: PublicChatSnapshot } | { state: "missing" } | { state: "limited" } | { state: "error" };

/** Reads the snapshot: no session, no cookies needed, nothing else on the page talks to the server. */
export async function loadPublicSnapshot(token: string, fetcher: typeof fetch = fetch): Promise<PublicLoad> {
  try {
    const response = await fetcher(`/api/public/chat-shares/${encodeURIComponent(token)}`, { credentials: "omit", headers: { Accept: "application/json" } });
    // The body is always read to its end, so no request is left open (an error page too).
    const raw = await response.text();
    if (response.status === 404) return { state: "missing" };
    if (response.status === 429) return { state: "limited" };
    if (!response.ok) return { state: "error" };
    const body = JSON.parse(raw) as { snapshot?: PublicChatSnapshot };
    return body.snapshot && Array.isArray(body.snapshot.messages) ? { state: "ready", snapshot: body.snapshot } : { state: "error" };
  } catch {
    return { state: "error" };
  }
}

/**
 * The public page of a shared chat (Wave 43, AC-D, plan §6.2, D362): `/share/c/<token>`, rendered
 * without the app shell and without a session (src/main.tsx mounts it instead of the app). Minimal
 * chrome: the app's name, the chat's title, the agent's name, and the owner's display name; never an
 * email, an id, or another chat. Every turn is untrusted text, rendered through the same Markdown
 * renderer as the app (D370: no HTML, no remote images, links through a sheet that shows the full
 * address). Read-only; 390 px first. The link sheet closes on Back (D18).
 */
export function PublicChat({ token, initial }: { token: string | null; initial?: PublicLoad }) {
  const [load, setLoad] = useState<PublicLoad>(initial ?? (token ? { state: "loading" } : { state: "missing" }));
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    if (initial || !token) return;
    let live = true;
    void loadPublicSnapshot(token).then((result) => { if (live) setLoad(result); });
    return () => { live = false; };
  }, [initial, token]);

  useEffect(() => {
    // The page has no router: Back only ever closes the link sheet (historyDialogs' guards).
    const onPopState = (event: PopStateEvent) => { popStateClosedDialog(event); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const name = appName();
    document.title = load.state === "ready" ? `${load.snapshot.title} · Shared chat · ${name}` : `Shared chat · ${name}`;
  }, [load]);

  const context = useMemo<RenderContext>(() => ({
    onExternalLink: (href) => setLink(href),
    // A Nook path in a public page is shown like any link: the reader may not have an account here.
    onNookLink: (path) => setLink(new URL(path, window.location.origin).href)
  }), []);

  return <div className="public-chat">
    <header className="public-chat-header">
      <span className="public-chat-brand"><Globe aria-hidden="true" />{appName()}</span>
      <span className="public-chat-badge">Shared chat · read-only</span>
    </header>
    <main className="public-chat-main">
      {load.state === "loading" && <p className="chat-muted" role="status">Loading…</p>}
      {load.state === "missing" && <section className="chat-state" role="alert"><span className="chat-state-icon"><TriangleAlert /></span><h1>This link is not available</h1><p>It may have been revoked, or public links are turned off here.</p></section>}
      {load.state === "limited" && <section className="chat-state" role="alert"><h1>Too many requests</h1><p>Wait a minute, then reload.</p></section>}
      {load.state === "error" && <section className="chat-state" role="alert"><h1>Could not load this chat</h1><p>Reload to try again.</p></section>}
      {load.state === "ready" && <PublicTranscript snapshot={load.snapshot} context={context} />}
    </main>
    {link && <PublicLinkSheet href={link} onClose={() => setLink(null)} />}
  </div>;
}

/** "2 Oct 2026, 14:05" */
const when = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
};

export function PublicTranscript({ snapshot, context }: { snapshot: PublicChatSnapshot; context: RenderContext }) {
  return <article className="public-chat-article" aria-labelledby="public-chat-title">
    <h1 id="public-chat-title">{snapshot.title}</h1>
    <p className="public-chat-meta">{snapshot.agentName ? <><Bot aria-hidden="true" />{snapshot.agentName} · </> : null}Shared by {snapshot.ownerName} · snapshot of {when(snapshot.snapshotAt)}</p>
    <p className="public-chat-note" role="note">Replies were written by an AI agent and may be wrong. {snapshot.includeToolResults ? "Tool calls show their arguments and results." : "Tool calls show by name only."}{snapshot.truncated ? " The oldest messages are left out." : ""}</p>
    <ol className="public-chat-messages">
      {snapshot.messages.map((message, index) => <li key={index} className={`public-chat-message ${message.role === "user" ? "public-chat-user" : "public-chat-assistant"}`}>
        <span className="public-chat-who">{message.role === "user" ? <><User aria-hidden="true" />{snapshot.ownerName}</> : <><Bot aria-hidden="true" />{snapshot.agentName ?? "Agent"} <small>Written by the agent</small></>}</span>
        {message.toolCalls.length > 0 && <ul className="public-chat-tools" aria-label="Tools it used">
          {message.toolCalls.map((call, callIndex) => <li key={callIndex}>
            <span><Wrench aria-hidden="true" /><code>{call.server ? `${call.server}/` : ""}{call.tool}</code>{call.ok === false ? " · failed" : ""}</span>
            {call.args !== undefined && <details><summary>Arguments and result</summary><pre>{call.args}</pre>{call.result ? <pre>{call.result}</pre> : null}</details>}
          </li>)}
        </ul>}
        {message.content && (message.role === "user" ? <p className="chat-user-text">{message.content}</p> : <div className="chat-bubble"><Markdown text={message.content} context={context} /></div>)}
      </li>)}
    </ol>
  </article>;
}

/** The full address before it is followed (plan §8, T304); copy or open in a new tab without a referrer. */
function PublicLinkSheet({ href, onClose }: { href: string; onClose: () => void }) {
  useHistoryDialogGuard(true, onClose);
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => { void navigator.clipboard.writeText(href).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }, () => undefined); }, [href]);
  let host = href;
  try { host = new URL(href).host; } catch { /* shown as is */ }
  return <ModalDialog title="Open this link?" eyebrow={host} onClose={onClose} className="chat-dialog chat-link-sheet">
    <p className="chat-link-url"><code>{href}</code></p>
    <p className="file-dialog-hint">This link is part of a shared chat. Check the address, including anything after “?”, before opening it.</p>
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={copy}>{copied ? <><Check />Copied</> : "Copy link"}</button>
      <button type="button" className="secondary-button" onClick={onClose}><X />Cancel</button>
      <a className="primary-button" href={href} target="_blank" rel="noopener noreferrer" onClick={onClose}>Open</a>
    </footer>
  </ModalDialog>;
}
