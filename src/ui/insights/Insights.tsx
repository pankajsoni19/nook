import { lazy, Suspense, useMemo } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { formatDuration } from "../../../shared/duration";
import { formatMoney } from "../../../shared/money";
import { REPORT_SERIES } from "../../../shared/reportTheme";
import type { Tone } from "../tone";
import "../workspace.css";

/**
 * Module Insights (§B.10, §E.3, D839): 2–4 KPI tiles, then charts, then a table — the Reports look
 * (its lazy ECharts canvas and theme, shared/reportTheme.ts) for structured dataset results. Every
 * chart has its numbers as a table under "Show as a table" (§E.1.9), and values carry their units.
 */
const EChart = lazy(() => import("../../reports/charts"));

export type InsightUnit = "number" | "percent" | "duration" | "money";

/** A value in its unit: "62%", "3h 20m", "$1,200", "1,234". */
export function formatInsightValue(value: number | null, unit: InsightUnit = "number", currency = "USD") {
  if (value === null || !Number.isFinite(value)) return "—";
  if (unit === "percent") return `${Math.round(value * 100)}%`;
  if (unit === "duration") return formatDuration(value);
  if (unit === "money") return formatMoney({ amount: Math.round(value), currency });
  return new Intl.NumberFormat().format(value);
}

export type KpiChange = { text: string; direction: "up" | "down" | "flat"; tone: Tone };

export function KpiTile({ label, value, unit = "number", currency, change, hint, text }: { label: string; value: number | null; unit?: InsightUnit; currency?: string; change?: KpiChange; hint?: string; /** Shown instead of the formatted value ("2–9"). */ text?: string }) {
  const Arrow = change?.direction === "up" ? ArrowUpRight : change?.direction === "down" ? ArrowDownRight : ArrowRight;
  return <div className="ui-kpi" title={hint}>
    <p className="ui-kpi-label">{label}</p>
    <p className="ui-kpi-value">{text ?? formatInsightValue(value, unit, currency)}</p>
    {change && <span className="ui-kpi-change ui-tone" data-tone={change.tone}><Arrow aria-hidden="true" />{change.text}</span>}
  </div>;
}

export function KpiRow({ children }: { children: React.ReactNode }) {
  return <div className="ui-kpis">{children}</div>;
}

export type InsightSeries = { name: string; values: Array<number | null> };

/** The ECharts option for a simple insight chart (bar, line, area, stacked bar, pie). Pure. */
export function insightOption(kind: "bar" | "line" | "area" | "stacked" | "pie", categories: readonly string[], series: readonly InsightSeries[], unit: InsightUnit, currency?: string) {
  const palette = REPORT_SERIES.dark;
  const format = (value: unknown) => formatInsightValue(typeof value === "number" ? value : null, unit, currency);
  if (kind === "pie") {
    const first = series[0];
    return {
      color: palette, tooltip: { trigger: "item", valueFormatter: format },
      series: [{ type: "pie", radius: ["45%", "72%"], data: categories.map((name, index) => ({ name, value: first?.values[index] ?? 0 })), label: { formatter: "{b}" } }]
    };
  }
  return {
    color: palette,
    grid: { left: 8, right: 16, top: series.length > 1 ? 36 : 16, bottom: 8, containLabel: true },
    // One scrolling row: a plain legend wraps onto more rows on a phone and runs into the plot (top is one row).
    legend: series.length > 1 ? { type: "scroll", top: 0, left: 0, right: 0 } : undefined,
    tooltip: { trigger: "axis", valueFormatter: format },
    xAxis: { type: "category", data: categories, boundaryGap: kind !== "line" && kind !== "area" },
    yAxis: { type: "value", axisLabel: { formatter: format } },
    series: series.map((entry) => ({
      name: entry.name,
      type: kind === "line" || kind === "area" ? "line" : "bar",
      data: entry.values,
      ...(kind === "area" ? { areaStyle: { opacity: .18 } } : {}),
      ...(kind === "stacked" ? { stack: "total" } : {}),
      ...(kind === "line" || kind === "area" ? { smooth: false, showSymbol: categories.length <= 12 } : { barMaxWidth: 32 })
    }))
  };
}

export function InsightChart({ title, kind, categories, series, unit = "number", currency, height = 240 }: {
  title: string;
  kind: "bar" | "line" | "area" | "stacked" | "pie";
  categories: readonly string[];
  series: readonly InsightSeries[];
  unit?: InsightUnit;
  currency?: string;
  height?: number;
}) {
  const option = useMemo(() => insightOption(kind, categories, series, unit, currency), [kind, categories, series, unit, currency]);
  return <figure className="ui-chart-card" style={{ margin: 0 }}>
    <h3>{title}</h3>
    <Suspense fallback={<div style={{ height }} role="status" aria-label={`Loading ${title}`} />}>
      <EChart option={option} label={`${title}, chart. The numbers are in the table below.`} height={height} />
    </Suspense>
    <details>
      <summary>Show as a table</summary>
      <table className="ui-chart-table">
        <thead><tr><th scope="col">{kind === "pie" ? "Part" : "Category"}</th>{series.map((entry) => <th key={entry.name} scope="col" className="number">{entry.name}</th>)}</tr></thead>
        <tbody>{categories.map((category, index) => <tr key={category}><th scope="row">{category}</th>{series.map((entry) => <td key={entry.name} className="number">{formatInsightValue(entry.values[index] ?? null, unit, currency)}</td>)}</tr>)}</tbody>
      </table>
    </details>
  </figure>;
}
