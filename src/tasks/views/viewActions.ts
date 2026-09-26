// Pure helpers for saved task views (17C, D140). No DOM access.
import type { NameCheck } from "../taskActions";
import type { TaskView } from "../home/homeApi";

// C0/C1 controls and bidi overrides, as refused by server/tasks/queryRoutes.ts.
const controlCharacters = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

/**
 * A view name: 1–80 characters, no control characters (the server rule). With `current` (rename)
 * an unchanged name is `changed: false`; without it (save as), any valid name is a change.
 */
export function validateViewName(input: string, current?: string): NameCheck {
  const name = input.trim();
  if (!name) return { ok: false, error: "Enter a view name." };
  if (name.length > 80) return { ok: false, error: "Use at most 80 characters." };
  if (controlCharacters.test(name)) return { ok: false, error: "Remove control characters." };
  return { ok: true, name, changed: current === undefined || name !== current };
}

/** Who a view reaches, in the share panel's words. */
export const viewVisibilityLabel = (visibility: TaskView["visibility"]) =>
  visibility === "all_users" ? "Everyone here" : visibility === "selected" ? "Selected people" : "Private";

/** The body that re-creates a deleted view (Undo, §5.2): the same name, query, and display, private again. */
export const viewUndoBody = (view: Pick<TaskView, "name" | "query" | "display">) => ({ name: view.name, query: view.query, display: { ...view.display } });

/**
 * What a Team role may do with views (task hierarchy plan Q12, Wave 15): viewers create, edit,
 * duplicate, and delete their own private views; guests create none; nobody read-only shares.
 * Chrome only: server/team/writeGate.ts enforces the same rule.
 */
export function viewRoleAccess(access: { canWrite: boolean; isGuest: boolean }) {
  return { canCreate: !access.isGuest, canShare: access.canWrite };
}

/** The Save dialogs' hint: a read-only role's views stay private. */
export const viewNameHint = (canShare: boolean) => canShare ? "Up to 80 characters. Only you see it until you share it." : "Up to 80 characters. Only you see it.";

/**
 * The views list listens for this after a change made elsewhere (Undo of a delete re-creates the
 * view from a toast after the view page has gone), so it reloads without a page reload.
 */
export const VIEWS_CHANGED_EVENT = "nook:task-views-changed";
export function announceViewsChanged(target: EventTarget = window) {
  target.dispatchEvent(new Event(VIEWS_CHANGED_EVENT));
}
/** Subscribes to {@link announceViewsChanged}; returns the unsubscribe. */
export function onViewsChanged(listener: () => void, target: EventTarget = window) {
  const handler = () => listener();
  target.addEventListener(VIEWS_CHANGED_EVENT, handler);
  return () => target.removeEventListener(VIEWS_CHANGED_EVENT, handler);
}
