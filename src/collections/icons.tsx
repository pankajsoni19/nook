import { Calendar, CheckSquare, ChefHat, Contact, CreditCard, Hash, Link, List, ListChecks, Package, Paperclip, Receipt, StickyNote, Table2, Type, UserRound } from "lucide-react";
import type { FieldType } from "./collectionsApi";

// Collection icons are stored as short names; anything unknown shows the table icon.
const collectionIcons = { table: Table2, package: Package, "credit-card": CreditCard, receipt: Receipt, "chef-hat": ChefHat, contact: Contact } as const;

export function CollectionIcon({ name }: { name: string }) {
  const Icon = collectionIcons[name as keyof typeof collectionIcons] ?? Table2;
  return <Icon aria-hidden="true" />;
}

const fieldIcons: Record<FieldType, typeof Type> = {
  text: Type,
  number: Hash,
  date: Calendar,
  checkbox: CheckSquare,
  select: List,
  multi_select: ListChecks,
  url: Link,
  note: StickyNote,
  file: Paperclip,
  person: UserRound,
  contact: Contact
};

export function FieldIcon({ type }: { type: FieldType }) {
  const Icon = fieldIcons[type] ?? Type;
  return <Icon aria-hidden="true" className="field-icon" />;
}
