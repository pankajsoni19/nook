import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Eye, ListFilter, LoaderCircle, TriangleAlert } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { PARAM_LIMITS } from "../../shared/reportParams";
import type { FilterColumn, FilterColumnsView, FilterPreview } from "../../shared/reportsEdit";
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

  useEffect(() => {
    if (!picked) return undefined;
    let alive = true;
    setPreview("loading");
    previewFilter(reportId, picked.table, picked.column).then(
      ({ preview: next }) => { if (alive) { setPreview(next); setLabel(next.suggested.label); } },
      (reason) => { if (alive) setPreview({ error: messageOf(reason, "Could not read the column's values") }); }
    );
    return () => { alive = false; };
  }, [reportId, picked]);

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
      await requestFilter(reportId, { table: picked.table, column: picked.column, label: label.trim() || ready.suggested.label });
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
              return <button key={columnKey(column)} type="button" role="radio" aria-checked={selected} aria-label={`${column.table}.${column.column}, ${column.type}`} className={`report-add-filter-column${selected ? " selected" : ""}`} onClick={() => setPicked(column)}>
                <span className="report-add-filter-name"><code>{column.column}</code>{column.sensitive && <span className="reports-status">Looks personal</span>}</span>
                <span className="report-add-filter-meta">{column.table} · {column.type} · {readByText(column.readBy.length, view.queries)}</span>
              </button>;
            })}
            {!shown.length && <p className="report-add-filter-empty">{view.columns.length ? "No column matches." : "The report's tables have no text or whole-number columns to filter by."}</p>}
          </div>
          {hidden > 0 && <label className="report-add-filter-toggle"><input type="checkbox" checked={showSensitive} onChange={(event) => setShowSensitive(event.target.checked)} />
            Show {hidden} {hidden === 1 ? "column that looks" : "columns that look"} personal (email, phone, token, secret)</label>}
        </>}
        {picked && <section className="report-add-filter-preview" aria-label="The filter" aria-busy={preview === "loading" || undefined}>
          {preview === "loading" && <p className="reports-loading" role="status"><LoaderCircle className="spin" aria-hidden="true" />Reading the values of {picked.column}…</p>}
          {preview && preview !== "loading" && "error" in preview && <p className="form-error" role="alert"><TriangleAlert aria-hidden="true" />{preview.error}</p>}
          {ready && <>
            <label htmlFor={labelId}>Label</label>
            <input id={labelId} value={label} maxLength={PARAM_LIMITS.label} autoComplete="off" onChange={(event) => setLabel(event.target.value)} />
            <p className="report-add-filter-values-head">{ready.truncated ? `${ready.optionCount}+ values` : `${ready.optionCount} ${ready.optionCount === 1 ? "value" : "values"}`}, the most common first</p>
            <ul className="report-add-filter-values" aria-label="Sample values">{ready.sample.map((value) => <li key={value}>{value || "(blank)"}</li>)}{ready.optionCount > ready.sample.length && <li className="report-add-filter-more">and {ready.truncated ? "more" : ready.optionCount - ready.sample.length} more</li>}</ul>
            <p className="report-add-filter-exposure" role="note"><Eye aria-hidden="true" />Readers will see the values of <code>{picked.table}.{picked.column}</code>.</p>
          </>}
        </section>}
        <p className="file-dialog-hint">Nook's edit agent adds it to the queries that read the table, as a filter that starts at All. Nook checks that every block shows the same as now with All before the change waits for you in Changes.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !ready || view?.slotsLeft === 0}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <ListFilter aria-hidden="true" />}{busy ? "Asking…" : "Ask for the filter"}</button>
      </footer>
    </form>
  </ModalDialog>;
}

