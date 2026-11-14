import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Building2, Contact, Filter, ListPlus, Loader2, Trash2, UserRound, X } from "lucide-react";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Select";
import { useModuleShortcuts } from "../ui/moduleKeys";
import { notify } from "../ui/notify";
import { useConfirm } from "../ui/useConfirm";
import type { CrmBook, CrmCompany, CrmContact, CrmEntity, CrmFilter, CrmList, CrmSort, CrmView } from "../../shared/crm";
import { binCompany, binContact, changeListMembers, createView, deleteView, errorMessage, listCompanies, listContacts, listLists, listViews, updateContact } from "./crmApi";
import { FilterSheet, filterLabel } from "./Sheets";
import { fieldText, relative } from "./format";
import { useRelationNames } from "./relationNames";
import { Avatar } from "../ui/Avatar";
import { usePhone } from "./usePhone";

/**
 * The contacts and companies tables (§D.5 "Tables"): sortable columns (built-in and custom fields),
 * filter chips and a filter sheet over any field, saved views, lists, keyset "Load more", bulk
 * select (add to list, take ownership, move to the Bin), j/k and Enter. At ≤ 760 px rows become a
 * list (name, a subtitle, one metric) and nothing is hidden.
 */

type Row = CrmContact | CrmCompany;
const isContact = (row: Row): row is CrmContact => "displayName" in row;
const nameOf = (row: Row) => isContact(row) ? row.displayName : row.name;

export function RecordsView({ entity, book, books, q, userId, canWrite, listRef, onOpen, emptyAction, refreshKey }: {
  entity: "contact" | "company"; book: CrmBook | null; books: readonly CrmBook[]; q: string; userId: string; canWrite: boolean; listRef?: string | null;
  onOpen: (href: string) => void; emptyAction?: { label: string; onClick: () => void }; refreshKey: number;
}) {
  const phone = usePhone();
  const [filters, setFilters] = useState<CrmFilter[]>([]);
  const [sort, setSort] = useState<CrmSort | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(-1);
  const [filtering, setFiltering] = useState(false);
  const [lists, setLists] = useState<CrmList[]>([]);
  const [views, setViews] = useState<CrmView[]>([]);
  const [viewId, setViewId] = useState<string | null>(null);
  const request = useRef(0);
  const { ask, confirmElement } = useConfirm();
  const [naming, setNaming] = useState<string | null>(null);
  const custom = book?.fields[entity] ?? [];
  const relationNames = useRelationNames(custom, rows ?? []);

  const load = useCallback(async (next: string | null = null) => {
    const id = ++request.current;
    const params = { book: book?.id ?? null, q, filters, sort, cursor: next, list: listRef ?? null, limit: 50 };
    try {
      const page = entity === "contact" ? await listContacts(params) : await listCompanies(params);
      if (id !== request.current) return;
      setRows((current) => next && current ? [...current, ...page.items] : page.items);
      setCursor(page.nextCursor);
      setError(null);
    } catch (reason) { if (id === request.current) setError(errorMessage(reason, "Could not load")); }
  }, [book?.id, entity, filters, listRef, q, sort]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(null); }, q ? 200 : 0); return () => window.clearTimeout(timer); }, [load, q, refreshKey]);
  useEffect(() => { setSelected(new Set()); setActive(-1); }, [book?.id, entity, filters, q, sort, listRef]);
  useEffect(() => {
    if (!book) { setLists([]); setViews([]); return; }
    listLists(book.id, entity).then(({ lists: found }) => setLists(found), () => setLists([]));
    listViews(book.id, entity).then(({ views: found }) => setViews(found), () => setViews([]));
  }, [book, entity, refreshKey]);

  useModuleShortcuts({
    j: () => { if (rows?.length) setActive((index) => Math.min(rows.length - 1, index + 1)); },
    k: () => { if (rows?.length) setActive((index) => Math.max(0, index - 1)); },
    Enter: () => { const row = rows?.[active]; if (!row) return false; onOpen(row.href); }
  });
  useEffect(() => { if (active >= 0) document.querySelector<HTMLElement>(`[data-crm-row="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);

  const applyView = (id: string) => {
    if (id === "") { setViewId(null); setFilters([]); setSort(null); return; }
    const view = views.find((item) => item.id === id);
    if (!view) return;
    setViewId(view.id); setFilters(view.config.filters ?? []); setSort(view.config.sort ?? null);
  };
  const saveView = async () => {
    if (!book) return;
    const name = naming;
    setNaming(null);
    if (!name?.trim()) return;
    try { const { view } = await createView({ bookId: book.id, entity, name: name.trim(), config: { filters, ...(sort ? { sort } : {}) } }); setViews((current) => [...current, view]); setViewId(view.id); notify.success(`Saved “${view.name}”`); }
    catch (reason) { notify.error(errorMessage(reason, "Could not save the view")); }
  };
  const removeView = async () => {
    if (!viewId) return;
    try { await deleteView(viewId); setViews((current) => current.filter((item) => item.id !== viewId)); applyView(""); } catch (reason) { notify.error(errorMessage(reason, "Could not delete the view")); }
  };

  const toggleSort = (field: string) => setSort((current) => current?.field === field ? (current.dir === "asc" ? { field, dir: "desc" } : null) : { field, dir: "asc" });
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const ids = [...selected];

  const addToList = async (listId: string) => {
    try { await changeListMembers(listId, { add: ids }); notify.success(`Added ${ids.length} to ${lists.find((list) => list.id === listId)?.name ?? "the list"}`); setSelected(new Set()); }
    catch (reason) { notify.error(errorMessage(reason, "Could not add to the list")); }
  };
  const removeFromList = async () => {
    if (!listRef) return;
    try { await changeListMembers(listRef, { remove: ids }); setSelected(new Set()); void load(null); } catch (reason) { notify.error(errorMessage(reason, "Could not remove")); }
  };
  const takeOwnership = async () => {
    try { await Promise.all(ids.map((id) => updateContact(id, { ownerId: userId }))); notify.success(`You own ${ids.length} ${ids.length === 1 ? "contact" : "contacts"}`); setSelected(new Set()); void load(null); }
    catch (reason) { notify.error(errorMessage(reason, "Could not change the owner")); }
  };
  const binSelected = async () => {
    if (!(await ask({ title: `Move ${ids.length} ${entity === "contact" ? (ids.length === 1 ? "contact" : "contacts") : (ids.length === 1 ? "company" : "companies")} to the Bin?`, message: "You can restore them from the Bin for 30 days.", confirmLabel: "Move to Bin", danger: true }))) return;
    try { await Promise.all(ids.map((id) => entity === "contact" ? binContact(id) : binCompany(id))); notify.success(`Moved ${ids.length} to the Bin`); setSelected(new Set()); void load(null); }
    catch (reason) { notify.error(errorMessage(reason, "Could not move to the Bin")); }
  };

  const columns = useMemo(() => entity === "contact"
    ? [{ id: "company", label: "Company" }, { id: "email", label: "Email", sort: false }, { id: "owner", label: "Owner" }, { id: "lifecycle", label: "Lifecycle" }, { id: "last_interaction", label: "Last interaction" }]
    : [{ id: "domain", label: "Domain" }, { id: "contacts", label: "Contacts", sort: false }, { id: "deals", label: "Open deals", sort: false }, { id: "owner", label: "Owner" }, { id: "last_interaction", label: "Last interaction" }], [entity]);
  const cell = (row: Row, column: string): string => {
    if (isContact(row)) {
      switch (column) {
        case "company": return row.companyName ?? "";
        case "email": return row.email ?? "";
        case "owner": return row.owner?.name ?? "";
        case "lifecycle": return row.lifecycle ?? "";
        case "last_interaction": return row.lastInteractionAt ? relative(row.lastInteractionAt) : "";
      }
    } else {
      switch (column) {
        case "domain": return row.domain ?? "";
        case "contacts": return String(row.contactCount);
        case "deals": return String(row.openDeals);
        case "owner": return row.owner?.name ?? "";
        case "last_interaction": return row.lastInteractionAt ? relative(row.lastInteractionAt) : "";
      }
    }
    const field = custom.find((item) => item.id === column);
    return field ? fieldText(field, row.custom[field.id], relationNames) : "";
  };
  const Icon = entity === "contact" ? Contact : Building2;
  const plural = entity === "contact" ? "contacts" : "companies";
  const lifecycles = book?.settings.lifecycles ?? [];
  const lifecycleFilter = filters.find((filter) => filter.field === "lifecycle" && filter.op === "eq");
  const mine = filters.some((filter) => filter.field === "owner" && filter.value === "me");

  return <div className="crm-records">
    <div className="crm-toolbar" role="toolbar" aria-label={`Filter ${plural}`}>
      {book && <Select variant="chip" label="Saved view" value={viewId ?? ""} options={[{ value: "", label: `All ${plural}` }, ...views.map((view) => ({ value: view.id, label: `${view.name}${view.shared ? " · shared" : ""}` }))]} onChange={applyView} />}
      <button type="button" className="ui-filter-chip" aria-pressed={mine} onClick={() => setFilters((current) => mine ? current.filter((filter) => !(filter.field === "owner" && filter.value === "me")) : [...current, { field: "owner", op: "eq", value: "me" }])}><UserRound aria-hidden="true" />Mine</button>
      {entity === "contact" && lifecycles.length > 0 && <Select variant="chip" label="Lifecycle" value={String(lifecycleFilter?.value ?? "")} options={[{ value: "", label: "Any lifecycle" }, ...lifecycles.map((item) => ({ value: item, label: item }))]}
        onChange={(value) => setFilters((current) => [...current.filter((filter) => !(filter.field === "lifecycle" && filter.op === "eq")), ...(value ? [{ field: "lifecycle", op: "eq" as const, value }] : [])])} />}
      {filters.filter((filter) => !(filter.field === "owner" && filter.value === "me") && !(filter.field === "lifecycle" && filter.op === "eq")).map((filter, index) =>
        <span key={`${filter.field}-${index}`} className="ui-filter-chip crm-filter-applied">{filterLabel(filter, book, entity)}<button type="button" aria-label={`Remove filter ${filterLabel(filter, book, entity)}`} onClick={() => setFilters((current) => current.filter((item) => item !== filter))}><X aria-hidden="true" /></button></span>)}
      <button type="button" className="ui-filter-chip" onClick={() => setFiltering(true)}><Filter aria-hidden="true" />Filter</button>
      {book && filters.length > 0 && !viewId && naming === null && <button type="button" className="ui-text-button" onClick={() => setNaming(filters.map((filter) => filterLabel(filter, book, entity)).join(", ").slice(0, 60))}>Save view</button>}
      {naming !== null && <form className="crm-inline-name" noValidate onSubmit={(event) => { event.preventDefault(); void saveView(); }}>
        <label className="ui-visually-hidden" htmlFor="crm-view-name">View name</label>
        <input id="crm-view-name" autoFocus maxLength={60} value={naming} onChange={(event) => setNaming(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setNaming(null); } }} />
        <button type="submit" className="ui-small-button secondary-button" disabled={!naming.trim()}>Save</button>
        <button type="button" className="ui-text-button" onClick={() => setNaming(null)}>Cancel</button>
      </form>}
      {viewId && views.find((view) => view.id === viewId)?.mine && <button type="button" className="ui-text-button" onClick={() => void removeView()}>Delete view</button>}
    </div>

    {selected.size > 0 && <div className="crm-bulk" role="region" aria-label="Selected">
      <strong>{selected.size} selected</strong>
      {lists.length > 0 && !listRef && <Select variant="chip" label="Add to list" value={null} placeholder="Add to list" options={lists.map((list) => ({ value: list.id, label: list.name }))} onChange={(listId) => void addToList(listId)} />}
      {listRef && canWrite && <button type="button" className="ui-small-button secondary-button" onClick={() => void removeFromList()}><ListPlus aria-hidden="true" />Remove from list</button>}
      {entity === "contact" && canWrite && <button type="button" className="ui-small-button secondary-button" onClick={() => void takeOwnership()}><UserRound aria-hidden="true" />Make me owner</button>}
      {canWrite && <button type="button" className="ui-small-button secondary-button crm-danger" onClick={() => void binSelected()}><Trash2 aria-hidden="true" />Move to Bin</button>}
      <button type="button" className="ui-text-button" onClick={() => setSelected(new Set())}>Clear</button>
    </div>}

    {error && <p className="ui-field-error" role="alert">{error}</p>}
    {rows === null ? <p className="ui-panel-loading" role="status"><Loader2 className="spin" aria-hidden="true" /> Loading {plural}…</p>
      : rows.length === 0 ? <EmptyState icon={Icon} title={q || filters.length ? `No ${plural} match` : listRef ? "This list is empty" : `No ${plural} yet`} action={!q && !filters.length && !listRef ? emptyAction : undefined}>
        {q || filters.length ? "Try other words or remove a filter." : listRef ? `Select ${plural} in the table and add them to this list.` : entity === "contact" ? "Add people you work with, or import a CSV." : "Companies appear as you add contacts with work emails, or add one."}
      </EmptyState>
      : phone ? <ul className="crm-list" aria-label={plural}>
        {rows.map((row, index) => <li key={row.id} data-crm-row={index} className={index === active ? "active" : undefined}>
          {canWrite && <input type="checkbox" className="crm-check" checked={selected.has(row.id)} onChange={() => toggle(row.id)} aria-label={`Select ${nameOf(row)}`} />}
          <button type="button" className="crm-list-row" onClick={() => onOpen(row.href)}>
            {entity === "company" ? <span className="crm-avatar square" aria-hidden="true"><Building2 /></span> : <Avatar className="crm-avatar" name={nameOf(row)} url={null} />}
            <span className="crm-list-text"><strong>{nameOf(row)}</strong><small>{isContact(row) ? [row.jobTitle, row.companyName].filter(Boolean).join(" · ") || row.email || "—" : row.domain ?? `${row.contactCount} contacts`}</small></span>
            <span className="crm-list-metric">{row.lastInteractionAt ? relative(row.lastInteractionAt) : isContact(row) ? row.lifecycle ?? "" : `${row.openDeals} open`}</span>
          </button>
        </li>)}
      </ul>
      : <div className="crm-table-wrap"><table className="crm-table">
        <thead><tr>
          {canWrite && <th scope="col" className="crm-col-check"><input type="checkbox" aria-label={`Select all ${plural} shown`} checked={rows.length > 0 && rows.every((row) => selected.has(row.id))} onChange={(event) => setSelected(event.target.checked ? new Set(rows.map((row) => row.id)) : new Set())} /></th>}
          {[{ id: "name", label: "Name" }, ...columns, ...custom.map((field) => ({ id: field.id, label: field.name, sort: !["multi_select", "person", "contact"].includes(field.type) }))].map((column) =>
            <th key={column.id} scope="col" aria-sort={sort?.field === column.id ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
              {(column as { sort?: boolean }).sort === false ? column.label : <button type="button" className="crm-sort" onClick={() => toggleSort(column.id)}>{column.label}{sort?.field === column.id && (sort.dir === "asc" ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />)}</button>}
            </th>)}
        </tr></thead>
        <tbody>{rows.map((row, index) => <tr key={row.id} data-crm-row={index} className={`${selected.has(row.id) ? "selected" : ""}${index === active ? " active" : ""}`}>
          {canWrite && <td className="crm-col-check"><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} aria-label={`Select ${nameOf(row)}`} /></td>}
          <th scope="row"><a href={row.href} className="crm-name" onClick={(event) => { event.preventDefault(); onOpen(row.href); }}>
            {entity === "company" ? <span className="crm-avatar square" aria-hidden="true"><Building2 /></span> : <Avatar className="crm-avatar" name={nameOf(row)} url={null} />}<span>{nameOf(row)}{isContact(row) && row.jobTitle && <small>{row.jobTitle}</small>}</span>
          </a></th>
          {columns.map((column) => <td key={column.id} className={column.id === "contacts" || column.id === "deals" ? "number" : undefined}>{cell(row, column.id) || <span className="crm-empty-cell" aria-label="Empty">—</span>}</td>)}
          {custom.map((field) => <td key={field.id}>{cell(row, field.id) || <span className="crm-empty-cell" aria-label="Empty">—</span>}</td>)}
        </tr>)}</tbody>
      </table></div>}
    {cursor && <button type="button" className="secondary-button crm-more" disabled={loadingMore} onClick={() => { setLoadingMore(true); void load(cursor).finally(() => setLoadingMore(false)); }}>{loadingMore ? "Loading…" : "Load more"}</button>}
    {filtering && <FilterSheet entity={entity as CrmEntity} book={book} onClose={() => setFiltering(false)} onAdd={(filter) => { setFilters((current) => [...current, filter]); setViewId(null); setFiltering(false); }} />}
    {confirmElement}
  </div>;
}
