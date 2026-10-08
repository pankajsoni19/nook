import { createContext, useContext } from "react";
import { api } from "../api";
import { formatRoute, parseRoute } from "../router";

export type NotificationItem = { id: string; kind?: "reminder" | "proposals" | "access"; title: string; href: string; late: boolean; read: boolean; createdAt: string; occurrenceStart: string | null };
export type NotificationList = { items: NotificationItem[]; unreadCount: number };

export const listNotifications = (options: { unread?: boolean; limit?: number } = {}) => {
  const params = new URLSearchParams();
  if (options.unread) params.set("unread", "1");
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  return api<NotificationList>(`/notifications${query ? `?${query}` : ""}`);
};
export const markRead = (ids: string[]) => api<{ ok: true; updated: number }>("/notifications/read", { method: "POST", body: JSON.stringify({ ids }) });
export const markAllRead = () => api<{ ok: true; updated: number }>("/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) });

/** At most this long: the server's longest path is well under it. */
const MAX_PATH = 200;

/**
 * The in-app path a notification opens (bell deep links, v0.32). The server builds every href from
 * ids only (T68); the client follows it only when it is a same-origin path the router itself would
 * write: parsing it and formatting it back must give the same text (so every id matches the id
 * pattern, ids are written lowercase, and nothing else rides along), and it must name a page, not fall through to Home.
 * Anything else opens the notifications list. The page then loads the item as usual, so an item
 * the reader can no longer open shows that module's own "not found" state, never its content.
 */
export function safeNotificationPath(href: unknown) {
  if (typeof href !== "string" || href.length > MAX_PATH || !href.startsWith("/") || href.startsWith("//") || /[\\\s#]/.test(href)) return "/notifications";
  const route = parseRoute(href);
  // Ids are compared without case: the router writes them lowercase, and so does the server.
  const path = formatRoute(route);
  if (route.app === "home" || path.toLowerCase() !== href.toLowerCase()) return "/notifications";
  return path;
}

/** "Just now", "5 min ago", "3 h ago", "2 days ago". */
export function notificationAge(createdAt: string, nowMs = Date.now()) {
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(createdAt)) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

/** Fired after each bell refresh (its poll, focus, or a change), so other account-row badges follow it. */
export const NOTIFICATIONS_POLLED = "mynotes:notifications-polled";

export const badgeLabel = (count: number) => count > 99 ? "99+" : String(count);

/** What the app shell gives the bell: how to open the full list and a notification's target. */
export type NotificationsContextValue = { openList: () => void; openPath: (path: string) => void };
export const NotificationsContext = createContext<NotificationsContextValue | null>(null);
export const useNotificationsContext = () => useContext(NotificationsContext);
