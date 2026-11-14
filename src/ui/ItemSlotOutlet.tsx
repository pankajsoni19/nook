import { Component, type ReactNode } from "react";
import { useDisabledModules } from "../modules";
import { itemSections, type ItemSlotProps } from "./itemSlots";

class SlotBoundary extends Component<{ children: ReactNode; id: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error(`Item section ${this.props.id} failed`, error); }
  render() { return this.state.failed ? null : this.props.children; }
}

/**
 * Where an item page renders the sections other modules registered for its kind (src/ui/itemSlots.ts,
 * D1056). Each section sits in the page's own panel frame (`frameClassName`); nothing renders when no
 * section applies. A section that throws is dropped, never the page.
 */
export function ItemSectionsOutlet({ frameClassName, ...props }: ItemSlotProps & { frameClassName?: string }) {
  const disabled = useDisabledModules();
  const list = itemSections(props.kind, disabled);
  if (list.length === 0) return null;
  return <>{list.map(({ id, component: Section }) => <SlotBoundary key={id} id={id}>
    {frameClassName ? <div className={frameClassName}><Section {...props} /></div> : <Section {...props} />}
  </SlotBoundary>)}</>;
}
