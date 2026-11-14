import type { ComponentType } from "react";

/**
 * Item sections (W3-WIRE, D1056): panels one module adds to another module's item page without
 * editing it, the card slots (D834) generalized to workspace items. Time adds "Time" to goals,
 * contacts, companies, deals, and bookings (C15); Bookings adds "Bookings" to contacts, companies,
 * and deals (C20). A leaf (types only), so pages and module files import it without cycles.
 *
 * A section names its module and is rendered only while that module is on for the viewer; a page
 * with no registered section for its kind renders nothing extra.
 */

/** A person the page is about (a contact), for sections that prefill something with them. */
export type ItemSlotPerson = { name: string; email?: string | null };

export type ItemSlotProps = {
  kind: string;
  id: string;
  /** The viewer may not write here (role or level). */
  readOnly: boolean;
  /** In-app navigation of the host page. */
  onOpen?: (href: string) => void;
  person?: ItemSlotPerson | null;
};

export type ItemSectionDef = { id: string; kinds: readonly string[]; order?: number; component: ComponentType<ItemSlotProps>; module?: string };

const sections: ItemSectionDef[] = [];

export function registerItemSection(def: ItemSectionDef) {
  const at = sections.findIndex((item) => item.id === def.id);
  if (at >= 0) sections.splice(at, 1, def);
  else sections.push(def);
  sections.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** The sections for an item kind while `disabled` modules are off. */
export const itemSections = (kind: string, disabled: readonly string[] = []) =>
  sections.filter((section) => section.kinds.includes(kind) && (!section.module || !disabled.includes(section.module)));

/** Tests: drop every registration. */
export function clearItemSectionsForTests() { sections.length = 0; }
