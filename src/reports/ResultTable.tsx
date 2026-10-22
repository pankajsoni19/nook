import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ResultColumn, ValueFormat } from "../../shared/reports";
import { cellLabel, formatValue } from "./chartOption";
import { CONTAINS_CHARS, containsRows, nextSort, sortRows, type TableSort } from "./tableView";

/** Rows a table shows before "Show all". */
export const TABLE_PAGE_ROWS = 100;
/** D563: from this many rows a table offers its contains box (it shows whenever it holds text). */
export const CONTAINS_FROM_ROWS = 8;

/** D563, D564: a report table's sort and contains box (personal, kept in the URL by the caller). */
export type TableViewState = {
  sort: TableSort | null;
  contains: string;
  onSort: (next: TableSort | null) => void;
  onContains: (text: string) => void;
  /** The query's rows were cut (the data source's row cap or the stored limit): sorting and matching see only these. */
  truncated: boolean;
};

type Props = {
  columns: readonly ResultColumn[];
  rows: readonly (readonly unknown[])[];
  /** Columns to show, in order (empty or missing: all). */
  show?: readonly string[];
  formats?: Partial<Record<string, ValueFormat>>;
  /** Columns to highlight (the inspect panel's Data tab: the block's mapped columns, by role). */
  highlight?: Record<string, string>;
  /** Raw cells (the Data tab) instead of formatted ones. */
  raw?: boolean;
  label: string;
  /** D536: a row click sets a filter to this column's value (focusable rows, Enter; `touch` for a tap). */
  pick?: { column: string; picked: readonly string[]; onPick: (value: string, touch: boolean) => void };
  /** D563: sortable headers and a contains box (a report's table block). */
  view?: TableViewState;
};

const numeric = (type: string) => /^(Nullable\()?(U?Int|Float|Decimal)/.test(type);

/** A result as a table that scrolls sideways on a phone, with the column types under the names. */
export function ResultTable({ columns, rows, show, formats, highlight, raw = false, label, pick, view }: Props) {
  const [all, setAll] = useState(false);
  const pointer = useRef<string>("mouse");
  const pickAt = pick ? columns.findIndex((column) => column.name === pick.column) : -1;
  const picked = show?.length ? show.map((name) => columns.findIndex((column) => column.name === name)).filter((index) => index >= 0) : columns.map((_, index) => index);
  // D563: the contains box narrows the loaded rows, then the sort orders them; "Show all" pages what is left.
  const matched = view ? sortRows(containsRows(rows, picked, columns, view.contains, formats), columns, view.sort) : rows;
  const visible = all ? matched : matched.slice(0, TABLE_PAGE_ROWS);
  const term = view?.contains.trim() ?? "";
  const tools = Boolean(view) && (rows.length > CONTAINS_FROM_ROWS || term !== "");
  // D564: sorting and matching see only the loaded rows; say so when the query's rows were cut.
  const within = view?.truncated && (term || view.sort) ? `within the first ${rows.length.toLocaleString()} rows` : null;
  const count = term ? `${matched.length.toLocaleString()} of ${rows.length.toLocaleString()} rows${within ? `, ${within}` : ""}` : within ? `Sorted ${within}` : null;
  return <div className="report-table-block">
    {view && tools && <div className="report-table-tools">
      <ContainsBox label={label} value={view.contains} onChange={view.onContains} />
      {count && <span className="report-table-count" role="status">{count}</span>}
    </div>}
    {!tools && count && <p className="report-table-count" role="status">{count}</p>}
    <div className="report-table-scroll" tabIndex={0} role="region" aria-label={label}>
      <table className="report-table">
        <thead><tr>{picked.map((index) => {
          const column = columns[index]!;
          const role = highlight?.[column.name];
          const sorted = view?.sort?.column === column.name ? view.sort : null;
          const name = <span>{column.name}{role && <em className="report-role">{role}</em>}{sorted && (sorted.desc ? <ArrowDown className="report-sort-icon" aria-hidden="true" /> : <ArrowUp className="report-sort-icon" aria-hidden="true" />)}</span>;
          return <th key={`${column.name}-${index}`} scope="col" className={role ? "report-mapped" : undefined}
            aria-sort={view ? sorted ? (sorted.desc ? "descending" : "ascending") : "none" : undefined}>
            {view ? <button type="button" className={`report-th-sort${sorted ? " sorted" : ""}`} onClick={() => view.onSort(nextSort(view.sort, column.name))}
              title={!sorted ? `Sort by ${column.name}` : sorted.desc ? "Back to the query's order" : `Sort by ${column.name}, largest first`}>{name}</button> : name}
            <small>{column.type}</small>
          </th>;
        })}</tr></thead>
        <tbody>{visible.map((row, rowIndex) => {
          const value = pickAt >= 0 && row[pickAt] !== null && row[pickAt] !== undefined ? cellLabel(row[pickAt]) : null;
          const on = value !== null && Boolean(pick?.picked.includes(value));
          const act = value === null || !pick ? undefined : (touch: boolean) => pick.onPick(value, touch);
          return <tr key={rowIndex} className={act ? `report-row-pickable${on ? " report-row-picked" : ""}` : undefined} tabIndex={act ? 0 : undefined} aria-current={act && on ? "true" : undefined} title={act ? (on ? `Clear ${value}` : `Filter by ${value}`) : undefined}
            onPointerDown={act ? (event) => { pointer.current = event.pointerType; } : undefined}
            onClick={act ? () => act(pointer.current === "touch" || pointer.current === "pen" || (typeof window.matchMedia === "function" && window.matchMedia("(hover: none)").matches)) : undefined}
            onKeyDown={act ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); act(false); } } : undefined}>{picked.map((index) => {
          const column = columns[index]!;
          const cell = row[index];
          const classes = [cell === null ? "report-null" : "", numeric(column.type) ? "report-num" : "", highlight?.[column.name] ? "report-mapped" : ""].filter(Boolean).join(" ");
          return <td key={index} className={classes || undefined}>{raw ? (cell === null || cell === undefined ? "NULL" : typeof cell === "string" ? cell : JSON.stringify(cell)) : (cell === null || cell === undefined ? "NULL" : formatValue(cell, formats?.[column.name]))}</td>;
        })}</tr>;
        })}</tbody>
      </table>
      {view && term && !matched.length && <p className="report-table-none">No rows contain “{term}”.</p>}
    </div>
    {matched.length > TABLE_PAGE_ROWS && <button type="button" className="secondary-button report-show-all" onClick={() => setAll((current) => !current)}>
      {all ? `Show the first ${TABLE_PAGE_ROWS}` : `Show all ${matched.length.toLocaleString()} rows`}
    </button>}
  </div>;
}

/** The contains box: it types freely; the URL (replace) follows each change. Escape clears it. */
function ContainsBox({ label, value, onChange }: { label: string; value: string; onChange: (text: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <input type="search" className="report-table-contains" placeholder="Contains…" aria-label={`Show rows of ${label} that contain`} value={draft} maxLength={CONTAINS_CHARS}
    onChange={(event) => { setDraft(event.target.value); onChange(event.target.value); }}
    onKeyDown={(event) => { if (event.key === "Escape" && draft) { event.preventDefault(); event.stopPropagation(); setDraft(""); onChange(""); } }} />;
}
