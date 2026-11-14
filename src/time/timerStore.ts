import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { notify } from "../ui/notify";
import { timeApi, type StartBody } from "./api";
import type { TimeEntry } from "../../shared/time";

/**
 * The running timer, shared by the top bar chip, the Timer tab, card slots, and Today (D870, T534):
 * the server holds it, so it survives reloads and other devices; this tab reads it on load, when the
 * window regains focus or becomes visible, and when another tab says it changed (BroadcastChannel).
 * `onTimeChanged` tells lists to reload after any write here (start, stop, an entry saved).
 */

type State = { entry: TimeEntry | null; todaySeconds: number; todayEntries: number; loaded: boolean; busy: boolean };

let state: State = { entry: null, todaySeconds: 0, todayEntries: 0, loaded: false, busy: false };
const listeners = new Set<(state: State) => void>();
const changeListeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
let started = false;
let inflight: Promise<void> | null = null;

function publish(next: Partial<State>) {
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener(state);
}

/** Tells every time view (here and in other tabs) to reload. */
export function timeChanged(broadcast = true) {
  for (const listener of [...changeListeners]) listener();
  if (broadcast) channel?.postMessage("changed");
}

export function onTimeChanged(listener: () => void) {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

export function refreshTimer(): Promise<void> {
  inflight ??= timeApi.timer().then((body) => {
    publish({ entry: body.entry, todaySeconds: body.today.seconds, todayEntries: body.today.entries, loaded: true });
  }, () => { publish({ loaded: true }); }).finally(() => { inflight = null; });
  return inflight;
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  void refreshTimer();
  const refresh = () => { if (document.visibilityState === "visible") void refreshTimer(); };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("nook-time");
    channel.onmessage = () => { void refreshTimer(); timeChanged(false); };
  }
}

export function useTimer(): State {
  const [value, setValue] = useState(state);
  useEffect(() => {
    listeners.add(setValue);
    ensureStarted();
    setValue(state);
    return () => { listeners.delete(setValue); };
  }, []);
  return value;
}

export const errorText = (reason: unknown, fallback: string) => reason instanceof ApiError ? reason.message : fallback;

export async function startTimer(body: StartBody = {}): Promise<TimeEntry | null> {
  publish({ busy: true });
  try {
    const result = await timeApi.start(body);
    publish({ entry: result.entry });
    timeChanged();
    void refreshTimer();
    return result.entry;
  } catch (reason) {
    notify.error(errorText(reason, "Could not start the timer"));
    return null;
  } finally {
    publish({ busy: false });
  }
}

export async function stopTimer(): Promise<TimeEntry | null> {
  publish({ busy: true });
  try {
    const result = await timeApi.stop();
    publish({ entry: null });
    timeChanged();
    void refreshTimer();
    return result.entry;
  } catch (reason) {
    notify.error(errorText(reason, "Could not stop the timer"));
    return null;
  } finally {
    publish({ busy: false });
  }
}

/** The running entry as this tab knows it. */
export const currentTimer = () => state.entry;

/** Replaces the running entry after an edit (description, project) without a round trip. */
export const setRunning = (entry: TimeEntry | null) => publish({ entry });

/** Tests: forget everything. */
export function resetTimerStoreForTests(next: Partial<State> = {}) {
  state = { entry: null, todaySeconds: 0, todayEntries: 0, loaded: true, busy: false, ...next };
  started = true;
  for (const listener of [...listeners]) listener(state);
}
