import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import type { FieldDefinition, FilterSpec, SortSpec } from "./collectionsApi";
import { PersonPicker } from "../ui/people/People";
import { resolvePeople } from "../ui/workspaceApi";
import type { PersonSummary } from "../../shared/people";
import { defaultFilterValue, filterReady, OPERATOR_LABELS, OPERATORS, SORTABLE_TYPES, valuelessOperator } from "./values";

export type SortFilter = { sort: SortSpec[]; filters: FilterSpec[]; hiddenFieldIds: string[] };

type SortFilterSheetProps = {
  fields: FieldDefinition[];
  value: SortFilter;
  onApply: (value: SortFilter) => void;
  onClose: () => void;
  /** Owners can save the result as a view (stage B). */
  onSaveAsView?: (value: SortFilter) => void;
};

const MAX_SORT = 3;
const MAX_FILTERS = 10;

// Sort (up to 3 fields) and filters (up to 10, all must match). A full-screen sheet on phones; a
// dialog on desktop. Pushes no history entry; Back closes it (dialogLayers).
export function SortFilterSheet({ fields, value, onApply, onClose, onSaveAsView }: SortFilterSheetProps) {
  const [sort, setSort] = useState<SortSpec[]>(value.sort);
  const [filters, setFilters] = useState<FilterSpec[]>(value.filters);
  const [hidden, setHidden] = useState<string[]>(value.hiddenFieldIds);
  const byId = new Map(fields.map((field) => [field.id, field]));
  const sortable = fields.filter((field) => SORTABLE_TYPES.includes(field.type));
  const ready = filters.every((filter) => filterReady(byId.get(filter.fieldId), filter));
  const result = (): SortFilter => ({ sort, filters, hiddenFieldIds: hidden });

  const setFilter = (index: number, change: Partial<FilterSpec>) => setFilters((items) => items.map((item, at) => {
    if (at !== index) return item;
    const next = { ...item, ...change };
    const field = byId.get(next.fieldId)!;
    if (change.fieldId !== undefined) next.op = OPERATORS[field.type][0]!;
    if (change.fieldId !== undefined || change.op !== undefined) next.value = defaultFilterValue(field, next.op);
    if (next.value === undefined) delete next.value;
    return next;
  }));

  return <ModalDialog title="Sort and filter" eyebrow="Rows" onClose={onClose} variant="sheet">
    <div className="sort-filter">
      <h3>Sort</h3>
      {sort.map((item, index) => <div key={index} className="sort-filter-row">
        <Select label={`Sort ${index + 1} field`} value={item.fieldId} onChange={(fieldId) => setSort((items) => items.map((entry, at) => at === index ? { ...entry, fieldId } : entry))}
          options={sortable.map((field) => ({ value: field.id, label: field.name, disabled: field.id !== item.fieldId && sort.some((entry) => entry.fieldId === field.id) }))} />
        <Select<"asc" | "desc"> label={`Sort ${index + 1} direction`} value={item.direction} onChange={(direction) => setSort((items) => items.map((entry, at) => at === index ? { ...entry, direction } : entry))}
          options={[{ value: "asc", label: "Ascending" }, { value: "desc", label: "Descending" }]} />
        <button type="button" className="icon-button" onClick={() => setSort((items) => items.filter((_, at) => at !== index))} aria-label={`Remove sort ${index + 1}`}><X /></button>
      </div>)}
      {sort.length < MAX_SORT && sortable.some((field) => !sort.some((entry) => entry.fieldId === field.id)) && <button type="button" className="field-editor-add-option" onClick={() => {
        const next = sortable.find((field) => !sort.some((entry) => entry.fieldId === field.id));
        if (next) setSort((items) => [...items, { fieldId: next.id, direction: "asc" }]);
      }}><Plus />Add sort</button>}

      <h3>Filters <small>All must match</small></h3>
      {filters.map((filter, index) => {
        const field = byId.get(filter.fieldId);
        if (!field) return null;
        return <div key={index} className="sort-filter-row sort-filter-filter">
          <Select label={`Filter ${index + 1} field`} value={filter.fieldId} onChange={(fieldId) => setFilter(index, { fieldId })}
            options={fields.map((option) => ({ value: option.id, label: option.name }))} />
          <Select label={`Filter ${index + 1} condition`} value={filter.op} onChange={(op) => setFilter(index, { op })}
            options={OPERATORS[field.type].map((op) => ({ value: op, label: OPERATOR_LABELS[op] }))} />
          {!valuelessOperator(filter.op) && <FilterValue field={field} filter={filter} onChange={(next) => setFilter(index, { value: next })} label={`Filter ${index + 1} value`} />}
          <button type="button" className="icon-button" onClick={() => setFilters((items) => items.filter((_, at) => at !== index))} aria-label={`Remove filter ${index + 1}`}><X /></button>
        </div>;
      })}
      {filters.length < MAX_FILTERS && <button type="button" className="field-editor-add-option" onClick={() => {
        const field = fields[0]!;
        setFilters((items) => [...items, { fieldId: field.id, op: OPERATORS[field.type][0]!, value: defaultFilterValue(field, OPERATORS[field.type][0]!) }]);
      }}><Plus />Add filter</button>}

      {fields.length > 1 && <>
        <h3>Fields shown <small>The first field is always shown</small></h3>
        <div className="sort-filter-fields" role="group" aria-label="Fields shown">
          {fields.slice(1).map((field) => <label key={field.id}>
            <input type="checkbox" checked={!hidden.includes(field.id)} onChange={() => setHidden((items) => items.includes(field.id) ? items.filter((id) => id !== field.id) : [...items, field.id])} />
            {field.name}
          </label>)}
        </div>
      </>}
    </div>
    {!ready && <p className="file-dialog-error sort-filter-error">Finish or remove the incomplete filter.</p>}
    <footer className="file-dialog-actions">
      <button className="secondary-button" onClick={() => { setSort([]); setFilters([]); setHidden([]); }}>Clear</button>
      {onSaveAsView && <button className="secondary-button" onClick={() => onSaveAsView(result())} disabled={!ready}>Save as view</button>}
      <button className="primary-button" onClick={() => onApply(result())} disabled={!ready}>Apply</button>
    </footer>
  </ModalDialog>;
}

// Keeps the typed text ("1.", "-") while only complete numbers reach the filter.
function NumberValue({ value, onChange, label }: { value: FilterSpec["value"]; onChange: (value: FilterSpec["value"]) => void; label: string }) {
  const [text, setText] = useState(typeof value === "number" ? String(value) : "");
  return <input aria-label={label} inputMode="decimal" value={text} onChange={(event) => {
    setText(event.target.value);
    const number = Number(event.target.value);
    onChange(event.target.value.trim() === "" || !Number.isFinite(number) ? undefined : number);
  }} />;
}

/** One team member or contact to match (D1202); a saved value is shown by name once resolved. */
function RelationValue({ field, value, onChange, label }: { field: FieldDefinition; value: FilterSpec["value"]; onChange: (value: FilterSpec["value"]) => void; label: string }) {
  const id = typeof value === "string" && value ? value : null;
  const [chosen, setChosen] = useState<PersonSummary[]>([]);
  const known = chosen[0] && "id" in chosen[0] ? chosen[0].id : null;
  useEffect(() => {
    if (!id || id === known) return;
    let active = true;
    resolvePeople(field.type === "person" ? { users: [id] } : { contacts: [id] }).then((result) => { if (active) setChosen(result.people.slice(0, 1)); }).catch(() => undefined);
    return () => { active = false; };
  }, [field.type, id, known]);
  return <PersonPicker label={label} value={id ? chosen : []} allow={[field.type === "contact" ? "contact" : "user"]} multiple={false}
    onChange={(people) => { setChosen(people); const next = people[0]; onChange(next && "id" in next ? next.id : ""); }} />;
}

function FilterValue({ field, filter, onChange, label }: { field: FieldDefinition; filter: FilterSpec; onChange: (value: FilterSpec["value"]) => void; label: string }) {
  if (field.type === "person" || field.type === "contact") return <RelationValue field={field} value={filter.value} onChange={onChange} label={label} />;
  if (field.type === "checkbox") {
    return <Select label={label} value={filter.value === false ? "false" : "true"} onChange={(next) => onChange(next === "true")}
      options={[{ value: "true", label: "Checked" }, { value: "false", label: "Not checked" }]} />;
  }
  if (field.type === "select" && filter.op !== "in") {
    return <Select label={label} value={typeof filter.value === "string" && filter.value ? filter.value : null} placeholder="Choose…" onChange={onChange}
      options={(field.options ?? []).map((option) => ({ value: option.id, label: option.label, swatch: option.color }))} />;
  }
  if (field.type === "select" || field.type === "multi_select") {
    const chosen = Array.isArray(filter.value) ? filter.value : [];
    return <span className="sort-filter-options" role="group" aria-label={label}>
      {(field.options ?? []).map((option) => <label key={option.id} className={`option-chip color-${option.color}${chosen.includes(option.id) ? " chosen" : ""}`}>
        <input type="checkbox" checked={chosen.includes(option.id)} onChange={() => onChange(chosen.includes(option.id) ? chosen.filter((id) => id !== option.id) : [...chosen, option.id].slice(0, 20))} />
        {option.label}
      </label>)}
    </span>;
  }
  if (field.type === "number") return <NumberValue value={filter.value} onChange={onChange} label={label} />;
  return <input aria-label={label} type={field.type === "date" ? "date" : "text"} maxLength={200} value={typeof filter.value === "string" ? filter.value : ""} onChange={(event) => onChange(event.target.value)} />;
}
