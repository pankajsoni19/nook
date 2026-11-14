import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import "./workspace.css";

export type MoreMenuItem = { id: string; label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean };

/**
 * The ⋯ menu for a screen's secondary actions (§E.1.2): a menu button and a list of menu items.
 * Arrow keys, Home, and End move; Enter or Space picks; Escape and a click outside close and return
 * focus to the button. Each item is a 36 px row (44 px on phones).
 */
export function MoreMenu({ label = "More actions", items, className }: { label?: string; items: readonly MoreMenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const enabled = items.filter((item) => !item.disabled);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const move = (index: number) => { event.preventDefault(); buttons[(index + buttons.length) % buttons.length]?.focus(); };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(buttons.length - 1);
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "Tab") setOpen(false);
  };

  if (items.length === 0) return null;
  return <div ref={rootRef} className={`ui-menu-root${className ? ` ${className}` : ""}`}>
    <button ref={buttonRef} type="button" className="icon-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      disabled={enabled.length === 0} onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); setOpen(true); } }}><MoreHorizontal /></button>
    {open && <ul id={menuId} className="ui-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map(({ id, label: itemLabel, icon: Icon, onSelect, danger, disabled }) => <li key={id} role="none">
        <button type="button" role="menuitem" className={`ui-menu-item${danger ? " danger" : ""}`} disabled={disabled} onClick={() => { setOpen(false); onSelect(); }}>
          {Icon && <Icon aria-hidden="true" />}{itemLabel}
        </button>
      </li>)}
    </ul>}
  </div>;
}
