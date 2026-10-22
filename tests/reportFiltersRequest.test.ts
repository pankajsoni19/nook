import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse, type FakeAnswer, type FakeRequest, type FakeTable } from "./support/fakeClickhouse";
import { retireUsersAfterFile } from "./support/retireUsers";
import { filterRequestPatch, qaEditScript, startScriptedProvider, withCondition, withoutCondition, type Script } from "../scripts/fakeReportProvider";
import { DEFAULT_COMPAT } from "../shared/agents";
import type { ReportSpec } from "../shared/reports";
import topRoutes from "../evals/reports/cases/top_routes/case";

const { editDeps, liveEdits } = await import("../server/reports/edit");
const { reportTools } = await import("../server/mcpTools").then(() => import("../server/reports/mcpTools"));
const refresh = await import("../server/reports/refresh");
const params = await import("../server/reports/params");
const { syncSchema } = await import("../server/reports/schemaCatalog");
const { filterChType, optionsQueryFor, suggestedFilter } = await import("../server/reports/filterRequest");
const { filterPatchErrors, resultFingerprint } = await import("../server/reports/filterChecks");
const { checkSpecShape } = await import("../server/reports/specValidate");

/**
 * Add filter and Remove filter (lane FILTERS, D534–D536; docs/plan/REPORT_FILTERS.md F3): the column
 * picker from the catalog, the options query built from identifiers, the structured request answered
 * by the scripted edit agent on the eval case `top_routes` ("add a filter on requests.route"), the
 * deterministic checks (D535) before a proposal is stored, Remove filter, click filters set by the
 * agent, owner-only routes and MCP tools, and that a filter proposal never applies itself.
 */

retireUsersAfterFile();
setDefaultTimeout(30_000);

const fake = startFakeClickhouse(0, { database: "eval_top_routes" });
const provider = startScriptedProvider(0, qaEditScript);
const originalConnection = editDeps.connection;
editDeps.connection = () => ({ id: "scripted", baseUrl: provider.baseUrl, apiKey: null, model: "scripted-report-model", compat: DEFAULT_COMPAT });

const TABLES: FakeTable[] = [{
  db: "eval_top_routes", name: "requests", engine: "MergeTree", total_rows: 9000,
  columns: [
    { name: "ts", type: "DateTime" }, { name: "route", type: "LowCardinality(String)" }, { name: "status", type: "UInt16" },
    { name: "latency_ms", type: "Float64" }, { name: "user_email", type: "String", comment: "who asked" }, { name: "api_token_hash", type: "String" }
  ]
}];
/** The eval's requests, by route: served (status < 500) and failed (≥ 500). Health checks are the largest raw route. */
const TRAFFIC: Record<string, { ok: number; failed: number }> = { healthz: { ok: 9000, failed: 0 }, digest: { ok: 3904, failed: 96 }, search: { ok: 1800, failed: 700 }, orders: { ok: 1500, failed: 100 } };

function answer(sql: string, req: FakeRequest): FakeAnswer {
  if (sql.includes("uniq(`route`)")) return { meta: [{ name: "distinct_values", type: "UInt64" }], data: [[String(Object.keys(TRAFFIC).length)]] };
  if (sql.includes("uniq(`status`)")) return { meta: [{ name: "distinct_values", type: "UInt64" }], data: [["250000"]] };
  if (sql.includes("toString(`route`) AS value")) return { meta: [{ name: "value", type: "String" }], data: Object.entries(TRAFFIC).sort((a, b) => (b[1].ok + b[1].failed) - (a[1].ok + a[1].failed)).map(([route]) => [route]) };
  const picked = req.params.param_route ? [...req.params.param_route.matchAll(/'([^']*)'/g)].map((match) => match[1]!) : [];
  // `empty(p) OR route IN p` keeps every route at All; a bare `route IN p` keeps none (the meaning changed).
  const narrows = sql.includes("{route:Array(String)}");
  const keepsAll = !narrows || sql.includes("empty({route:Array(String)})");
  const routes = Object.keys(TRAFFIC).filter((route) => route !== "healthz" && route !== "readyz").filter((route) => !narrows || (picked.length ? picked.includes(route) : keepsAll));
  if (sql.includes("AS served")) return { meta: [{ name: "route", type: "LowCardinality(String)" }, { name: "served", type: "UInt64" }], data: routes.map((route) => [route, String(TRAFFIC[route]!.ok)]).sort((a, b) => Number(b[1]) - Number(a[1])) };
  if (sql.includes("error_rate")) {
    const failed = routes.reduce((sum, route) => sum + TRAFFIC[route]!.failed, 0);
    const total = routes.reduce((sum, route) => sum + TRAFFIC[route]!.ok + TRAFFIC[route]!.failed, 0);
    return { meta: [{ name: "error_rate", type: "Float64" }], data: [[total ? failed / total : null]] };
  }
  return { meta: [{ name: "n", type: "UInt64" }], data: [["1"]] };
}

afterAll(() => {
  editDeps.connection = originalConnection;
  fake.stop();
  provider.stop();
});
beforeEach(() => {
  fake.state.tables = TABLES;
  fake.state.grants = ["GRANT SELECT ON eval_top_routes.* TO nook_ro"];
  fake.state.select = answer;
  provider.setScript(qaEditScript);
  provider.calls.length = 0;
  params.resetParamRateLimit();
});
afterEach(async () => {
  const until = Date.now() + 15_000;
  while (liveEdits().length) {
    if (Date.now() > until) throw new Error("an edit is still running");
    await Bun.sleep(20);
  }
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

fake.state.tables = TABLES;
const admin = await createUser("Filter request admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Filter request owner");
const commenter = await createUser("Filter request commenter");
const created = await send(admin, "POST", "/reports/admin/datasources", { name: `Routes ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", database: "eval_top_routes", allowlist: ["eval_top_routes"] });
const datasourceId = created.body.datasource.id as string;
await syncSchema(datasourceId).catch(() => undefined);

/** The eval case's golden report: a KPI over the error rate and a chart of served requests by route. */
function goldenSpec(): ReportSpec {
  return { version: 1, specVersion: 3, sections: [], parameters: [], queries: topRoutes.golden.queries.map((query) => ({ ...query, createdBy: "agent" as const })), blocks: topRoutes.golden.blocks as ReportSpec["blocks"] };
}

async function seededReport() {
  const report = await send(owner, "POST", "/reports", { title: "API traffic", datasourceId });
  const id = report.body.report.id as string;
  db.query("UPDATE reports SET spec_json = ?, status = 'ready' WHERE id = ?").run(JSON.stringify(goldenSpec()), id);
  expect((await send(owner, "PUT", `/reports/${id}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: commenter.userId, level: "comment" }] })).status).toBe(200);
  await refresh.startRefresh(owner.userId, id, { trigger: "user" }).done;
  return id;
}

async function waitFor<T>(read: () => T, check: (value: T) => boolean, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (check(value)) return value;
    if (Date.now() > until) throw new Error(`timed out: ${JSON.stringify(value)}`);
    await Bun.sleep(15);
  }
}
const instructionOf = (id: string) => db.query("SELECT status, error FROM report_instructions WHERE id = ?").get(id) as { status: string; error: string | null };
const waitStatus = (id: string, statuses: string[]) => waitFor(() => instructionOf(id), (row) => statuses.includes(row.status));
const specOf = (reportId: string) => JSON.parse((db.query("SELECT spec_json FROM reports WHERE id = ?").get(reportId) as { spec_json: string }).spec_json) as ReportSpec;
const ROUTES_SQL = topRoutes.golden.queries[0]!.sql;
const ERRORS_SQL = topRoutes.golden.queries[1]!.sql;

describe("pure parts", () => {
  test("the column types a filter takes, the options query from identifiers, and the suggested id and label", () => {
    expect(filterChType("LowCardinality(Nullable(String))")).toBe("Array(String)");
    expect(filterChType("Enum8('a' = 1, 'b' = 2)")).toBe("Array(String)");
    expect(filterChType("UInt16")).toBe("Array(UInt32)");
    expect(filterChType("Int64")).toBe("Array(Int64)");
    expect(filterChType("UInt64")).toBe("Array(UInt64)");
    expect(filterChType("DateTime")).toBeNull();
    expect(filterChType("Float64")).toBeNull();
    expect(filterChType("Array(String)")).toBeNull();
    expect(optionsQueryFor("eval_top_routes.requests", "route")).toBe("SELECT toString(`route`) AS value FROM `eval_top_routes`.`requests` GROUP BY value ORDER BY count() DESC LIMIT 200");
    expect(optionsQueryFor("db.t", "we`ird")).toContain("toString(`we\\`ird`)");
    expect(suggestedFilter("plan_tier", [])).toEqual({ id: "plan_tier", label: "Plan tier" });
    expect(suggestedFilter("Route", ["route"])).toEqual({ id: "route_2", label: "Route" });
    expect(suggestedFilter("customerId", [])).toEqual({ id: "customerid", label: "Customer id" });
    expect(suggestedFilter("9lives", [])).toEqual({ id: "lives", label: "9lives" });
  });

  test("the scripted agent's condition goes in and comes out again", () => {
    const condition = "(empty({route:Array(String)}) OR route IN {route:Array(String)})";
    const added = withCondition(ROUTES_SQL, condition);
    expect(added).toContain(`WHERE ${condition} AND route NOT IN`);
    expect(withoutCondition(added, "route")).toBe(ROUTES_SQL);
    const bare = "SELECT count() AS n FROM db.t GROUP BY x";
    expect(withoutCondition(withCondition(bare, condition), "route")).toBe(bare);
  });

  test("D535: the patch must be exactly the request (shape checks)", () => {
    const before = goldenSpec();
    const request = { kind: "add_filter" as const, id: "route", label: "Route", table: "eval_top_routes.requests", column: "route", chType: "Array(String)", optionsQuery: optionsQueryFor("eval_top_routes.requests", "route") };
    const param = { id: "route", label: "Route", type: "multi_select" as const, chType: "Array(String)", default: [], optionsQuery: request.optionsQuery };
    const condition = "(empty({route:Array(String)}) OR route IN {route:Array(String)})";
    const good: ReportSpec = { ...before, parameters: [param], queries: before.queries.map((query) => query.key === "errors" ? { ...query, sql: withCondition(query.sql, condition) } : query) };
    expect(filterPatchErrors(before, good, request, "eval_top_routes")).toEqual([]);
    expect(filterPatchErrors(before, { ...good, parameters: [{ ...param, label: "Routes" }] }, request, "eval_top_routes")[0]).toContain("The parameter must be exactly");
    expect(filterPatchErrors(before, { ...good, parameters: [{ ...param, default: ["digest"] }] }, request, "eval_top_routes")[0]).toContain("The parameter must be exactly");
    expect(filterPatchErrors(before, { ...good, blocks: good.blocks.map((block) => ({ ...block, title: "Renamed" })) }, request, "eval_top_routes")).toContain("A block changed; a filter request changes no block (it may only set clickFilter to the new filter on a chart or table that shows its column)");
    expect(filterPatchErrors(before, { ...good, parameters: [param], queries: before.queries }, request, "eval_top_routes")).toContain("Put the filter into at least one query that reads eval_top_routes.requests (update_query)");
    const elsewhere = { ...good, queries: good.queries.map((query) => query.key === "errors" ? { ...query, sql: "SELECT 1 AS error_rate FROM eval_top_routes.other WHERE (empty({route:Array(String)}) OR 1 IN {route:Array(String)})" } : query) };
    expect(filterPatchErrors(before, elsewhere, request, "eval_top_routes")).toContain("Query errors does not read eval_top_routes.requests; only queries that read it take this filter");
    const added = { ...good, queries: [...good.queries, { key: "extra", sql: "SELECT 1", purpose: "", createdBy: "agent" as const }] };
    expect(filterPatchErrors(before, added, request, "eval_top_routes")).toContain("Query extra was added; a filter request adds no query");
    // A click filter on the new parameter is the one block change allowed.
    const clicked = { ...good, blocks: good.blocks.map((block) => block.id === "routes" ? { ...block, clickFilter: { param: "route", column: "route" } } : block) } as ReportSpec;
    expect(filterPatchErrors(before, clicked, request, "eval_top_routes")).toEqual([]);
    // Its own query must not read the filter (the clicked chart keeps every category).
    const selfFiltering = { ...clicked, queries: clicked.queries.map((query) => ({ ...query, sql: query.key === "routes" ? withCondition(query.sql, condition) : query.sql })) };
    const shape = checkSpecShape(selfFiltering);
    expect(shape.ok ? [] : shape.errors).toContain("block routes: clickFilter cannot filter by route: the block's own query reads it (a clicked chart highlights its choice and keeps every category)");
  });

  test("a result's fingerprint ignores row order, not values or columns", () => {
    const columns = [{ name: "route", type: "String" }, { name: "n", type: "UInt64" }];
    expect(resultFingerprint({ columns, rows: [["a", "1"], ["b", "2"]] })).toBe(resultFingerprint({ columns, rows: [["b", "2"], ["a", "1"]] }));
    expect(resultFingerprint({ columns, rows: [["a", "1"]] })).not.toBe(resultFingerprint({ columns, rows: [["a", "2"]] }));
    expect(resultFingerprint({ columns, rows: [] })).not.toBe(resultFingerprint({ columns: [columns[0]!], rows: [] }));
  });
});

describe("Add filter: the eval case top_routes, \"add a filter on requests.route\"", () => {
  test("columns from the catalog (owner only), a preview with sample values, then a request the scripted agent answers; the proposal passes the checks and applies", async () => {
    const reportId = await seededReport();
    const columns = await send(owner, "GET", `/reports/${reportId}/filters/columns`);
    expect(columns.status).toBe(200);
    expect(columns.body.queries).toBe(2);
    expect(columns.body.slotsLeft).toBe(8);
    const byName = Object.fromEntries(columns.body.columns.map((column: Json) => [column.column, column]));
    expect(Object.keys(byName).sort()).toEqual(["api_token_hash", "route", "status", "ts", "user_email"]);
    // D569, D570: text also as "contains", whole numbers as a list, a time as a date range.
    expect([byName.route.kinds, byName.status.kinds, byName.ts.kinds, byName.ts.chType]).toEqual([["multi_select", "text"], ["multi_select"], ["date_range"], "Date"]);
    expect(byName.route).toMatchObject({ table: "eval_top_routes.requests", type: "LowCardinality(String)", chType: "Array(String)", readBy: ["routes", "errors"], sensitive: false });
    expect(byName.user_email.sensitive).toBe(true);
    expect(byName.api_token_hash.sensitive).toBe(true);
    // Readers and commenters cannot add filters.
    expect((await send(commenter, "GET", `/reports/${reportId}/filters/columns`)).status).toBe(404);
    expect((await send(commenter, "POST", `/reports/${reportId}/filters`, { table: "eval_top_routes.requests", column: "route" })).status).toBe(404);
    expect((await send(commenter, "DELETE", `/reports/${reportId}/filters/route`)).status).toBe(404);

    const preview = await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: "eval_top_routes.requests", column: "route" });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ sample: ["healthz", "digest", "search", "orders"], optionCount: 4, distinct: 4, suggested: { id: "route", label: "Route" }, optionsQuery: optionsQueryFor("eval_top_routes.requests", "route") });
    // A column with too many values, or one the report's tables do not have, is refused.
    expect((await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: "eval_top_routes.requests", column: "status" })).body.error).toContain("different values");
    expect((await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: "eval_top_routes.requests", column: "latency_ms" })).status).toBe(400);
    expect((await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: "system.users", column: "name" })).status).toBe(400);

    // Auto-apply is on: a filter proposal still waits for review.
    db.query("UPDATE reports SET auto_apply = 1 WHERE id = ?").run(reportId);
    const asked = await send(owner, "POST", `/reports/${reportId}/filters`, { table: "eval_top_routes.requests", column: "route", label: "Route" });
    expect(asked.status).toBe(201);
    expect(asked.body.instruction).toMatchObject({ text: "Add a filter: Route (eval_top_routes.requests.route)", request: { kind: "add_filter", id: "route", label: "Route", table: "eval_top_routes.requests", column: "route", chType: "Array(String)" } });
    const instructionId = asked.body.instruction.id as string;
    expect(await waitStatus(instructionId, ["proposed", "failed"])).toEqual({ status: "proposed", error: null });
    // The prompt carried the structured request (the label as JSON data), not the block part.
    const system = String(provider.calls.at(-1)!.messages![0]!.content);
    expect(system).toContain("## The filter request");
    expect(system).toContain(`<request>${JSON.stringify(asked.body.instruction.request)}</request>`);
    expect(system).not.toContain("## The block\n");

    const proposal = (await send(owner, "GET", `/reports/${reportId}/instructions/${instructionId}/proposal`)).body.proposal;
    expect(proposal.filter).toEqual({
      request: asked.body.instruction.request,
      // healthz (the most common value) gives the error rate no data (the query excludes it); digest, the next, does.
      checked: [{ key: "errors", rows: 1, otherValue: "digest", otherRows: 1 }],
      untouched: [{ key: "routes", reason: "Shows every route; clicking it sets the filter" }],
      reach: { blocks: 1, total: 2 }
    });
    expect(proposal.queries).toEqual([{ key: "errors", change: "updated", before: ERRORS_SQL, after: withCondition(ERRORS_SQL, "(empty({route:Array(String)}) OR route IN {route:Array(String)})") }]);
    expect(proposal.spec.blocks.find((block: Json) => block.id === "routes").clickFilter).toEqual({ param: "route", column: "route" });
    expect(specOf(reportId).parameters).toEqual([]);

    const applied = await send(owner, "POST", `/reports/${reportId}/instructions/${instructionId}/apply`, {});
    expect(applied.body.instruction).toMatchObject({ status: "applied", autoApplied: false });
    const spec = specOf(reportId);
    expect(spec.parameters).toEqual([{ id: "route", label: "Route", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: optionsQueryFor("eval_top_routes.requests", "route") }]);
    // The default results did not change; a picked route filters the KPI, and the chart (its click source) keeps every route.
    const defaults = await send(owner, "GET", `/reports/${reportId}/results`);
    expect(defaults.body.results.find((item: Json) => item.queryKey === "errors").result.rows).toEqual([[896 / 8100]]);
    expect(defaults.body.reach).toEqual({ route: ["errors"] });
    const run = await send(owner, "POST", `/reports/${reportId}/param-runs`, { values: { route: ["search"] } });
    expect(run.body.results.find((item: Json) => item.queryKey === "errors").result.rows).toEqual([[700 / 2500]]);
    expect(run.body.results.find((item: Json) => item.queryKey === "routes").result.rows.length).toBe(3);
    // TF3: a clicked value that is not one of the options is refused like a picked one.
    const forged = await send(owner, "POST", `/reports/${reportId}/param-runs`, { values: { route: ["'; DROP TABLE x"] } });
    expect(forged).toMatchObject({ status: 400, body: { code: "INVALID" } });
  });

  test("D535: an agent whose filter changes the default results is refused with the reason, and the instruction fails after its tries", async () => {
    const reportId = await seededReport();
    // A bare `IN` keeps nothing at All: the meaning changed.
    const careless: Script = (context) => {
      const good = filterRequestPatch(context.system);
      if (!good) return qaEditScript(context);
      const ops = good.ops.map((op) => op.op === "update_query" ? { ...op, sql: (op as { sql: string }).sql.replace("(empty({route:Array(String)}) OR route IN {route:Array(String)})", "route IN {route:Array(String)}") } : op);
      return { toolCalls: [{ name: "submit_patch", arguments: { ...good, ops } }] };
    };
    provider.setScript(careless);
    const asked = await send(owner, "POST", `/reports/${reportId}/filters`, { table: "eval_top_routes.requests", column: "route" });
    const row = await waitStatus(asked.body.instruction.id, ["proposed", "failed"]);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("with the filter at All its result is not identical to today's");
    const refusals = provider.calls.flatMap((body) => (body.messages ?? []).filter((turn) => turn.role === "tool").map((turn) => String(turn.content)));
    expect(refusals.some((text) => text.includes("Query errors: with the filter at All its result is not identical to today's"))).toBe(true);
    expect(specOf(reportId).parameters).toEqual([]);
  });

  test("Remove filter: the parameter and its condition go, the click filter on it too, checked against All", async () => {
    const reportId = await seededReport();
    const asked = await send(owner, "POST", `/reports/${reportId}/filters`, { table: "eval_top_routes.requests", column: "route" });
    await waitStatus(asked.body.instruction.id, ["proposed"]);
    await send(owner, "POST", `/reports/${reportId}/instructions/${asked.body.instruction.id}/apply`, {});
    expect(specOf(reportId).parameters.map((param) => param.id)).toEqual(["route"]);
    expect((await send(owner, "DELETE", `/reports/${reportId}/filters/period`)).status).toBe(404);
    const removal = await send(owner, "DELETE", `/reports/${reportId}/filters/route`);
    expect(removal.status).toBe(200);
    expect(removal.body.instruction).toMatchObject({ text: "Remove the filter Route", request: { kind: "remove_filter", id: "route", label: "Route" } });
    expect(await waitStatus(removal.body.instruction.id, ["proposed", "failed"])).toEqual({ status: "proposed", error: null });
    const proposal = (await send(owner, "GET", `/reports/${reportId}/instructions/${removal.body.instruction.id}/proposal`)).body.proposal;
    expect(proposal.filter.checked).toEqual([{ key: "errors", rows: 1, otherValue: null, otherRows: null }]);
    await send(owner, "POST", `/reports/${reportId}/instructions/${removal.body.instruction.id}/apply`, {});
    const spec = specOf(reportId);
    expect(spec.parameters).toEqual([]);
    expect(spec.queries.map((query) => query.sql)).toEqual([ROUTES_SQL, ERRORS_SQL]);
    expect(spec.blocks.some((block) => "clickFilter" in block)).toBe(false);
  });

  test("MCP: add_report_filter is the owner's (reports:write); get_report shows clickFilter and reach; removing a filter stays in the app (D180)", async () => {
    const reportId = await seededReport();
    const tool = (name: string) => reportTools.find((item) => item.name === name)!;
    const key = (session: Session) => ({ keyId: `k-${session.userId.slice(0, 6)}`, userId: session.userId, name: "k", scopes: ["reports:read", "reports:write"] as never });
    await expect(Promise.resolve(tool("add_report_filter").handler({ reportId, table: "eval_top_routes.requests", column: "route" }, key(commenter)))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const added = await tool("add_report_filter").handler({ reportId, table: "eval_top_routes.requests", column: "route", label: "Route", parameterId: "route" }, key(owner)) as Json;
    expect(added.instruction).toMatchObject({ via: "mcp", request: { kind: "add_filter", id: "route" } });
    await waitStatus(added.instruction.id, ["proposed"]);
    await send(owner, "POST", `/reports/${reportId}/instructions/${added.instruction.id}/apply`, {});
    const report = await tool("get_report").handler({ reportId }, key(owner)) as Json;
    expect(report.reach).toEqual({ route: ["errors"] });
    expect(report.blocks.find((block: Json) => block.id === "routes").clickFilter).toEqual({ param: "route", column: "route" });
    // No MCP tool removes a filter, and a removal asked for in the app is applied in the app only.
    expect(reportTools.some((item) => /remove/.test(item.name))).toBe(false);
    const removal = await send(owner, "DELETE", `/reports/${reportId}/filters/route`);
    await waitStatus(removal.body.instruction.id, ["proposed"]);
    await expect(Promise.resolve(tool("apply_report_proposal").handler({ reportId, instructionId: removal.body.instruction.id }, key(owner)))).rejects.toMatchObject({ code: "INVALID" });
    expect(specOf(reportId).parameters.map((param) => param.id)).toEqual(["route"]);
    expect((await send(owner, "POST", `/reports/${reportId}/instructions/${removal.body.instruction.id}/apply`, {})).status).toBe(200);
    expect(specOf(reportId).parameters).toEqual([]);
  });
});

describe("D536: the owner sets what a click filters by (set_click_filter)", () => {
  test("a manual edit sets and clears it; refused on a block that reads the parameter, on another kind, or on a missing column", async () => {
    const reportId = await seededReport();
    const asked = await send(owner, "POST", `/reports/${reportId}/filters`, { table: "eval_top_routes.requests", column: "route" });
    await waitStatus(asked.body.instruction.id, ["proposed"]);
    await send(owner, "POST", `/reports/${reportId}/instructions/${asked.body.instruction.id}/apply`, {});
    const edit = async (ops: Json[]) => send(owner, "POST", `/reports/${reportId}/spec/edit`, { ops, expectedRevision: (db.query("SELECT revision FROM reports WHERE id = ?").get(reportId) as { revision: number }).revision });
    const cleared = await edit([{ op: "set_click_filter", id: "routes", clickFilter: null }]);
    expect(cleared.status).toBe(200);
    expect(specOf(reportId).blocks.find((block) => block.id === "routes")).not.toHaveProperty("clickFilter");
    expect((await edit([{ op: "set_click_filter", id: "routes", clickFilter: { param: "route", column: "route" } }])).status).toBe(200);
    expect((await edit([{ op: "set_click_filter", id: "errors", clickFilter: { param: "route", column: "error_rate" } }])).body.error).toContain("only a chart or a table filters on a click");
    expect((await edit([{ op: "set_click_filter", id: "routes", clickFilter: { param: "route", column: "served" } }])).body.error).toContain("column must be the chart's x (route)");
    expect((await edit([{ op: "set_click_filter", id: "routes", clickFilter: { param: "nope", column: "route" } }])).body.error).toContain("not one of the report's parameters");
  });
});

describe("D568–D570: Add filter as exclude, text contains, and a date range", () => {
  test("a list readers may leave values out of: the condition reads the flag, the default results stay, and a run leaves values out", async () => {
    const reportId = await seededReport();
    const asked = await send(owner, "POST", `/reports/${reportId}/filters`, { table: "eval_top_routes.requests", column: "route", exclude: true });
    expect(asked.body.instruction).toMatchObject({ text: "Add a filter: Route (eval_top_routes.requests.route), values can be left out", request: { exclude: true, condition: "(empty({route:Array(String)}) OR (route IN {route:Array(String)}) != {route_not:UInt8})" } });
    expect(await waitStatus(asked.body.instruction.id, ["proposed", "failed"])).toEqual({ status: "proposed", error: null });
    await send(owner, "POST", `/reports/${reportId}/instructions/${asked.body.instruction.id}/apply`, {});
    expect(specOf(reportId).queries.find((query) => query.key === "errors")!.sql).toContain("!= {route_not:UInt8}");
    fake.requests.length = 0;
    const run = await send(owner, "POST", `/reports/${reportId}/param-runs`, { values: { route: { not: ["search"] } } });
    expect(run.status).toBe(200);
    expect(fake.requests.some((item) => item.params.param_route_not === "1" && item.params.param_route === "['search']")).toBe(true);
    const tool = reportTools.find((item) => item.name === "get_report")!;
    expect((await tool.handler({ reportId }, { keyId: "k-x", userId: owner.userId, name: "k", scopes: ["reports:read"] as never }) as Json).excludable).toEqual(["route"]);
  });

  test("text contains: a text parameter, positionCaseInsensitive, checked at empty text", async () => {
    const reportId = await seededReport();
    const preview = await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: "eval_top_routes.requests", column: "route", kind: "text" });
    expect(preview.body.preview).toMatchObject({ kind: "text", narrowBy: [] });
    expect((await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: "eval_top_routes.requests", column: "status", kind: "text" })).status).toBe(400);
    const asked = await send(owner, "POST", `/reports/${reportId}/filters`, { table: "eval_top_routes.requests", column: "route", kind: "text", label: "Route contains" });
    expect(asked.body.instruction.request).toMatchObject({ type: "text", chType: "String", condition: "(empty({route:String}) OR positionCaseInsensitive(toString(route), {route:String}) > 0)" });
    expect(await waitStatus(asked.body.instruction.id, ["proposed", "failed"])).toEqual({ status: "proposed", error: null });
    const proposal = (await send(owner, "GET", `/reports/${reportId}/instructions/${asked.body.instruction.id}/proposal`)).body.proposal;
    expect(proposal.filter.reviewByHand).toBeUndefined();
    // Text contains narrows the chart too (it is no list a click could set), so both queries take it.
    expect(proposal.filter.checked.map((item: Json) => [item.key, item.otherValue])).toEqual([["routes", "healthz"], ["errors", "healthz"]]);
    await send(owner, "POST", `/reports/${reportId}/instructions/${asked.body.instruction.id}/apply`, {});
    expect(specOf(reportId).parameters).toEqual([{ id: "route", label: "Route contains", type: "text", chType: "String", default: "" }]);
  });

  test("a date range on a DateTime: no identity check, the proposal says to review it by hand", async () => {
    const reportId = await seededReport();
    const preview = await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: "eval_top_routes.requests", column: "ts" });
    expect(preview.body.preview).toMatchObject({ kind: "date_range", sample: [], optionsQuery: "" });
    expect((await send(owner, "POST", `/reports/${reportId}/filters`, { table: "eval_top_routes.requests", column: "ts", preset: "2y" })).status).toBe(400);
    const asked = await send(owner, "POST", `/reports/${reportId}/filters`, { table: "eval_top_routes.requests", column: "ts", label: "Period", preset: "7d" });
    expect(asked.body.instruction).toMatchObject({ text: "Add a filter: Period (eval_top_routes.requests.ts), a date range starting at Last 7 days", request: { type: "date_range", preset: "7d", condition: "toDate(ts) BETWEEN {ts_from:Date} AND {ts_to:Date}" } });
    expect(await waitStatus(asked.body.instruction.id, ["proposed", "failed"])).toEqual({ status: "proposed", error: null });
    const proposal = (await send(owner, "GET", `/reports/${reportId}/instructions/${asked.body.instruction.id}/proposal`)).body.proposal;
    expect(proposal.filter.reviewByHand).toBe(true);
    expect(proposal.filter.checked.map((item: Json) => item.otherValue)).toEqual(proposal.filter.checked.map(() => "30d"));
    await send(owner, "POST", `/reports/${reportId}/instructions/${asked.body.instruction.id}/apply`, {});
    expect(specOf(reportId).parameters).toEqual([{ id: "ts", label: "Period", type: "date_range", chType: "Date", default: { preset: "7d" } }]);
  });
});

describe("D562: Add filter narrowed by an existing filter on the same table (a linked filter)", () => {
  test("the preview offers Narrow by Status; the request's options query reads it, and the agent adds the filter after it", async () => {
    const STATUS_BY = "(empty({status:Array(UInt32)}) OR status IN {status:Array(UInt32)})";
    const status = { id: "status", label: "Status", type: "multi_select" as const, chType: "Array(UInt32)", default: [], optionsQuery: optionsQueryFor("eval_top_routes.requests", "status") };
    const report = await send(owner, "POST", "/reports", { title: "API traffic by status", datasourceId });
    const reportId = report.body.report.id as string;
    const spec = goldenSpec();
    db.query("UPDATE reports SET spec_json = ?, status = 'ready' WHERE id = ?").run(JSON.stringify({ ...spec, parameters: [status], queries: spec.queries.map((query) => query.key === "errors" ? { ...query, sql: withCondition(query.sql, STATUS_BY) } : query) }), reportId);
    await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;

    const plain = await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: "eval_top_routes.requests", column: "route" });
    expect(plain.body.preview.narrowBy).toEqual([{ paramId: "status", label: "Status", column: "status", picked: false }]);
    const narrowed = await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: "eval_top_routes.requests", column: "route", narrowBy: ["status"] });
    const linkedQuery = "SELECT toString(`route`) AS value FROM `eval_top_routes`.`requests` WHERE (empty({status:Array(UInt32)}) OR (`status` IN {status:Array(UInt32)}) != {status_not:UInt8}) GROUP BY value ORDER BY count() DESC LIMIT 200";
    expect(narrowed.body.preview).toMatchObject({ optionsQuery: linkedQuery, narrowBy: [{ paramId: "status", picked: true }], sample: ["healthz", "digest", "search", "orders"] });
    // The options query ran with the parent bound (All).
    expect(fake.requests.some((item) => item.sql.includes("`status` IN {status:Array(UInt32)}") && item.params.param_status === "[]" && item.params.param_status_not === "0")).toBe(true);
    // Only an offered filter can narrow.
    expect((await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: "eval_top_routes.requests", column: "route", narrowBy: ["nope"] })).status).toBe(400);

    const asked = await send(owner, "POST", `/reports/${reportId}/filters`, { table: "eval_top_routes.requests", column: "route", narrowBy: ["status"] });
    expect(asked.status).toBe(201);
    expect(asked.body.instruction).toMatchObject({ text: "Add a filter: Route (eval_top_routes.requests.route), narrowed by Status", request: { optionsQuery: linkedQuery } });
    expect(await waitStatus(asked.body.instruction.id, ["proposed", "failed"])).toEqual({ status: "proposed", error: null });
    expect(String(provider.calls.at(-1)!.messages![0]!.content)).toContain('Pass after: "status"');
    await send(owner, "POST", `/reports/${reportId}/instructions/${asked.body.instruction.id}/apply`, {});
    expect(specOf(reportId).parameters.map((param) => param.id)).toEqual(["status", "route"]);
    const options = await send(owner, "GET", `/reports/${reportId}/parameters/route/options?values=${encodeURIComponent(JSON.stringify({ status: ["500"] }))}`);
    expect(options.body.options.parents).toEqual({ status: ["500"] });
  });
});
