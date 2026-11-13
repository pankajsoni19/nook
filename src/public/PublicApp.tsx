import { Suspense } from "react";
import { appName } from "../appName";
import { readyWorkspaceModules } from "../workspaceModules";
import { PublicNotFound } from "./PublicPageShell";
import "../ui/workspace.css";

/**
 * Public pages under /p/… (§B.8, D831): rendered without the app's session, shell, or account code
 * (main.tsx loads this chunk before anything that reads a session, as for /share/c/). Each ready
 * module registers its pages by path prefix (`publicPages` in its module.tsx: Forms `/p/f/`,
 * Bookings `/p/book/`, Townhall `/p/t/`); the page fetches its own JSON from /api/public/… and wraps
 * itself in PublicPageShell. Anything else is the one uniform "not available" page (T507).
 */
export function publicPageFor(pathname: string) {
  for (const module of readyWorkspaceModules()) {
    for (const page of module.publicPages ?? []) if (pathname.startsWith(page.prefix)) return page;
  }
  return null;
}

export function PublicApp({ pathname, search }: { pathname: string; search: string }) {
  const page = publicPageFor(pathname);
  if (!page) return <PublicNotFound appName={appName()} />;
  const Page = page.component;
  return <Suspense fallback={<div className="ui-public" aria-busy="true"><p role="status" className="ui-visually-hidden">Loading…</p></div>}>
    <Page path={pathname} search={search} />
  </Suspense>;
}
