import type { ResultColumn, ValueFormat } from "../../shared/reports";
import { cellLabel, formatValue } from "./chartOption";

/**
 * A table block's sort and contains box (D563, D564; docs/plan/REPORT_FILTERS.md "Later" 2): over the
 * rows already loaded, in the browser, nothing asked of the server. The state is personal and lives in
 * the report page's URL (`?t.<blockId>=<column>.desc`, `?tq.<blockId>=<text>`), changed with history
 * replace so typing never fills Back.
 */

export type TableSort = { column: string; desc: boolean };

/** The URL keys of a block's sort and contains text. */
export const sortKey = (blockId: string) => `t.${blockId}`;
export const containsKey = (blockId: string) => `tq.${blockId}`;
/** The contains box's longest text. */
export const CONTAINS_CHARS = 100;

/** `route.desc` → { column: "route", desc: true }; null for anything else or a column the result does not have. */
export function parseSort(raw: string | undefined, columns: readonly Pick<ResultColumn, "name">[]): TableSort | null {
  if (!raw) return null;
  const at = raw.lastIndexOf(".");
  if (at <= 0) return null;
  const column = raw.slice(0, at);
  const direction = raw.slice(at + 1);
  if (direction !== "asc" && direction !== "desc") return null;
  return columns.some((item) => item.name === column) ? { column, desc: direction === "desc" } : null;
}
export const formatSort = (sort: TableSort | null) => sort ? `${sort.column}.${sort.desc ? "desc" : "asc"}` : null;

/** A header click: ascending, then descending, then the query's own order. */
export const nextSort = (current: TableSort | null, column: string): TableSort | null =>
  current?.column !== column ? { column, desc: false } : current.desc ? null : { column, desc: true };

export const isNumericType = (type: string) => /^(Nullable\()?(LowCardinality\()?(U?Int|Float|Decimal)/.test(type);

function compare(a: unknown, b: unknown, numeric: boolean): number {
  const missingA = a === null || a === undefined;
  const missingB = b === null || b === undefined;
  if (missingA || missingB) return missingA === missingB ? 0 : missingA ? 1 : -1;
  if (numeric) {
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x === y ? 0 : x < y ? -1 : 1;
  }
  return cellLabel(a).localeCompare(cellLabel(b), undefined, { numeric: true, sensitivity: "base" });
}

/** The rows sorted by a column (NULLs last either way; numbers as numbers; ties keep the query's order). */
export function sortRows<T extends readonly unknown[]>(rows: readonly T[], columns: readonly ResultColumn[], sort: TableSort | null): T[] {
  const at = sort ? columns.findIndex((column) => column.name === sort.column) : -1;
  if (!sort || at < 0) return [...rows];
  const numeric = isNumericType(columns[at]!.type);
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const missing = (a.row[at] === null || a.row[at] === undefined) !== (b.row[at] === null || b.row[at] === undefined);
    const order = compare(a.row[at], b.row[at], numeric);
    // NULLs stay last when descending too.
    return (missing ? order : sort.desc ? -order : order) || a.index - b.index;
  }).map((item) => item.row);
}

/** The rows with a shown cell that holds the text (case-insensitive), as stored or as shown. */
export function containsRows<T extends readonly unknown[]>(rows: readonly T[], shown: readonly number[], columns: readonly ResultColumn[], text: string, formats?: Partial<Record<string, ValueFormat>>): T[] {
  const term = text.trim().toLowerCase();
  if (!term) return [...rows];
  return rows.filter((row) => shown.some((index) => {
    const cell = row[index];
    if (cell === null || cell === undefined) return false;
    return cellLabel(cell).toLowerCase().includes(term) || formatValue(cell, formats?.[columns[index]!.name]).toLowerCase().includes(term);
  }));
}
