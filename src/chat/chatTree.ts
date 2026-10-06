import type { ChatMessage } from "../../shared/agents";

/**
 * The message tree on the client (agent chat plan §6.1, D360): the branch on screen is the path
 * from a root to the active leaf, and a message with siblings shows a "‹ n / m ›" switcher.
 * Pure, so it is unit tested directly.
 */

export type Shown = { message: ChatMessage; index: number; count: number; siblings: ChatMessage[] };

const byTime = (a: ChatMessage, b: ChatMessage) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;

export function childrenOf(messages: readonly ChatMessage[], parentId: string | null): ChatMessage[] {
  return messages.filter((message) => message.parentId === parentId).sort(byTime);
}

/** The path root → leaf, oldest first; an unknown leaf yields the latest branch. */
export function pathTo(messages: readonly ChatMessage[], leafId: string | null): ChatMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  let cursor = leafId ? byId.get(leafId) ?? null : null;
  if (!cursor) return latestPath(messages, null);
  const path: ChatMessage[] = [];
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) ?? null : null;
  }
  return path.reverse();
}

/** From `parentId` down, always the newest child. */
export function latestPath(messages: readonly ChatMessage[], parentId: string | null): ChatMessage[] {
  const path: ChatMessage[] = [];
  let cursor = parentId;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const children = childrenOf(messages, cursor);
    const next = children.at(-1);
    if (!next) break;
    path.push(next);
    cursor = next.id;
  }
  return path;
}

/** The branch on screen with each message's position among its siblings. */
export function shownBranch(messages: readonly ChatMessage[], leafId: string | null): Shown[] {
  return pathTo(messages, leafId).map((message) => {
    const siblings = childrenOf(messages, message.parentId);
    return { message, index: siblings.findIndex((item) => item.id === message.id), count: siblings.length, siblings };
  });
}

/** The leaf to make active when the switcher moves to sibling `index` of `message`: that sibling's newest descendant. */
export function leafForSibling(messages: readonly ChatMessage[], sibling: ChatMessage): string {
  const below = latestPath(messages, sibling.id);
  return below.at(-1)?.id ?? sibling.id;
}
