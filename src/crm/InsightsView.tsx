import { useEffect, useMemo, useState } from "react";
import { ChartColumn } from "lucide-react";
import { EmptyState } from "../ui/EmptyState";
import { InsightChart, KpiRow, KpiTile } from "../ui/insights/Insights";
import { Select } from "../ui/Select";
import { useWorkspaceSettings } from "../ui/units";
import { errorMessage, listPipelines, queryDataset } from "./crmApi";
import type { CrmBook, CrmPipeline } from "../../shared/crm";
import type { DatasetFilter, DatasetResult } from "../../shared/datasets";
import "./crmPanels.css";

/**
 * Contacts Insights (§B.10, §E.4): KPI tiles (open pipeline, weighted pipeline, win rate, won this
 * quarter), then pipeline by stage, won vs lost by month, stage conversion, and interactions per week.
 * Every number comes from the module's datasets through structured queries, scoped on the server
 * to books the viewer reads; the book (or one of its pipelines) narrows them here.
 */

type Loaded = {
  status: DatasetResult; weighted: DatasetResult; quarter: DatasetResult; byStage: DatasetResult;
  byMonth: DatasetResult; conversion: DatasetResult | null; interactions: DatasetResult;
};

const quarterStart = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(Math.floor(now.getMonth() / 3) * 3 + 1).padStart(2, "0")}-01`;
};
const num = (value: unknown) => typeof value === "number" ? value : value === null || value === undefined ? 0 : Number(value) || 0;

export function InsightsView({ book, books }: { book: CrmBook | null; books: readonly CrmBook[] }) {
  const workspace = useWorkspaceSettings();
  const [pipelines, setPipelines] = useState<CrmPipeline[]>([]);
  const [pipelineId, setPipelineId] = useState<string>("all");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPipelineId("all");
    setPipelines([]);
    if (!book) return;
    let live = true;
    listPipelines(book.id).then((body) => { if (live) setPipelines(body.pipelines); }, () => undefined);
    return () => { live = false; };
  }, [book?.id]);

  const pipeline = pipelines.find((item) => item.id === pipelineId) ?? null;
  const currency = pipeline?.currency ?? book?.settings.currency ?? workspace.defaultCurrency;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const scope: DatasetFilter[] = [
      ...(book ? [{ column: "book", op: "eq" as const, value: book.name }] : []),
      ...(pipeline ? [{ column: "pipeline_key", op: "eq" as const, value: pipeline.id }] : []),
      { column: "deal_currency", op: "eq", value: currency }
    ];
    const pipelineIds = pipeline ? [pipeline.id] : pipelines.map((item) => item.id);
    const base = { dataset: "crm.deals", tz };
    Promise.all([
      queryDataset({ ...base, measures: [{ fn: "count" }, { fn: "sum", column: "value", as: "value" }], dimensions: ["status"], filters: scope }),
      queryDataset({ ...base, measures: [{ fn: "sum", column: "weighted", as: "weighted" }], filters: [...scope, { column: "status", op: "eq", value: "open" }] }),
      queryDataset({ ...base, measures: [{ fn: "sum", column: "value", as: "value" }, { fn: "count" }], filters: [...scope, { column: "status", op: "eq", value: "won" }, { column: "closed", op: "gte", value: `${quarterStart()}T00:00:00.000Z` }] }),
      queryDataset({ ...base, measures: [{ fn: "sum", column: "value", as: "value" }, { fn: "count" }, { fn: "min", column: "stage_position", as: "position" }], dimensions: ["stage"], filters: [...scope, { column: "status", op: "eq", value: "open" }], sort: [{ column: "position", dir: "asc" }] }),
      queryDataset({ ...base, measures: [{ fn: "count" }], dimensions: ["status"], timeBucket: "month", filters: [...scope, { column: "status", op: "in", value: ["won", "lost"] }] }),
      book && pipelineIds.length
        ? queryDataset({ dataset: "crm.deal_stage_changes", tz, measures: [{ fn: "count_distinct", column: "deal_id", as: "deals" }, { fn: "min", column: "to_stage_position", as: "position" }], dimensions: ["to_stage"], filters: [{ column: "pipeline_key", op: "in", value: pipelineIds }], sort: [{ column: "position", dir: "asc" }] })
        : Promise.resolve(null),
      queryDataset({ dataset: "crm.interactions", tz, measures: [{ fn: "count" }], dimensions: ["interaction_kind"], timeBucket: "week", filters: book ? [{ column: "book", op: "eq", value: book.name }] : [], timeRange: { from: new Date(Date.now() - 84 * 86_400_000).toISOString().slice(0, 10) } })
    ]).then(([status, weighted, quarter, byStage, byMonth, conversion, interactions]) => {
      if (!live) return;
      setData({ status, weighted, quarter, byStage, byMonth, conversion, interactions });
      setLoading(false);
    }, (reason) => { if (live) { setError(errorMessage(reason, "Could not load Insights")); setLoading(false); } });
    return () => { live = false; };
  }, [book?.id, book?.name, pipeline?.id, pipelines.length, currency, tz]);

  const view = useMemo(() => {
    if (!data) return null;
    const statusRows = new Map(data.status.rows.map((row) => [String(row[0]), { count: num(row[1]), value: num(row[2]) }]));
    const won = statusRows.get("won")?.count ?? 0;
    const lost = statusRows.get("lost")?.count ?? 0;
    const totalDeals = [...statusRows.values()].reduce((sum, item) => sum + item.count, 0);
    const stageCats = data.byStage.rows.map((row) => String(row[0]));
    const months = [...new Set(data.byMonth.rows.map((row) => String(row[1])))].sort();
    const monthValue = (status: string, month: string) => num(data.byMonth.rows.find((row) => row[0] === status && row[1] === month)?.[2]);
    const conversionRows = data.conversion?.rows ?? [];
    const first = num(conversionRows[0]?.[1]);
    const weeks = [...new Set(data.interactions.rows.map((row) => String(row[1])))].sort();
    const kinds = [...new Set(data.interactions.rows.map((row) => String(row[0])))].sort();
    return {
      totalDeals,
      openValue: statusRows.get("open")?.value ?? 0,
      weighted: num(data.weighted.rows[0]?.[0]),
      winRate: won + lost ? won / (won + lost) : null,
      wonQuarter: num(data.quarter.rows[0]?.[0]),
      wonQuarterCount: num(data.quarter.rows[0]?.[1]),
      stageCats, stageValues: data.byStage.rows.map((row) => num(row[1])), stageCounts: data.byStage.rows.map((row) => num(row[2])),
      months, won: months.map((month) => monthValue("won", month)), lost: months.map((month) => monthValue("lost", month)),
      conversionCats: conversionRows.map((row) => String(row[0])), conversionCounts: conversionRows.map((row) => num(row[1])),
      conversionRates: conversionRows.map((row) => first ? num(row[1]) / first : null),
      weeks, kinds, interactionSeries: kinds.map((kind) => ({ name: kind[0]!.toUpperCase() + kind.slice(1), values: weeks.map((week) => num(data.interactions.rows.find((row) => row[0] === kind && row[1] === week)?.[2])) }))
    };
  }, [data]);

  const pipelinePicker = book && pipelines.length > 1 && <div className="crm-insights-filters">
    <Select label="Pipeline" value={pipelineId} onChange={setPipelineId} options={[{ value: "all", label: "All pipelines" }, ...pipelines.map((item) => ({ value: item.id, label: item.name }))]} />
  </div>;

  if (error) return <div className="crm-insights"><p className="ui-field-error" role="alert">{error}</p></div>;
  if (loading && !view) return <div className="crm-insights" aria-busy="true"><p className="ui-panel-loading" role="status">Loading Insights…</p></div>;
  if (!view || view.totalDeals === 0) {
    return <div className="crm-insights">
      {pipelinePicker}
      <EmptyState icon={ChartColumn} title="No deals to chart yet">{book ? `Add deals to ${book.name} and Insights shows your pipeline, win rate, and conversion.` : books.length ? "Add deals to a book and Insights shows your pipeline, win rate, and conversion." : "Create a contact book to start."}</EmptyState>
    </div>;
  }

  return <div className="crm-insights" aria-busy={loading || undefined}>
    {pipelinePicker}
    <KpiRow>
      <KpiTile label="Open pipeline" value={view.openValue} unit="money" currency={currency} hint="Total value of open deals" />
      <KpiTile label="Weighted pipeline" value={view.weighted} unit="money" currency={currency} hint="Open value × stage probability" />
      <KpiTile label="Win rate" value={view.winRate} unit="percent" hint="Won ÷ (won + lost) deals" />
      <KpiTile label="Won this quarter" value={view.wonQuarter} unit="money" currency={currency} hint={`${view.wonQuarterCount} ${view.wonQuarterCount === 1 ? "deal" : "deals"}`} />
    </KpiRow>
    <div className="crm-insights-grid">
      {view.stageCats.length > 0 && <InsightChart title="Open pipeline by stage" kind="bar" categories={view.stageCats} series={[{ name: "Value", values: view.stageValues }]} unit="money" currency={currency} />}
      {view.months.length > 0 && <InsightChart title="Won and lost by month" kind="stacked" categories={view.months} series={[{ name: "Won", values: view.won }, { name: "Lost", values: view.lost }]} />}
      {view.conversionCats.length > 0 && <InsightChart title="Stage conversion (deals that reached each stage)" kind="bar" categories={view.conversionCats} series={[{ name: "Deals", values: view.conversionCounts }]} />}
      {view.conversionCats.length > 0 && <InsightChart title="Share of deals reaching each stage" kind="line" categories={view.conversionCats} series={[{ name: "Of the first stage", values: view.conversionRates }]} unit="percent" />}
      {view.weeks.length > 0 && <InsightChart title="Interactions per week" kind="stacked" categories={view.weeks} series={view.interactionSeries} />}
    </div>
  </div>;
}
