/**
 * Report filters, slice 1, in the browser (happy-dom; lane FILTERS, docs/plan/REPORT_FILTERS.md):
 * D533 "Not filtered by" only while a filter differs from its default, and "Filters N of M blocks";
 * D537 the new presets in the picker.
 */
import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import type { ReportDetail, ReportResult, ReportSpec } from "../shared/reports";
import { installDom, mockApi, render } from "./support/dom";

installDom("http://nook.test/reports");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { ReportView } = await import("../src/reports/ReportView");
const { ReportParamsContext, reachText } = await import("../src/reports/ReportParamsBar");

const REPORT_ID = "6f1d3c55-4a8e-4f8b-9a43-1f2e3d4c5b6a";
const BY_COUNTRY = "(empty({country:Array(String)}) OR country IN {country:Array(String)})";
const spec: ReportSpec = {
  version: 1, specVersion: 3, sections: [],
  parameters: [
    { id: "period", label: "Period", type: "date_range", chType: "Date", default: { preset: "30d" } },
    { id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT country FROM analytics.orders" }
  ],
  queries: [
    { key: "totals", sql: `SELECT count() AS orders FROM analytics.orders WHERE day >= {period_from:Date} AND day <= {period_to:Date} AND ${BY_COUNTRY}`, purpose: "Orders", createdBy: "agent" },
    { key: "signups", sql: "SELECT count() AS signups FROM analytics.users WHERE day >= {period_from:Date} AND day <= {period_to:Date}", purpose: "Signups", createdBy: "agent" }
  ],
  blocks: [
    { id: "kpi", type: "kpi", title: "Orders", intent: "headline", queryKey: "totals", column: "orders", unit: "orders" },
    { id: "kpi2", type: "kpi", title: "Signups", intent: "headline", queryKey: "signups", column: "signups", unit: "users" }
  ]
};
const report = {
  id: REPORT_ID, title: "Orders", datasourceId: "d", datasourceName: "Warehouse", status: "ready", isOwner: false, ownerName: "Owner", blockCount: 2,
  lastRunAt: "2026-10-13T09:00:00.000Z", createdAt: "2026-10-13T07:00:00.000Z", updatedAt: "2026-10-13T09:00:00.000Z", revision: 1, folderId: null, scheduleCadence: null,
  spec, doc: null, lastError: null
} as unknown as ReportDetail;

const result = (key: string, column: string, value: number): ReportResult => ({
  runId: "", queryKey: key, sql: "", sentSql: "", columns: [{ name: column, type: "UInt64" }], rows: [[String(value)]], rowCount: 1,
  truncated: false, rowsRead: null, bytesRead: null, chQueryId: "x", ms: 1, error: null, errorCode: null, createdAt: "2026-10-13T09:00:00.000Z", params: null
});
const results = () => [
  { queryKey: "totals", result: result("totals", "orders", 1200), failed: null, stale: false },
  { queryKey: "signups", result: result("signups", "signups", 40), failed: null, stale: false }
];

function Page({ initial }: { initial?: Record<string, string[]> }) {
  const [search, setSearch] = useState<Record<string, string[]> | undefined>(initial);
  return <ReportParamsContext.Provider value={{ search, onChange: (next) => setSearch(next) }}><ReportView report={report} canWrite={false} /></ReportParamsContext.Provider>;
}

function api() {
  return mockApi({
    [`GET /reports/${REPORT_ID}/results`]: () => ({ results: results(), running: null, timeZone: "UTC" }),
    [`GET /reports/${REPORT_ID}/runs`]: () => ({ runs: [], schedule: null }),
    [`GET /reports/${REPORT_ID}/parameters/country/options`]: () => ({ options: { paramId: "country", options: ["DE", "FR"], truncated: false, error: null, at: null } }),
    [`GET /reports/${REPORT_ID}/results?values=${encodeURIComponent(JSON.stringify({ period: { preset: "30d" }, country: ["DE"] }))}`]: () => ({ results: results(), running: null, set: { isDefault: false, values: {}, bound: {}, missing: [] } })
  });
}

const notes = () => [...document.querySelectorAll(".report-block")].map((block) => `${block.getAttribute("aria-label")}: ${block.querySelector(".report-block-unfiltered")?.textContent ?? "-"}`);

describe("D533: what each filter reaches", () => {
  test("reachText", () => {
    expect(reachText({ blocks: 4, total: 6 })).toBe("Filters 4 of 6 blocks");
    expect(reachText({ blocks: 6, total: 6 })).toBe("Filters all 6 blocks");
    expect(reachText({ blocks: 1, total: 1 })).toBe("Filters the one block");
    expect(reachText({ blocks: 0, total: 1 })).toBe("Filters 0 of 1 block");
    expect(reachText(undefined)).toBeNull();
  });

  test("\"Not filtered by\" shows only on blocks a changed filter does not reach, and only while it differs from its default", async () => {
    api();
    const plain = await render(<Page />);
    await plain.waitFor(() => document.querySelectorAll(".report-block").length === 2);
    expect(notes()).toEqual(["Orders: -", "Signups: -"]);
    await plain.rerender(<Page key="filtered" initial={{ country: ["DE"] }} />);
    const filtered = plain;
    await filtered.waitFor(() => document.querySelector(".report-block-unfiltered") !== null);
    expect(notes()).toEqual(["Orders: -", "Signups: Not filtered by Country"]);
    // The multi-select's sheet says how far the filter reaches.
    await filtered.click(document.querySelector<HTMLButtonElement>(".report-params-chips .report-param-multi")!);
    await filtered.waitFor(() => document.querySelector(".report-params-sheet .report-param-reach") !== null);
    expect(document.querySelector(".report-params-sheet .report-param-reach")?.textContent).toBe("Filters 1 of 2 blocks");
  });

  test("D537: the date picker lists the new presets in the report's zone", async () => {
    api();
    const view = await render(<Page />);
    await view.waitFor(() => document.querySelector(".report-params-chips .report-param button[role=\"combobox\"]") !== null);
    await view.click(document.querySelector<HTMLButtonElement>(".report-params-chips .report-param button[role=\"combobox\"]")!);
    const labels = await view.waitFor(() => { const items = [...document.querySelectorAll("[role=\"option\"]")].map((item) => item.textContent?.trim()); return items.length ? items : null; });
    expect(labels).toEqual(["Today (UTC)", "Yesterday (UTC)", "Last 7 days (UTC)", "Last 30 days (UTC)", "Last 90 days (UTC)", "This week (UTC)", "Last week (UTC)", "Month to date (UTC)",
      "Last month (UTC)", "Quarter to date (UTC)", "Last quarter (UTC)", "Year to date (UTC)", "Last 12 months (UTC)", "Custom range…"]);
    expect(document.querySelector(".ui-popup .report-param-reach, .ui-sheet .report-param-reach")?.textContent).toBe("Filters all 2 blocks");
  });
});

const { AddFilterSheet, readByText } = await import("../src/reports/AddFilterSheet");
const { FilterFacts } = await import("../src/reports/ProposalSheet");

describe("D534: Add filter", () => {
  const COLUMNS = {
    columns: [
      { table: "eval_top_routes.requests", column: "route", type: "LowCardinality(String)", chType: "Array(String)", comment: "", readBy: ["routes", "errors"], sensitive: false },
      { table: "eval_top_routes.requests", column: "status", type: "UInt16", chType: "Array(UInt32)", comment: "", readBy: ["routes", "errors"], sensitive: false },
      { table: "eval_top_routes.requests", column: "user_email", type: "String", chType: "Array(String)", comment: "", readBy: ["routes", "errors"], sensitive: true }
    ],
    queries: 2, slotsLeft: 8
  };
  const PREVIEW = { preview: { column: COLUMNS.columns[0], optionsQuery: "SELECT …", sample: ["healthz", "digest", "search", "orders"], optionCount: 4, truncated: false, distinct: 4, suggested: { id: "route", label: "Route" } } };

  test("readByText", () => {
    expect(readByText(2, 2)).toBe("read by all 2 queries");
    expect(readByText(3, 5)).toBe("read by 3 of 5 queries");
    expect(readByText(1, 1)).toBe("read by the report's query");
  });

  test("columns from the catalog (personal-looking ones hidden until asked), sample values and the exposure note, then the request", async () => {
    const api = mockApi({
      [`GET /reports/${REPORT_ID}/filters/columns`]: () => COLUMNS,
      [`POST /reports/${REPORT_ID}/filters/preview`]: () => PREVIEW,
      [`POST /reports/${REPORT_ID}/filters`]: (call) => ({ instruction: { id: "i1", text: "Add a filter", request: { kind: "add_filter", ...(call.body as object) } } })
    });
    let requested = 0;
    const view = await render(<AddFilterSheet reportId={REPORT_ID} onClose={() => undefined} onRequested={() => { requested += 1; }} />);
    await view.waitFor(() => document.querySelectorAll(".report-add-filter-column").length === 2);
    const names = () => [...document.querySelectorAll(".report-add-filter-column code")].map((item) => item.textContent);
    expect(names()).toEqual(["route", "status"]);
    expect(document.querySelector(".report-add-filter-meta")?.textContent).toBe("eval_top_routes.requests · LowCardinality(String) · read by all 2 queries");
    expect(document.querySelector(".report-add-filter-toggle")?.textContent).toContain("Show 1 column that looks personal");
    await view.click(document.querySelector(".report-add-filter-toggle input")!);
    expect(names()).toEqual(["route", "status", "user_email"]);
    expect(view.button("Ask for the filter")!.disabled).toBe(true);
    await view.click(document.querySelector(".report-add-filter-column")!);
    await view.waitFor(() => document.querySelector(".report-add-filter-values"));
    expect([...document.querySelectorAll(".report-add-filter-values li")].map((item) => item.textContent)).toEqual(["healthz", "digest", "search", "orders"]);
    expect(document.querySelector(".report-add-filter-exposure")?.textContent).toBe("Readers will see the values of eval_top_routes.requests.route.");
    expect((document.querySelector(".report-add-filter-preview input") as HTMLInputElement).value).toBe("Route");
    await view.click(view.button("Ask for the filter")!);
    await view.waitFor(() => requested === 1);
    expect(api.calls.find((call) => call.method === "POST" && call.path.endsWith("/filters"))?.body).toEqual({ table: "eval_top_routes.requests", column: "route", label: "Route" });
  });

  test("the proposal's facts: default results unchanged on each changed query, the value it ran with, and the untouched queries", async () => {
    await render(<FilterFacts filter={{
      request: { kind: "add_filter", id: "route", label: "Route", table: "eval_top_routes.requests", column: "route", chType: "Array(String)", optionsQuery: "" },
      checked: [{ key: "errors", rows: 1, otherValue: "digest", otherRows: 1 }],
      untouched: [{ key: "routes", reason: "Shows every route; clicking it sets the filter" }],
      reach: { blocks: 1, total: 2 }
    }} />);
    const text = document.querySelector(".report-proposal-filter")?.textContent ?? "";
    expect(text).toContain("New filterRoute");
    expect(text).toContain("Filters 1 of 2 blocks; it starts at All.");
    expect(text).toContain("errorsDefault results unchangedRan with Route = digest: 1 row");
    expect(text).toContain("Not filteredroutesShows every route; clicking it sets the filter");
  });
});
