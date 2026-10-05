import { api } from "../api";
import type { BinItem, BinRestoreResult } from "../types";

const itemPath = (item: Pick<BinItem, "type" | "id">) => `/bin/${item.type}/${encodeURIComponent(item.id)}`;

const BIN_CHANGED = "nook:bin-changed";

/** Tells the Bin count (useBinCount, on Settings → Bin since Wave 38) that the Bin's contents changed, so they count again (Friction 8). */
export function notifyBinChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BIN_CHANGED));
}

/** Runs `listener` after each notifyBinChanged; returns the unsubscribe function. */
export function onBinChanged(listener: () => void) {
  window.addEventListener(BIN_CHANGED, listener);
  return () => window.removeEventListener(BIN_CHANGED, listener);
}

const changed = <T,>(result: T) => { notifyBinChanged(); return result; };

const BIN_COUNTED = "nook:bin-counted";
let sectionsReporting = 0;

/**
 * Settings → Bin reports its own item count while it is on screen (Wave 38 review L3): the count hook
 * neither loads the Bin beside the section's own load nor counts again after each restore or delete
 * the section already applied. Returns the release function.
 */
export function claimBinCount() {
  sectionsReporting += 1;
  return () => { sectionsReporting = Math.max(0, sectionsReporting - 1); };
}

/** True while a Bin section on screen reports the count (see claimBinCount). */
export const binCountClaimed = () => sectionsReporting > 0;

/** The Bin section's count of its loaded items, for the count hook. */
export function reportBinCount(count: number) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(BIN_COUNTED, { detail: count }));
}

/** Runs `listener` with each reported count; returns the unsubscribe function. */
export function onBinCount(listener: (count: number) => void) {
  const handler = (event: Event) => { const count = (event as CustomEvent<unknown>).detail; if (typeof count === "number") listener(count); };
  window.addEventListener(BIN_COUNTED, handler);
  return () => window.removeEventListener(BIN_COUNTED, handler);
}

export const listBin = () => api<{ items: BinItem[] }>("/bin");
export const restoreBinItem = (item: Pick<BinItem, "type" | "id">) => api<BinRestoreResult>(`${itemPath(item)}/restore`, { method: "POST", body: "{}" }).then(changed);
export const deleteBinItem = (item: Pick<BinItem, "type" | "id">) => api<{ ok: true; pending?: true }>(itemPath(item), { method: "DELETE", body: "{}" }).then(changed);
export const emptyBin = () => api<{ ok: true; purged: number; pending: number }>("/bin", { method: "DELETE", body: "{}" }).then(changed);
