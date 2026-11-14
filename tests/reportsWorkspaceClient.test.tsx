/**
 * W3-REPORTS (D1067): Add widget's draft → structured query → spec ops, without rendering.
 */
import { describe, expect, test } from "bun:test";
import { installDom } from "./support/dom";
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
