/**
 * Townhall's live updates (D1075): an in-process hub per session (one replica, as the rest of Nook).
 * A write calls `sessionChanged(id)` after its transaction commits; every open stream of that session
 * wakes, waits out a short coalescing window, and sends its viewer a fresh state (each stream builds
 * its own, so access and "mine"/"voted" are per viewer). Streams are counted per person, per address,
 * and per session, so a tab storm gets 429 (T614).
 */

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
const revisions = new Map<string, number>();

export function subscribeSession(sessionId: string, listener: Listener) {
  const set = listeners.get(sessionId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(sessionId);
  };
}

/** Wakes the session's streams (call after the write commits). */
export function sessionChanged(sessionId: string) {
  revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1);
  const set = listeners.get(sessionId);
  if (!set?.size) return;
  queueMicrotask(() => { for (const listener of [...set]) listener(); });
}

/** A counter that moves on every change (clients poll with it when streams are unavailable). */
export const liveRevision = (sessionId: string) => revisions.get(sessionId) ?? 0;
export const openStreams = (sessionId: string) => listeners.get(sessionId)?.size ?? 0;

/** Stream caps (T614). */
export const STREAM_CAPS = { perUser: 8, perAddress: 300, perSession: 3000 } as const;
const counts = new Map<string, number>();

/** Takes one stream slot under every key, or null when any is full; returns its release. */
export function takeStream(slots: ReadonlyArray<{ key: string; limit: number }>): (() => void) | null {
  if (slots.some((slot) => (counts.get(slot.key) ?? 0) >= slot.limit)) return null;
  for (const slot of slots) counts.set(slot.key, (counts.get(slot.key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const slot of slots) {
      const next = (counts.get(slot.key) ?? 1) - 1;
      if (next <= 0) counts.delete(slot.key);
      else counts.set(slot.key, next);
    }
  };
}

/** The coalescing window between two pushes, the keep-alive, and the access re-check of a stream. */
export const LIVE_TIMING = { coalesceMs: 400, pingMs: 15_000, accessCheckMs: 15_000 };
