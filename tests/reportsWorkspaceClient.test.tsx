/**
 * W3-REPORTS (D1067): Add widget's draft → structured query → spec ops, without rendering.
 */
import { describe, expect, test } from "bun:test";
import { captureToasts, installDom, mockApi, render } from "./support/dom";
import type { DatasetInfo } from "../shared/datasets";
import { EMPTY_SPEC } from "../shared/reports";
import { parseDatasetQuery } from "../shared/reportsWorkspace";

installDom("http://nook.test/reports");
const { draftProblem, widgetOps } = await import("../src/reports/WorkspaceWidgetSheet");

const time: DatasetInfo = {
  id: "time.entries", module: "time", label: "Time entries", description: "", timeColumn: "started_at",
  columns: [
    { name: "client", type: "string", label: "Client", dimension: true },
    { name: "project", type: "string", label: "Project", dimension: true },
    { name: "hours", type: "number", label: "Hours", measures: ["sum", "avg"] },
    { name: "seconds", type: "duration", label: "Time", measures: ["sum"] },
    { name: "started_at", type: "datetime", label: "Started", dimension: true }
  ]
};
const draft = { dataset: "time.entries", measures: [{ key: "a", fn: "sum" as const, column: "hours" }], dimension: "client", split: null, bucket: null, range: "mtd" as const, filters: [], kind: "bar" as const, title: "Hours by client" };

describe("Add widget", () => {
  test("a bar by client is a ranked structured query and a compare chart on it", () => {
    const { ops, queryKey } = widgetOps({ spec: EMPTY_SPEC }, draft, time);
    expect(queryKey).toBe("entries_1");
    const add = ops.find((op) => op.op === "add_query") as { query: { sql: string } };
    const parsed = parseDatasetQuery(add.query.sql);
    expect(parsed.ok && parsed.query).toEqual({ dataset: "time.entries", measures: [{ fn: "sum", column: "hours" }], dimensions: ["client"], timeRange: { preset: "mtd" }, sort: [{ column: "sum_hours", dir: "desc" }], limit: 20 });
    expect(ops.find((op) => op.op === "add_block")).toMatchObject({ block: { type: "chart", kind: "bar", intent: "compare", x: "client", y: ["sum_hours"], queryKey: "entries_1" } });
  });

  test("the report's date filter adds a date range parameter once and reads it as placeholders", () => {
    const { ops } = widgetOps({ spec: EMPTY_SPEC }, { ...draft, kind: "line", dimension: "project", bucket: "week", range: "__report" }, time);
    expect(ops[0]).toMatchObject({ op: "add_parameter", parameter: { id: "period", type: "date_range" } });
    const sql = (ops[1] as { query: { sql: string } }).query.sql;
    expect(sql).toContain("{period_from:Date}");
    expect(ops[2]).toMatchObject({ block: { kind: "line", intent: "trend", x: "bucket", series: "project" } });
  });

  test("drafts that cannot draw say why", () => {
    expect(draftProblem({ ...draft, kind: "kpi" }, time)).toContain("one value");
    expect(draftProblem({ ...draft, kind: "line" }, time)).toContain("over time");
    expect(draftProblem({ ...draft, dimension: null }, time)).toContain("axis");
    expect(draftProblem(draft, time)).toBeNull();
  });
});

// ------------------------------------------------------------------------------ Edit widget (D1220–D1223)

const { widgetDraftOf, widgetEditOps, WorkspaceWidgetSheet } = await import("../src/reports/WorkspaceWidgetSheet");
const { whenHistorySettled } = await import("../src/historyDialogs");

const REPORT = "0b8f7c2e-2222-4222-8222-222222222222";
const clientParam = { id: "client", label: "Client", type: "multi_select" as const, chType: "Array(String)", default: [] as string[] };
const savedSql = JSON.stringify({ dataset: "time.entries", measures: [{ fn: "sum", column: "hours" }], dimensions: ["client"], filters: [{ column: "client", op: "in", value: "{client:Array(String)}" }, { column: "hours", op: "gt", value: 1 }], timeRange: { preset: "mtd" }, sort: [{ column: "client", dir: "asc" }], limit: 50 }, null, 2);
const chart = { id: "hours_by_client", type: "chart" as const, title: "Hours by client", intent: "compare" as const, queryKey: "hours_by_client", kind: "bar" as const, x: "client", y: ["sum_hours"], format: "currency" as const, emphasis: "Acme", width: "half" as const, section: "s1" };
const spec = { ...EMPTY_SPEC, parameters: [clientParam], sections: [{ id: "s1", title: "Hours" }], queries: [{ key: "hours_by_client", sql: savedSql, purpose: "Hours by client", createdBy: "user" as const }], blocks: [chart] } as unknown as typeof EMPTY_SPEC;

describe("Edit widget", () => {
  test("a saved widget reads back: editable filters, a report filter kept locked, its own order kept", () => {
    const read = widgetDraftOf(chart, savedSql, [time], spec.parameters);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.draft).toMatchObject({ dataset: "time.entries", dimension: "client", split: null, bucket: null, range: "mtd", kind: "bar", title: "Hours by client", order: { sort: [{ column: "client", dir: "asc" }], limit: 50 } });
    expect(read.draft.filters.map((row) => [row.column, row.op, row.value, Boolean(row.locked)])).toEqual([["client", "in", "", true], ["hours", "gt", "1", false]]);
  });

  test("the edit updates the query and the block in place; the author's format stays, a moved mapping drops its emphasis", () => {
    const read = widgetDraftOf(chart, savedSql, [time], spec.parameters);
    if (!read.ok) throw new Error(read.reasons.join("; "));
    const same = widgetEditOps({ spec }, chart, { ...read.draft, kind: "horizontal_bar" }, time);
    expect(same.ops).toEqual([{ op: "update_block", id: chart.id, set: { kind: "horizontal_bar", intent: "rank" } }]);
    const more = widgetEditOps({ spec }, chart, { ...read.draft, measures: [...read.draft.measures, { key: "b", fn: "avg", column: "hours" }], title: "Hours" }, time);
    expect(more.ops[0]).toMatchObject({ op: "update_query", key: chart.queryKey, purpose: "Hours" });
    expect(JSON.parse((more.ops[0] as { sql: string }).sql).measures).toEqual([{ fn: "sum", column: "hours" }, { fn: "avg", column: "hours" }]);
    expect(more.ops[1]).toEqual({ op: "update_block", id: chart.id, set: { title: "Hours", y: ["sum_hours", "avg_hours"] }, unset: ["emphasis"] });
    // A new type keeps the section and width it sat in.
    const kpi = widgetEditOps({ spec }, chart, { ...read.draft, kind: "kpi", dimension: null }, time);
    expect(kpi.ops.at(-1)).toMatchObject({ op: "update_block", id: chart.id, set: { type: "kpi", column: "sum_hours", section: "s1", width: "half" } });
  });

  test("what the builder cannot show says why", () => {
    const fixed = savedSql.replace('"preset": "mtd"', '"from": "2026-01-01",\n    "to": "2026-02-01"');
    expect(widgetDraftOf(chart, fixed, [time], spec.parameters)).toEqual({ ok: false, reasons: ["it has a fixed date range"] });
    expect(widgetDraftOf({ ...chart, kind: "funnel" }, savedSql, [time], spec.parameters)).toMatchObject({ ok: false, reasons: [expect.stringContaining("funnel")] });
    expect(widgetDraftOf({ ...chart, x: "hours" }, savedSql, [time], spec.parameters)).toMatchObject({ ok: false, reasons: [expect.stringContaining("maps its columns")] });
    expect(widgetDraftOf(chart, savedSql, [], spec.parameters)).toMatchObject({ ok: false, reasons: [expect.stringContaining("not one you can read")] });
  });

  test("the sheet opens on the widget, waits for a change, and saves one edit with Undo", async () => {
    const toasts = captureToasts();
    const api = mockApi({
      "GET /reports/workspace/datasets": () => ({ datasets: [time] }),
      [`POST /reports/${REPORT}/spec/edit`]: () => ({ version: 4, revision: 5 })
    });
    let changed = 0;
    const view = await render(<WorkspaceWidgetSheet report={{ id: REPORT, revision: 4, spec }} editBlockId={chart.id} onClose={() => undefined} onChanged={() => { changed += 1; }} />);
    const sheet = await view.waitFor(() => document.querySelector(".report-widget-sheet"));
    await view.waitFor(() => sheet.textContent?.includes("Nothing changed yet"));
    expect(sheet.textContent).toContain("Edit widget");
    expect(sheet.textContent).toContain("follows the report's filter Client");
    expect(sheet.textContent).toContain("Client, lowest first; top 50");
    expect(view.button("Save changes")!.disabled).toBe(true);
    await view.click(view.button("Use the usual order")!);
    expect(view.button("Save changes")!.disabled).toBe(false);
    await view.click(view.button("Save changes")!);
    await view.waitFor(() => changed === 1);
    const body = api.calls.find((call) => call.method === "POST")!.body as { ops: Array<{ op: string; sql?: string }>; expectedRevision: number };
    expect(body.expectedRevision).toBe(4);
    expect(body.ops.map((op) => op.op)).toEqual(["update_query"]);
    expect(JSON.parse(body.ops[0]!.sql!)).toMatchObject({ sort: [{ column: "sum_hours", dir: "desc" }], limit: 20 });
    expect(toasts.at(-1)).toEqual({ kind: "success", message: "Saved Hours by client (version 4)" });
    await new Promise<void>((resolve) => whenHistorySettled(resolve));
  });

  test("a widget the builder cannot show offers the JSON editor", async () => {
    mockApi({ "GET /reports/workspace/datasets": () => ({ datasets: [time] }) });
    let json: string | null = null;
    const funnel = { ...chart, kind: "funnel" as const };
    const view = await render(<WorkspaceWidgetSheet report={{ id: REPORT, revision: 4, spec: { ...spec, blocks: [funnel] } }} editBlockId={chart.id} onClose={() => undefined} onChanged={() => undefined} onEditJson={(id) => { json = id; }} />);
    const sheet = await view.waitFor(() => document.querySelector(".report-widget-sheet"));
    await view.waitFor(() => sheet.textContent?.includes("The builder can't show this widget"));
    expect(sheet.textContent).toContain("funnel");
    expect(view.button("Save changes")).toBeNull();
    await view.click(view.button("Edit as JSON")!);
    expect(json as string | null).toBe(chart.id);
    await new Promise<void>((resolve) => whenHistorySettled(resolve));
  });
});
