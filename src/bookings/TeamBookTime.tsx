import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CalendarPlus, ChevronDown } from "lucide-react";
import { api } from "../api";
import type { MemberActionDef, MemberActionProps } from "../ui/memberSlots";
import { durationLabel, type BookableType } from "./api";
import "../ui/workspace.css";
import "./teamBookTime.css";

/**
 * "Book time with …" on the Team page (D1250–D1253), a member action (src/ui/memberSlots.ts). The
 * Team list asks once for every member on screen which types each offers to the viewer
 * (GET /api/bookings/bookable); a member with none shows nothing. One type opens the in-app booking
 * sheet straight away; several open a small chooser (title, lengths) first.
 */

const BookTimeSheet = lazy(() => import("./BookTimeSheet"));

/** Short member lists go by id; a long one asks for everyone (the URL stays short). */
const BY_ID_LIMIT = 150;

export const loadBookable = (memberIds: readonly string[]) => api<{ hosts: Record<string, BookableType[]> }>(
  memberIds.length <= BY_ID_LIMIT ? `/bookings/bookable?users=${memberIds.map(encodeURIComponent).join(",")}` : "/bookings/bookable"
).then(({ hosts }) => Object.fromEntries(Object.entries(hosts).filter(([, types]) => types.length > 0)) as Record<string, unknown>);

const lengths = (type: BookableType) => type.durations.map(durationLabel).join(" / ");
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export function BookTimeAction({ member, data, variant }: MemberActionProps) {
  const types = Array.isArray(data) ? data as BookableType[] : [];
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<BookableType | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  if (!types.length) return null;
  const label = `Book time with ${member.displayName}`;
  const several = types.length > 1;
  const pick = (type: BookableType) => { setOpen(false); setChosen(type); };
  const onMenuKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (index: number) => { event.preventDefault(); items[(index + items.length) % items.length]?.focus(); };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); buttonRef.current?.focus(); }
    else if (event.key === "Tab") setOpen(false);
  };

  return <div ref={rootRef} className={`ui-menu-root bk-team-book ${variant}`}>
    <button ref={buttonRef} type="button" className={variant === "detail" ? "action-button bk-team-book-button" : "secondary-button ui-small-button bk-team-book-button"}
      aria-label={variant === "row" ? label : undefined} title={variant === "row" ? label : undefined}
      aria-haspopup={several ? "menu" : "dialog"} aria-expanded={several ? open : undefined} aria-controls={several && open ? menuId : undefined}
      onClick={() => { if (several) setOpen((value) => !value); else setChosen(types[0]!); }}
      onKeyDown={(event) => { if (several && event.key === "ArrowDown" && !open) { event.preventDefault(); setOpen(true); } }}>
      <CalendarPlus aria-hidden="true" />
      <span className="bk-team-book-label">{variant === "row" ? "Book time" : label}</span>
      {several && <ChevronDown aria-hidden="true" className="bk-team-book-caret" />}
    </button>
    {open && <ul id={menuId} className="ui-menu bk-team-book-menu" role="menu" aria-label={`Book time with ${firstName(member.displayName)}: choose a meeting`} onKeyDown={onMenuKey}>
      {types.map((type) => <li key={type.id} role="none">
        <button type="button" role="menuitem" className="ui-menu-item bk-team-book-item" onClick={() => pick(type)}>
          <span className="bk-team-book-dot" style={{ background: type.color }} aria-hidden="true" />
          <span className="bk-team-book-copy"><strong>{type.title}</strong><small>{lengths(type)}{type.assignment === "collective" ? " · group" : ""}{type.confirm === "manual" ? " · needs approval" : ""}</small></span>
        </button>
      </li>)}
    </ul>}
    {/* D1261: on document.body, out of the row's transformed actions box, which clipped and offset it. */}
    {chosen && createPortal(<Suspense fallback={null}>
      <BookTimeSheet type={chosen} hostName={member.displayName} onClose={() => { setChosen(null); buttonRef.current?.focus(); }} />
    </Suspense>, document.body)}
  </div>;
}

export const bookTimeMemberAction: MemberActionDef = {
  id: "bookings.book-time",
  order: 10,
  hiddenFor: ["viewer", "guest"],
  load: loadBookable,
  component: BookTimeAction
};
