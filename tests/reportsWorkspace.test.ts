import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { bindDatasetQuery, datasetQueryText, parseDatasetQuery } from "../shared/reportsWorkspace";

const { missingDatasetScope } = await import("../server/reports/workspaceSource");

/**
 * Reports on "This workspace" (docs/plan/WORKSPACE_MODULES.md §D.8, W3-REPORTS, D1060–D1066,
 * T600–T603): structured dataset queries only, each reader's own access, no rows kept.
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
const revision = (reportId: string) => (db.query("SELECT revision FROM reports WHERE id = ?").get(reportId) as { revision: number }).revision;

let owner: Session;
let reader: Session;
let reportId: string;

const hoursByPerson = datasetQueryText({ dataset: "time.entries", measures: [{ fn: "sum", column: "hours", as: "hours" }], dimensions: ["person"], sort: [{ column: "hours", dir: "desc" }] });

beforeAll(async () => {
  owner = await createUser("Workspace report owner");
  reader = await createUser("Workspace report reader");
  // The owner logs 4 h on a private project; the reader logs 2 h of their own. Neither sees the other's.
  const project = await send(owner, "POST", "/time/projects", { name: "Private workspace project" });
  expect(project.status).toBeLessThan(300);
  for (const duration of ["3h", "1h"]) expect((await send(owner, "POST", "/time/entries", { startedAt: hoursAgo(5), duration, projectId: project.body.project.id })).status).toBeLessThan(300);
  expect((await send(reader, "POST", "/time/entries", { startedAt: hoursAgo(4), duration: "2h" })).status).toBeLessThan(300);
});

describe("This workspace as a report data source", () => {
  test("members see it first among the data sources and can create a report on it", async () => {
    const sources = await send(owner, "GET", "/reports/datasources");
    expect(sources.body.datasources[0]).toEqual({ id: "workspace", name: "This workspace", database: "", kind: "workspace" });
    const created = await send(owner, "POST", "/reports", { title: "Hours by person", datasourceId: "workspace" });
    expect(created.status).toBe(201);
    reportId = created.body.report.id;
    expect(created.body.report.datasourceId).toBe("workspace");
    expect(created.body.report.datasourceName).toBe("This workspace");
    const stored = db.query("SELECT source, datasource_id FROM reports WHERE id = ?").get(reportId) as { source: string; datasource_id: string | null };
    expect(stored).toEqual({ source: "workspace", datasource_id: null });
    const listed = await send(owner, "GET", "/reports?datasource=workspace");
    expect(listed.body.reports.map((item: Json) => item.id)).toContain(reportId);
  });

  test("a widget is a structured query; SQL is refused", async () => {
    const refused = await send(owner, "POST", `/reports/${reportId}/spec/edit`, { expectedRevision: revision(reportId), ops: [
      { op: "add_query", query: { key: "hours", sql: "SELECT 1", purpose: "nope" } },
      { op: "add_block", block: { id: "hours", type: "table", title: "Hours", queryKey: "hours" }, after: null }
    ] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("structured query");
    const saved = await send(owner, "POST", `/reports/${reportId}/spec/edit`, { expectedRevision: revision(reportId), ops: [
      { op: "add_query", query: { key: "hours", sql: hoursByPerson, purpose: "Hours by person" } },
      { op: "add_block", block: { id: "hours", type: "table", title: "Hours by person", intent: "detail", queryKey: "hours" }, after: null }
    ] });
    expect(saved.status).toBe(200);
  });

  test("each reader sees the numbers their own access allows, computed live; nothing stored keeps rows", async () => {
    const mine = await send(owner, "GET", `/reports/${reportId}/results`);
    expect(mine.body.live).toBe(true);
    expect(mine.body.results[0].result.rows).toEqual([["Workspace report owner", 4]]);
    expect(mine.body.results[0].result.columns).toEqual([{ name: "person", type: "String" }, { name: "hours", type: "Float64" }]);
    expect((await send(owner, "PUT", `/reports/${reportId}/sharing`, { visibility: "all_users", shares: [] })).status).toBe(200);
    const theirs = await send(reader, "GET", `/reports/${reportId}/results`);
    expect(theirs.status).toBe(200);
    expect(theirs.body.results[0].result.rows).toEqual([["Workspace report reader", 2]]);
    // The owner's validation and refresh results are stored without rows (113's triggers).
    const refresh = await send(owner, "POST", `/reports/${reportId}/refresh`, {});
    expect(refresh.status).toBeLessThan(300);
    for (let i = 0; i < 50 && db.query("SELECT 1 FROM report_runs WHERE report_id = ? AND status = 'running'").get(reportId); i += 1) await Bun.sleep(20);
    const stored = db.query("SELECT rows_json, row_count, error FROM report_results WHERE report_id = ?").all(reportId) as Array<{ rows_json: string; row_count: number; error: string | null }>;
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((row) => row.rows_json === "[]")).toBe(true);
    expect(stored.some((row) => row.error === null && row.row_count === 1)).toBe(true);
  });

  test("a date filter (D489) binds through placeholders, per reader", async () => {
    const withRange = datasetQueryText({ dataset: "time.entries", measures: [{ fn: "sum", column: "hours", as: "hours" }], timeRange: { from: "{period_from:Date}", to: "{period_to:Date}" } });
    const saved = await send(owner, "POST", `/reports/${reportId}/spec/edit`, { expectedRevision: revision(reportId), ops: [
      { op: "add_parameter", parameter: { id: "period", label: "Period", type: "date_range", chType: "Date", default: { preset: "30d" } } },
      { op: "add_query", query: { key: "total", sql: withRange, purpose: "Total hours" } },
      { op: "add_block", block: { id: "total", type: "kpi", title: "Hours", intent: "headline", queryKey: "total", column: "hours", format: "number" }, after: null }
    ] });
    expect(saved.status).toBe(200);
    const now = await send(reader, "GET", `/reports/${reportId}/results`);
    expect(now.body.results.find((item: Json) => item.queryKey === "total").result.rows).toEqual([[2]]);
    const longAgo = encodeURIComponent(JSON.stringify({ period: { preset: "custom", from: "2020-01-01", to: "2020-01-31" } }));
    const old = await send(reader, "GET", `/reports/${reportId}/results?values=${longAgo}`);
    expect(old.status).toBe(200);
    expect(old.body.live).toBe(true);
    expect(old.body.results.find((item: Json) => item.queryKey === "total").result.rows).toEqual([[null]]);
    expect(old.body.set.missing).toEqual([]);
    const run = await send(reader, "POST", `/reports/${reportId}/param-runs`, { values: { period: { preset: "custom", from: "2020-01-01", to: "2020-01-31" } } });
    expect(run.status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS n FROM report_param_results WHERE report_id = ? AND rows_json <> '[]'").get(reportId)).toEqual({ n: 0 });
  });

  test("a copy is a workspace report too, and the source cannot switch while it has queries", async () => {
    const copy = await send(reader, "POST", `/reports/${reportId}/duplicate`, {});
    expect(copy.status).toBe(201);
    const copyId = copy.body.report.id;
    expect((db.query("SELECT source FROM reports WHERE id = ?").get(copyId) as { source: string }).source).toBe("workspace");
    expect(db.query("SELECT COUNT(*) AS n FROM report_results WHERE report_id = ? AND rows_json <> '[]'").get(copyId)).toEqual({ n: 0 });
    expect((await send(reader, "GET", `/reports/${copyId}/results`)).body.results[0].result.rows).toEqual([["Workspace report reader", 2]]);
    const datasource = db.query("SELECT id FROM report_datasources LIMIT 1").get() as { id: string } | null;
    if (datasource) expect((await send(reader, "PATCH", `/reports/${copyId}`, { datasourceId: datasource.id, expectedRevision: revision(copyId) })).status).toBe(409);
  });

  test("guests have no workspace source", async () => {
    const guest = await createUser("Workspace report guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    const created = await send(guest, "POST", "/reports", { title: "Nope", datasourceId: "workspace" });
    expect(created.status).toBeGreaterThanOrEqual(400);
  });
});

describe("workspace queries (shared/reportsWorkspace.ts)", () => {
  test("a saved query is JSON of known fields only; SQL and unknown fields are refused", () => {
    expect(parseDatasetQuery("SELECT * FROM users").ok).toBe(false);
    expect(parseDatasetQuery(JSON.stringify({ dataset: "time.entries", measures: [{ fn: "count" }], sql: "SELECT 1" })).ok).toBe(false);
    expect(parseDatasetQuery(JSON.stringify({ dataset: "time.entries", measures: [{ fn: "drop" }] })).ok).toBe(false);
    expect(parseDatasetQuery(JSON.stringify({ dataset: "time.entries", measures: [{ fn: "count" }], timeRange: { preset: "mtd" } })).ok).toBe(true);
  });

  test("presets resolve on today; placeholders bind; All and open ends filter nothing", () => {
    const query = { dataset: "crm.deals", measures: [{ fn: "count" as const }], timeRange: { preset: "mtd" as const }, filters: [
      { column: "stage", op: "in" as const, value: "{stages:Array(String)}" },
      { column: "owner", op: "eq" as const, value: "{who:String}" },
      { column: "value", op: "gte" as const, value: "{amount_min:Float64}" }
    ] };
    const bound = bindDatasetQuery(query, [
      { name: "stages", type: "Array(String)", value: "[]" }, { name: "who", type: "String", value: "Ann\\tB" }, { name: "amount_min", type: "Float64", value: "-inf" }
    ], "2026-11-14");
    expect(bound.timeRange).toEqual({ from: "2026-11-01", to: "2026-11-14" });
    expect(bound.filters).toEqual([{ column: "owner", op: "eq", value: "Ann\tB" }]);
    const picked = bindDatasetQuery(query, [{ name: "stages", type: "Array(String)", value: "['Won','Lost']" }, { name: "who", type: "String", value: "x" }, { name: "amount_min", type: "Float64", value: "10" }], "2026-11-14");
    expect(picked.filters).toEqual([{ column: "stage", op: "in", value: ["Won", "Lost"] }, { column: "owner", op: "eq", value: "x" }, { column: "value", op: "gte", value: 10 }]);
    expect(() => bindDatasetQuery({ dataset: "crm.deals", measures: [{ fn: "count" }], filters: [{ column: "stage", op: "eq", value: "{nope:String}" }] }, [], "2026-11-14")).toThrow();
  });

  test("an API key reads a workspace block only with its dataset's module scope (T603)", () => {
    expect(missingDatasetScope(hoursByPerson, (scope) => scope === "reports:read")).toBe("time:read");
    expect(missingDatasetScope(hoursByPerson, (scope) => scope === "time:read")).toBeNull();
  });
});

describe("generating a workspace report with the AI (scripted provider)", () => {
  test("the prompt carries the dataset catalog, the schema tools are gone, and run_sql takes a structured query", async () => {
    const { startScriptedProvider } = await import("../scripts/fakeReportProvider");
    const { DEFAULT_COMPAT } = await import("../shared/agents");
    const { generateDeps, liveGenerations } = await import("../server/reports/generate");
    const provider = startScriptedProvider(0, (context) => {
      if (context.step === 1) return { toolCalls: [{ name: "run_sql", arguments: { sql: hoursByPerson, purpose: "Hours by person", key: "hours" } }] };
      return { toolCalls: [{ name: "submit_report", arguments: { title: "Hours by person this month", sections: [], parameters: [], queries: [{ key: "hours", sql: hoursByPerson, purpose: "Hours by person" }],
        blocks: [{ id: "hours", type: "table", intent: "detail", title: "Hours by person", queryKey: "hours" }] } }] };
    });
    const original = generateDeps.connection;
    generateDeps.connection = () => ({ id: "scripted", baseUrl: provider.baseUrl, apiKey: null, model: "scripted-report-model", compat: DEFAULT_COMPAT });
    try {
      const noteId = (await send(owner, "POST", "/notes", { folderId: null })).body.note.id as string;
      expect((await send(owner, "PUT", `/notes/${noteId}/draft`, { markdown: "# Hours\n\nHours by person this month.", revision: 1 })).status).toBe(200);
      expect((await send(owner, "POST", `/notes/${noteId}/publish`)).status).toBe(200);
      const started = await send(owner, "POST", "/reports/generate", { docRef: noteId, serverId: "nook", datasourceId: "workspace" });
      expect(started.status).toBe(202);
      const until = Date.now() + 20_000;
      while (liveGenerations().length && Date.now() < until) await Bun.sleep(20);
      const run = db.query("SELECT status, error FROM report_runs WHERE id = ?").get(started.body.run.id) as { status: string; error: string | null };
      expect(run).toMatchObject({ status: "succeeded" });
      const first = provider.calls[0]!;
      const system = String(first.messages?.[0]?.content ?? "");
      expect(system).toContain("## Datasets you can query");
      expect(system).toContain("### time.entries");
      expect(system).not.toContain("ClickHouse dialect");
      const tools = (first.tools ?? []).map((tool) => tool.function.name);
      expect(tools).toContain("run_sql");
      expect(tools).not.toContain("search_schema");
      const reportId = started.body.report.id as string;
      expect((db.query("SELECT source FROM reports WHERE id = ?").get(reportId) as { source: string }).source).toBe("workspace");
      expect((await send(owner, "GET", `/reports/${reportId}/results`)).body.results[0].result.rows).toEqual([["Workspace report owner", 4]]);
    } finally {
      generateDeps.connection = original;
      provider.stop();
    }
  });
});
