import { useEffect, useRef, type ReactNode } from "react";
import { House, Search, Sparkles, type LucideIcon } from "lucide-react";
import { AccountActions, AppPageName } from "../AppShell";
import { ReadOnlyBanner } from "../team/roleAccess";
import { MoreMenu, type MoreMenuItem } from "./MoreMenu";
import { useModuleShortcuts } from "./moduleKeys";
import { centerActiveTab } from "./tabStrip";
import "./workspace.css";

export type ModuleTab = { id: string; label: string; count?: number };
export type ModulePrimaryAction = { label: string; icon?: LucideIcon; onClick: () => void; disabled?: boolean; /** Bound to `n` (§E.1.4); off for actions that are not "new". */ shortcut?: boolean };
export type ModuleSearch = { value: string; onChange: (value: string) => void; placeholder: string; /** The field's accessible name. */ label: string };

type ModuleHomeProps = {
  icon: LucideIcon;
  /** The module's name: the header's brand text and the page's h1 (unless `heading` differs). */
  title: string;
  /** The page's h1 when it is not the module's name ("Q1 2027 goals"). */
  heading?: string;
  displayName: string;
  onHome: () => void;
  onSettings: () => void;
  onSignOut: () => void;
  /** The one primary action (amber, §E.1.2). Hidden for read-only roles by the caller. */
  primary?: ModulePrimaryAction;
  /** Secondary actions in the ⋯ menu. */
  menu?: readonly MoreMenuItem[];
  /** The module's top-level views (a strip of tabs, each its own route). */
  tabs?: readonly ModuleTab[];
  activeTab?: string;
  onTab?: (id: string) => void;
  /** Filter chips (the row under the tabs, before the search). */
  filters?: ReactNode;
  search?: ModuleSearch;
  /** A right detail pane on wide screens (≥ 1280 px); phones open details as routes or sheets instead. */
  detail?: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * The module home scaffold (§E.2, D837): every workspace module's home has the same header (Home, the
 * module's name, the account row), title row (icon, name, primary action, ⋯), tab strip, filter row
 * (chips + search), and content, so Forms, Time, Goals, Standups, Contacts, Bookings, and Townhall
 * share header height, tab style, and spacing. Keys: `/` focuses the search, `n` runs the primary
 * action. At 375 px it is two rows, nothing hidden: the title with its actions, then the tabs; the
 * filters wrap and the search takes its own full-width line.
 */
export function ModuleHome({ icon: Icon, title, heading, displayName, onHome, onSettings, onSignOut, primary, menu, tabs, activeTab, onTab, filters, search, detail, children, className }: ModuleHomeProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLUListElement>(null);
  useEffect(() => { centerActiveTab(tabsRef.current); }, [activeTab]);
  useModuleShortcuts({
    "/": search ? () => { searchRef.current?.focus(); } : undefined,
    n: primary && primary.shortcut !== false && !primary.disabled ? () => { primary.onClick(); } : undefined
  });
  const PrimaryIcon = primary?.icon;
  const headingId = `module-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-title`;

  return <main className={`app-page ui-module-home${className ? ` ${className}` : ""}`}>
    <header className="app-page-header">
      <button className="app-home-button" onClick={onHome}><House />Home</button>
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>{title}</strong></span></span><AppPageName name={title} />
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} />
    </header>
    <ReadOnlyBanner />
    <div className="ui-module-bar">
      <div className="ui-module-title-row">
        <span className="ui-module-icon" aria-hidden="true"><Icon /></span>
        <h1 id={headingId} className="ui-module-title" tabIndex={-1}>{heading ?? title}</h1>
        <div className="ui-module-actions">
          {primary && <button type="button" className="action-button" onClick={primary.onClick} disabled={primary.disabled} aria-keyshortcuts={primary.shortcut === false ? undefined : "n"}>{PrimaryIcon && <PrimaryIcon aria-hidden="true" />}{primary.label}</button>}
          {menu && menu.length > 0 && <MoreMenu label={`More ${title} actions`} items={menu} />}
        </div>
      </div>
      {tabs && tabs.length > 0 && <nav aria-label={`${title} views`}>
        <ul ref={tabsRef} className="ui-module-tabs">
          {tabs.map((tab) => <li key={tab.id}>
            <button type="button" className="ui-module-tab" aria-current={tab.id === activeTab ? "page" : undefined} onClick={() => onTab?.(tab.id)}>
              {tab.label}{tab.count !== undefined && <span className="ui-module-tab-count" aria-label={`, ${tab.count}`}>{tab.count}</span>}
            </button>
          </li>)}
        </ul>
      </nav>}
      {(filters || search) && <div className="ui-module-filters">
        {filters}
        {search && <label className="ui-module-search">
          <Search aria-hidden="true" />
          <span className="ui-visually-hidden">{search.label}</span>
          <input ref={searchRef} type="search" value={search.value} placeholder={search.placeholder} maxLength={200} aria-keyshortcuts="/" onChange={(event) => search.onChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && search.value) { event.preventDefault(); search.onChange(""); } }} />
          <kbd aria-hidden="true">/</kbd>
        </label>}
      </div>}
    </div>
    <div className={`ui-module-layout${detail ? " has-detail" : ""}`}>
      <section className="ui-module-content" aria-labelledby={headingId}>{children}</section>
      {detail && <aside className="ui-module-detail" aria-label="Details">{detail}</aside>}
    </div>
  </main>;
}
