import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import type { ReportSpec } from "../shared/reports";
import { VIEW_LIMITS } from "../shared/reportsView";
import type { ReportParameter } from "../shared/reportParams";
import { designRefusals, refusalSentence } from "../shared/designRefusals";

const { reportTools } = await import("../server/mcpTools").then(() => import("../server/reports/mcpTools"));
const refresh = await import("../server/reports/refresh");
const params = await import("../server/reports/params");

/**
 * Saved views (lane FILT2, D565, D566; docs/plan/REPORT_FILTERS.md "Later" 3): per person, named value
 * sets and "my default view" (migration 069); anyone who can read keeps their own and sees no one
 * else's; values are checked when saved and stored as what differs from the defaults; only the owner's
 * "Save as report default" changes the spec, through the manual edit (a version that re-runs what reads
 * the changed defaults). App only to change: D676's MCP list_report_views only reads the key owner's own.
 */

retireUsersAfterFile();
const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
  fake.state.select = (sql: string, req) => sql.includes("DISTINCT country")
    ? { meta: [{ name: "country", type: "String" }], data: [["DE"], ["FR"], ["US"]] }
    : { meta: [{ name: "orders", type: "UInt64" }], data: [[String(req.params.param_country?.length ?? 0)]] };
  params.resetParamRateLimit();
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const PERIOD: ReportParameter = { id: "period", label: "Period", type: "date_range", chType: "Date", default: { preset: "30d" } };
const COUNTRY: ReportParameter = { id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT country FROM analytics.orders" };
const spec: ReportSpec = {
  version: 1, specVersion: 3, sections: [], parameters: [PERIOD, COUNTRY],
  queries: [{ key: "orders", sql: "SELECT count() AS orders FROM analytics.orders WHERE day >= {period_from:Date} AND day <= {period_to:Date} AND (empty({country:Array(String)}) OR country IN {country:Array(String)})", purpose: "Orders", createdBy: "agent" }],
  blocks: [{ id: "kpi", type: "kpi", title: "Orders", intent: "headline", queryKey: "orders", column: "orders", unit: "orders" }]
};

const admin = await createUser("Views admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Views owner");
const viewer = await createUser("Views viewer");
const stranger = await createUser("Views stranger");
const created = await send(admin, "POST", "/reports/admin/datasources", { name: "Views warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;

async function seeded() {
  const report = await send(owner, "POST", "/reports", { title: "Viewed orders", datasourceId });
  const id = report.body.report.id as string;
  db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(spec), id);
  expect((await send(owner, "PUT", `/reports/${id}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: viewer.userId, level: "view" }] })).status).toBe(200);
  await refresh.startRefresh(owner.userId, id, { trigger: "user" }).done;
  return id;
}

describe("D565: personal views", () => {
  test("a reader saves, renames, stars, and removes their own views; nobody else sees them", async () => {
    const reportId = await seeded();
    const saved = await send(viewer, "POST", `/reports/${reportId}/views`, { name: "  Germany  ", values: { country: ["DE"], period: { preset: "30d" } } });
    expect(saved.status).toBe(201);
    // Stored as what differs from the defaults.
    expect(saved.body.view).toMatchObject({ name: "Germany", values: { country: ["DE"] }, isDefault: false });
    // The same name (any case) overwrites.
    const again = await send(viewer, "POST", `/reports/${reportId}/views`, { name: "germany", values: { country: ["FR", "DE"] }, isDefault: true });
    expect(again.body.view).toMatchObject({ id: saved.body.view.id, name: "germany", values: { country: ["DE", "FR"] }, isDefault: true });
    const week = await send(viewer, "POST", `/reports/${reportId}/views`, { name: "This week", values: { period: { preset: "this_week" } }, isDefault: true });
    let list = await send(viewer, "GET", `/reports/${reportId}/views`);
    expect(list.body.canSaveDefault).toBe(false);
    expect(list.body.views.map((view: Json) => [view.name, view.isDefault])).toEqual([["germany", false], ["This week", true]]);
    // Others see none of them.
    expect((await send(owner, "GET", `/reports/${reportId}/views`)).body).toEqual({ views: [], canSaveDefault: true });
    expect((await send(stranger, "GET", `/reports/${reportId}/views`)).status).toBe(404);
    expect((await send(owner, "DELETE", `/reports/${reportId}/views/${week.body.view.id}`)).status).toBe(404);
    expect((await send(owner, "PATCH", `/reports/${reportId}/views/${week.body.view.id}`, { isDefault: false })).status).toBe(404);
    // Rename, unstar, remove.
    expect((await send(viewer, "PATCH", `/reports/${reportId}/views/${week.body.view.id}`, { name: "Germany" })).status).toBe(409);
    expect((await send(viewer, "PATCH", `/reports/${reportId}/views/${week.body.view.id}`, { name: "Week", isDefault: false })).body.view).toMatchObject({ name: "Week", isDefault: false });
    expect((await send(viewer, "DELETE", `/reports/${reportId}/views/${saved.body.view.id}`)).status).toBe(200);
    list = await send(viewer, "GET", `/reports/${reportId}/views`);
    expect(list.body.views.map((view: Json) => view.name)).toEqual(["Week"]);
  });

  test("values that do not fit, an empty name, a report without filters, and the per-report limit are refused", async () => {
    const reportId = await seeded();
    expect((await send(viewer, "POST", `/reports/${reportId}/views`, { name: "Bad", values: { country: "DE" } })).status).toBe(400);
    expect((await send(viewer, "POST", `/reports/${reportId}/views`, { name: "Bad", values: { nope: 1 } })).status).toBe(400);
    expect((await send(viewer, "POST", `/reports/${reportId}/views`, { name: "  ", values: {} })).status).toBe(400);
    for (let index = 0; index < VIEW_LIMITS.perReport; index += 1) expect((await send(viewer, "POST", `/reports/${reportId}/views`, { name: `View ${index}`, values: {} })).status).toBe(201);
    expect((await send(viewer, "POST", `/reports/${reportId}/views`, { name: "One more", values: {} })).body.code).toBe("LIMIT_REACHED");
    // Overwriting an existing name still works at the limit.
    expect((await send(viewer, "POST", `/reports/${reportId}/views`, { name: "View 0", values: { country: ["US"] } })).status).toBe(201);
    const plain = await send(owner, "POST", "/reports", { title: "No filters", datasourceId });
    expect((await send(owner, "POST", `/reports/${plain.body.report.id}/views`, { name: "x", values: {} })).status).toBe(400);
  });

  test("views go with the report; D676: MCP only lists the key owner's own views (read-only), nothing changes them", async () => {
    const reportId = await seeded();
    const saved = await send(viewer, "POST", `/reports/${reportId}/views`, { name: "Germany", values: { country: ["DE"] }, isDefault: true });
    expect(reportTools.filter((tool) => /view/.test(tool.name)).map((tool) => [tool.name, tool.write, tool.scopes])).toEqual([["list_report_views", false, ["reports:read"]]]);
    const tool = reportTools.find((item) => item.name === "list_report_views")!;
    const keyOf = (session: Session) => ({ keyId: "k-views", userId: session.userId, name: "k", scopes: ["reports:read"] as never });
    expect(await tool.handler({ reportId }, keyOf(viewer) as never)).toEqual({ views: [{ id: saved.body.view.id, name: "Germany", values: { country: ["DE"] }, isDefault: true, createdAt: saved.body.view.createdAt, updatedAt: saved.body.view.updatedAt }] });
    // The owner's key lists the owner's views (none), never the viewer's; a stranger's key finds no report.
    expect(await tool.handler({ reportId }, keyOf(owner) as never)).toEqual({ views: [] });
    await expect(Promise.resolve().then(() => tool.handler({ reportId }, keyOf(stranger) as never))).rejects.toThrow();
    db.query("DELETE FROM reports WHERE id = ?").run(reportId);
    expect((db.query("SELECT count(*) AS n FROM report_param_views WHERE report_id = ?").get(reportId) as { n: number }).n).toBe(0);
  });
});

describe("D566: Save as report default (the owner, a version)", () => {
  test("update_parameter on the defaults is a manual edit: a new version whose default results are re-run", async () => {
    const reportId = await seeded();
    const before = db.query("SELECT revision FROM reports WHERE id = ?").get(reportId) as { revision: number };
    const edit = await send(owner, "POST", `/reports/${reportId}/spec/edit`, { ops: [{ op: "update_parameter", id: "country", set: { default: ["DE", "FR"] } }], expectedRevision: before.revision });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const stored = JSON.parse((db.query("SELECT spec_json FROM reports WHERE id = ?").get(reportId) as { spec_json: string }).spec_json) as ReportSpec;
    expect(stored.parameters.find((param) => param.id === "country")!.default).toEqual(["DE", "FR"]);
    const results = await send(owner, "GET", `/reports/${reportId}/results`);
    expect(results.body.results[0].result.params.country).toBe("['DE','FR']");
    // A reader cannot.
    expect((await send(viewer, "POST", `/reports/${reportId}/spec/edit`, { ops: [{ op: "update_parameter", id: "country", set: { default: [] } }], expectedRevision: edit.body.revision })).status).toBe(404);
  });

  test("D674: a block the design rules refuse is named per block; the one-step fix goes with the defaults in the same edit", async () => {
    const reportId = await seeded();
    // A KPI saved before the rule (no format or unit) reads the changed default, so the rules check it.
    const bare = { ...spec, blocks: [{ id: "kpi", type: "kpi", title: "Orders", intent: "headline", queryKey: "orders", column: "orders" }] };
    db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(bare), reportId);
    const revision = (db.query("SELECT revision FROM reports WHERE id = ?").get(reportId) as { revision: number }).revision;
    const defaults = { op: "update_parameter", id: "country", set: { default: ["DE"] } };
    const refused = await send(owner, "POST", `/reports/${reportId}/spec/edit`, { ops: [defaults], expectedRevision: revision });
    expect(refused.status).toBe(400);
    const read = designRefusals(refused.body.details);
    expect(read.blocks).toEqual([{ blockId: "kpi", rule: 8, text: "the measure orders needs a format (number, percent, duration, currency:<ISO>) or a unit", fix: "format" }]);
    expect(refusalSentence(read.blocks[0]!.text)).toBe("The measure orders needs a format (number, percent, duration, currency:<ISO>) or a unit.");
    const fixed = await send(owner, "POST", `/reports/${reportId}/spec/edit`, { ops: [defaults, { op: "update_block", id: "kpi", set: { unit: "orders" } }], expectedRevision: revision });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    const stored = JSON.parse((db.query("SELECT spec_json FROM reports WHERE id = ?").get(reportId) as { spec_json: string }).spec_json) as ReportSpec;
    expect([stored.parameters.find((param) => param.id === "country")!.default, (stored.blocks[0] as { unit?: string }).unit]).toEqual([["DE"], "orders"]);
  });

  test("D674: refusal lines are read per block; a title is the other one-step fix; lines that name no block stay as they are", () => {
    expect(designRefusals(["block b1: rule 8: give the block a title", "block b2: rule 10: the query returned no rows; a chart needs data (filter less, or use a table or markdown note)", "query orders: Code: 60", 3])).toEqual({
      blocks: [{ blockId: "b1", rule: 8, text: "give the block a title", fix: "title" }, { blockId: "b2", rule: 10, text: "the query returned no rows; a chart needs data (filter less, or use a table or markdown note)", fix: null }],
      other: ["query orders: Code: 60"]
    });
  });
});
