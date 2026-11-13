import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import { api } from "../api";
import { InsightChart, KpiRow, KpiTile } from "../ui/insights/Insights";
import { EmptyState } from "../ui/EmptyState";
import { errorText } from "../ui/notify";
import { HEALTH_LABEL, type Health } from "../ui/tone";

/**
 * Goals → Insights (§B.10, §E.4): preset structured queries over the module's datasets
 * (`goals.key_results`, `goals.checkins`), scoped by the server to goals the viewer can open, for the
 * chosen period. KPI tiles, then charts (each with its table fallback).
 */

type Result = { columns: Array<{ name: string }>; rows: Array<Array<string | number | null>> };
const query = (body: Record<string, unknown>) => api<Result>("/datasets/query", { method: "POST", body: JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", ...body }) });

type Data = { goals: number; avg: number | null; onTrack: number; checkins30: number; health: Array<[string, number]>; weekly: Array<[string, number]>; byOwner: Array<[string, number]>; confidence: Array<[string, number]> };

export default function GoalInsights({ periodName }: { periodName: string | null }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const period = periodName ? [{ column: "period", op: "eq", value: periodName }] : [];
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const quarterAgo = new Date(Date.now() - 91 * 86_400_000).toISOString().slice(0, 10);
    Promise.all([
      query({ dataset: "goals.key_results", measures: [{ fn: "count_distinct", column: "goal_id" }, { fn: "avg", column: "goal_progress" }], filters: [...period, { column: "state", op: "in", value: ["active", "draft"] }] }),
      query({ dataset: "goals.key_results", measures: [{ fn: "count_distinct", column: "goal_id" }], dimensions: ["health"], filters: [...period, { column: "state", op: "in", value: ["active", "draft"] }] }),
      query({ dataset: "goals.checkins", measures: [{ fn: "count" }], filters: period, timeRange: { from: since } }),
      query({ dataset: "goals.checkins", measures: [{ fn: "count" }], timeBucket: "week", filters: period, timeRange: { from: quarterAgo } }),
      query({ dataset: "goals.key_results", measures: [{ fn: "avg", column: "goal_progress" }], dimensions: ["owner"], filters: period, sort: [{ column: "avg_goal_progress", dir: "desc" }], limit: 12 }),
      query({ dataset: "goals.checkins", measures: [{ fn: "avg", column: "confidence" }], timeBucket: "week", filters: period, timeRange: { from: quarterAgo } })
    ]).then(([totals, health, recent, weekly, byOwner, confidence]) => {
      const healthRows = health.rows.map((row) => [HEALTH_LABEL[(row[0] ?? "none") as Health] ?? String(row[0]), Number(row[1] ?? 0)] as [string, number]);
      const onTrack = health.rows.filter((row) => row[0] === "on_track").reduce((sum, row) => sum + Number(row[1] ?? 0), 0);
      setData({
        goals: Number(totals.rows[0]?.[0] ?? 0), avg: totals.rows[0]?.[1] === null || totals.rows[0]?.[1] === undefined ? null : Number(totals.rows[0][1]), onTrack,
        checkins30: Number(recent.rows[0]?.[0] ?? 0), health: healthRows, weekly: weekly.rows.map((row) => [String(row[0]), Number(row[1] ?? 0)]),
        byOwner: byOwner.rows.map((row) => [String(row[0] ?? "—"), Math.round(Number(row[1] ?? 0) * 100)]), confidence: confidence.rows.map((row) => [String(row[0]), Math.round(Number(row[1] ?? 0) * 10) / 10])
      });
    }, (reason) => setError(errorText(reason, "Could not load insights")));
  }, [periodName]);
  if (error) return <p className="ui-field-error" role="alert">{error}</p>;
  if (!data) return <p className="ui-panel-loading" role="status">Loading insights…</p>;
  if (!data.goals) return <EmptyState icon={BarChart3} title={periodName ? `No goals with key results in ${periodName}` : "No goals with key results yet"}>Insights count goals that have key results.</EmptyState>;
  return <div className="ui-insights" style={{ display: "grid", gap: 16 }}>
    <KpiRow>
      <KpiTile label="Open goals" value={data.goals} />
      <KpiTile label="Average progress" value={data.avg} unit="percent" />
      <KpiTile label="On track" value={data.goals ? data.onTrack / data.goals : null} unit="percent" hint={`${data.onTrack} of ${data.goals}`} />
      <KpiTile label="Check-ins, last 30 days" value={data.checkins30} />
    </KpiRow>
    <div className="goals-grid-2">
      <InsightChart title="Goals by health" kind="pie" categories={data.health.map((row) => row[0])} series={[{ name: "Goals", values: data.health.map((row) => row[1]) }]} />
      <InsightChart title="Check-ins per week" kind="bar" categories={data.weekly.map((row) => row[0])} series={[{ name: "Check-ins", values: data.weekly.map((row) => row[1]) }]} />
    </div>
    <div className="goals-grid-2">
      <InsightChart title="Average progress by owner (%)" kind="bar" categories={data.byOwner.map((row) => row[0])} series={[{ name: "Progress %", values: data.byOwner.map((row) => row[1]) }]} />
      <InsightChart title="Average confidence per week (1–10)" kind="bar" categories={data.confidence.map((row) => row[0])} series={[{ name: "Confidence", values: data.confidence.map((row) => row[1]) }]} />
    </div>
  </div>;
}
