import { useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import "./live.css";

/**
 * The presenter view shell (§G.1 Townhall): what a host screen-shares. Full window, high contrast
 * (white on near-black, the accent for what is current), large type that scales with the window,
 * nothing interactive in the content but its own controls: Esc leaves, F toggles full screen, ←/→
 * step between the module's slides when `onPrev`/`onNext` are given. A "Live" marker shows that the
 * content updates by itself. The module puts LivePoll / WordCloud / RatingWidget (presenter) or the
 * pinned question inside.
 */
export function PresenterView({ title, joinText, joinCode, children, onExit, onPrev, onNext, position, live = true }: {
  title: string;
  /** "Join at nook.example/t/allhands" (shown large in the corner for the audience). */
  joinText?: string;
  joinCode?: string;
  children: ReactNode;
  onExit: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** "2 / 5" for slides. */
  position?: string;
  live?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void ref.current?.requestFullscreen?.().catch(() => undefined);
  };
  useEffect(() => {
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape" && !document.fullscreenElement) { event.preventDefault(); onExit(); }
      else if (event.key === "f" || event.key === "F") { event.preventDefault(); toggle(); }
      else if (event.key === "ArrowRight" && onNext) { event.preventDefault(); onNext(); }
      else if (event.key === "ArrowLeft" && onPrev) { event.preventDefault(); onPrev(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit, onNext, onPrev]);

  return <div ref={ref} className="ui-presenter" role="dialog" aria-modal="true" aria-label={`Presenter view: ${title}`} tabIndex={-1}>
    <header className="ui-presenter-bar">
      <strong className="ui-presenter-title">{title}</strong>
      {live && <span className="ui-live-state"><span className="ui-live-dot" aria-hidden="true" />Live</span>}
      {position && <span className="ui-presenter-position ui-tabular">{position}</span>}
      <span className="ui-presenter-tools">
        <button type="button" className="ui-presenter-button" onClick={toggle} aria-label={fullscreen ? "Leave full screen" : "Full screen"} title={`${fullscreen ? "Leave full screen" : "Full screen"} (F)`} aria-keyshortcuts="F">{fullscreen ? <Minimize2 /> : <Maximize2 />}</button>
        <button type="button" className="ui-presenter-button" onClick={onExit} aria-label="Leave presenter view" title="Leave (Esc)" aria-keyshortcuts="Escape"><X /></button>
      </span>
    </header>
    <main className="ui-presenter-stage">{children}</main>
    {(joinText || joinCode) && <footer className="ui-presenter-join">{joinText}{joinCode && <> · code <strong className="ui-tabular">{joinCode}</strong></>}</footer>}
  </div>;
}
