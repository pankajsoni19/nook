/**
 * Friendly URLs in the app (docs/plan/FRIENDLY_URLS.md, D773–D774): resolving a URL the tab has no
 * name for yet, and keeping the address bar on the canonical URL.
 */
import { api, ApiError } from "./api";
import { formatRoute, locationUrl, routeFromLocation, type PendingLink, type Route } from "./router";
import { nameBoard, nameCard, nameItems, setCanonicalizer } from "./routeNames";
import { lookupCardKey } from "./tasks/tasksApi";

type Resolved = { id: string; title?: string; code?: string };

/**
 * Learns what a pending link names (GET /api/links/:kind/:ref; a card key through the key lookup,
 * D713), so the location parses to ids. "missing" for anything the caller cannot open: unknown,
 * binned, and unreadable look the same (T490). Other failures throw.
 */
export async function resolvePending(pending: PendingLink): Promise<"resolved" | "missing"> {
  try {
    if (pending.kind === "card") {
      const found = await lookupCardKey(pending.ref);
      // The current key first, then the asked-for one as an alias when it is an old key (D714, D715).
      nameCard(found.cardId, found.key ?? pending.ref, found.boardId);
      if (found.key !== pending.ref) nameCard(found.cardId, pending.ref, found.boardId, { alias: true });
      return "resolved";
    }
    const found = await api<Resolved>(`/links/${pending.kind}/${encodeURIComponent(pending.ref)}`);
    if (pending.kind === "board") {
      nameBoard(found.id, found.code ?? pending.ref);
      if (found.code && found.code !== pending.ref) nameBoard(found.id, pending.ref, { alias: true });
    } else {
      nameItems(pending.kind, [{ id: found.id, short_id: pending.ref, title: found.title ?? "" }]);
    }
    return "resolved";
  } catch (reason) {
    if (reason instanceof ApiError && (reason.status === 404 || reason.status === 400)) return "missing";
    throw reason;
  }
}

/**
 * The location's route once every link in it is resolved (a board code, then a card key under it):
 * the resolved route, or "missing" when one of them names nothing the caller can open.
 */
export async function resolveLocation(): Promise<Route | "missing"> {
  for (let step = 0; step < 3; step += 1) {
    const route = routeFromLocation(window.location);
    const pending = "pending" in route ? route.pending : undefined;
    if (!pending) return route;
    if (await resolvePending(pending) === "missing") return "missing";
    const next = routeFromLocation(window.location);
    if ("pending" in next && next.pending && next.pending.kind === pending.kind && next.pending.ref === pending.ref) return "missing";
  }
  return "missing";
}

/** The pending link of a route, if any. */
export const pendingOf = (route: Route): PendingLink | null => ("pending" in route && route.pending) || null;

const FRIENDLY_APPS = new Set<Route["app"]>(["notes", "files", "tasks", "collections", "whiteboards", "reports"]);

/**
 * Replaces the address bar with the current route's canonical URL when they differ (D774): a UUID
 * link once the item's name is known, a stale slug or folder, a renamed note or folder, a moved card,
 * a board's former code. history.replaceState keeps the entry's state and adds no entry. A query the
 * app's URLs do not carry, and the fragment, are kept as they are.
 */
export function canonicalizeLocation() {
  const route = routeFromLocation(window.location);
  if (!FRIENDLY_APPS.has(route.app) || pendingOf(route)) return;
  const formatted = formatRoute(route);
  const current = locationUrl(window.location);
  if (formatted === current) return;
  const keepSearch = current === window.location.pathname ? window.location.search : "";
  window.history.replaceState(window.history.state, "", `${formatted}${keepSearch}${window.location.hash}`);
}

/** Installs the canonicalizer (App, once signed in); returns the uninstall. */
export function installCanonicalizer() {
  setCanonicalizer(canonicalizeLocation);
  return () => setCanonicalizer(null);
}
