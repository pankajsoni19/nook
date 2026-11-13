import { useEffect, useRef } from "react";

/** A key press meant for a field, an editor, or a control that handles its own keys. */
export function isEditableTarget(target: EventTarget | null) {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  return element.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="listbox"], [role="menu"], [role="slider"]') !== null;
}

/** True while a modal dialog or sheet is open: page shortcuts wait until it closes. */
export const modalOpen = () => typeof document !== "undefined" && document.querySelector('[aria-modal="true"]') !== null;

/**
 * Single-key page shortcuts for a module screen (§E.1.4): `/` search, `n` new, `j`/`k` move, `e`
 * edit, `?` help. Ignored while typing, with Ctrl/⌘/Alt held, or under a modal; the handler for a
 * key that is not registered never runs. Each handler may return false to let the key through.
 */
export function useModuleShortcuts(keys: Partial<Record<string, (event: KeyboardEvent) => boolean | void>>, enabled = true) {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event.target) || modalOpen()) return;
      const handler = ref.current[event.key];
      if (!handler) return;
      if (handler(event) === false) return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
