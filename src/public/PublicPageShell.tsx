import type { CSSProperties, ReactNode } from "react";
import { publicAccent } from "./publicTheme";
import "./public.css";

/**
 * The public page frame (§B.8, §E.6, D831): forms, polls, booking pages, and Townhall's audience
 * page. A light card on a neutral background (dark when the visitor's system is), the workspace's
 * name and logo top-left, "Powered by <app>" at the foot, 375 px first. 640 px wide for forms, 880
 * for a booking calendar with its times. No session, no app chrome; links leave with no referrer.
 */
export function PublicPageShell({ workspaceName, logoUrl, appName, width = "form", accent, title, children, footer }: {
  workspaceName: string;
  /** A same-origin logo path (branding); anything else is ignored. */
  logoUrl?: string | null;
  appName: string;
  width?: "form" | "booking";
  /** The form's or booking type's color (#rrggbb), made contrast-safe. */
  accent?: string | null;
  /** The page's own heading (a form title); the host may render its own inside `children` instead. */
  title?: string;
  children: ReactNode;
  /** A line above "Powered by" (a privacy note, "Report abuse"). */
  footer?: ReactNode;
}) {
  const colors = publicAccent(accent);
  const logo = logoUrl && /^\/[^/\\]/.test(logoUrl) ? logoUrl : null;
  return <div className="ui-public" style={{ "--module-accent": colors.accent, "--module-accent-text": colors.accentText } as CSSProperties}>
    <header className="ui-public-brand">
      {logo ? <img src={logo} alt="" width={28} height={28} referrerPolicy="no-referrer" /> : <span className="ui-public-mark" aria-hidden="true">{(workspaceName.trim()[0] ?? "N").toUpperCase()}</span>}
      <span>{workspaceName}</span>
    </header>
    <main className={`ui-public-card ${width}`}>
      {title && <h1 className="ui-public-title">{title}</h1>}
      {children}
    </main>
    <footer className="ui-public-foot">
      {footer}
      <p>Powered by <strong>{appName}</strong></p>
    </footer>
  </div>;
}

/** The one "not available" page: unknown, revoked, expired, turned off, binned, or closed look the same (T507). */
export function PublicNotFound({ appName, workspaceName = appName }: { appName: string; workspaceName?: string }) {
  return <PublicPageShell workspaceName={workspaceName} appName={appName} title="This link is not available">
    <p className="ui-public-text">It may have expired or been turned off. Ask the person who shared it for a new link.</p>
  </PublicPageShell>;
}

/** The page after a submission (a form's ending, a booking's confirmation). */
export function PublicDone({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="ui-public-done" role="status">
    <span className="ui-public-check" aria-hidden="true">✓</span>
    <h2>{title}</h2>
    {children && <div className="ui-public-text">{children}</div>}
  </div>;
}
