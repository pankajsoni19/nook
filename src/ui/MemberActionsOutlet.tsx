import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { useDisabledModules } from "../modules";
import type { Role } from "../team/teamRoles";
import { memberActions, type MemberActionDef, type MemberSlotMember } from "./memberSlots";

class SlotBoundary extends Component<{ children: ReactNode; id: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error(`Member action ${this.props.id} failed`, error); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Each action's data by action id, then member id. */
export type MemberActionData = { actions: readonly MemberActionDef[]; byAction: Readonly<Record<string, Record<string, unknown>>> };

/**
 * Loads every member action's data for the members on screen: one call per action for the whole
 * list (D1253), again only when the set of ids changes. A failed load shows that action nowhere.
 */
export function useMemberActionData(memberIds: readonly string[] | null, role: Role): MemberActionData {
  const disabled = useDisabledModules();
  const list = useMemo(() => memberActions(role, disabled), [role, disabled]);
  const key = memberIds ? [...memberIds].sort().join(",") : "";
  const [byAction, setByAction] = useState<Record<string, Record<string, unknown>>>({});
  useEffect(() => {
    if (!key || !list.length) { setByAction({}); return; }
    let live = true;
    const ids = key.split(",");
    for (const action of list) {
      action.load(ids).then((data) => { if (live) setByAction((current) => ({ ...current, [action.id]: data })); },
        () => { if (live) setByAction((current) => { const next = { ...current }; delete next[action.id]; return next; }); });
    }
    return () => { live = false; };
  }, [key, list]);
  return useMemo(() => ({ actions: list, byAction }), [list, byAction]);
}

/** The actions that have something for this member; nothing at all when none do. */
export function MemberActions({ member, variant, data, className }: { member: MemberSlotMember; variant: "row" | "detail"; data: MemberActionData; className?: string }) {
  const shown = data.actions.filter((action) => data.byAction[action.id]?.[member.id] !== undefined);
  if (!shown.length) return null;
  return <div className={className}>
    {shown.map(({ id, component: Action }) => <SlotBoundary key={id} id={id}><Action member={member} variant={variant} data={data.byAction[id]![member.id]} /></SlotBoundary>)}
  </div>;
}
