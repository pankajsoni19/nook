import type { ChatUpdateEvent } from "../../shared/agents";

/**
 * Chat-level change signals (Wave 43 fixes, QA M1): someone reading a shared chat learns that the
 * owner sent a message, started an answer, switched branch, or deleted the chat, without polling.
 * `GET /api/chats/:id/updates` (server/agents/routes.ts) streams these to readers of the chat; the
 * client then reloads the chat and follows a new run on its own stream. In memory only: a reconnect
 * passes the chat revision it has, and the route sends a catch-up event when the chat moved on.
 * Events carry ids and the revision, never text, so a stale listener learns nothing it cannot read.
 */

type Listener = (event: ChatUpdateEvent) => void;
const listeners = new Map<string, Set<Listener>>();

export function publishChatUpdate(chatId: string, event: ChatUpdateEvent) {
  const set = listeners.get(chatId);
  if (!set) return;
  for (const listener of [...set]) {
    try { listener(event); } catch { set.delete(listener); }
  }
}

export function subscribeChatUpdates(chatId: string, listener: Listener): () => void {
  let set = listeners.get(chatId);
  if (!set) {
    set = new Set();
    listeners.set(chatId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(chatId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(chatId);
  };
}

/** Test hook: how many listeners a chat has. */
export const chatUpdateListeners = (chatId: string) => listeners.get(chatId)?.size ?? 0;
