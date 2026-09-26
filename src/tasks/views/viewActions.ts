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

/**
 * What an owner may do with one of their views. A read-only owner (a member demoted after sharing)
 * edits, renames, and deletes a view only while it is private, and may withdraw a share by making
 * it private (the server answers 403 VIEW_SHARED_READ_ONLY otherwise).
 */
export function ownedViewActions(canShare: boolean, visibility: TaskView["visibility"]) {
  const edit = canShare || visibility === "private";
  return { edit, share: canShare, withdraw: !canShare && visibility !== "private" };
}

/** The Save dialogs' hint: a read-only role's views stay private. */
export const viewNameHint = (canShare: boolean) => canShare ? "Up to 80 characters. Only you see it until you share it." : "Up to 80 characters. Only you see it.";
