import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Eye, ListFilter, LoaderCircle, TriangleAlert } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { DATE_PRESET_LABELS, DATE_PRESETS, PARAM_LIMITS, type DatePreset } from "../../shared/reportParams";
import { Select } from "../ui/Select";
import type { FilterColumn, FilterColumnsView, FilterKind, FilterPreview } from "../../shared/reportsEdit";
import { filterColumns, previewFilter, requestFilter } from "./reportEditApi";
import { messageOf } from "./reportsApi";
import "./reportEdit.css";

/**
 * Add filter (lane FILTERS, D534; docs/plan/REPORT_FILTERS.md F3): the owner picks a column of a table
 * the report's queries read, sees the values readers will pick from (and that they will see them), names
 * the filter, and asks for it. Nook's edit agent puts it into the queries that read the table and Nook
 * checks the default results stay identical before the proposal waits in Changes. A sheet (a bottom
 * sheet on a phone) with its own history layer (`reports.add-filter`): Back closes it, Forward reopens it.
 */

/** D569, D570: the filter types a column offers. */
const KIND_LABELS: Record<FilterKind, string> = { multi_select: "Pick from a list", text: "Text contains", date_range: "Date range" };
const columnKey = (column: Pick<FilterColumn, "table" | "column">) => `${column.table}\u0000${column.column}`;
/** "read by 3 of 5 queries" */
export const readByText = (readBy: number, total: number) => total <= 1 ? (readBy ? "read by the report's query" : "not read") : readBy === total ? `read by all ${total} queries` : `read by ${readBy} of ${total} queries`;

export function AddFilterSheet({ reportId, onClose, reopen, onRequested }: { reportId: string; onClose: () => void; reopen?: () => void; onRequested: () => void }) {
  const [view, setView] = useState<FilterColumnsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showSensitive, setShowSensitive] = useState(false);
  const [picked, setPicked] = useState<FilterColumn | null>(null);
  const [preview, setPreview] = useState<FilterPreview | { error: string } | "loading" | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  useHistoryDialogGuard(true, onClose, { blocked: busy, reopen, layerKey: "reports.add-filter" });

  useEffect(() => {
    let alive = true;
    filterColumns(reportId).then((next) => { if (alive) setView(next); }, (reason) => { if (alive) setLoadError(messageOf(reason, "Could not read the report's tables")); });
    return () => { alive = false; };
  }, [reportId]);

  // D562: "Narrow by" existing filters on the same table; toggling one reads the narrowed choices again (the sheet keeps its place).
  const [narrowBy, setNarrowBy] = useState<string[]>([]);
  const [narrowing, setNarrowing] = useState(false);
  // D568–D570: what the filter is (a list, text contains, a date range), whether readers may leave values out, a date range's default.
  const [kind, setKind] = useState<FilterKind>("multi_select");
  const [exclude, setExclude] = useState(false);
  const [preset, setPreset] = useState<string>("30d");
  const labelFor = useRef<string | null>(null);
  const narrowKey = narrowBy.join(",");
  useEffect(() => {
    if (!picked) return undefined;
    let alive = true;
    const key = columnKey(picked);
    setPreview((current) => current && current !== "loading" && "sample" in current && columnKey(current.column) === key && current.kind === kind ? current : "loading");
    setNarrowing(true);
    previewFilter(reportId, picked.table, picked.column, narrowKey ? narrowKey.split(",") : [], kind).then(
      ({ preview: next }) => {
        if (!alive) return;
        setPreview(next);
        setNarrowing(false);
        if (labelFor.current !== key) setLabel(next.suggested.label);
        labelFor.current = key;
      },
      (reason) => { if (alive) { setPreview({ error: messageOf(reason, "Could not read the column's values") }); setNarrowing(false); } }
    );
    return () => { alive = false; };
  }, [reportId, picked, narrowKey, kind]);

  const hidden = view?.columns.filter((column) => column.sensitive).length ?? 0;
  const shown = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (view?.columns ?? []).filter((column) => (showSensitive || !column.sensitive) && (!term || `${column.table}.${column.column} ${column.comment}`.toLowerCase().includes(term)));
  }, [query, showSensitive, view]);
  const ready = preview && preview !== "loading" && "sample" in preview ? preview : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!picked || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestFilter(reportId, { table: picked.table, column: picked.column, label: label.trim() || ready.suggested.label, ...(kind === "multi_select" && narrowBy.length ? { narrowBy } : {}), ...(kind !== "multi_select" ? { kind } : exclude ? { exclude: true } : {}), ...(kind === "date_range" ? { preset } : {}) });
      notify.success("Filter requested; Nook proposes it in Changes");
      onRequested();
    } catch (reason) {
      setError(messageOf(reason, "Could not ask for the filter"));
      setBusy(false);
    }
  }

  return <ModalDialog title="Add filter" eyebrow="Report" onClose={onClose} busy={busy} variant="sheet" className="reports-dialog report-add-filter">
    <form className="file-dialog-form report-add-filter-form" onSubmit={submit} noValidate>
      <div className="report-add-filter-body">
        {loadError && <p className="form-error" role="alert">{loadError}</p>}
        {!view && !loadError && <p className="reports-loading" role="status">Reading the report's tables…</p>}
        {view && view.slotsLeft === 0 && <p className="form-error" role="alert">This report has {PARAM_LIMITS.parameters} filters, the most it can have.</p>}
        {view && <>
          <input className="report-add-filter-search" type="search" placeholder="Search columns" aria-label="Search columns" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} />
          <div className="report-add-filter-columns" role="radiogroup" aria-label="Columns">
            {shown.map((column) => {
              const selected = picked !== null && columnKey(picked) === columnKey(column);
              return <button key={columnKey(column)} type="button" role="radio" aria-checked={selected} aria-label={`${column.table}.${column.column}, ${column.type}`} className={`report-add-filter-column${selected ? " selected" : ""}`} onClick={() => { if (!selected) { setPicked(column); setNarrowBy([]); setKind(column.kinds?.[0] ?? "multi_select"); } }}>
                <span className="report-add-filter-name"><code>{column.column}</code>{column.sensitive && <span className="reports-status">Looks personal</span>}</span>
                <span className="report-add-filter-meta">{column.table} · {column.type} · {readByText(column.readBy.length, view.queries)}</span>
              </button>;
            })}
            {!shown.length && <p className="report-add-filter-empty">{view.columns.length ? "No column matches." : "The report's tables have no text, whole-number, or date columns to filter by."}</p>}
          </div>
          {hidden > 0 && <label className="report-add-filter-toggle"><input type="checkbox" checked={showSensitive} onChange={(event) => setShowSensitive(event.target.checked)} />
            Show {hidden} {hidden === 1 ? "column that looks" : "columns that look"} personal (email, phone, token, secret)</label>}
        </>}
        {picked && <section className="report-add-filter-preview" aria-label="The filter" aria-busy={preview === "loading" || undefined}>
          {preview === "loading" && <p className="reports-loading" role="status"><LoaderCircle className="spin" aria-hidden="true" />Reading the values of {picked.column}…</p>}
          {preview && preview !== "loading" && "error" in preview && <p className="form-error" role="alert"><TriangleAlert aria-hidden="true" />{preview.error}</p>}
          {(picked.kinds?.length ?? 0) > 1 && <div className="report-add-filter-kinds" role="radiogroup" aria-label="Filter type">
            {picked.kinds.map((item) => <button key={item} type="button" role="radio" aria-checked={kind === item} className={`report-add-filter-kind${kind === item ? " selected" : ""}`} disabled={narrowing} onClick={() => setKind(item)}>{KIND_LABELS[item]}</button>)}
          </div>}
          {ready && <>
            <label htmlFor={labelId}>Label</label>
            <input id={labelId} value={label} maxLength={PARAM_LIMITS.label} autoComplete="off" onChange={(event) => setLabel(event.target.value)} />
            {ready.kind === "date_range" ? <>
              <p className="report-add-filter-values-head">{ready.range ? `Data from ${ready.range.from} to ${ready.range.to}` : "No days in this column yet"}</p>
              <span className="report-add-filter-values-head">Starts at</span>
              <Select<string> variant="field" label="Starts at" value={preset} searchable={false} onChange={setPreset}
                options={DATE_PRESETS.filter((item) => item !== "custom").map((item) => ({ value: item, label: DATE_PRESET_LABELS[item] }))} />
              <p className="report-add-filter-review" role="note"><TriangleAlert aria-hidden="true" /><span>A date range changes what every block it reaches shows by default ({DATE_PRESET_LABELS[preset as DatePreset].toLowerCase()}), so Nook cannot check the results stay the same: review the proposal by hand before you apply it.</span></p>
            </> : <>
              <p className="report-add-filter-values-head">{ready.truncated ? `${ready.optionCount}+ values` : `${ready.optionCount} ${ready.optionCount === 1 ? "value" : "values"}`}, the most common first</p>
              <ul className="report-add-filter-values" aria-label="Sample values">{ready.sample.map((value) => <li key={value}>{value || "(blank)"}</li>)}{ready.optionCount > ready.sample.length && <li className="report-add-filter-more">and {ready.truncated ? "more" : ready.optionCount - ready.sample.length} more</li>}</ul>
              {ready.kind === "text"
                ? <p className="report-add-filter-exposure" role="note"><Eye aria-hidden="true" /><span>Readers type text; rows whose <code>{picked.column}</code> contains it (any case) stay. They see no list of values.</span></p>
                : <p className="report-add-filter-exposure" role="note"><Eye aria-hidden="true" /><span>Readers will see the values of <code>{picked.table}.{picked.column}</code>.</span></p>}
            </>}
            {ready.kind === "multi_select" && <label className="report-add-filter-toggle report-add-filter-exclude"><input type="checkbox" checked={exclude} onChange={(event) => setExclude(event.target.checked)} />
              <span>Readers may also leave values out<small>“All but these”, besides “only these”</small></span></label>}
            {ready.kind === "multi_select" && (ready.narrowBy ?? []).length > 0 && <div className="report-add-filter-narrow" role="group" aria-label="Linked choices" aria-busy={narrowing || undefined}>
              <p className="report-add-filter-values-head">Linked choices</p>
              {ready.narrowBy.map((choice) => <label key={choice.paramId} className="report-add-filter-toggle">
                <input type="checkbox" checked={narrowBy.includes(choice.paramId)} disabled={narrowing}
                  onChange={(event) => { const on = event.target.checked; setNarrowBy((current) => on ? [...current, choice.paramId] : current.filter((item) => item !== choice.paramId)); }} />
                <span>Narrow by {choice.label}<small>Only the {picked.column} values of the picked {choice.label.toLowerCase()} are offered</small></span>
              </label>)}
            </div>}
          </>}
        </section>}
        {kind !== "date_range" && <p className="file-dialog-hint">Nook's edit agent adds it to the queries that read the table, as a filter that starts at {kind === "text" ? "empty (every row)" : "All"}. Nook checks that every block shows the same as now before the change waits for you in Changes.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !ready || narrowing || view?.slotsLeft === 0}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <ListFilter aria-hidden="true" />}{busy ? "Asking…" : "Ask for the filter"}</button>
      </footer>
    </form>
  </ModalDialog>;
}

