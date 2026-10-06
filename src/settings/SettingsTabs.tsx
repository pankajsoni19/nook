import { useEffect, useRef, type KeyboardEvent } from "react";

/**
 * A Settings section's tab row (Settings → AI first): each tab is its own URL, so the caller's
 * `onSelect` navigates and browser Back and Forward move between tabs. The row scrolls sideways on a
 * narrow screen and never wraps a label. Arrow keys (and Home, End) move focus between the tabs;
 * Enter or Space opens one, so moving through the row adds no history entries.
 */
export type SettingsTab<Id extends string> = {
  id: Id;
  label: string;
  /** A count beside the label (providers, tool servers); `countNoun` names it for assistive tech. */
  count?: number;
  countNoun?: string;
};

/** The ids a tab and its panel share, so the caller's panel can point back at its tab. */
export const settingsTabIds = (prefix: string, id: string) => ({ tab: `${prefix}-tab-${id}`, panel: `${prefix}-panel-${id}` });

export function SettingsTabs<Id extends string>({ label, idPrefix, tabs, selected, onSelect }: { label: string; idPrefix: string; tabs: ReadonlyArray<SettingsTab<Id>>; selected: Id; onSelect: (id: Id) => void }) {
  const refs = useRef(new Map<Id, HTMLButtonElement>());
  const rowRef = useRef<HTMLDivElement>(null);
  // A narrow screen: the selected tab (a deep link, Back or Forward) is scrolled into the row's view,
  // sideways only, again whenever the row's width changes (a count arriving, the page's styles loading).
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const reveal = () => {
      const tab = refs.current.get(selected);
      if (!tab) return;
      const rowBox = row.getBoundingClientRect();
      const tabBox = tab.getBoundingClientRect();
      if (tabBox.left < rowBox.left) row.scrollLeft -= rowBox.left - tabBox.left;
      else if (tabBox.right > rowBox.right) row.scrollLeft += tabBox.right - rowBox.right;
    };
    reveal();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(reveal);
    observer.observe(row);
    for (const tab of refs.current.values()) observer.observe(tab);
    return () => observer.disconnect();
  }, [selected, tabs.length]);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    const target = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    const tab = tabs[target];
    if (tab) refs.current.get(tab.id)?.focus();
  }
  return <div ref={rowRef} className="settings-tabs" role="tablist" aria-label={label}>
    {tabs.map((tab, index) => {
      const ids = settingsTabIds(idPrefix, tab.id);
      const current = tab.id === selected;
      const count = tab.count;
      return <button
        key={tab.id}
        ref={(element) => { if (element) refs.current.set(tab.id, element); else refs.current.delete(tab.id); }}
        type="button"
        role="tab"
        id={ids.tab}
        aria-selected={current}
        aria-controls={ids.panel}
        aria-label={count !== undefined ? `${tab.label}, ${count} ${tab.countNoun ?? "item"}${count === 1 ? "" : "s"}` : undefined}
        tabIndex={current ? 0 : -1}
        className={`settings-tab${current ? " active" : ""}`}
        onClick={() => { if (!current) onSelect(tab.id); }}
        onKeyDown={(event) => onKeyDown(event, index)}
      >
        <span>{tab.label}</span>
        {count !== undefined && <span className="settings-tab-count" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
      </button>;
    })}
  </div>;
}
