import { useRef } from "react";
import { KEYS_TAB_LABELS, type KeysTab } from "./keyTabs";

export const keysTabId = (tab: KeysTab) => `keys-tab-${tab}`;
export const keysPanelId = (tab: KeysTab) => `keys-panel-${tab}`;

/**
 * API keys' tabs (the tablist pattern). Arrow keys, Home, and End move focus between tabs; Enter or
 * Space (or a click) opens one. Opening is a move to the tab's URL, so focus moving never adds a
 * history entry or asks the leave guard. Each label carries its live-key count ("Vault 2").
 */
export function KeysTabs({ tabs, selected, counts, onSelect }: { tabs: readonly KeysTab[]; selected: KeysTab; counts: Record<KeysTab, number> | null; onSelect: (tab: KeysTab) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const focusTab = (tab: KeysTab) => {
    const button = listRef.current?.querySelector<HTMLButtonElement>(`#${keysTabId(tab)}`);
    button?.focus();
    button?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = (event.target as HTMLElement).closest<HTMLElement>("[role=tab]")?.dataset.tab as KeysTab | undefined;
    const index = current ? tabs.indexOf(current) : -1;
    if (index < 0) return;
    const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length]
      : event.key === "ArrowLeft" ? tabs[(index - 1 + tabs.length) % tabs.length]
        : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : undefined;
    if (!next) return;
    event.preventDefault();
    focusTab(next);
  };
  // The bar holds the scrolling row, so the section's grid sizes it by its tabs.
  return <div className="keys-tabs-bar"><div ref={listRef} className="keys-tabs" role="tablist" aria-label="Key kinds" onKeyDown={onKeyDown}>
    {tabs.map((tab) => {
      const active = tab === selected;
      const count = counts?.[tab];
      return <button key={tab} type="button" role="tab" id={keysTabId(tab)} data-tab={tab} aria-selected={active} aria-controls={keysPanelId(tab)} tabIndex={active ? 0 : -1}
        className={active ? "keys-tab active" : "keys-tab"} onClick={() => { if (!active) onSelect(tab); }}>
        <span>{KEYS_TAB_LABELS[tab]}</span>{count !== undefined && <>{" "}<span className="keys-tab-count">{count}</span></>}
      </button>;
    })}
  </div></div>;
}
