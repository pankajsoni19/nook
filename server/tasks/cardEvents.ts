import { db } from "../db";
import { logger } from "../log";
import type { CardActivityKind } from "../../shared/cardActivity";

const slog = logger("tasks");

/**
 * Card changes for other modules (docs/plan/WORKSPACE_MODULES.md §C C7/C17, D1040). Every change to a
 * card already records card activity inside the change's transaction (D742), so `recordCardActivity`
 * reports each entry here and listeners hear about it **after** the change: the batch is delivered in
 * a microtask, once the synchronous transaction that wrote it has committed or rolled back. A listener
 * gets only entries whose activity row still exists (a refused change records nothing, so it reports
 * nothing), and must re-read whatever it needs: the event names the card, never its contents.
 *
 * Tasks itself never listens and nothing here changes how a card is written; a listener that throws is
 * logged and skipped. Listeners run as Nook (no request context); they check access themselves.
 */
export type CardChange = { activityId: string; cardId: string; boardId: string; actorId: string | null; kind: CardActivityKind; at: string };
export type CardChangeListener = (changes: readonly CardChange[]) => void | Promise<void>;

const listeners: CardChangeListener[] = [];
let pending: CardChange[] = [];
let scheduled = false;

export function onCardChange(listener: CardChangeListener) {
  listeners.push(listener);
  return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
}

/** Called by `recordCardActivity` (server/tasks/activity.ts) for every entry it writes or folds. */
export function reportCardChange(change: CardChange) {
  if (!listeners.length) return;
  pending.push(change);
  if (pending.length > 5_000) pending = pending.slice(-5_000);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(deliver);
}

function deliver() {
  scheduled = false;
  const batch = pending;
  pending = [];
  if (!batch.length || !listeners.length) return;
  // Entries of a rolled-back transaction are gone: drop them (D1040).
  const live = new Set((db.query("SELECT id FROM card_activity WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...new Set(batch.map((change) => change.activityId))])) as Array<{ id: string }>).map((row) => row.id));
  const changes = batch.filter((change) => live.has(change.activityId));
  if (!changes.length) return;
  for (const listener of [...listeners]) {
    try {
      const result = listener(changes);
      if (result && typeof (result as Promise<void>).catch === "function") (result as Promise<void>).catch((error) => slog.error("A card change listener failed", error));
    } catch (error) {
      slog.error("A card change listener failed", error);
    }
  }
}

/** Tests: delivers what is pending now (the microtask would, a moment later). */
export async function flushCardChangesForTests() {
  await Promise.resolve();
  if (scheduled) deliver();
}
