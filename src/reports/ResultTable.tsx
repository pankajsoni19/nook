import { useRef, useState } from "react";
import type { ResultColumn, ValueFormat } from "../../shared/reports";
import { cellLabel, formatValue } from "./chartOption";

/** Rows a table shows before "Show all". */
export const TABLE_PAGE_ROWS = 100;

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
};

/** A result as a table that scrolls sideways on a phone, with the column types under the names. */
export function ResultTable({ columns, rows, show, formats, highlight, raw = false, label, pick }: Props) {
  const [all, setAll] = useState(false);
  const pointer = useRef<string>("mouse");
  const pickAt = pick ? columns.findIndex((column) => column.name === pick.column) : -1;
  const picked = show?.length ? show.map((name) => columns.findIndex((column) => column.name === name)).filter((index) => index >= 0) : columns.map((_, index) => index);
  const visible = all ? rows : rows.slice(0, TABLE_PAGE_ROWS);
  const numeric = (type: string) => /^(Nullable\()?(U?Int|Float|Decimal)/.test(type);
  return <div className="report-table-block">
    <div className="report-table-scroll" tabIndex={0} role="region" aria-label={label}>
      <table className="report-table">
        <thead><tr>{picked.map((index) => {
          const column = columns[index]!;
          const role = highlight?.[column.name];
          return <th key={`${column.name}-${index}`} scope="col" className={role ? "report-mapped" : undefined}>
            <span>{column.name}{role && <em className="report-role">{role}</em>}</span><small>{column.type}</small>
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
    </div>
    {rows.length > TABLE_PAGE_ROWS && <button type="button" className="secondary-button report-show-all" onClick={() => setAll((current) => !current)}>
      {all ? `Show the first ${TABLE_PAGE_ROWS}` : `Show all ${rows.length.toLocaleString()} rows`}
    </button>}
  </div>;
}
