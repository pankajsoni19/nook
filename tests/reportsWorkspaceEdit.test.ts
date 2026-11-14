import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import type { DatasetInfo } from "../shared/datasets";
import type { ReportDetail } from "../shared/reports";
import { datasetQueryText } from "../shared/reportsWorkspace";

const { widgetDraftOf, widgetEditOps, widgetOps } = await import("../src/reports/WorkspaceWidgetSheet");

/**
 * Edit widget on a This workspace report (D1220–D1223): the builder reads a saved widget back, and its
 * save is one manual edit through `POST …/spec/edit` (the server's checks, a version, Undo by restoring
 * the version before), keeping the block's id and place.
 */

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { text }; }
  return { status: response.status, body: json };
}
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

let owner: Session;
let reportId: string;
let datasets: DatasetInfo[];
const report = async () => (await send(owner, "GET", `/reports/${reportId}`)).body.report as ReportDetail;
const blockOf = (detail: ReportDetail, id: string) => detail.spec.blocks.find((block) => block.id === id)!;
const edit = async (ops: unknown[], detail: ReportDetail) => send(owner, "POST", `/reports/${reportId}/spec/edit`, { expectedRevision: detail.revision, ops });

beforeAll(async () => {
  owner = await createUser("Widget editor");
  const project = await send(owner, "POST", "/time/projects", { name: "Widget project" });
  const other = await send(owner, "POST", "/time/projects", { name: "Other project" });
  // Two projects, so a chart by project has more than one bar (the design rules refuse a single value).
  for (const [duration, projectId] of [["3h", project.body.project.id], ["1h", project.body.project.id], ["2h", other.body.project.id]]) expect((await send(owner, "POST", "/time/entries", { startedAt: hoursAgo(5), duration, projectId })).status).toBeLessThan(300);
  const created = await send(owner, "POST", "/reports", { title: "Edit widgets", datasourceId: "workspace" });
  reportId = created.body.report.id;
  datasets = (await send(owner, "GET", "/reports/workspace/datasets")).body.datasets;
});

describe("Edit widget", () => {
  test("a widget Add saved reads back as the same draft, and its edit saves in place as one version", async () => {
    const time = datasets.find((item) => item.id === "time.entries")!;
    const project = time.columns.find((column) => column.dimension && column.name.includes("project"))!.name;
    const measure = time.columns.find((column) => column.measures?.includes("sum"))!;
    // Two widgets: the second, edited, keeps its place after the first.
    const first = widgetOps({ spec: (await report()).spec }, { dataset: time.id, measures: [{ key: "a", fn: "count", column: null }], dimension: null, split: null, bucket: null, range: "30d", filters: [], kind: "kpi", title: "Entries" }, time);
    expect((await edit(first.ops, await report())).status).toBe(200);
    const added = widgetOps({ spec: (await report()).spec }, { dataset: time.id, measures: [{ key: "a", fn: "sum", column: measure.name }], dimension: project, split: null, bucket: null, range: "30d", filters: [], kind: "bar", title: "By project" }, time);
    const addedSave = await edit(added.ops, await report());
    expect(addedSave.body).toEqual(expect.objectContaining({ version: expect.any(Number) }));
    let detail = await report();
    const blockId = added.queryKey;
    const before = detail.spec.blocks.map((block) => block.id);
    const read = widgetDraftOf(blockOf(detail, blockId), detail.spec.queries.find((query) => query.key === blockId)!.sql, datasets, detail.spec.parameters);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.draft).toMatchObject({ dataset: time.id, dimension: project, kind: "bar", range: "30d", title: "By project", measures: [{ fn: "sum", column: measure.name }] });

    // Now a horizontal bar on the report's date filter (which the edit adds), retitled.
    const { ops, queryKey, ownQuery } = widgetEditOps(detail, blockOf(detail, blockId) as never, { ...read.draft, kind: "horizontal_bar", range: "__report", title: "Hours by project" }, time);
    expect(ownQuery).toBe(false);
    expect(queryKey).toBe(blockId);
    expect(ops.map((op) => op.op)).toEqual(["add_parameter", "update_query", "update_block"]);
    const version = (db.query("SELECT MAX(version) AS v FROM report_versions WHERE report_id = ?").get(reportId) as { v: number }).v;
    const saved = await edit(ops, detail);
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(version + 1);
    detail = await report();
    expect(detail.spec.blocks.map((block) => block.id)).toEqual(before);
    expect(blockOf(detail, blockId)).toMatchObject({ type: "chart", kind: "horizontal_bar", title: "Hours by project", intent: "rank", queryKey: blockId });
    expect(detail.spec.parameters.map((param) => param.id)).toEqual(["period"]);
    expect(detail.spec.queries.find((query) => query.key === blockId)!.sql).toContain("{period_from:Date}");
    expect(detail.spec.queries.find((query) => query.key === blockId)!.purpose).toBe("Hours by project");
    // It reads back again (now on the report's filter).
    const again = widgetDraftOf(blockOf(detail, blockId), detail.spec.queries.find((query) => query.key === blockId)!.sql, datasets, detail.spec.parameters);
    expect(again.ok && again.draft.range).toBe("__report");

    // Undo is Restore of the version before (the report page's toast): the bar is back.
    expect((await send(owner, "POST", `/reports/${reportId}/versions/${version}/restore`, {})).status).toBe(200);
    detail = await report();
    expect(blockOf(detail, blockId)).toMatchObject({ kind: "bar", title: "By project" });
    expect(detail.spec.parameters).toEqual([]);
  });

  test("a number turned into a table changes type in place; a shared query gets one of its own", async () => {
    const time = datasets.find((item) => item.id === "time.entries")!;
    let detail = await report();
    const kpi = detail.spec.blocks.find((block) => block.type === "kpi")!;
    const read = widgetDraftOf(kpi, detail.spec.queries.find((query) => query.key === (kpi as { queryKey: string }).queryKey)!.sql, datasets, detail.spec.parameters);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const { ops } = widgetEditOps(detail, kpi as never, { ...read.draft, kind: "table" }, time);
    expect((await edit(ops, detail)).status).toBe(200);
    detail = await report();
    expect(detail.spec.blocks[0]).toMatchObject({ id: kpi.id, type: "table" });

    // A second block on the same query: editing one leaves the other on the old query.
    const queryKey = (kpi as { queryKey: string }).queryKey;
    expect((await edit([{ op: "add_block", block: { id: "twin", type: "table", title: "Twin", intent: "detail", queryKey }, after: kpi.id }], detail)).status).toBe(200);
    detail = await report();
    const table = blockOf(detail, kpi.id);
    const twinRead = widgetDraftOf(table, detail.spec.queries.find((query) => query.key === queryKey)!.sql, datasets, detail.spec.parameters);
    if (!twinRead.ok) throw new Error(twinRead.reasons.join("; "));
    const split = widgetEditOps(detail, table as never, { ...twinRead.draft, range: "7d" }, time);
    expect(split.ownQuery).toBe(true);
    expect((await edit(split.ops, detail)).status).toBe(200);
    detail = await report();
    expect((blockOf(detail, kpi.id) as { queryKey: string }).queryKey).toBe(split.queryKey);
    expect((blockOf(detail, "twin") as { queryKey: string }).queryKey).toBe(queryKey);
  });

  test("what the builder cannot show falls back to the JSON editor, with the reasons", async () => {
    const detail = await report();
    const block = { id: "x", type: "chart", kind: "scatter", queryKey: "q", x: "a", y: ["b"] } as never;
    const aliased = datasetQueryText({ dataset: "time.entries", measures: [{ fn: "count", as: "n" }] });
    const scatter = widgetDraftOf(block, aliased, datasets, detail.spec.parameters);
    expect(scatter.ok).toBe(false);
    expect(!scatter.ok && scatter.reasons.join(" ")).toContain("scatter");
    expect(!scatter.ok && scatter.reasons.join(" ")).toContain("own column name");
    const fixed = widgetDraftOf({ id: "y", type: "table", queryKey: "q" }, datasetQueryText({ dataset: "time.entries", measures: [{ fn: "count" }], timeRange: { from: "2026-01-01", to: "2026-01-31" } }), datasets, []);
    expect(!fixed.ok && fixed.reasons).toEqual(["it has a fixed date range"]);
    expect(widgetDraftOf({ id: "z", type: "table", queryKey: "q" }, "SELECT 1", datasets, []).ok).toBe(false);
  });
});
