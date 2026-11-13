import { Fragment, useEffect, useMemo, useState } from "react";
import { ChartColumn, ChevronDown, ChevronRight, Download } from "lucide-react";
import { api } from "../api";
import { Select } from "../ui/Select";
import { EmptyState } from "../ui/EmptyState";
import { InsightChart, KpiRow, KpiTile } from "../ui/insights/Insights";
import { MoneyText } from "../ui/money/Money";
import { useUnitPreferences } from "../ui/units";
import { formatDuration } from "../../shared/duration";
import { addDays, SUMMARY_GROUP_LABELS, weekStartOf, type Summary, type SummaryGroup, type TimeProject } from "../../shared/time";
import type { DatasetResult, StructuredQuery } from "../../shared/datasets";
import { timeApi, viewerZone } from "./api";
import { localDay } from "./format";
import { errorText, onTimeChanged } from "./timerStore";

/**
 * Reports (§D.2 "Reports", §B.10, §E.4 Insights): filters on top (range, project, person, billable),
 * group-by chips (project, client, person, work item, tag), report-time rounding (D875), then KPI
 * tiles (total, billable share, amount where the viewer may see money, entries), the hours by day
 * from the `time.entries` dataset, a donut by the chosen group, and the table with a second level,
 * and CSV of the same filters.
 */

type Range = "this_week" | "last_week" | "this_month" | "last_month" | "last_30" | "this_year";
const RANGES: Array<{ value: Range; label: string }> = [
  { value: "this_week", label: "This week" }, { value: "last_week", label: "Last week" }, { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" }, { value: "last_30", label: "Last 30 days" }, { value: "this_year", label: "This year" }
];
const GROUPS: SummaryGroup[] = ["project", "client", "user", "target", "tag"];
const SUB_GROUPS: Array<SummaryGroup | ""> = ["", "user", "project", "target", "tag", "billable", "week"];

export function rangeDates(range: Range, today: string, weekStart: 0 | 1 | 6): { from: string; to: string } {
  const month = today.slice(0, 7);
  switch (range) {
    case "this_week": { const from = weekStartOf(today, weekStart); return { from, to: addDays(from, 6) }; }
    case "last_week": { const from = addDays(weekStartOf(today, weekStart), -7); return { from, to: addDays(from, 6) }; }
    case "this_month": return { from: `${month}-01`, to: today };
    case "last_month": {
      const first = `${month}-01`;
      const end = addDays(first, -1);
      return { from: `${end.slice(0, 7)}-01`, to: end };
    }
    case "last_30": return { from: addDays(today, -29), to: today };
    case "this_year": return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

export function ReportsTab({ onOpen, userId }: { onOpen: (href: string) => void; userId: string }) {
  const prefs = useUnitPreferences();
  const [range, setRange] = useState<Range>("this_month");
  const [group, setGroup] = useState<SummaryGroup>("project");
  const [sub, setSub] = useState<SummaryGroup | "">("user");
  const [person, setPerson] = useState<"all" | "me">("all");
  const [billable, setBillable] = useState<"" | "true" | "false">("");
  const [rounding, setRounding] = useState("0");
  const [projectId, setProjectId] = useState("");
  const [projects, setProjects] = useState<TimeProject[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [daily, setDaily] = useState<DatasetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);
  const dates = useMemo(() => rangeDates(range, localDay(), prefs.weekStart), [range, prefs.weekStart]);
  const query = useMemo(() => ({
    from: dates.from, to: dates.to, user: person, billable: billable || undefined, rounding, project: projectId || undefined,
    groupBy: [group, ...(sub && sub !== group ? [sub] : [])].join(",")
  }), [dates, person, billable, rounding, projectId, group, sub]);

  useEffect(() => { void timeApi.projects().then((body) => setProjects(body.projects), () => undefined); }, []);
  useEffect(() => onTimeChanged(() => setReload((value) => value + 1)), []);
  useEffect(() => {
    let alive = true;
    setError(null);
    timeApi.summary(query).then((body) => { if (alive) setSummary(body); }, (reason) => { if (alive) setError(errorText(reason, "Could not load the report")); });
    const filters: StructuredQuery["filters"] = [
      ...(projectId ? [{ column: "project_id", op: "eq" as const, value: projectId }] : []),
      ...(billable ? [{ column: "billable", op: "eq" as const, value: billable === "true" }] : [])
    ];
    const dataset: StructuredQuery = { dataset: "time.entries", measures: [{ fn: "sum", column: "seconds", as: "seconds" }], dimensions: ["billable"], timeBucket: "day", timeRange: { from: dates.from, to: dates.to }, tz: viewerZone(), filters, limit: 1000 };
    const mine = person === "me" ? [{ column: "person_id", op: "eq" as const, value: userId }] : [];
    void api<DatasetResult>("/datasets/query", { method: "POST", body: JSON.stringify({ ...dataset, filters: [...filters, ...mine] }) }).then((body) => { if (alive) setDaily(body); }, () => { if (alive) setDaily(null); });
    return () => { alive = false; };
  }, [query, reload, dates, projectId, billable, person, userId]);

  const chart = useMemo(() => {
    if (!daily) return null;
    const days: string[] = [];
    for (let day = dates.from; day <= dates.to && days.length < 400; day = addDays(day, 1)) days.push(day);
    const billableValues = new Map<string, number>();
    const other = new Map<string, number>();
    for (const row of daily.rows) {
      const [isBillable, bucket, seconds] = row as [boolean, string, number | null];
      (isBillable ? billableValues : other).set(bucket, (seconds ?? 0) / 3600);
    }
    const labels = days.map((day) => day.slice(5));
    return { labels, series: [{ name: "Billable", values: days.map((day) => Math.round((billableValues.get(day) ?? 0) * 100) / 100) }, { name: "Non-billable", values: days.map((day) => Math.round((other.get(day) ?? 0) * 100) / 100) }] };
  }, [daily, dates]);

  const totals = summary?.totals;
  const currency = summary?.currency ?? undefined;
  return <div className="time-tab time-reports-tab">
    <div className="time-report-filters">
      <Select label="Range" variant="chip" value={range} onChange={setRange} options={RANGES} />
      <Select label="Project" variant="chip" value={projectId} searchable="auto" onChange={setProjectId} options={[{ value: "", label: "All projects" }, { value: "none", label: "No project" }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} />
      <Select label="People" variant="chip" value={person} onChange={setPerson} options={[{ value: "all", label: "Everyone I can see" }, { value: "me", label: "Only me" }]} />
      <Select label="Billable" variant="chip" value={billable} onChange={setBillable} options={[{ value: "", label: "Billable and not" }, { value: "true", label: "Billable" }, { value: "false", label: "Non-billable" }]} />
      <Select label="Rounding" variant="chip" value={rounding} onChange={setRounding} options={[{ value: "0", label: "No rounding" }, { value: "6", label: "Round to 6 min" }, { value: "15", label: "Round to 15 min" }, { value: "30", label: "Round to 30 min" }]} />
      <a className="secondary-button ui-small-button time-export" href={timeApi.exportHref(query)} download><Download aria-hidden="true" />CSV</a>
    </div>
    <div className="time-report-groups">
      <div className="ui-segmented" role="group" aria-label="Group by">
        {GROUPS.map((value) => <button key={value} type="button" aria-pressed={group === value} onClick={() => { setGroup(value); setOpen(new Set()); }}>{SUMMARY_GROUP_LABELS[value]}</button>)}
      </div>
      <Select label="Then by" variant="chip" value={sub} onChange={setSub} options={SUB_GROUPS.filter((value) => value !== group).map((value) => ({ value, label: value ? `Then by ${SUMMARY_GROUP_LABELS[value].toLowerCase()}` : "No second level" }))} />
    </div>
    {error && <p className="ui-field-error" role="alert">{error}</p>}
    {!summary && !error && <p className="time-loading" role="status">Loading the report…</p>}
    {summary && totals && <>
      <KpiRow>
        <KpiTile label="Total" value={totals.seconds} unit="duration" />
        <KpiTile label="Billable" value={totals.billableSeconds} unit="duration" hint="Billable time" change={totals.seconds ? { text: `${Math.round((totals.billableSeconds / totals.seconds) * 100)}% of the total`, direction: "flat", tone: "neutral" } : undefined} />
        <KpiTile label="Amount" value={totals.amountMinor} unit="money" currency={currency} text={totals.amountMinor === null ? (summary.mixedCurrency ? "Several currencies" : "—") : undefined} hint="Billable amounts you may see" />
        <KpiTile label="Entries" value={totals.entries} />
      </KpiRow>
      {totals.entries === 0
        ? <EmptyState icon={ChartColumn} title="No time in this range." compact>Try a longer range or another project.</EmptyState>
        : <>
          <div className="time-charts">
            {chart && <InsightChart title="Hours by day" kind="stacked" categories={chart.labels} series={chart.series} unit="number" />}
            <InsightChart title={`By ${SUMMARY_GROUP_LABELS[group].toLowerCase()}`} kind="pie" categories={summary.rows.slice(0, 10).map((row) => row.label)} series={[{ name: "Hours", values: summary.rows.slice(0, 10).map((row) => Math.round((row.seconds / 3600) * 100) / 100) }]} unit="number" />
          </div>
          <table className="time-report-table">
            <thead><tr><th scope="col">{SUMMARY_GROUP_LABELS[group]}</th><th scope="col" className="number">Time</th><th scope="col" className="number hide-phone">Billable</th><th scope="col" className="number">Amount</th></tr></thead>
            <tbody>
              {summary.rows.map((row) => {
                const expanded = open.has(row.key);
                return <Fragment key={row.key || "none"}>
                  <tr className="time-report-row">
                    <th scope="row">
                      {row.sub?.length
                        ? <button type="button" className="time-expand" aria-expanded={expanded} onClick={() => setOpen((current) => { const next = new Set(current); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return next; })}>
                          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{row.color && <span className="time-dot" style={{ background: row.color }} aria-hidden="true" />}{row.label}
                        </button>
                        : row.href ? <a href={row.href} onClick={(event) => { event.preventDefault(); onOpen(row.href!); }}>{row.label}</a> : <span>{row.label}</span>}
                    </th>
                    <td className="number ui-tabular">{formatDuration(row.seconds, prefs.durationFormat)}</td>
                    <td className="number ui-tabular hide-phone">{formatDuration(row.billableSeconds, prefs.durationFormat)}</td>
                    <td className="number ui-tabular">{row.amountMinor !== null && currency ? <MoneyText money={{ amount: row.amountMinor, currency }} /> : "—"}</td>
                  </tr>
                  {expanded && row.sub?.map((child) => <tr key={`${row.key}:${child.key}`} className="time-report-sub">
                    <th scope="row">{child.label}</th>
                    <td className="number ui-tabular">{formatDuration(child.seconds, prefs.durationFormat)}</td>
                    <td className="number ui-tabular hide-phone">{formatDuration(child.billableSeconds, prefs.durationFormat)}</td>
                    <td className="number ui-tabular">{child.amountMinor !== null && currency ? <MoneyText money={{ amount: child.amountMinor, currency }} /> : "—"}</td>
                  </tr>)}
                </Fragment>;
              })}
            </tbody>
            <tfoot><tr><th scope="row">Total</th><td className="number ui-tabular">{formatDuration(totals.seconds, prefs.durationFormat)}</td><td className="number ui-tabular hide-phone">{formatDuration(totals.billableSeconds, prefs.durationFormat)}</td><td className="number ui-tabular">{totals.amountMinor !== null && currency ? <MoneyText money={{ amount: totals.amountMinor, currency }} /> : "—"}</td></tr></tfoot>
          </table>
        </>}
    </>}
  </div>;
}
