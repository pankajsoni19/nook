import type { AuditQuery, Route } from "./router";

export type ChatRoute = Extract<Route, { app: "chat" }>;

/** A Chat route: the list, a new chat (optionally with an agent preselected), or one chat. */
export function chatRoute(chatId: string | null = null, options: { newChat?: boolean; agentId?: string | null } = {}): ChatRoute {
  if (chatId) return { app: "chat", chatId };
  if (options.newChat) return options.agentId ? { app: "chat", chatId: null, newChat: true, agentId: options.agentId } : { app: "chat", chatId: null, newChat: true };
  return { app: "chat", chatId: null };
}

/** The Audit log (Wave 42, plan §13.3): the list, or one run's timeline; the list's filters ride along (QA L4). */
export function auditRoute(runId: string | null = null, filter?: { [K in keyof AuditQuery]?: string | null } | null): ChatRoute {
  const clean = filter ? Object.fromEntries(Object.entries(filter).filter(([, value]) => typeof value === "string" && value)) as AuditQuery : null;
  const base: ChatRoute = clean && Object.keys(clean).length ? { app: "chat", chatId: null, audit: true, auditFilter: clean } : { app: "chat", chatId: null, audit: true };
  return runId ? { ...base, runId } : base;
}

/**
 * In-app Back (the ‹ in a chat's header on phones, and the list's Home): step back through entries
 * this visit pushed (the `mynotes.depth` counter), so it matches the browser's Back; from a deep
 * link replace the chat with the list (a run with the Audit log, the Audit log with the chats); from
 * the list go Home. It never leaves Nook.
 */
export function chatBackAction(route: ChatRoute, depth: number): { kind: "history" } | { kind: "replace"; route: ChatRoute } | { kind: "home" } {
  if (!route.chatId && !route.newChat && !route.audit) return { kind: "home" };
  if (depth > 0) return { kind: "history" };
  if (route.audit && route.runId) return { kind: "replace", route: auditRoute(null, route.auditFilter) };
  return { kind: "replace", route: chatRoute() };
}

/** The date group a chat belongs to in the left column (plan §13.2). */
export function chatGroup(updatedAt: string, pinned: boolean, nowMs = Date.now()): string {
  if (pinned) return "Pinned";
  const when = new Date(updatedAt).getTime();
  if (!Number.isFinite(when)) return "Older";
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (when >= startOfToday) return "Today";
  if (when >= startOfToday - 86_400_000) return "Yesterday";
  if (when >= startOfToday - 7 * 86_400_000) return "Previous 7 days";
  const date = new Date(when);
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString(undefined, { month: "long" });
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
