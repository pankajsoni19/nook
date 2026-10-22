/**
 * A table block's sort and contains box (lane FILT2, D563, D564; docs/plan/REPORT_FILTERS.md "Later" 2):
 * client side over the loaded rows, personal, kept in the URL (`?t.<block>=col.desc`, `?tq.<block>=text`)
 * with history replace; "within the first N rows" when the query's rows were cut; keyboard reachable.
 */
import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import type { ReportDetail, ReportResult, ReportSpec } from "../shared/reports";
import { installDom, mockApi, render } from "./support/dom";

installDom("http://nook.test/reports");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart">chart</div> }));

const { ReportView } = await import("../src/reports/ReportView");
const { ReportParamsContext } = await import("../src/reports/ReportParamsBar");
const { containsRows, nextSort, parseSort, sortRows } = await import("../src/reports/tableView");
const { formatReportParams, parseReportParams } = await import("../src/router");

const COLUMNS = [{ name: "route", type: "LowCardinality(String)" }, { name: "requests", type: "UInt64" }, { name: "avg_ms", type: "Nullable(Float64)" }];
const ROWS: unknown[][] = [["/orders", "1500", 120.5], ["/search", "9000", null], ["/digest", "250", 40], ["/health", "18000", 3], ["/api/a", "90", 800], ["/api/b", "91", 790], ["/api/c", "92", 780], ["/api/d", "93", 770], ["/api/e", "94", 760], ["/api/f", "95", null]];

describe("D563: sort and contains over loaded rows", () => {
  test("parseSort reads `column.direction` (a dotted column too) and refuses anything else", () => {
    expect(parseSort("requests.desc", COLUMNS)).toEqual({ column: "requests", desc: true });
    expect(parseSort("route.asc", COLUMNS)).toEqual({ column: "route", desc: false });
    expect(parseSort("a.b.desc", [{ name: "a.b" }])).toEqual({ column: "a.b", desc: true });
    for (const raw of [undefined, "", "requests", "requests.up", "nope.desc", ".desc"]) expect(parseSort(raw, COLUMNS)).toBeNull();
  });

  test("a header click goes ascending, descending, then back to the query's order", () => {
    expect(nextSort(null, "route")).toEqual({ column: "route", desc: false });
    expect(nextSort({ column: "route", desc: false }, "route")).toEqual({ column: "route", desc: true });
    expect(nextSort({ column: "route", desc: true }, "route")).toBeNull();
    expect(nextSort({ column: "route", desc: true }, "requests")).toEqual({ column: "requests", desc: false });
  });

  test("numbers sort as numbers, NULLs stay last either way, ties keep the query's order", () => {
    const by = (column: string, desc: boolean) => sortRows(ROWS, COLUMNS, { column, desc }).map((row) => row[0]);
    expect(by("requests", true).slice(0, 4)).toEqual(["/health", "/search", "/orders", "/digest"]);
    expect(by("requests", false).slice(0, 2)).toEqual(["/api/a", "/api/b"]);
    expect(by("avg_ms", false).slice(-2)).toEqual(["/search", "/api/f"]);
    expect(by("avg_ms", true).slice(-2)).toEqual(["/search", "/api/f"]);
    expect(by("route", false).slice(0, 3)).toEqual(["/api/a", "/api/b", "/api/c"]);
    const ties = [["a", "1"], ["b", "1"], ["c", "0"]];
    expect(sortRows(ties, [{ name: "k", type: "String" }, { name: "n", type: "UInt8" }], { column: "n", desc: true }).map((row) => row[0])).toEqual(["a", "b", "c"]);
  });

  test("contains matches a shown cell as stored or as shown, case-insensitive", () => {
    expect(containsRows(ROWS, [0, 1, 2], COLUMNS, "API/").length).toBe(6);
    // A number as shown (18,000; 25% as a percent).
    expect(containsRows([["a", 18000], ["b", 0.25]], [1], [{ name: "k", type: "String" }, { name: "n", type: "Float64" }], "18,000").map((row) => row[0])).toEqual(["a"]);
    expect(containsRows([["a", 18000], ["b", 0.25]], [1], [{ name: "k", type: "String" }, { name: "n", type: "Float64" }], "25%", { n: "percent" }).map((row) => row[0])).toEqual(["b"]);
    // A column not shown is not searched.
    expect(containsRows(ROWS, [1], COLUMNS, "orders")).toEqual([]);
    expect(containsRows(ROWS, [0], COLUMNS, "  ").length).toBe(ROWS.length);
  });

  test("the URL keeps a table's sort and contains text beside the filters", () => {
    const parsed = parseReportParams("?p.route=%2Fa&t.routes-table=requests.desc&tq.routes-table=api&t.Bad=x.asc&x.y=1");
    expect(parsed).toEqual({ route: ["/a"], "t.routes-table": ["requests.desc"], "tq.routes-table": ["api"] });
    expect(formatReportParams(parsed)).toBe("?p.route=%2Fa&t.routes-table=requests.desc&tq.routes-table=api");
  });
});

const REPORT_ID = "8b1d3c55-4a8e-4f8b-9a43-1f2e3d4c5b6a";
const spec: ReportSpec = {
  version: 1, specVersion: 3, sections: [], parameters: [],
  queries: [{ key: "by_route", sql: "SELECT route, count() AS requests FROM t GROUP BY route", purpose: "", createdBy: "agent" }],
  blocks: [{ id: "routes-table", type: "table", title: "Requests by route", intent: "detail", queryKey: "by_route", width: "full" }]
};
const report = {
  id: REPORT_ID, title: "Routes", datasourceId: "d", datasourceName: "Warehouse", status: "ready", isOwner: false, ownerName: "Owner", blockCount: 1,
  lastRunAt: "2026-10-13T09:00:00.000Z", createdAt: "2026-10-13T07:00:00.000Z", updatedAt: "2026-10-13T09:00:00.000Z", revision: 1, folderId: null, scheduleCadence: null,
  spec, doc: null, lastError: null
} as unknown as ReportDetail;
const result = (truncated: boolean): ReportResult => ({
  runId: "", queryKey: "by_route", sql: "", sentSql: "", columns: COLUMNS, rows: ROWS, rowCount: ROWS.length,
  truncated, rowsRead: null, bytesRead: null, chQueryId: "x", ms: 1, error: null, errorCode: null, createdAt: "2026-10-13T09:00:00.000Z", params: null
});

function page(truncated = false, initial?: Record<string, string[]>) {
  mockApi({
    [`GET /reports/${REPORT_ID}/results`]: () => ({ results: [{ queryKey: "by_route", result: result(truncated), failed: null, stale: false }], running: null, timeZone: "UTC" }),
    [`GET /reports/${REPORT_ID}/runs`]: () => ({ runs: [], schedule: null })
  });
  const changes: Array<{ search: Record<string, string[]> | undefined; replace: boolean }> = [];
  function Page() {
    const [search, setSearch] = useState<Record<string, string[]> | undefined>(initial);
    return <ReportParamsContext.Provider value={{ search, onChange: (next, options) => { changes.push({ search: next, replace: Boolean(options?.replace) }); setSearch(next); } }}><ReportView report={report} canWrite={false} /></ReportParamsContext.Provider>;
  }
  return { changes, Page };
}
async function type(box: HTMLInputElement, text: string) {
  const { act } = await import("react");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const firstColumn = () => [...document.querySelectorAll(".report-table tbody tr")].map((row) => row.querySelector("td")?.textContent);

describe("D563, D564: in the report", () => {
  test("a header button sorts (replace, never a Back step), and the header says how", async () => {
    const { changes, Page } = page();
    const view = await render(<Page />);
    await view.waitFor(() => document.querySelector(".report-th-sort"));
    const requests = () => [...document.querySelectorAll<HTMLButtonElement>(".report-th-sort")].find((button) => button.textContent?.startsWith("requests"))!;
    expect(requests().closest("th")!.getAttribute("aria-sort")).toBe("none");
    await view.click(requests());
    expect(changes.at(-1)).toEqual({ search: { "t.routes-table": ["requests.asc"] }, replace: true });
    expect(firstColumn()[0]).toBe("/api/a");
    await view.click(requests());
    expect(changes.at(-1)).toEqual({ search: { "t.routes-table": ["requests.desc"] }, replace: true });
    expect(requests().closest("th")!.getAttribute("aria-sort")).toBe("descending");
    expect(firstColumn()[0]).toBe("/health");
    await view.click(requests());
    expect(changes.at(-1)).toEqual({ search: undefined, replace: true });
    expect(firstColumn()[0]).toBe("/orders");
  });

  test("the contains box narrows the rows and counts them; a link restores both; truncated rows say so", async () => {
    const { changes, Page } = page(true, { "t.routes-table": ["requests.desc"], "tq.routes-table": ["api"] });
    const view = await render(<Page />);
    await view.waitFor(() => document.querySelector(".report-table-contains"));
    expect((document.querySelector(".report-table-contains") as HTMLInputElement).value).toBe("api");
    expect(firstColumn()).toEqual(["/api/f", "/api/e", "/api/d", "/api/c", "/api/b", "/api/a"]);
    expect(document.querySelector(".report-table-count")?.textContent).toBe("6 of 10 rows, within the first 10 rows");
    await type(document.querySelector<HTMLInputElement>(".report-table-contains")!, "zzz");
    expect(changes.at(-1)).toEqual({ search: { "t.routes-table": ["requests.desc"], "tq.routes-table": ["zzz"] }, replace: true });
    expect(document.querySelector(".report-table-none")?.textContent).toBe("No rows contain “zzz”.");
    await type(document.querySelector<HTMLInputElement>(".report-table-contains")!, "");
    expect(changes.at(-1)).toEqual({ search: { "t.routes-table": ["requests.desc"] }, replace: true });
    expect(document.querySelector(".report-table-count")?.textContent).toBe("Sorted within the first 10 rows");
  });
});
