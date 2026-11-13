/**
 * Module notifications (§B.7, D809): one `notifications` row of kind `module` per event, written by
 * `notify()` (server/notify/index.ts), shown in the bell and on the Notifications page with the
 * module's icon (W1-UI). Titles are written by the server from kinds, and hrefs are relative app
 * paths only (T509).
 */
import type { WorkspaceModuleId } from "./workspaceModules";
import type { WorkKind } from "./workRefs";

export const NOTIFY_TITLE_MAX = 200;
export const NOTIFY_BODY_MAX = 500;
export const NOTIFY_TOPIC_PATTERN = /^[a-z][a-z0-9_.]{1,39}$/;

/** A module notification as GET /api/notifications lists it (alongside reminder and proposal rows). */
export type ModuleNotification = {
  id: string;
  kind: "module";
  module: WorkspaceModuleId;
  /** Module-defined, e.g. `forms.response`, `bookings.confirmed`. */
  topic: string;
  title: string;
  body: string | null;
  /** A relative in-app path (`/goals/…`), never an absolute URL. */
  href: string;
  item: { kind: WorkKind; id: string } | null;
  actor: { id: string; name: string } | null;
  createdAt: string;
  readAt: string | null;
};

/** Whether an href is a safe relative in-app path (T509): one leading slash, no scheme, no `//`, no backslashes or control characters. */
export const isSafeAppHref = (href: string) => /^\/(?![/\\])[^\s\\]*$/.test(href) && href.length <= 500 && !/[\u0000-\u001f]/.test(href);
