import type { ComponentType } from "react";
import type { Role } from "../team/teamRoles";

/**
 * Member actions (D1253): buttons a module adds to the Team page's member rows and a member's
 * profile without editing Team, the item sections (D1056) for people. Bookings adds "Book time with
 * …". Each action loads what it needs for the whole list in ONE call (`load`, no request per row) and
 * renders only for members its data names, so a member with nothing to offer shows no button. A
 * leaf (types and a list), so Team and module files import it without cycles.
 */

export type MemberSlotMember = { id: string; displayName: string; isYou: boolean; blocked: boolean };

export type MemberActionProps = {
  member: MemberSlotMember;
  /** What `load` returned for this member. */
  data: unknown;
  /** A compact button beside a list row, or a full-width one on the member's profile. */
  variant: "row" | "detail";
};

export type MemberActionDef = {
  id: string;
  module?: string;
  order?: number;
  /** Roles that never see it (read-only roles cannot book). */
  hiddenFor?: readonly Role[];
  /** One batched read for the members on screen: their ids → this action's data; absent ids show nothing. */
  load: (memberIds: readonly string[]) => Promise<Record<string, unknown>>;
  component: ComponentType<MemberActionProps>;
};

const actions: MemberActionDef[] = [];

export function registerMemberAction(def: MemberActionDef) {
  const at = actions.findIndex((item) => item.id === def.id);
  if (at >= 0) actions.splice(at, 1, def);
  else actions.push(def);
  actions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** The actions for a role while `disabled` modules are off. */
export const memberActions = (role: Role, disabled: readonly string[] = []) =>
  actions.filter((action) => !action.hiddenFor?.includes(role) && (!action.module || !disabled.includes(action.module)));

/** Tests: drop every registration. */
export function clearMemberActionsForTests() { actions.length = 0; }
