/**
 * "A new version of Nook is available" (docs/ARCHITECTURE.md, Update notice). The production build
 * writes its build id into index.html (`<meta name="nook-build">`, vite.config.ts buildIdentity), and
 * the server reports the build it serves: `X-Nook-Build` on every API response and `GET /api/build`
 * (server/buildId.ts). When the two differ, a build is waiting and the frame shows the notice
 * (UpdateNotice.tsx); the person reloads when they choose, never automatically.
 *
 * Detection is nearly free: every api() response carries the header (no request of its own), and
 * `/api/build` is asked only on focus, on visibility, on `online`, every 10 minutes while the tab is
 * visible, and after a chunk failed to load; never from a hidden tab, and at most once per
 * CHECK_GAP_MS (a chunk failure skips the gap). A development client ("development", or no meta)
 * never shows the notice, and neither does a server that reports "development".
 *
 * Later hides the notice for that build for the rest of the session (sessionStorage); a newer build
 * shows it again. A chunk failure shows it even after Later: the page is out of date in a way the
 * person just met.
 */

export const DEV_BUILD = "development";
export const BUILD_META = "nook-build";
export const BUILD_HEADER = "X-Nook-Build";
export const LATER_KEY = "nook:update-later";
export const CHECK_INTERVAL_MS = 10 * 60_000;
export const CHECK_GAP_MS = 30_000;

const BUILD_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** A usable build id, or null (missing, malformed, or a development build). */
export function normalBuild(value: string | null | undefined): string | null {
  const id = value?.trim() ?? "";
  return BUILD_PATTERN.test(id) && id !== DEV_BUILD ? id : null;
}

/** Whether the server's build is a different, real build from the one this page runs. */
export function isNewBuild(client: string | null | undefined, server: string | null | undefined) {
  const mine = normalBuild(client);
  const theirs = normalBuild(server);
  return mine !== null && theirs !== null && mine !== theirs;
}

/** The build this page runs: the meta the production build wrote, "development" in dev or without it. */
export function pageBuild(doc: Pick<Document, "querySelector"> | null = typeof document === "undefined" ? null : document, dev = Boolean(import.meta.env?.DEV)) {
  if (dev || !doc) return DEV_BUILD;
  return normalBuild(doc.querySelector(`meta[name="${BUILD_META}"]`)?.getAttribute("content")) ?? DEV_BUILD;
}

export type UpdateState = { waiting: string | null; shown: boolean };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type Target = Pick<Window, "addEventListener" | "removeEventListener"> & { document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> };

export type BuildWatchOptions = {
  clientBuild: string;
  /** Asks the server which build it serves (GET /api/build). */
  fetchBuild: () => Promise<string | null>;
  storage?: () => Storage | null;
  now?: () => number;
  setInterval?: (run: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

/** The watch: state, the server's reports, the checks, and Later. One per page (`buildWatch` below). */
export function createBuildWatch(options: BuildWatchOptions) {
  const now = options.now ?? Date.now;
  const storage = () => { try { return options.storage?.() ?? null; } catch { return null; } };
  const listeners = new Set<() => void>();
  let waiting: string | null = null;
  let forced = false;
  let state: UpdateState = { waiting: null, shown: false };
  let lastCheck = -Infinity;
  let inFlight: Promise<void> | null = null;

  // Later's build: sessionStorage (the session), or this page alone when storage is unavailable.
  let laterHere: string | null = null;
  const laterBuild = () => { try { return storage()?.getItem(LATER_KEY) ?? laterHere; } catch { return laterHere; } };
  const publish = () => {
    const shown = waiting !== null && (forced || laterBuild() !== waiting);
    if (state.waiting === waiting && state.shown === shown) return;
    state = { waiting, shown };
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* a listener's failure is its own */ }
    }
  };

  /** A build the server reported (a header, or /api/build). The same build as the page's clears nothing: a waiting build stays waiting. */
  function report(server: string | null | undefined) {
    if (!isNewBuild(options.clientBuild, server)) return;
    const id = normalBuild(server)!;
    if (id !== waiting) forced = false;
    waiting = id;
    publish();
  }

  /** Asks the server, unless a check ran within CHECK_GAP_MS (`force` skips the gap) or one is running. */
  function check(force = false) {
    if (normalBuild(options.clientBuild) === null) return Promise.resolve();
    if (inFlight) return inFlight;
    if (!force && now() - lastCheck < CHECK_GAP_MS) return Promise.resolve();
    lastCheck = now();
    inFlight = options.fetchBuild().then(report, () => undefined).finally(() => { inFlight = null; });
    return inFlight;
  }

  /** A lazy chunk failed (chunkReload.ts): ask now, and show the notice even after Later. */
  function chunkFailed() {
    return check(true).then(() => {
      if (waiting !== null) { forced = true; publish(); }
    });
  }

  /** Later: hidden until a newer build, or for the rest of this session. */
  function later() {
    if (waiting === null) return;
    laterHere = waiting;
    try { storage()?.setItem(LATER_KEY, waiting); } catch { /* no storage: hidden for this page only */ }
    forced = false;
    publish();
  }

  /**
   * Starts the checks on focus, visibility, `online`, and every CHECK_INTERVAL_MS while visible.
   * Returns the stop function. A development page never starts them.
   */
  function start(target: Target) {
    if (normalBuild(options.clientBuild) === null) return () => undefined;
    const doc = target.document;
    const visible = () => !doc || doc.visibilityState !== "hidden";
    const onVisible = () => { if (visible()) void check(); };
    const onOnline = () => { if (visible()) void check(true); };
    target.addEventListener("focus", onVisible);
    target.addEventListener("online", onOnline);
    doc?.addEventListener("visibilitychange", onVisible);
    const set = options.setInterval ?? ((run, ms) => setInterval(run, ms));
    const clear = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    const timer = set(() => { if (visible()) void check(); }, CHECK_INTERVAL_MS);
    return () => {
      target.removeEventListener("focus", onVisible);
      target.removeEventListener("online", onOnline);
      doc?.removeEventListener("visibilitychange", onVisible);
      clear(timer);
    };
  }

  return {
    clientBuild: options.clientBuild,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    report,
    check,
    chunkFailed,
    later,
    start
  };
}

export type BuildWatch = ReturnType<typeof createBuildWatch>;

async function fetchServerBuild() {
  const response = await fetch("/api/build", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { build?: unknown } | null;
  return typeof body?.build === "string" ? body.build : response.headers.get(BUILD_HEADER);
}

/** This page's watch. */
export const buildWatch = createBuildWatch({
  clientBuild: pageBuild(),
  fetchBuild: fetchServerBuild,
  storage: () => typeof sessionStorage === "undefined" ? null : sessionStorage
});

/** api() hands every response here: the header costs nothing to read. */
export function noteResponseBuild(response: Pick<Response, "headers">) {
  try { buildWatch.report(response.headers.get(BUILD_HEADER)); } catch { /* a mock response without headers */ }
}
