/**
 * Reload to update (UpdateNotice, the ⌘K command, and a chunk that failed to load): the same leave
 * path as a sidebar move. The frame's guard runs first (App's Settings-hub confirm, then the page's,
 * such as Files' uploads), then App's own leave (Notes saves or publishes the open note and asks about
 * uploads in flight), then the before-reload hooks (an open whiteboard keeps its unsaved edits), and
 * only then the reload. A declined confirm or a note that could not be saved stops it. The browser's
 * own beforeunload prompts (a form or booking type being edited) still fire on the reload itself.
 *
 * The service worker (public/sw.js) has no fetch handler and caches nothing, so a plain reload
 * fetches the new index.html (no-cache) and its new hashed chunks; there is no worker to update first.
 */

export type ReloadSteps = {
  /** The frame's guard: App's, then the page's; calls `leave` once every confirm said yes. */
  guard: (leave: () => void) => void;
  /** App's own leave (Notes saves first); false stops the reload. */
  leave?: () => Promise<boolean> | boolean;
  /** The before-reload hooks (chunkReload.ts runBeforeReload). */
  beforeReload?: () => Promise<unknown>;
  /** The reload itself. */
  go: () => void;
  /** Lets state settle (a cancelled upload drops its beforeunload listener) before the reload. */
  settle?: () => Promise<void>;
};

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Runs the steps; resolves true when the reload was started, false when a step stopped it. */
export function guardedReload({ guard, leave, beforeReload, go, settle = nextTask }: ReloadSteps): Promise<boolean> {
  return new Promise((resolve) => {
    // A guard whose confirm the person declines never calls leave: the promise stays pending.
    guard(() => {
      void (async () => {
        try {
          if (leave && !await leave()) { resolve(false); return; }
          await beforeReload?.();
          await settle();
          go();
          resolve(true);
        } catch {
          resolve(false);
        }
      })();
    });
  });
}

/** The reload a button starts. */
export const reloadPage = () => window.location.reload();
