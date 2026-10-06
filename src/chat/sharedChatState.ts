import { ApiError } from "../api";
import type { ChatSummary } from "../../shared/agents";
import { errorCode } from "./chatApi";

/**
 * Wave 43 fixes 2: the "Shared with me" list follows the open shared chat (QA L1), and Continue as
 * a copy says what the server says (QA L2). Pure helpers, so the tests can call them.
 */

/** The server's own message on a refused request, or null when it sent none. */
export function serverMessage(reason: unknown): string | null {
  if (!(reason instanceof ApiError) || !reason.payload || typeof reason.payload !== "object") return null;
  const message = (reason.payload as { error?: unknown }).error;
  return typeof message === "string" && message.trim() ? message : null;
}

/**
 * Continue as a copy refused (QA L2): the server's message, which says "in the Bin" only to the
 * agent's owner and "no longer available" to everyone else; a generic line only when it sent none.
 */
export function forkFailureText(reason: unknown): string {
  const fromServer = serverMessage(reason);
  if (fromServer) return fromServer;
  const code = errorCode(reason);
  if (code === "AGENT_NOT_SHARED") return "Its agent is not shared with you, so you cannot continue this chat";
  if (code === "AGENT_GONE") return "This chat's agent is no longer available, so you cannot continue this chat";
  return "Could not copy the chat";
}

/** The list with `chat`'s title (and time) as the open chat has them; the same list when nothing changed. */
export function syncSharedChat(list: ChatSummary[] | null, chat: Pick<ChatSummary, "id" | "title" | "updatedAt">): ChatSummary[] | null {
  if (!list) return list;
  const index = list.findIndex((item) => item.id === chat.id);
  if (index < 0) return list;
  const current = list[index]!;
  if (current.title === chat.title && current.updatedAt === chat.updatedAt) return list;
  const next = list.slice();
  next[index] = { ...current, title: chat.title, updatedAt: chat.updatedAt };
  return next;
}

/** The list without `chatId` (unshared, deleted, or otherwise gone); the same list when it was not there. */
export function dropSharedChat(list: ChatSummary[] | null, chatId: string): ChatSummary[] | null {
  if (!list || !list.some((item) => item.id === chatId)) return list;
  return list.filter((item) => item.id !== chatId);
}
