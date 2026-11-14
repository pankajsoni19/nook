import { Fragment, useEffect, useState, type ReactNode } from "react";
import { pendingOf, resolveLocation } from "./friendlyLinks";
import { routeFromLocation, type PendingLink, type Route } from "./router";
import { notifier } from "./ui/notify";

const MISSING: Partial<Record<PendingLink["kind"], string>> = { file: "File not found", whiteboard: "Whiteboard not found", collection: "Collection not found", report: "Report not found" };

function pendingFor(app: Route["app"]): PendingLink | null {
  const route = routeFromLocation(window.location);
  return route.app === app ? pendingOf(route) : null;
}

/**
 * Friendly URLs for the apps that read their route from the location (Files, Whiteboards, Collections,
 * Reports; D773): while the location names an item by a short id this tab has no name for yet, the
 * app waits here; the link is resolved (GET /api/links/:kind/:ref), the entry is replaced with the
 * canonical URL, and the app mounts on it. Back or Forward onto such an entry (from before a reload)
 * remounts the app the same way. A link the person cannot open is "… not found" and the app's list,
 * exactly as for an unknown id (T490).
 */
export function FriendlyLinkGate({ app, listRoute, navigate, children }: { app: Route["app"]; listRoute: Route; navigate: (route: Route, options?: { replace?: boolean }) => void; children: ReactNode }) {
  const [state, setState] = useState(() => ({ generation: 0, pending: pendingFor(app) }));
  const pendingKey = state.pending ? `${state.pending.kind}:${state.pending.ref}` : null;

  useEffect(() => {
    const onPopState = () => {
      const pending = pendingFor(app);
      if (pending) setState((current) => ({ ...current, pending }));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [app]);

  useEffect(() => {
    const pending = state.pending;
    if (!pending) return;
    let live = true;
    const done = (route: Route) => {
      navigate(route, { replace: true });
      setState((current) => ({ generation: current.generation + 1, pending: null }));
    };
    resolveLocation().then((resolved) => {
      if (!live) return;
      if (resolved === "missing" || pendingOf(resolved)) {
        notifier.warning(MISSING[pending.kind] ?? "Not found");
        done(listRoute);
      } else done(resolved);
    }, () => {
      if (!live) return;
      notifier.error("Could not open that link");
      done(listRoute);
    });
    return () => { live = false; };
    // Keyed by the link; listRoute and navigate are recreated on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  if (state.pending) return <main className="app-page" aria-busy="true"><p className="bin-loading" role="status">Opening…</p></main>;
  return <Fragment key={state.generation}>{children}</Fragment>;
}
