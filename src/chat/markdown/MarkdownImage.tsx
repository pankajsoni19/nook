import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, ImageIcon, ImageOff, RefreshCw } from "lucide-react";
import { ModalDialog } from "../../files/Dialog";
import { useHistoryDialogGuard } from "../../ui/useHistoryDialogGuard";
import { allowHost, classifyImage, hostAllowed, loadedImage, loadProxiedImage, REFUSAL_TEXT, subscribeImageConsent } from "./images";

/**
 * The image elements of agent Markdown (images.ts has the rules). Everything is a `<span>` or a
 * `<button>`, so an image can sit inside a paragraph without breaking the HTML nesting rules.
 */

/** Where a renderer runs: the app (with the chat, or the Audit run, as the consent scope) or the signed-out public page. */
export type ImagePolicy = { mode: "app"; scope: string; chatId?: string } | { mode: "public" };
export const PUBLIC_IMAGES: ImagePolicy = { mode: "public" };

type ImageProps = { href: string; alt: string; title?: string | null; policy: ImagePolicy; onExternalLink: (href: string) => void };

export function MarkdownImage({ href, alt, title, policy, onExternalLink }: ImageProps) {
  const target = useMemo(() => classifyImage(href), [href]);
  if (target.kind === "refused") return <ImageChip alt={alt} detail={REFUSAL_TEXT[target.reason]} />;
  if (target.kind === "data") return <ShownImage src={target.src} alt={alt} title={title} />;
  if (target.kind === "nook") {
    return policy.mode === "public" ? <ImageChip alt={alt} detail="Images from this Nook are not shown on a public page" /> : <ShownImage src={target.src} alt={alt} title={title} />;
  }
  // The public page never proxies: the chip names the host, as it always has (T304).
  if (policy.mode === "public") return <ImageChip alt={alt} host={target.url.host} detail="Images from other sites are not loaded on a public page" />;
  return <ExternalImage url={target.url.toString()} host={target.url.host} alt={alt} title={title} scope={policy.scope} onExternalLink={onExternalLink} />;
}

/** An image that is not shown: "🖼 alt · host", with why in its title. */
export function ImageChip({ alt, host, detail }: { alt: string; host?: string; detail: string }) {
  return <span className="chat-md-image" title={detail}>🖼 {alt || "image"}{host ? ` · ${host}` : ""}</span>;
}

/** A picture that may show: a button that opens the viewer, and a neat fallback when it does not load. */
export function ShownImage({ src, alt, title, host, onOpenLink }: { src: string; alt: string; title?: string | null; host?: string; onOpenLink?: () => void }) {
  const [broken, setBroken] = useState(false);
  const [viewing, setViewing] = useState(false);
  if (broken) return <span className="chat-md-image-broken" role="img" aria-label={`${alt || "Image"} (could not be shown)`}><ImageOff aria-hidden="true" /><span>{alt || "Image"}</span><small>Could not be shown</small></span>;
  return <span className="chat-md-figure">
    <button type="button" className="chat-md-img-button" onClick={() => setViewing(true)} aria-label={`View image${alt ? `: ${alt}` : ""}`}>
      <img src={src} alt={alt} title={title ?? undefined} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    </button>
    {viewing && <ImageViewer src={src} alt={alt} host={host} onOpenLink={onOpenLink} onClose={() => setViewing(false)} />}
  </span>;
}

/** The viewer sheet: the picture fitted to the screen, its alt text, and Close (Back closes it too, D18). */
export function ImageViewer({ src, alt, host, onClose, onOpenLink }: { src: string; alt: string; host?: string; onClose: () => void; onOpenLink?: () => void }) {
  useHistoryDialogGuard(true, onClose);
  const dialog = <ModalDialog title={alt || "Image"} eyebrow={host ?? "Image"} onClose={onClose} className="chat-dialog chat-image-viewer">
    <div className="chat-image-viewer-body"><img src={src} alt={alt} referrerPolicy="no-referrer" /></div>
    <footer className="file-dialog-actions">
      {onOpenLink && <button type="button" className="secondary-button" onClick={() => { onClose(); onOpenLink(); }}><ExternalLink />Open link</button>}
      <button type="button" className="primary-button" onClick={onClose}>Close</button>
    </footer>
  </ModalDialog>;
  // Portalled: a bubble's scroll container must not clip or offset the sheet.
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

export type ExternalState = { status: "idle" } | { status: "loading" } | { status: "shown"; src: string } | { status: "failed"; message: string };

/** The external image's card, by state (exported for tests: it renders without a DOM). */
export function ExternalImageCard({ state, host, alt, title, onLoad, onAlways, onOpenLink }: { state: ExternalState; host: string; alt: string; title?: string | null; onLoad: () => void; onAlways: () => void; onOpenLink: () => void }) {
  if (state.status === "shown") return <ShownImage src={state.src} alt={alt} title={title} host={host} onOpenLink={onOpenLink} />;
  const busy = state.status === "loading";
  return <span className="chat-md-remote" role="group" aria-label={`Image from ${host}, not loaded`}>
    <span className="chat-md-remote-head"><ImageIcon aria-hidden="true" /><span className="chat-md-remote-alt">{alt || "Image"}</span></span>
    <span className="chat-md-remote-host">{host}</span>
    {state.status === "failed"
      ? <span className="chat-md-remote-note chat-md-remote-error" role="alert">{state.message}</span>
      : <span className="chat-md-remote-note">Loading it sends its address to {host}.</span>}
    <span className="chat-md-remote-actions">
      <button type="button" className="secondary-button" onClick={onLoad} disabled={busy} aria-busy={busy || undefined}>{state.status === "failed" ? <><RefreshCw />Try again</> : busy ? "Loading…" : "Load image"}</button>
      <button type="button" className="secondary-button" onClick={onOpenLink}><ExternalLink />Open link</button>
    </span>
    <button type="button" className="chat-md-remote-always" onClick={onAlways} disabled={busy}>Always load images from {host} in this chat</button>
  </span>;
}

function ExternalImage({ url, host, alt, title, scope, onExternalLink }: { url: string; host: string; alt: string; title?: string | null; scope: string; onExternalLink: (href: string) => void }) {
  const cached = loadedImage(url);
  const [state, setState] = useState<ExternalState>(cached ? { status: "shown", src: cached } : { status: "idle" });
  const allowed = useSyncExternalStore(subscribeImageConsent, () => hostAllowed(scope, host), () => false);
  const load = () => {
    setState({ status: "loading" });
    void loadProxiedImage(url).then((result) => setState(result.ok ? { status: "shown", src: result.src } : { status: "failed", message: result.message }));
  };
  // A host the person chose to trust in this chat loads without another click.
  useEffect(() => {
    if (allowed && state.status === "idle") load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);
  return <ExternalImageCard state={state} host={host} alt={alt} title={title} onLoad={load} onAlways={() => allowHost(scope, host)} onOpenLink={() => onExternalLink(url)} />;
}
