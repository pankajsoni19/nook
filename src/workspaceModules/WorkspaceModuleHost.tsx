import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { FriendlyLinkGate } from "../FriendlyLinkGate";
import { popStateClosedDialog } from "../historyDialogs";
import { parseRoute, type Route } from "../router";
import { workspaceHomeRoute, workspaceModule } from "./registry";
import type { WorkspaceAppProps, WorkspaceModuleId, WorkspaceRoute } from "./types";

type HostProps = Omit<WorkspaceAppProps, "route" | "navigate"> & {
  id: WorkspaceModuleId;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
};

const currentRoute = (id: WorkspaceModuleId): WorkspaceRoute => {
  const route = parseRoute(window.location.pathname, window.location.search);
  return route.app === id ? route as WorkspaceRoute : workspaceHomeRoute(id);
};

/**
 * The one generic render branch of App.tsx for workspace modules (D833): a friendly link is resolved
 * first (FriendlyLinkGate), then the module's lazy app mounts with the standard props and its route,
 * which follows the location: the module's own moves, Back, and Forward (a popstate a dialog consumed
 * is left alone, D18). A module without an app (a stub) is never routed here: its segment does not parse.
 */
export function WorkspaceModuleHost({ id, navigate, ...props }: HostProps) {
  const module = workspaceModule(id);
  const [route, setRoute] = useState<WorkspaceRoute>(() => currentRoute(id));
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const go = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    if (next.app === id) setRoute(next as WorkspaceRoute);
    navigateRef.current(next, options);
  }, [id]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      const next = parseRoute(window.location.pathname, window.location.search);
      if (next.app === id) setRoute(next as WorkspaceRoute);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [id]);

  if (!module?.app) return null;
  const App = module.app;
  return <FriendlyLinkGate app={id} listRoute={workspaceHomeRoute(id)} navigate={go}>
    <Suspense fallback={<main className="app-page" aria-busy="true"><p className="sr-only" role="status">Loading {module.label}…</p></main>}>
      <App {...props} route={route} navigate={go} />
    </Suspense>
  </FriendlyLinkGate>;
}
