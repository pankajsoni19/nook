import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import { api } from "../api";
import { InsightChart, KpiRow, KpiTile } from "../ui/insights/Insights";
import { EmptyState } from "../ui/EmptyState";
import type { DatasetResult, StructuredQuery } from "../../shared/datasets";
import type { FormsNav } from "./FormsApp";

/**
 * Forms Insights (§B.10, §E.4 "Insights tabs"): preset structured queries on the `forms.responses`
 * dataset (only forms whose results you can read, the dataset's own predicate): KPI tiles, responses
 * per week, by form, and by respondent kind, each chart with its table (the Reports wrapper).
 */
const ZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
const query = (body: StructuredQuery) => api<DatasetResult>("/datasets/query", { method: "POST", body: JSON.stringify(body) });
const RANGES = [{ id: "30", label: "30 days" }, { id: "90", label: "90 days" }, { id: "365", label: "12 months" }] as const;

export default function FormsInsights({ nav }: { nav: FormsNav }) {
  void nav;
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("90");
  const [data, setData] = useState<{ total: number; forms: number; avgScore: number | null; weeks: DatasetResult; byForm: DatasetResult; byKind: DatasetResult; publicShare: number | null } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const from = new Date(Date.now() - Number(range) * 86_400_000).toISOString().slice(0, 10);
    const base = { dataset: "forms.responses", timeRange: { from }, tz: ZONE };
    setData(null);
    setFailed(false);
    Promise.all([
      query({ ...base, measures: [{ fn: "count", as: "responses" }, { fn: "count_distinct", column: "form_id", as: "forms" }, { fn: "avg", column: "score", as: "score" }] }),
      query({ ...base, measures: [{ fn: "count", as: "responses" }], timeBucket: Number(range) > 120 ? "month" : "week", sort: [{ column: "bucket", dir: "asc" }] }),
      query({ ...base, measures: [{ fn: "count", as: "responses" }], dimensions: ["form"], sort: [{ column: "responses", dir: "desc" }], limit: 10 }),
      query({ ...base, measures: [{ fn: "count", as: "responses" }], dimensions: ["kind"] }),
      query({ ...base, measures: [{ fn: "count", as: "responses" }], dimensions: ["public"] })
    ]).then(([totals, weeks, byForm, byKind, byPublic]) => {
      const row = totals.rows[0] ?? [];
      const total = Number(row[0] ?? 0);
      const publicCount = byPublic.rows.filter((item) => item[0] === 1 || item[0] === true).reduce((sum, item) => sum + Number(item[1] ?? 0), 0);
      setData({ total, forms: Number(row[1] ?? 0), avgScore: row[2] === null || row[2] === undefined ? null : Math.round(Number(row[2]) * 10) / 10, weeks, byForm, byKind, publicShare: total ? publicCount / total : null });
    }).catch(() => setFailed(true));
  }, [range]);
  if (failed) return <EmptyState icon={BarChart3} title="Insights could not load">Try again in a moment.</EmptyState>;
  return <div className="forms-insights">
    <div className="ui-segmented" role="group" aria-label="Period">{RANGES.map((item) => <button key={item.id} type="button" aria-pressed={range === item.id} onClick={() => setRange(item.id)}>{item.label}</button>)}</div>
    {!data ? <p className="ui-panel-loading" role="status">Loading…</p> : data.total === 0 ? <EmptyState icon={BarChart3} title="No responses in this period">Insights count responses to forms whose results you can see.</EmptyState> : <>
      <KpiRow>
        <KpiTile label="Responses" value={data.total} />
        <KpiTile label="Forms answered" value={data.forms} />
        <KpiTile label="Through public links" value={data.publicShare} unit="percent" />
        <KpiTile label="Average score" value={data.avgScore} hint="Forms with scored questions" />
      </KpiRow>
      <InsightChart title={`Responses per ${Number(range) > 120 ? "month" : "week"}`} kind="bar" categories={data.weeks.rows.map((row) => String(row[0]))} series={[{ name: "Responses", values: data.weeks.rows.map((row) => Number(row[1] ?? 0)) }]} />
      <div className="forms-insight-pair">
        <InsightChart title="Most answered" kind="bar" categories={data.byForm.rows.map((row) => String(row[0]))} series={[{ name: "Responses", values: data.byForm.rows.map((row) => Number(row[1] ?? 0)) }]} height={260} />
        <InsightChart title="By kind" kind="pie" categories={data.byKind.rows.map((row) => row[0] === "poll" ? "Polls" : row[0] === "time_poll" ? "Find a time" : "Forms")} series={[{ name: "Responses", values: data.byKind.rows.map((row) => Number(row[1] ?? 0)) }]} height={260} />
      </div>
    </>}
  </div>;
}
