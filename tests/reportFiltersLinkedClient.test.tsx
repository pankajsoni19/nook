/**
 * Linked filters in the browser (happy-dom; lane FILT2, D560, D561): a parent's change drops the child's
 * picks its new choices do not hold, with a note, before the URL changes; an old link whose child value
 * is not among its parents' choices is cleaned (replace) instead of showing the server's refusal.
 */
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { useState } from "react";
import type { ReportDetail, ReportResult, ReportSpec } from "../shared/reports";
import { installDom, mockApi, render, reply } from "./support/dom";

installDom("http://nook.test/reports");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart">chart</div> }));
const notes: string[] = [];
const { notify } = await import("../src/ui/notify");
const info = spyOn(notify, "info").mockImplementation((message: string) => { notes.push(message); return 0; });
afterAll(() => info.mockRestore());

const { ReportView } = await import("../src/reports/ReportView");
const { ReportParamsContext } = await import("../src/reports/ReportParamsBar");
const { dropUnlinked, parentValuesOf } = await import("../src/reports/linkedFilters");

const REPORT_ID = "7a1d3c55-4a8e-4f8b-9a43-1f2e3d4c5b6a";
const BY_COUNTRY = "(empty({country:Array(String)}) OR country IN {country:Array(String)})";
const spec: ReportSpec = {
  version: 1, specVersion: 3, sections: [],
  parameters: [
    { id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT country FROM analytics.orders" },
    { id: "route", label: "Route", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: `SELECT DISTINCT route FROM analytics.orders WHERE ${BY_COUNTRY}` },
    { id: "plan", label: "Plan", type: "select", chType: "String", default: "all", optionsQuery: `SELECT DISTINCT plan FROM analytics.orders WHERE ${BY_COUNTRY}` }
  ],
  queries: [{ key: "totals", sql: `SELECT count() AS orders FROM analytics.orders WHERE ${BY_COUNTRY} AND route IN {route:Array(String)} AND plan = {plan:String}`, purpose: "Orders", createdBy: "agent" }],
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
const enc = (values: unknown) => encodeURIComponent(JSON.stringify(values));
const ROUTES: Record<string, string[]> = { "[]": ["/de/a", "/fr/a", "/shared"], '["DE"]': ["/de/a", "/shared"], '["FR"]': ["/fr/a", "/shared"] };
const PLANS: Record<string, string[]> = { "[]": ["all", "pro", "team"], '["DE"]': ["all", "pro"], '["FR"]': ["all", "team"] };
const list = (paramId: string, options: string[]) => ({ options: { paramId, options, truncated: false, error: null, at: null } });

function api(extra: Record<string, () => unknown> = {}) {
  const routes: Record<string, () => unknown> = {
    [`GET /reports/${REPORT_ID}/results`]: () => ({ results: [{ queryKey: "totals", result, failed: null, stale: false }], running: null, timeZone: "UTC" }),
    [`GET /reports/${REPORT_ID}/runs`]: () => ({ runs: [], schedule: null }),
    [`GET /reports/${REPORT_ID}/parameters/country/options`]: () => list("country", ["DE", "FR"]),
    ...extra
  };
  for (const [key, options] of Object.entries(ROUTES)) routes[`GET /reports/${REPORT_ID}/parameters/route/options?values=${enc({ country: JSON.parse(key) })}`] = () => list("route", options);
  for (const [key, options] of Object.entries(PLANS)) routes[`GET /reports/${REPORT_ID}/parameters/plan/options?values=${enc({ country: JSON.parse(key) })}`] = () => list("plan", options);
  return mockApi(routes);
}

describe("D561: a parent's change drops what its children no longer offer", () => {
  test("parentValuesOf names only the parents; dropUnlinked keeps what fits and says what went", async () => {
    expect(parentValuesOf(spec.parameters[1]!, spec.parameters, { country: ["DE"], route: ["/x"] })).toEqual({ country: ["DE"] });
    expect(parentValuesOf(spec.parameters[0]!, spec.parameters, {})).toBeUndefined();
    api();
    const before = { country: [], route: ["/de/a", "/fr/a"], plan: "team" };
    const next = { ...before, country: ["DE"] };
    expect(await dropUnlinked(REPORT_ID, spec.parameters, before, next)).toEqual({
      values: { country: ["DE"], route: ["/de/a"], plan: "all" },
      notes: ["Route: /fr/a dropped, not in DE", "Plan reset: not in DE"]
    });
    // Nothing to drop, or no parent changed: the values as given.
    expect(await dropUnlinked(REPORT_ID, spec.parameters, next, { ...next, route: ["/shared"] })).toEqual({ values: { ...next, route: ["/shared"] }, notes: [] });
    expect(await dropUnlinked(REPORT_ID, spec.parameters, before, { ...before, country: ["FR"], route: ["/fr/a"], plan: "team" })).toEqual({ values: { country: ["FR"], route: ["/fr/a"], plan: "team" }, notes: [] });
  });

  test("an old link with a child value its parents do not offer is cleaned in place (replace), with a note, instead of an error", async () => {
    notes.length = 0;
    const values = { country: ["DE"], route: ["/fr/a"], plan: "all" };
    api({
      [`GET /reports/${REPORT_ID}/results?values=${enc(values)}`]: () => reply(400, { error: "/fr/a is not one of the choices for Route", code: "INVALID", paramId: "route" }),
      [`GET /reports/${REPORT_ID}/results?values=${enc({ ...values, route: [] })}`]: () => ({ results: [{ queryKey: "totals", result, failed: null, stale: false }], running: null, set: { isDefault: false, values: {}, bound: {}, missing: [] } })
    });
    const changes: Array<{ search: Record<string, string[]> | undefined; replace: boolean }> = [];
    function Page() {
      const [search, setSearch] = useState<Record<string, string[]> | undefined>({ country: ["DE"], route: ["/fr/a"] });
      return <ReportParamsContext.Provider value={{ search, onChange: (next, options) => { changes.push({ search: next, replace: Boolean(options?.replace) }); setSearch(next); } }}><ReportView report={report} canWrite={false} /></ReportParamsContext.Provider>;
    }
    const view = await render(<Page />);
    await view.waitFor(() => changes.length > 0);
    expect(changes[0]).toEqual({ search: { country: ["DE"] }, replace: true });
    expect(notes).toEqual(["Route reset: not in DE"]);
    await view.waitFor(() => document.querySelector(".report-kpi-value, .report-block-kpi"));
    expect(document.querySelector(".form-error")).toBeNull();
  });
});
