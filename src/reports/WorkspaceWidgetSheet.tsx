import { useContext, useEffect, useId, useMemo, useState } from "react";
import { Braces, Check, LoaderCircle, Play, Plus, Trash2 } from "lucide-react";
import { api } from "../api";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { measureName, TIME_BUCKETS, type DatasetColumn, type DatasetFilter, type DatasetInfo, type DatasetMeasure, type DatasetMeasureFn, type FilterOp, type TimeBucket } from "../../shared/datasets";
import { blockKeys, FACETABLE_KINDS, STACKABLE_KINDS, type ChartKind, type QueryOutcome, type ReportBlock, type ReportDetail } from "../../shared/reports";
import { DATE_PRESET_LABELS, valuesFromSearch, type ReportParameter } from "../../shared/reportParams";
import { datasetQueryText, isPlaceholder, parseDatasetQuery, placeholderText, RELATIVE_PRESETS, type RelativePreset, type ReportDatasetQuery, type WorkspaceCatalog } from "../../shared/reportsWorkspace";
import type { PatchOp } from "../../shared/reportsEdit";
import { ReportParamsContext } from "./ReportParamsBar";
import { ResultTable } from "./ResultTable";
import { editSpec } from "./reportEditApi";
import { codeOf, countLabel, messageOf } from "./reportsApi";
import { blockLabel, undoToBefore } from "./reportBlockEdit";

/**
 * Add widget (W3-REPORTS, D1067): a report on This workspace gets its charts from structured dataset
 * queries, built here without SQL: a dataset, what to measure, what to group by, a time bucket and
 * range (relative, or the report's date filter, D489), filters, and the chart kind Reports draws.
 * Preview runs the query with the reader's own access; Add saves the query and its block as one
 * manual edit (a new version, checked by the server like any edit).
 *
 * Edit widget (D1220–D1223) is the same sheet on a saved block (`editBlockId`): it reads the block and
 * its query back into the draft (`widgetDraftOf`), and Save changes updates them in place as one
 * manual edit with Undo (`widgetEditOps`). A widget it cannot show faithfully offers the JSON editor.
 */

export const WIDGET_KINDS = ["kpi", "bar", "horizontal_bar", "line", "area", "stacked_bar", "pie", "table"] as const;
export type WidgetKind = typeof WIDGET_KINDS[number];
const KIND_LABELS: Record<WidgetKind, string> = { kpi: "Number (KPI)", bar: "Bar chart", horizontal_bar: "Horizontal bars", line: "Line chart", area: "Area chart", stacked_bar: "Stacked bars", pie: "Pie chart", table: "Table" };
const FN_LABELS: Record<DatasetMeasureFn, string> = { count: "Count", sum: "Sum", avg: "Average", min: "Minimum", max: "Maximum", count_distinct: "Distinct count" };
const BUCKET_LABELS: Record<TimeBucket, string> = { day: "Day", week: "Week", month: "Month", quarter: "Quarter" };
const FILTER_OPS_SHOWN: FilterOp[] = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "is_null", "not_null"];
const OP_LABELS: Partial<Record<FilterOp, string>> = { eq: "is", neq: "is not", contains: "contains", gt: "more than", gte: "at least", lt: "less than", lte: "at most", is_null: "is empty", not_null: "is not empty" };
const NONE = "__none";
const ALL_TIME = "__all";
const REPORT_RANGE = "__report";
/** The id of the date filter Add widget creates when the report has none. */
export const WIDGET_PERIOD_ID = "period";

type MeasureDraft = { key: string; fn: DatasetMeasureFn; column: string | null };
/** A filter row; `locked` is a saved filter the builder shows but cannot edit (a report filter's placeholder, a list), kept as is (D1221). */
type FilterDraft = { key: string; column: string; op: FilterOp; value: string; locked?: DatasetFilter };
/** A saved query's own sort and limit, kept while its columns are still in the result (D1221). */
type OrderDraft = { sort?: Array<{ column: string; dir: "asc" | "desc" }>; limit?: number };

export type WidgetDraft = {
  dataset: string; measures: MeasureDraft[]; dimension: string | null; split: string | null; bucket: TimeBucket | null;
  range: RelativePreset | typeof ALL_TIME | typeof REPORT_RANGE; filters: FilterDraft[]; kind: WidgetKind; title: string;
  order?: OrderDraft | null;
};

const rowsKey = () => Math.random().toString(36).slice(2, 10);

/** The report's date range parameter, if it has one. */
export const reportDateRange = (parameters: readonly ReportParameter[]) => parameters.find((param) => param.type === "date_range") ?? null;

/** A filter value as typed, as the dataset column takes it (numbers for number columns, true/false for yes/no). */
function filterValue(column: DatasetColumn | undefined, text: string): string | number | boolean {
  if (column?.type === "bool") return /^(yes|true|1)$/i.test(text.trim());
  if (column && ["number", "money", "duration"].includes(column.type) && text.trim() !== "" && Number.isFinite(Number(text))) return Number(text);
  return text;
}

/** The structured query a draft saves (the report's date filter as placeholders). */
export function widgetQuery(draft: WidgetDraft, info: DatasetInfo, parameters: readonly ReportParameter[]): ReportDatasetQuery {
  const columns = new Map(info.columns.map((column) => [column.name, column]));
  const measures: DatasetMeasure[] = draft.measures.map((item) => item.fn === "count" && !item.column ? { fn: "count" } : { fn: item.fn, column: item.column ?? undefined });
  const dims = [...new Set([draft.dimension, draft.split].filter((name): name is string => Boolean(name)))];
  const filters: DatasetFilter[] = draft.filters.filter((item) => item.column).map((item) => item.locked ? item.locked : item.op === "is_null" || item.op === "not_null"
    ? { column: item.column, op: item.op }
    : { column: item.column, op: item.op, value: filterValue(columns.get(item.column), item.value) });
  const range = draft.range === ALL_TIME || !info.timeColumn ? undefined
    : draft.range === REPORT_RANGE ? (() => { const id = reportDateRange(parameters)?.id ?? WIDGET_PERIOD_ID; return { from: placeholderText(`${id}_from`, "Date"), to: placeholderText(`${id}_to`, "Date") }; })()
      : { preset: draft.range };
  const first = measureName(measures[0]!);
  const ranked = !draft.bucket && dims.length > 0 && draft.kind !== "table";
  const order = keptOrder(draft, info, measures, dims);
  return {
    dataset: info.id, measures,
    ...(dims.length ? { dimensions: dims } : {}),
    ...(filters.length ? { filters } : {}),
    ...(range ? { timeRange: range } : {}),
    ...(draft.bucket && info.timeColumn ? { timeBucket: draft.bucket } : {}),
    ...(order ? { ...(order.sort ? { sort: order.sort } : {}), ...(order.limit ? { limit: order.limit } : {}) }
      : ranked ? { sort: [{ column: first, dir: "desc" as const }], limit: draft.kind === "pie" ? 5 : 20 } : {})
  };
}

/** The draft's kept order, while every column it sorts by is still in the result (else the builder's own). */
function keptOrder(draft: WidgetDraft, info: DatasetInfo, measures: readonly DatasetMeasure[], dims: readonly string[]): OrderDraft | null {
  if (!draft.order) return null;
  const outputs = new Set([...dims, ...measures.map(measureName), ...(draft.bucket && info.timeColumn ? ["bucket"] : [])]);
  return (draft.order.sort ?? []).every((item) => outputs.has(item.column)) ? draft.order : null;
}

const intentOf = (kind: WidgetKind, timed: boolean) => kind === "kpi" ? "headline" : kind === "table" ? "detail" : kind === "pie" ? "share" : kind === "line" || kind === "area" ? "trend" : timed ? "trend" : kind === "horizontal_bar" ? "rank" : "compare";

/** The block a draft adds (on query `queryKey`), in the spec's vocabulary. */
export function widgetBlock(draft: WidgetDraft, info: DatasetInfo, query: ReportDatasetQuery, ids: { blockId: string; queryKey: string }): ReportBlock {
  const columns = new Map(info.columns.map((column) => [column.name, column]));
  const names = query.measures.map(measureName);
  const firstColumn = query.measures[0]?.column ? columns.get(query.measures[0].column) : undefined;
  const format = firstColumn?.type === "duration" && query.measures[0]?.fn !== "count" && query.measures[0]?.fn !== "count_distinct" ? "duration" as const : "number" as const;
  const title = draft.title.trim() || info.label;
  const timed = Boolean(query.timeBucket);
  const intent = intentOf(draft.kind, timed);
  if (draft.kind === "kpi") return { id: ids.blockId, type: "kpi", title, intent, queryKey: ids.queryKey, column: names[0]!, format, label: title };
  if (draft.kind === "table") return { id: ids.blockId, type: "table", title, intent, queryKey: ids.queryKey, width: "full" };
  const dims = query.dimensions ?? [];
  const x = timed ? "bucket" : dims[0]!;
  const series = timed ? dims[0] : dims[1];
  return { id: ids.blockId, type: "chart", title, intent, queryKey: ids.queryKey, kind: draft.kind as ChartKind, x, y: series ? [names[0]!] : names, ...(series ? { series } : {}), format };
}

/** The date filter a draft on "the report's filter" adds when the report has none (Add and Edit alike). */
function periodOps(draft: WidgetDraft, info: DatasetInfo, parameters: readonly ReportParameter[]): PatchOp[] {
  return draft.range === REPORT_RANGE && info.timeColumn && !reportDateRange(parameters)
    ? [{ op: "add_parameter", parameter: { id: WIDGET_PERIOD_ID, label: "Date range", type: "date_range", chType: "Date", default: { preset: "30d" } } } as PatchOp]
    : [];
}

/** A key for a new query on `dataset` the spec does not use yet (time.entries → entries_1, entries_2, …). */
function freshQueryKey(spec: Pick<ReportDetail["spec"], "queries" | "blocks">, dataset: string) {
  const taken = new Set([...spec.queries.map((query) => query.key), ...spec.blocks.map((block) => block.id)]);
  const base = dataset.split(".")[1]!.replace(/[^a-z0-9_]/g, "_").slice(0, 30);
  let n = 1;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/** The ops Add saves: the date filter when the widget asks for one the report lacks, the query, the block. */
export function widgetOps(report: Pick<ReportDetail, "spec">, draft: WidgetDraft, info: DatasetInfo): { ops: PatchOp[]; queryKey: string } {
  const queryKey = freshQueryKey(report.spec, info.id);
  const parameters = report.spec.parameters ?? [];
  const query = widgetQuery(draft, info, parameters);
  const ops: PatchOp[] = periodOps(draft, info, parameters);
  ops.push({ op: "add_query", query: { key: queryKey, sql: datasetQueryText(query), purpose: (draft.title.trim() || info.label).slice(0, 300) } } as PatchOp);
  const block = widgetBlock(draft, info, query, { blockId: queryKey, queryKey });
  const last = report.spec.blocks.at(-1)?.id ?? null;
  ops.push({ op: "add_block", block, after: last } as PatchOp);
  return { ops, queryKey };
}

// ------------------------------------------------------------------------------------- Edit widget

/** Stable JSON (keys sorted, undefined left out) to compare a saved query with the one a draft makes. */
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value) ?? "null";

/** A saved filter value as the builder's value box shows it, when typing it back gives the same value. */
function filterText(column: DatasetColumn | undefined, value: DatasetFilter["value"]): string | null {
  if (value === undefined || Array.isArray(value) || isPlaceholder(value)) return null;
  const text = typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
  return canonical(filterValue(column, text)) === canonical(value) ? text : null;
}

/** A saved widget as the builder reads it back, or what the builder cannot show of it, in words. */
export type WidgetEditable = { ok: true; draft: WidgetDraft } | { ok: false; reasons: string[] };

/**
 * Edit widget (D1220): the draft a saved block and its structured query read back as, so the builder
 * opens on what is there. Anything it cannot show faithfully (SQL, a measure alias, a fixed date range,
 * a chart kind it does not offer, a mapping it would draw differently) is a reason instead, and the
 * sheet offers the JSON editor (D1222). A filter the rows cannot edit (a report filter's placeholder,
 * a list) is kept as a locked row; the query's own sort and limit are kept (D1221).
 */
export function widgetDraftOf(block: ReportBlock, sql: string | undefined, datasets: readonly DatasetInfo[], parameters: readonly ReportParameter[]): WidgetEditable {
  if (block.type === "markdown") return { ok: false, reasons: ["it is text, not a chart"] };
  if (sql === undefined) return { ok: false, reasons: [`it names a query the report does not have (${block.queryKey})`] };
  const parsed = parseDatasetQuery(sql);
  if (!parsed.ok) return { ok: false, reasons: [parsed.error] };
  const query = parsed.query;
  const info = datasets.find((item) => item.id === query.dataset);
  if (!info) return { ok: false, reasons: [`its dataset (${query.dataset}) is not one you can read`] };
  const reasons: string[] = [];
  const kind: WidgetKind | null = block.type === "kpi" ? "kpi" : block.type === "table" ? "table" : (WIDGET_KINDS as readonly string[]).includes(block.kind) ? block.kind as WidgetKind : null;
  if (!kind) reasons.push(`it is a ${block.type === "chart" ? block.kind.replace(/_/g, " ") : block.type} chart, which the builder does not make`);
  if (query.measures.length > 4) reasons.push("it measures more than four things");
  if (query.measures.some((item) => item.as)) reasons.push("a measure has its own column name (as)");
  if (query.measures.some((item) => item.fn === "count" && item.column)) reasons.push("it counts one column's values");
  if (query.tz) reasons.push("it sets its own time zone");
  const dims = query.dimensions ?? [];
  if (dims.length > (query.timeBucket ? 1 : 2)) reasons.push(query.timeBucket ? "it groups by more than one column over time" : "it groups by more than two columns");
  if (query.timeBucket && !info.timeColumn) reasons.push("it buckets time on a dataset without a time column");
  let range: WidgetDraft["range"] = ALL_TIME;
  if (query.timeRange) {
    const dateFilter = reportDateRange(parameters);
    const own = dateFilter ? { from: placeholderText(`${dateFilter.id}_from`, "Date"), to: placeholderText(`${dateFilter.id}_to`, "Date") } : null;
    if (!info.timeColumn) reasons.push("it has a time range on a dataset without a time column");
    else if (query.timeRange.preset) range = query.timeRange.preset;
    else if (own && query.timeRange.from === own.from && query.timeRange.to === own.to) range = REPORT_RANGE;
    else reasons.push(isPlaceholder(query.timeRange.from) || isPlaceholder(query.timeRange.to) ? "its time range follows a date filter other than the report's first" : "it has a fixed date range");
  }
  if (reasons.length) return { ok: false, reasons };
  const columns = new Map(info.columns.map((column) => [column.name, column]));
  const filters: FilterDraft[] = (query.filters ?? []).map((filter) => {
    const shown = FILTER_OPS_SHOWN.includes(filter.op);
    if (shown && (filter.op === "is_null" || filter.op === "not_null") && filter.value === undefined) return { key: rowsKey(), column: filter.column, op: filter.op, value: "" };
    const text = shown && filter.op !== "is_null" && filter.op !== "not_null" ? filterText(columns.get(filter.column), filter.value) : null;
    return text !== null ? { key: rowsKey(), column: filter.column, op: filter.op, value: text } : { key: rowsKey(), column: filter.column, op: filter.op, value: "", locked: filter };
  });
  const timed = Boolean(query.timeBucket);
  const title = block.title && block.title !== info.label ? block.title : "";
  const draft: WidgetDraft = {
    dataset: info.id, measures: query.measures.map((item) => ({ key: rowsKey(), fn: item.fn, column: item.column ?? null })),
    dimension: dims[0] ?? null, split: timed ? null : dims[1] ?? null, bucket: query.timeBucket ?? null, range, filters, kind: kind!, title,
    ...(query.sort || query.limit ? { order: { ...(query.sort ? { sort: query.sort } : {}), ...(query.limit ? { limit: query.limit } : {}) } } : {})
  };
  // The builder's own sort and limit need no keeping (the sheet then says nothing about them).
  const plain = widgetQuery({ ...draft, order: null }, info, parameters);
  if (canonical({ sort: plain.sort, limit: plain.limit }) === canonical({ sort: query.sort, limit: query.limit })) delete draft.order;
  const again = widgetQuery(draft, info, parameters);
  if (canonical(again) !== canonical(query)) return { ok: false, reasons: ["it has settings the builder does not show"] };
  const made = widgetBlock(draft, info, again, { blockId: block.id, queryKey: block.queryKey });
  const mapping = (item: ReportBlock) => canonical(item.type === "kpi" ? { type: item.type, column: item.column } : item.type === "chart" ? { type: item.type, kind: item.kind, x: item.x, y: item.y, series: item.series } : { type: item.type });
  if (mapping(made) !== mapping(block)) return { ok: false, reasons: [block.type === "kpi" ? "its number reads another column than the first measure" : "it maps its columns differently from what the builder draws"] };
  return { ok: true, draft };
}

/** What a draft makes, as one comparable string (Save waits for a change). */
export function draftSignature(draft: WidgetDraft, info: DatasetInfo, parameters: readonly ReportParameter[]) {
  const query = widgetQuery(draft, info, parameters);
  return canonical({ query, block: widgetBlock(draft, info, query, { blockId: "b", queryKey: "q" }) });
}

/** The fields Edit widget sets on a block; what the new block leaves out of these is unset. */
const OWNED_FIELDS = ["title", "intent", "queryKey", "column", "format", "label", "kind", "x", "y", "series"] as const;
/** Chart fields that belong to kinds the builder does not make (D462); a new kind drops them. */
const KIND_FIELDS = ["x2", "midpoint", "cohort", "target", "max", "ranges", "start", "total", "yUnits"] as const;

/** Whether other blocks read the block's query (a comparison or sparkline counts). */
export const queryShared = (spec: Pick<ReportDetail["spec"], "blocks">, block: ReportBlock) =>
  block.type !== "markdown" && spec.blocks.some((other) => other.id !== block.id && blockKeys(other).includes(block.queryKey));

/**
 * The ops Edit widget saves as one manual edit (D1220): the date filter when the draft needs one the
 * report lacks, `update_query` on the block's query (or `add_query` of its own when other blocks read
 * it, which keep theirs), and `update_block` in place (same id, section, and position). Fields the
 * builder does not set stay, except those naming a column the new result no longer has.
 */
export function widgetEditOps(report: Pick<ReportDetail, "spec">, block: Exclude<ReportBlock, { type: "markdown" }>, draft: WidgetDraft, info: DatasetInfo): { ops: PatchOp[]; queryKey: string; ownQuery: boolean } {
  const parameters = report.spec.parameters ?? [];
  const query = widgetQuery(draft, info, parameters);
  const sql = datasetQueryText(query);
  const ops: PatchOp[] = periodOps(draft, info, parameters);
  const stored = report.spec.queries.find((item) => item.key === block.queryKey);
  const title = draft.title.trim() || info.label;
  const retitled = title !== (block.title ?? info.label);
  const ownQuery = queryShared(report.spec, block) || !stored;
  const queryKey = ownQuery ? freshQueryKey(report.spec, info.id) : block.queryKey;
  if (ownQuery) ops.push({ op: "add_query", query: { key: queryKey, sql, purpose: (stored && !retitled ? stored.purpose || title : title).slice(0, 300) } });
  else if (stored!.sql !== sql || retitled) ops.push({ op: "update_query", key: queryKey, ...(stored!.sql !== sql ? { sql } : {}), ...(retitled ? { purpose: title.slice(0, 300) } : {}) });

  const next = widgetBlock(draft, info, query, { blockId: block.id, queryKey }) as Record<string, unknown>;
  const { id: _id, ...fields } = next;
  const old = block as Record<string, unknown>;
  if (next.type !== block.type) {
    // A new type is a new block in the same place (patch.ts keeps only what is set), so its section and width go with it.
    ops.push({ op: "update_block", id: block.id, set: { ...fields, ...(block.section ? { section: block.section } : {}), ...(block.width && next.type !== "table" ? { width: block.width } : {}) } });
    return { ops, queryKey, ownQuery };
  }
  const outputs = new Set([...(query.dimensions ?? []), ...query.measures.map(measureName), ...(query.timeBucket ? ["bucket"] : [])]);
  const oldQuery = stored ? parseDatasetQuery(stored.sql) : null;
  const sameFirst = Boolean(oldQuery?.ok && canonical(oldQuery.query.measures[0]) === canonical(query.measures[0]));
  // The same measure keeps the format its author chose (currency, percent, …); a table keeps its width.
  if (sameFirst && old.format !== undefined) delete fields.format;
  if (block.type === "table") delete fields.width;
  const set = Object.fromEntries(Object.entries(fields).filter(([key, value]) => canonical(old[key]) !== canonical(value)));
  const unset: string[] = OWNED_FIELDS.filter((key) => key in old && !(key in fields) && !(key === "format" && sameFirst));
  const gone = (column: unknown) => typeof column === "string" && !outputs.has(column);
  if (block.type === "chart") {
    const kind = next.kind as ChartKind;
    if (old.kind !== kind) unset.push(...KIND_FIELDS.filter((key) => key in old));
    if (block.stack && !STACKABLE_KINDS.includes(kind)) unset.push("stack");
    if (block.facet && (!FACETABLE_KINDS.includes(kind) || gone(block.facet))) unset.push("facet");
    // Emphasis names a series or a category: a new measure list or series leaves it pointing at nothing sure.
    if (block.emphasis !== undefined && canonical([old.y, old.series]) !== canonical([next.y, next.series])) unset.push("emphasis");
    if (block.compareTo && !block.compareTo.queryKey && gone(block.compareTo.column)) unset.push("compareTo");
  }
  if (block.type === "kpi") {
    if (block.compareTo && !block.compareTo.queryKey && gone(block.compareTo.column)) unset.push("compareTo");
    if (block.compareColumn && gone(block.compareColumn)) unset.push("compareColumn");
    if (block.sparkline && block.sparkline.queryKey === block.queryKey && (gone(block.sparkline.x) || gone(block.sparkline.y))) unset.push("sparkline");
  }
  if (block.type === "table") {
    if (block.columns?.some(gone)) unset.push("columns");
    if (block.formats && Object.keys(block.formats).some(gone)) unset.push("formats");
  }
  if ((block.type === "chart" || block.type === "table") && block.clickFilter && gone(block.clickFilter.column)) unset.push("clickFilter");
  if (Object.keys(set).length || unset.length) ops.push({ op: "update_block", id: block.id, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset: [...new Set(unset)] } : {}) });
  return { ops, queryKey, ownQuery };
}

/** How a locked filter row reads ("follows the report's filter Status", "is one of a, b"). */
export function lockedFilterText(filter: DatasetFilter, parameters: readonly ReportParameter[]): string {
  if (isPlaceholder(filter.value)) {
    const name = /^\{\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(filter.value)![1]!;
    const param = parameters.find((item) => item.id === name || name === `${item.id}_from` || name === `${item.id}_to` || name === `${item.id}_min` || name === `${item.id}_max`);
    return `follows the report's filter ${param?.label ?? name}`;
  }
  const value = Array.isArray(filter.value) ? filter.value.map(String).join(", ") : String(filter.value ?? "");
  const verb = filter.op === "in" ? "is one of" : filter.op === "not_in" ? "is none of" : filter.op === "between" ? "is between" : OP_LABELS[filter.op] ?? filter.op;
  return `${verb} ${value.slice(0, 120)}`.trim();
}

/** Whether a draft's kept order still applies (its sort columns are in the result). */
function orderKept(draft: WidgetDraft, info: DatasetInfo): boolean {
  const measures = draft.measures.map((item) => item.fn === "count" && !item.column ? { fn: "count" as const } : { fn: item.fn, column: item.column ?? undefined });
  return keptOrder(draft, info, measures, [draft.dimension, draft.split].filter((name): name is string => Boolean(name))) !== null;
}

/** A kept order in words ("Sum of Hours, highest first; top 10"). */
function orderText(order: OrderDraft, info: DatasetInfo, draft: WidgetDraft): string {
  const label = (name: string) => {
    if (name === "bucket") return draft.bucket ? BUCKET_LABELS[draft.bucket] : "Time";
    const column = info.columns.find((item) => item.name === name);
    if (column) return column.label;
    const measure = draft.measures.find((item) => measureName(item.fn === "count" && !item.column ? { fn: "count" } : { fn: item.fn, column: item.column ?? undefined }) === name);
    const of = measure?.column ? info.columns.find((item) => item.name === measure.column)?.label ?? measure.column : null;
    return measure ? (of ? `${FN_LABELS[measure.fn]} of ${of}` : "Count of rows") : name;
  };
  const sort = (order.sort ?? []).map((item) => `${label(item.column)}, ${item.dir === "desc" ? "highest first" : "lowest first"}`).join("; then ");
  return [sort, order.limit ? `top ${order.limit}` : ""].filter(Boolean).join("; ") || "as saved";
}

/** What a draft may not save yet, in words (null: ready). */
export function draftProblem(draft: WidgetDraft, info: DatasetInfo | null): string | null {
  if (!info) return "Choose a dataset.";
  if (!draft.measures.length) return "Add something to measure.";
  if (draft.measures.some((item) => item.fn !== "count" && !item.column)) return "Choose the column each measure reads.";
  const names = draft.measures.map((item) => measureName(item.fn === "count" && !item.column ? { fn: "count" } : { fn: item.fn, column: item.column ?? undefined }));
  if (new Set(names).size !== names.length) return "Two measures are the same.";
  if (draft.kind === "kpi" && (draft.dimension || draft.bucket)) return "A number shows one value: take away the grouping and the time bucket.";
  if (draft.kind !== "kpi" && draft.kind !== "table" && !draft.dimension && !draft.bucket) return "A chart needs something on its axis: group by a column or by time.";
  if (draft.kind === "pie" && (draft.bucket || draft.measures.length > 1 || draft.split)) return "A pie shows one measure split by one column.";
  if ((draft.kind === "line" || draft.kind === "area") && !draft.bucket) return "A line or area chart runs over time: choose a time bucket.";
  if (draft.split && draft.measures.length > 1) return "Split by a column shows one measure; take away the others.";
  if (draft.split && draft.bucket) return "Over time, one grouping shows as the series; take away Split by.";
  if (draft.filters.some((item) => !item.locked && item.column && item.op !== "is_null" && item.op !== "not_null" && !item.value.trim())) return "Give each filter a value.";
  return null;
}

type Props = {
  report: Pick<ReportDetail, "id" | "revision" | "spec">;
  onClose: () => void;
  onChanged: () => void;
  reopen?: () => void;
  layerKey?: string;
  /** D1220: Edit widget, on this block (its id): the builder opens on the block and saves it in place. */
  editBlockId?: string;
  /** D1222: the block the builder cannot show opens Inspect's JSON editor (Edit SQL) instead. */
  onEditJson?: (blockId: string) => void;
};

const EMPTY_DRAFT: WidgetDraft = { dataset: "", measures: [{ key: "m0", fn: "count", column: null }], dimension: null, split: null, bucket: null, range: "30d", filters: [], kind: "bar", title: "" };

export function WorkspaceWidgetSheet({ report, onClose, onChanged, reopen, layerKey, editBlockId, onEditJson }: Props) {
  const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<WidgetDraft>(EMPTY_DRAFT);
  // D1220: the block being edited, what it read back as (Save waits for a change), or why the builder cannot show it.
  const editBlock = editBlockId ? report.spec.blocks.find((block) => block.id === editBlockId) : undefined;
  const editing = editBlockId !== undefined;
  const [initial, setInitial] = useState<string | null>(null);
  const [unbuildable, setUnbuildable] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [preview, setPreview] = useState<{ text: string; outcome: QueryOutcome } | null>(null);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const ids = { dataset: useId(), kind: useId(), title: useId(), dimension: useId(), split: useId(), bucket: useId(), range: useId() };
  useHistoryDialogGuard(true, onClose, { blocked: busy === "save", reopen, layerKey });
  const paramsContext = useContext(ReportParamsContext);
  const parameters = report.spec.parameters ?? [];
  const values = useMemo(() => valuesFromSearch(parameters, paramsContext?.search), [parameters, paramsContext?.search]);

  useEffect(() => {
    let live = true;
    api<WorkspaceCatalog>("/reports/workspace/datasets").then(({ datasets: list }) => {
      if (!live) return;
      setDatasets(list);
      if (editBlockId !== undefined) {
        const block = report.spec.blocks.find((item) => item.id === editBlockId);
        const read = block ? widgetDraftOf(block, block.type === "markdown" ? undefined : report.spec.queries.find((query) => query.key === block.queryKey)?.sql, list, report.spec.parameters ?? [])
          : { ok: false as const, reasons: ["it is no longer in the report"] };
        if (read.ok) {
          setDraft(read.draft);
          setInitial(draftSignature(read.draft, list.find((item) => item.id === read.draft.dataset)!, report.spec.parameters ?? []));
        } else setUnbuildable(read.reasons);
        return;
      }
      setDraft((current) => current.dataset ? current : { ...current, dataset: list[0]?.id ?? "" });
    }).catch((reason) => { if (live) setLoadError(messageOf(reason, "Could not load the datasets")); });
    return () => { live = false; };
    // The block and spec it opened on: a reload under the open sheet does not reset the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const info = datasets?.find((item) => item.id === draft.dataset) ?? null;
  const update = (patch: Partial<WidgetDraft>) => { setDraft((current) => ({ ...current, ...patch })); setError(null); };
  const groupable = info?.columns.filter((column) => column.dimension) ?? [];
  const measurable = info?.columns.filter((column) => column.measures?.length) ?? [];
  const problem = draftProblem(draft, info);
  const queryText = info && !problem ? datasetQueryText(widgetQuery(draft, info, parameters)) : null;
  const dateFilter = reportDateRange(parameters);

  const chooseDataset = (id: string) => update({ dataset: id, measures: [{ key: rowsKey(), fn: "count", column: null }], dimension: null, split: null, bucket: null, filters: [], range: datasets?.find((item) => item.id === id)?.timeColumn ? draft.range : ALL_TIME });

  const failureOf = (reason: unknown, fallback: string) => {
    const payload = reason && typeof reason === "object" && "payload" in reason ? (reason as { payload?: { details?: unknown } }).payload : undefined;
    const details = Array.isArray(payload?.details) ? payload.details.filter((item): item is string => typeof item === "string") : [];
    const message = messageOf(reason, fallback);
    return { message, details: details.filter((line) => line !== message).slice(0, 5) };
  };

  async function runPreview() {
    if (!queryText) return;
    setBusy("preview");
    setError(null);
    try {
      const result = await api<{ outcome: QueryOutcome }>(`/reports/${report.id}/workspace/preview`, { method: "POST", body: JSON.stringify({ query: queryText, ...(parameters.length ? { values } : {}) }) });
      setPreview({ text: queryText, outcome: result.outcome });
    } catch (reason) {
      setPreview(null);
      // A widget on the report's date filter before the report has one previews on its default (30 days).
      setError(failureOf(reason, "The preview did not run"));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!info || problem) return;
    setBusy("save");
    setError(null);
    const name = draft.title.trim() || info.label;
    try {
      const target = editBlock && editBlock.type !== "markdown" ? editBlock : null;
      if (editing && !target) throw new Error("That block is no longer in the report; close this and reload it.");
      const { ops } = target ? widgetEditOps(report, target, draft, info) : widgetOps(report, draft, info);
      const saved = await editSpec(report.id, ops, report.revision);
      // D1223: like Edit SQL and Remove, the edit is a version with Undo (the version before, while this one is current).
      notify.success(`${target ? "Saved" : "Added"} ${name} (version ${saved.version})`, {
        id: `report-widget-saved:${report.id}`,
        action: {
          label: "Undo",
          onClick: () => {
            void undoToBefore(report.id, saved.version).then((outcome) => {
              if (outcome === "moved_on") notify.warning("The report changed since; restore a version from Versions");
              else notify.success(target ? `${name} is as it was` : `Took ${name} out again`);
              onChanged();
            }, (reason: unknown) => notify.error(codeOf(reason).code === "RUN_IN_PROGRESS" ? "The report is running; undo from Versions when it finishes" : messageOf(reason, "Could not undo the change")));
          }
        }
      });
      if (saved.warnings?.length) notify.warning(`Saved, but Nook's checks noticed: ${saved.warnings.slice(0, 2).join("; ")}`);
      onChanged();
      onClose();
    } catch (reason) {
      const { code } = codeOf(reason);
      const failure = failureOf(reason, editing ? "Could not save the widget" : "Could not add the widget");
      setError(code === "REVISION_CONFLICT" ? { message: "The report changed since you opened this; close it and try again.", details: [] }
        : code === "RUN_IN_PROGRESS" ? { message: "The report is running; try when it finishes.", details: [] } : failure);
      setBusy(null);
    }
  }

  const measureOptions = (row: MeasureDraft) => [
    { value: "count:", label: "Count of rows" },
    ...measurable.flatMap((column) => (column.measures ?? []).map((fn) => ({ value: `${fn}:${column.name}`, label: `${FN_LABELS[fn]} of ${column.label}` })))
  ].filter((option) => option.value === `${row.fn}:${row.column ?? ""}` || !draft.measures.some((other) => other.key !== row.key && `${other.fn}:${other.column ?? ""}` === option.value));
  const dimensionOptions = [{ value: NONE, label: "Nothing (one total)" }, ...groupable.map((column) => ({ value: column.name, label: column.label, description: column.type === "datetime" || column.type === "date" ? "Each exact value; use Time bucket for days and weeks" : undefined }))];
  const rangeOptions = [
    ...(dateFilter || info?.timeColumn ? [{ value: REPORT_RANGE, label: dateFilter ? `The report's filter (${dateFilter.label})` : "A date filter readers can change", description: dateFilter ? undefined : "Adds a Date range filter to the report (last 30 days to start)" }] : []),
    ...RELATIVE_PRESETS.map((preset) => ({ value: preset, label: DATE_PRESET_LABELS[preset] })),
    { value: ALL_TIME, label: "All time" }
  ];

  const editTitle = editBlock ? blockLabel(editBlock) : null;
  const shared = editBlock ? queryShared(report.spec, editBlock) : false;
  const ready = !editing || initial !== null;
  const unchanged = editing && info !== null && !problem && initial === draftSignature(draft, info, parameters);
  return <ModalDialog title={editing ? "Edit widget" : "Add widget"} eyebrow={editTitle ? `This workspace · ${editTitle}` : "This workspace"} onClose={onClose} busy={busy === "save"} variant="sheet" className="reports-dialog report-edit-sheet report-widget-sheet">
    <div className="report-edit-sheet-body">
      {!unbuildable && <p className="file-dialog-hint">{editing ? "Change what this widget shows; it keeps its place in the report. Saving is a new version, checked like any edit." : "Build a chart from this workspace's data."} Everyone who opens the report sees the numbers their own access allows.</p>}
      {loadError && <p className="form-error" role="alert">{loadError}</p>}
      {!datasets && !loadError && <p className="file-dialog-hint" role="status">{editing ? "Opening the widget…" : "Loading the datasets…"}</p>}
      {datasets && !datasets.length && <p className="file-dialog-hint">No workspace data is available to you yet.</p>}
      {/* D1222: a saved widget the builder cannot show faithfully opens in the JSON editor instead. */}
      {unbuildable && <section className="report-widget-unbuildable" role="status" aria-label="Edit as JSON">
        <p><strong>The builder can't show this widget</strong>: {unbuildable.join("; ")}.</p>
        <p className="file-dialog-hint">Edit its query as JSON instead (the same editor as Inspect → Edit SQL); Nook checks it the same way before saving, and the change is a version you can undo.</p>
      </section>}
      {shared && ready && !unbuildable && <p className="file-dialog-hint report-widget-note" role="note">Other blocks read this widget's query too. Saving gives this widget a query of its own; they keep the current one.</p>}
      {datasets && datasets.length > 0 && ready && !unbuildable && <>
        <div className="report-widget-field">
          <span className="reports-label" id={ids.dataset}>Data</span>
          <Select labelledBy={ids.dataset} label="Dataset" value={draft.dataset || null} onChange={chooseDataset}
            options={datasets.map((item) => ({ value: item.id, label: item.label, description: item.description }))} />
        </div>
        {info && <>
          <fieldset className="report-widget-group">
            <legend>Measure</legend>
            {draft.measures.map((row, index) => <div className="report-widget-row" key={row.key}>
              <Select label={`Measure ${index + 1}`} value={`${row.fn}:${row.column ?? ""}`} onChange={(value) => {
                const [fn, column] = value.split(":") as [DatasetMeasureFn, string];
                update({ measures: draft.measures.map((item) => item.key === row.key ? { ...item, fn, column: column || null } : item) });
              }} options={measureOptions(row)} />
              {draft.measures.length > 1 && <button type="button" className="icon-button" aria-label={`Remove measure ${index + 1}`} onClick={() => update({ measures: draft.measures.filter((item) => item.key !== row.key) })}><Trash2 aria-hidden="true" /></button>}
            </div>)}
            {draft.measures.length < 4 && measurable.length > 0 && <button type="button" className="secondary-button report-widget-add" onClick={() => update({ measures: [...draft.measures, { key: rowsKey(), fn: measurable[0]!.measures![0]!, column: measurable[0]!.name }] })}><Plus aria-hidden="true" />Add a measure</button>}
          </fieldset>
          <div className="report-widget-grid">
            <div className="report-widget-field">
              <span className="reports-label" id={ids.dimension}>Group by</span>
              <Select labelledBy={ids.dimension} label="Group by" value={draft.dimension ?? NONE} onChange={(value) => update({ dimension: value === NONE ? null : value, ...(value === NONE ? { split: null } : {}) })} options={dimensionOptions} />
            </div>
            {info.timeColumn && <div className="report-widget-field">
              <span className="reports-label" id={ids.bucket}>Time bucket</span>
              <Select labelledBy={ids.bucket} label="Time bucket" value={draft.bucket ?? NONE} onChange={(value) => update({ bucket: value === NONE ? null : value as TimeBucket })}
                options={[{ value: NONE, label: "None" }, ...TIME_BUCKETS.map((bucket) => ({ value: bucket, label: BUCKET_LABELS[bucket] }))]} />
            </div>}
            {draft.dimension && !draft.bucket && draft.kind !== "kpi" && draft.kind !== "pie" && <div className="report-widget-field">
              <span className="reports-label" id={ids.split}>Split by</span>
              <Select labelledBy={ids.split} label="Split by" value={draft.split ?? NONE} onChange={(value) => update({ split: value === NONE ? null : value })}
                options={[{ value: NONE, label: "Nothing" }, ...groupable.filter((column) => column.name !== draft.dimension).map((column) => ({ value: column.name, label: column.label }))]} />
            </div>}
            {info.timeColumn && <div className="report-widget-field">
              <span className="reports-label" id={ids.range}>Time range</span>
              <Select labelledBy={ids.range} label="Time range" value={draft.range} onChange={(value) => update({ range: value as WidgetDraft["range"] })} options={rangeOptions} />
            </div>}
          </div>
          <fieldset className="report-widget-group">
            <legend>Filters</legend>
            {draft.filters.map((row, index) => {
              const column = info.columns.find((item) => item.name === row.column);
              // D1221: a saved filter the rows cannot edit (a report filter, a list) stays as it is, or goes.
              if (row.locked) return <div className="report-widget-row report-widget-locked" key={row.key}>
                <p><strong>{column?.label ?? row.column}</strong> {lockedFilterText(row.locked, parameters)}<small>Kept as saved</small></p>
                <button type="button" className="icon-button" aria-label={`Remove filter ${index + 1}`} onClick={() => update({ filters: draft.filters.filter((item) => item.key !== row.key) })}><Trash2 aria-hidden="true" /></button>
              </div>;
              return <div className="report-widget-row report-widget-filter" key={row.key}>
                <Select label={`Filter ${index + 1} column`} value={row.column} onChange={(value) => update({ filters: draft.filters.map((item) => item.key === row.key ? { ...item, column: value } : item) })} options={info.columns.map((item) => ({ value: item.name, label: item.label }))} />
                <Select label={`Filter ${index + 1} condition`} value={row.op} onChange={(value) => update({ filters: draft.filters.map((item) => item.key === row.key ? { ...item, op: value as FilterOp } : item) })} options={FILTER_OPS_SHOWN.map((op) => ({ value: op, label: OP_LABELS[op]! }))} />
                {row.op !== "is_null" && row.op !== "not_null" && <input aria-label={`Filter ${index + 1} value`} value={row.value} maxLength={500} placeholder={column?.type === "bool" ? "yes or no" : column?.type === "money" ? "In minor units (cents)" : column?.type === "duration" ? "Seconds" : "Value"}
                  inputMode={column && ["number", "money", "duration"].includes(column.type) ? "decimal" : undefined} onChange={(event) => update({ filters: draft.filters.map((item) => item.key === row.key ? { ...item, value: event.target.value } : item) })} />}
                <button type="button" className="icon-button" aria-label={`Remove filter ${index + 1}`} onClick={() => update({ filters: draft.filters.filter((item) => item.key !== row.key) })}><Trash2 aria-hidden="true" /></button>
              </div>;
            })}
            {draft.filters.length < 10 && <button type="button" className="secondary-button report-widget-add" onClick={() => update({ filters: [...draft.filters, { key: rowsKey(), column: groupable[0]?.name ?? info.columns[0]!.name, op: "eq", value: "" }] })}><Plus aria-hidden="true" />Add a filter</button>}
          </fieldset>
          <div className="report-widget-grid">
            <div className="report-widget-field">
              <span className="reports-label" id={ids.kind}>Show as</span>
              <Select labelledBy={ids.kind} label="Show as" value={draft.kind} onChange={(value) => update({ kind: value as WidgetKind })} options={WIDGET_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }))} />
            </div>
            <div className="report-widget-field">
              <label htmlFor={ids.title} className="reports-label">Title</label>
              <input id={ids.title} value={draft.title} maxLength={120} placeholder={info.label} onChange={(event) => update({ title: event.target.value })} />
            </div>
          </div>
          {/* D1221: the query's own sort and limit, kept until the author takes the builder's. */}
          {draft.order && <fieldset className="report-widget-group">
            <legend>Order</legend>
            <div className="report-widget-row report-widget-locked">
              <p>{orderText(draft.order, info, draft)}<small>{orderKept(draft, info) ? "Kept as saved" : "Its columns are gone, so the usual order applies"}</small></p>
              <button type="button" className="secondary-button" onClick={() => update({ order: null })}>Use the usual order</button>
            </div>
          </fieldset>}
          {problem && <p className="file-dialog-hint report-widget-problem" role="status">{problem}</p>}
          {unchanged && <p className="file-dialog-hint" role="status">Nothing changed yet.</p>}
          <div className="report-query-edit-run">
            <button type="button" className="secondary-button" onClick={() => { void runPreview(); }} disabled={busy !== null || !queryText} aria-busy={busy === "preview" || undefined}>
              {busy === "preview" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}{busy === "preview" ? "Running…" : "Preview"}
            </button>
            <p className="file-dialog-hint">Runs with your access{parameters.length ? " and the filters on screen" : ""}; nothing is saved.</p>
          </div>
          {preview && <section className={`report-query-preview${preview.text === queryText ? "" : " report-query-preview-old"}`} aria-label="Preview">
            <p className="report-inspect-facts" role="status"><span>{countLabel(preview.outcome.rows.length)}{preview.outcome.truncated ? " (more were cut off)" : ""}</span>{preview.text !== queryText && <span>Changed since this preview</span>}</p>
            {preview.outcome.columns.length > 0 && <ResultTable columns={preview.outcome.columns} rows={preview.outcome.rows} raw label="Widget preview" />}
          </section>}
        </>}
      </>}
      {error && <div className="form-error report-query-edit-error" role="alert"><p>{error.message}</p>{error.details.length > 0 && <ul>{error.details.map((line) => <li key={line}>{line}</li>)}</ul>}</div>}
    </div>
    <footer className="file-dialog-actions report-edit-sheet-actions">
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy === "save"}>Cancel</button>
      {unbuildable ? onEditJson && editBlockId && editBlock && editBlock.type !== "markdown" && report.spec.queries.some((query) => query.key === editBlock.queryKey) && <button type="button" className="primary-button" onClick={() => onEditJson(editBlockId)}><Braces aria-hidden="true" />Edit as JSON</button>
        : <button type="button" className="primary-button" onClick={() => { void save(); }} disabled={busy !== null || Boolean(problem) || !info || !ready || unchanged} aria-busy={busy === "save" || undefined}>
          {busy === "save" ? <LoaderCircle className="spin" aria-hidden="true" /> : editing ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}{busy === "save" ? "Checking…" : editing ? "Save changes" : "Add to report"}
        </button>}
    </footer>
  </ModalDialog>;
}
