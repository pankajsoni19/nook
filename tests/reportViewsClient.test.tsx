/**
 * Saved views in the browser (happy-dom; lane FILT2, D565, D566): "my default view" opens a report whose
 * URL names no values (history replace, once); the chip names the view on show; a view's values that
 * no longer fit read as their defaults; the owner's Save as report default is one update_parameter per
 * changed filter.
 */
import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import type { ReportDetail, ReportResult, ReportSpec } from "../shared/reports";
import { installDom, mockApi, render } from "./support/dom";

installDom("http://nook.test/reports");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart">chart</div> }));

const { ReportView } = await import("../src/reports/ReportView");
const { ReportParamsContext } = await import("../src/reports/ReportParamsBar");
const { activeView, defaultOps, viewSummary, viewValues } = await import("../src/reports/ReportViews");

const REPORT_ID = "9c1d3c55-4a8e-4f8b-9a43-1f2e3d4c5b6a";
const spec: ReportSpec = {
  version: 1, specVersion: 3, sections: [],
  parameters: [
    { id: "period", label: "Period", type: "date_range", chType: "Date", default: { preset: "30d" } },
    { id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT country FROM analytics.orders" }
  ],
  queries: [{ key: "totals", sql: "SELECT count() AS orders FROM analytics.orders WHERE day >= {period_from:Date} AND day <= {period_to:Date} AND (empty({country:Array(String)}) OR country IN {country:Array(String)})", purpose: "", createdBy: "agent" }],
  blocks: [{ id: "kpi", type: "kpi", title: "Orders", intent: "headline", queryKey: "totals", column: "orders", unit: "orders" }]
};
const report = {
  id: REPORT_ID, title: "Orders", datasourceId: "d", datasourceName: "Warehouse", status: "ready", isOwner: false, ownerName: "Owner", blockCount: 1,
  lastRunAt: "2026-10-13T09:00:00.000Z", createdAt: "2026-10-13T07:00:00.000Z", updatedAt: "2026-10-13T09:00:00.000Z", revision: 1, folderId: null, scheduleCadence: null,
  spec, doc: null, lastError: null
} as unknown as ReportDetail;
const result: ReportResult = {
  runId: "", queryKey: "totals", sql: "", sentSql: "", columns: [{ name: "orders", type: "UInt64" }], rows: [["12"]], rowCount: 1,
  truncated: false, rowsRead: null, bytesRead: null, chQueryId: "x", ms: 1, error: null, errorCode: null, createdAt: "2026-10-13T09:00:00.000Z", params: null
};
const VIEWS = [
  { id: "v1", name: "Germany", values: { country: ["DE"] }, isDefault: true, createdAt: "", updatedAt: "" },
  { id: "v2", name: "Old", values: { country: ["DE"], gone: 1, period: { preset: "2y" } }, isDefault: false, createdAt: "", updatedAt: "" }
];

describe("D565: views", () => {
  test("a view's values for the report as it is now, the view on show, and the summary", () => {
    expect(viewValues(spec.parameters, VIEWS[1]!)).toEqual({ period: { preset: "30d" }, country: ["DE"] });
    expect(activeView(spec.parameters, { period: { preset: "30d" }, country: ["DE"] }, VIEWS)?.id).toBe("v1");
    expect(activeView(spec.parameters, { period: { preset: "7d" }, country: [] }, VIEWS)).toBeNull();
    expect(viewSummary(spec.parameters, { period: { preset: "7d" }, country: ["DE"] })).toBe("Period: Last 7 days · Country: DE");
    expect(viewSummary(spec.parameters, {})).toBe("The report's defaults");
    expect(defaultOps(spec.parameters, { period: { preset: "30d" }, country: ["FR"] })).toEqual([{ op: "update_parameter", id: "country", set: { default: ["FR"] } }]);
  });

  test("my default view opens a clean URL (replace, once), and the chip names it; a URL with values keeps them", async () => {
    mockApi({
      [`GET /reports/${REPORT_ID}/results`]: () => ({ results: [{ queryKey: "totals", result, failed: null, stale: false }], running: null, timeZone: "UTC" }),
      [`GET /reports/${REPORT_ID}/results?values=${encodeURIComponent(JSON.stringify({ period: { preset: "30d" }, country: ["DE"] }))}`]: () => ({ results: [{ queryKey: "totals", result, failed: null, stale: false }], running: null, set: { isDefault: false, values: {}, bound: {}, missing: [] } }),
      [`GET /reports/${REPORT_ID}/results?values=${encodeURIComponent(JSON.stringify({ period: { preset: "7d" }, country: [] }))}`]: () => ({ results: [{ queryKey: "totals", result, failed: null, stale: false }], running: null, set: { isDefault: false, values: {}, bound: {}, missing: [] } }),
      [`GET /reports/${REPORT_ID}/runs`]: () => ({ runs: [], schedule: null }),
      [`GET /reports/${REPORT_ID}/views`]: () => ({ views: VIEWS, canSaveDefault: false }),
      [`GET /reports/${REPORT_ID}/parameters/country/options`]: () => ({ options: { paramId: "country", options: ["DE", "FR"], truncated: false, error: null, at: null } })
    });
    const changes: Array<{ search: Record<string, string[]> | undefined; replace: boolean }> = [];
    function Page({ initial }: { initial?: Record<string, string[]> }) {
      const [search, setSearch] = useState<Record<string, string[]> | undefined>(initial);
      return <ReportParamsContext.Provider value={{ search, onChange: (next, options) => { changes.push({ search: next, replace: Boolean(options?.replace) }); setSearch(next); } }}><ReportView report={report} canWrite={false} /></ReportParamsContext.Provider>;
    }
    const view = await render(<Page />);
    await view.waitFor(() => changes.length > 0);
    expect(changes).toEqual([{ search: { country: ["DE"] }, replace: true }]);
    await view.waitFor(() => document.querySelector(".report-params-views")?.textContent === "View: Germany");
    // Reset to defaults afterwards is not undone by the default view.
    await view.click(view.button("Reset to defaults")!);
    await Bun.sleep(30);
    expect(changes.at(-1)).toEqual({ search: undefined, replace: false });
    expect(changes.length).toBe(2);
    view.container.remove();

    changes.length = 0;
    const linked = await render(<Page initial={{ period: ["7d"] }} />);
    await linked.waitFor(() => document.querySelectorAll(".report-params-views").length > 0);
    await Bun.sleep(30);
    expect(changes).toEqual([]);
  });
});

describe("D674: Save as report default names the refused blocks and fixes the obvious ones", () => {
  test("a KPI without a format or unit: the refusal names it with Show the block; picking a format sends it with the defaults", async () => {
    const { ViewsSheet } = await import("../src/reports/ReportViews");
    const { ApiError } = await import("../src/api");
    const sent: unknown[] = [];
    const shown: string[] = [];
    const onSaveDefault = async (fixes?: unknown[]) => {
      sent.push(fixes ?? null);
      if (sent.length === 1) throw new ApiError("block kpi: rule 8: the measure orders needs a format (number, percent, duration, currency:<ISO>) or a unit", 400, {
        error: "…", code: "INVALID", details: ["block kpi: rule 8: the measure orders needs a format (number, percent, duration, currency:<ISO>) or a unit", "block chart: rule 10: the query returned no rows; a chart needs data (filter less, or use a table or markdown note)"]
      });
    };
    const blocks = [{ id: "kpi", type: "kpi", title: "Orders" }, { id: "chart", type: "chart", title: "By day" }] as never;
    const view = await render(<ViewsSheet reportId={REPORT_ID} parameters={spec.parameters} values={{ period: { preset: "7d" }, country: [] }} views={[]} canSaveDefault
      onApply={() => undefined} onChanged={() => undefined} onSaveDefault={onSaveDefault as never} blocks={blocks} onShowBlock={(id) => shown.push(id)} onClose={() => undefined} reopen={() => undefined} />);
    await view.click(view.button("Save as report default")!);
    await view.waitFor(() => document.querySelectorAll(".report-views-refusal").length === 2);
    expect(document.querySelector(".report-views-refused > p")?.textContent).toBe("The design rules refuse these 2 blocks with the new defaults:");
    const rows = [...document.querySelectorAll(".report-views-refusal")];
    expect(rows.map((row) => `${row.querySelector("b")?.textContent}|${row.querySelector("small")?.textContent}`)).toEqual([
      "Orders|The measure orders needs a format (number, percent, duration, currency:<ISO>) or a unit.",
      "By day|The query returned no rows; a chart needs data (filter less, or use a table or markdown note)."
    ]);
    // Only the rule with an obvious fix offers one; both link to their block.
    expect(rows.map((row) => row.querySelector(".report-views-fix") !== null)).toEqual([true, false]);
    expect(document.querySelector(".form-error")).toBeNull();
    await view.click(view.button("Show the block", rows[1])!);
    expect(shown).toEqual(["chart"]);
    await view.click(rows[0]!.querySelector("button[role=\"combobox\"]")!);
    const percent = await view.waitFor(() => [...document.querySelectorAll("[role=\"option\"]")].find((item) => item.textContent?.trim() === "Percent"));
    await view.click(percent);
    await view.click(await view.waitFor(() => view.button("Fix the block and save as default")));
    await view.waitFor(() => sent.length === 2);
    expect(sent).toEqual([null, [{ op: "update_block", id: "kpi", set: { format: "percent" } }]]);
    await view.waitFor(() => document.querySelector(".report-views-refused") === null);
  });
});
