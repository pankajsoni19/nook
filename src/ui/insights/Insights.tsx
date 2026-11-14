import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { formatDuration } from "../../../shared/duration";
import { formatMoney } from "../../../shared/money";
import { REPORT_INK, REPORT_SERIES, STATUS, TYPE, type ThemeMode } from "../../../shared/reportTheme";
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

/**
 * A slice or bar's colour for a status tone (D1181): health and the like keep their meaning in a
 * chart (on track green, at risk amber, off track red), from the same tones the chips use.
 */
export const TONE_CHART: Record<ThemeMode, Record<Tone, string>> = {
  dark: { success: "#5fbf7a", warning: "#f6c453", danger: "#fb7185", info: "#7aa7f0", neutral: "#8d8d94", accent: "#f6c453" },
  light: { success: STATUS.good, warning: STATUS.warning, danger: STATUS.critical, info: REPORT_SERIES.light[1]!, neutral: REPORT_INK.light.muted, accent: REPORT_INK.light.accent }
};

/**
 * The buckets of a rating or scale chart: every value from min to max, zeros included (D1182), so
 * "3 people gave 5" reads against the whole scale rather than only the values someone picked.
 */
export function ratingBuckets(distribution: ReadonlyArray<{ value: number; count: number }>, min: number, max: number) {
  const counts = new Map(distribution.map((entry) => [entry.value, entry.count]));
  const values: Array<{ value: number; count: number }> = [];
  for (let value = min; value <= max; value += 1) values.push({ value, count: counts.get(value) ?? 0 });
  // A value outside the configured scale (the scale was edited after answers came in) still shows.
  for (const entry of distribution) if (entry.value < min || entry.value > max) values.push(entry);
  return values.sort((a, b) => a.value - b.value);
}

export type InsightOptions = {
  currency?: string;
  /** The page's theme: labels, axes, tooltip, and series colours follow it. Default dark. */
  mode?: ThemeMode;
  /** Per-category tones (pie slices, single-series bars): health charts keep health colours. */
  tones?: Readonly<Record<string, Tone>>;
};

/** The ECharts option for a simple insight chart (bar, line, area, stacked bar, pie). Pure. */
export function insightOption(kind: "bar" | "line" | "area" | "stacked" | "pie", categories: readonly string[], series: readonly InsightSeries[], unit: InsightUnit, options: InsightOptions | string = {}) {
  const { currency, mode = "dark", tones } = typeof options === "string" ? { currency: options } as InsightOptions : options;
  const palette = REPORT_SERIES[mode];
  const ink = REPORT_INK[mode];
  const colorFor = (category: string, index: number) => {
    const tone = tones?.[category];
    return tone ? TONE_CHART[mode][tone] : palette[index % palette.length]!;
  };
  const format = (value: unknown) => formatInsightValue(typeof value === "number" ? value : null, unit, currency);
  const tooltip = { backgroundColor: ink.tooltip, borderColor: ink.border, borderWidth: 1, textStyle: { color: ink.ink, fontSize: 12 } };
  const textStyle = { color: ink.ink, fontFamily: TYPE.font };
  if (kind === "pie") {
    const first = series[0];
    return {
      color: categories.map((category, index) => colorFor(category, index)), textStyle,
      tooltip: { ...tooltip, trigger: "item", valueFormatter: format },
      series: [{
        type: "pie", radius: ["45%", "72%"],
        itemStyle: { borderColor: ink.surface, borderWidth: 2 },
        data: categories.map((name, index) => ({ name, value: first?.values[index] ?? 0 })),
        // The theme's ink with no halo: ECharts' default pie label is dark text with a white outline.
        label: { formatter: "{b}", color: ink.inkSecondary, fontSize: TYPE.axis.size, textBorderWidth: 0, textShadowBlur: 0 },
        labelLine: { lineStyle: { color: ink.axis } }
      }]
    };
  }
  const colourByCategory = tones !== undefined && series.length === 1;
  return {
    color: palette, textStyle,
    grid: { left: 8, right: 16, top: series.length > 1 ? 36 : 16, bottom: 8, containLabel: true },
    // One scrolling row: a plain legend wraps onto more rows on a phone and runs into the plot (top is one row).
    legend: series.length > 1 ? { type: "scroll", top: 0, left: 0, right: 0, textStyle: { color: ink.inkSecondary }, pageTextStyle: { color: ink.muted } } : undefined,
    tooltip: { ...tooltip, trigger: "axis", valueFormatter: format },
    xAxis: { type: "category", data: categories, boundaryGap: kind !== "line" && kind !== "area", axisLabel: { color: ink.muted }, axisLine: { lineStyle: { color: ink.axis } }, axisTick: { show: false } },
    // Counts never get fractional ticks (D1182): "0.5 goals" is not a value.
    yAxis: { type: "value", ...(unit === "number" ? { minInterval: 1 } : {}), axisLabel: { color: ink.muted, formatter: format }, splitLine: { lineStyle: { color: ink.grid } } },
    series: series.map((entry) => ({
      name: entry.name,
      type: kind === "line" || kind === "area" ? "line" : "bar",
      data: colourByCategory ? entry.values.map((value, index) => ({ value, itemStyle: { color: colorFor(categories[index] ?? "", 0) } })) : entry.values,
      ...(kind === "area" ? { areaStyle: { opacity: .18 } } : {}),
      ...(kind === "stacked" ? { stack: "total" } : {}),
      ...(kind === "line" || kind === "area" ? { smooth: false, showSymbol: categories.length <= 12 } : { barMaxWidth: 32 })
    }))
  };
}

/** The root's colour scheme as a chart mode (one theme source, as Reports reads it): light only when the page says light. */
export function readInsightMode(): ThemeMode {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return "dark";
  try {
    const scheme = getComputedStyle(document.documentElement).colorScheme ?? "";
    return /\blight\b/.test(scheme) && !/\bdark\b/.test(scheme) ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** The chart mode, re-read when the root's attributes or the OS scheme change. */
export function useInsightMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>(() => readInsightMode());
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const update = () => setMode(readInsightMode());
    update();
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    observer?.observe(document.documentElement, { attributes: true });
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    media?.addEventListener?.("change", update);
    return () => { observer?.disconnect(); media?.removeEventListener?.("change", update); };
  }, []);
  return mode;
}

export function InsightChart({ title, kind, categories, series, unit = "number", currency, tones, height = 240 }: {
  title: string;
  kind: "bar" | "line" | "area" | "stacked" | "pie";
  categories: readonly string[];
  series: readonly InsightSeries[];
  unit?: InsightUnit;
  currency?: string;
  /** Per-category tones: health and other statuses keep their colours (D1181). */
  tones?: Readonly<Record<string, Tone>>;
  height?: number;
}) {
  const mode = useInsightMode();
  const option = useMemo(() => insightOption(kind, categories, series, unit, { currency, mode, tones }), [kind, categories, series, unit, currency, mode, tones]);
  return <figure className="ui-chart-card" style={{ margin: 0 }}>
    <h3>{title}</h3>
    <Suspense fallback={<div style={{ height }} role="status" aria-label={`Loading ${title}`} />}>
      <EChart option={option} mode={mode} label={`${title}, chart. The numbers are in the table below.`} height={height} />
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
