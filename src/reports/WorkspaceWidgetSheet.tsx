import { useContext, useEffect, useId, useMemo, useState } from "react";
import { LoaderCircle, Play, Plus, Trash2 } from "lucide-react";
import { api } from "../api";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { measureName, TIME_BUCKETS, type DatasetColumn, type DatasetFilter, type DatasetInfo, type DatasetMeasure, type DatasetMeasureFn, type FilterOp, type TimeBucket } from "../../shared/datasets";
import type { ChartKind, QueryOutcome, ReportBlock, ReportDetail } from "../../shared/reports";
import { DATE_PRESET_LABELS, valuesFromSearch, type ReportParameter } from "../../shared/reportParams";
import { datasetQueryText, placeholderText, RELATIVE_PRESETS, type RelativePreset, type ReportDatasetQuery, type WorkspaceCatalog } from "../../shared/reportsWorkspace";
import type { PatchOp } from "../../shared/reportsEdit";
import { ReportParamsContext } from "./ReportParamsBar";
import { ResultTable } from "./ResultTable";
import { editSpec } from "./reportEditApi";
import { countLabel, messageOf } from "./reportsApi";

/**
 * Add widget (W3-REPORTS, D1067): a report on This workspace gets its charts from structured dataset
 * queries, built here without SQL: a dataset, what to measure, what to group by, a time bucket and
 * range (relative, or the report's date filter, D489), filters, and the chart kind Reports draws.
 * Preview runs the query with the reader's own access; Add saves the query and its block as one
 * manual edit (a new version, checked by the server like any edit).
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
type FilterDraft = { key: string; column: string; op: FilterOp; value: string };

export type WidgetDraft = {
  dataset: string; measures: MeasureDraft[]; dimension: string | null; split: string | null; bucket: TimeBucket | null;
  range: RelativePreset | typeof ALL_TIME | typeof REPORT_RANGE; filters: FilterDraft[]; kind: WidgetKind; title: string;
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
  const filters: DatasetFilter[] = draft.filters.filter((item) => item.column).map((item) => item.op === "is_null" || item.op === "not_null"
    ? { column: item.column, op: item.op }
    : { column: item.column, op: item.op, value: filterValue(columns.get(item.column), item.value) });
  const range = draft.range === ALL_TIME || !info.timeColumn ? undefined
    : draft.range === REPORT_RANGE ? (() => { const id = reportDateRange(parameters)?.id ?? WIDGET_PERIOD_ID; return { from: placeholderText(`${id}_from`, "Date"), to: placeholderText(`${id}_to`, "Date") }; })()
      : { preset: draft.range };
  const first = measureName(measures[0]!);
  const ranked = !draft.bucket && dims.length > 0 && draft.kind !== "table";
  return {
    dataset: info.id, measures,
    ...(dims.length ? { dimensions: dims } : {}),
    ...(filters.length ? { filters } : {}),
    ...(range ? { timeRange: range } : {}),
    ...(draft.bucket && info.timeColumn ? { timeBucket: draft.bucket } : {}),
    ...(ranked ? { sort: [{ column: first, dir: "desc" as const }], limit: draft.kind === "pie" ? 5 : 20 } : {})
  };
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

/** The ops Add saves: the date filter when the widget asks for one the report lacks, the query, the block. */
export function widgetOps(report: Pick<ReportDetail, "spec">, draft: WidgetDraft, info: DatasetInfo): { ops: PatchOp[]; queryKey: string } {
  const taken = new Set([...report.spec.queries.map((query) => query.key), ...report.spec.blocks.map((block) => block.id)]);
  const base = info.id.split(".")[1]!.replace(/[^a-z0-9_]/g, "_").slice(0, 30);
  let n = 1;
  while (taken.has(`${base}_${n}`)) n += 1;
  const queryKey = `${base}_${n}`;
  const parameters = report.spec.parameters ?? [];
  const query = widgetQuery(draft, info, parameters);
  const ops: PatchOp[] = [];
  if (draft.range === REPORT_RANGE && info.timeColumn && !reportDateRange(parameters)) {
    ops.push({ op: "add_parameter", parameter: { id: WIDGET_PERIOD_ID, label: "Date range", type: "date_range", chType: "Date", default: { preset: "30d" } } } as PatchOp);
  }
  ops.push({ op: "add_query", query: { key: queryKey, sql: datasetQueryText(query), purpose: (draft.title.trim() || info.label).slice(0, 300) } } as PatchOp);
  const block = widgetBlock(draft, info, query, { blockId: queryKey, queryKey });
  const last = report.spec.blocks.at(-1)?.id ?? null;
  ops.push({ op: "add_block", block, after: last } as PatchOp);
  return { ops, queryKey };
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
  if (draft.filters.some((item) => item.column && item.op !== "is_null" && item.op !== "not_null" && !item.value.trim())) return "Give each filter a value.";
  return null;
}

type Props = {
  report: Pick<ReportDetail, "id" | "revision" | "spec">;
  onClose: () => void;
  onChanged: () => void;
  reopen?: () => void;
  layerKey?: string;
};

export function WorkspaceWidgetSheet({ report, onClose, onChanged, reopen, layerKey }: Props) {
  const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<WidgetDraft>({ dataset: "", measures: [{ key: rowsKey(), fn: "count", column: null }], dimension: null, split: null, bucket: null, range: "30d", filters: [], kind: "bar", title: "" });
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
      setDraft((current) => current.dataset ? current : { ...current, dataset: list[0]?.id ?? "" });
    }).catch((reason) => { if (live) setLoadError(messageOf(reason, "Could not load the datasets")); });
    return () => { live = false; };
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
    try {
      const { ops } = widgetOps(report, draft, info);
      const saved = await editSpec(report.id, ops, report.revision);
      notify.success(`Added ${draft.title.trim() || info.label} (version ${saved.version})`);
      onChanged();
      onClose();
    } catch (reason) {
      setError(failureOf(reason, "Could not add the widget"));
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

  return <ModalDialog title="Add widget" eyebrow="This workspace" onClose={onClose} busy={busy === "save"} variant="sheet" className="reports-dialog report-edit-sheet report-widget-sheet">
    <div className="report-edit-sheet-body">
      <p className="file-dialog-hint">Build a chart from this workspace's data. Everyone who opens the report sees the numbers their own access allows.</p>
      {loadError && <p className="form-error" role="alert">{loadError}</p>}
      {!datasets && !loadError && <p className="file-dialog-hint" role="status">Loading the datasets…</p>}
      {datasets && !datasets.length && <p className="file-dialog-hint">No workspace data is available to you yet.</p>}
      {datasets && datasets.length > 0 && <>
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
          {problem && <p className="file-dialog-hint report-widget-problem" role="status">{problem}</p>}
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
      <button type="button" className="primary-button" onClick={() => { void save(); }} disabled={busy !== null || Boolean(problem) || !info} aria-busy={busy === "save" || undefined}>
        {busy === "save" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}{busy === "save" ? "Checking…" : "Add to report"}
      </button>
    </footer>
  </ModalDialog>;
}
