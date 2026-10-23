import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startFakeClickhouse, type FakeRequest } from "./support/fakeClickhouse";
import type { ReportSpec } from "../shared/reports";
import { LINKED_OPTIONS, optionParentsOf, type ReportParameter } from "../shared/reportParams";
import { registeredMigrations } from "../server/migrations";
import { reportFilterViewsMigration } from "../server/migrations/069_report_filter_views";

const { reportTools } = await import("../server/mcpTools").then(() => import("../server/reports/mcpTools"));
const { syncSchema } = await import("../server/reports/schemaCatalog");
const refresh = await import("../server/reports/refresh");
const params = await import("../server/reports/params");
const { checkSpecShape } = await import("../server/reports/specValidate");
const { narrowChoices, optionColumnOf, optionSourceOf, optionsQueryFor } = await import("../server/reports/filterRequest");

/**
 * Linked filters (lane FILT2, D560–D562; docs/plan/REPORT_FILTERS.md "Later" 1): an options query may
 * read parameters declared before it; its list is cached per parents' values (at most 50 lists a
 * report); a set whose linked value is not among its parents' choices is refused (the client drops it
 * first, with a note); search and MCP follow the parents; Add filter's "Narrow by" (filterRequest).
 */

retireUsersAfterFile();
const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());

const ROUTES: Record<string, string[]> = { DE: ["/de/a", "/shared"], FR: ["/fr/a", "/shared"], US: ["/us/a"] };
const picked = (raw: string | undefined) => raw ? [...raw.matchAll(/'([^']*)'/g)].map((match) => match[1]!) : [];
function answer(sql: string, req: FakeRequest) {
  if (sql.includes("SELECT DISTINCT country")) return { meta: [{ name: "country", type: "String" }], data: Object.keys(ROUTES).map((country) => [country]) };
  if (sql.includes("SELECT DISTINCT route")) {
    const countries = picked(req.params.param_country);
    const routes = [...new Set(Object.entries(ROUTES).filter(([country]) => !countries.length || countries.includes(country)).flatMap(([, list]) => list))].sort();
    const term = req.params.param_nook_search?.replace(/%/g, "").toLowerCase();
    return { meta: [{ name: "route", type: "String" }], data: routes.filter((route) => !term || route.toLowerCase().includes(term)).map((route) => [route]) };
  }
  return { meta: [{ name: "orders", type: "UInt64" }], data: [[String(picked(req.params.param_route).length || 9)]] };
}
beforeEach(() => {
  fake.reset();
  fake.state.select = answer;
  params.resetParamRateLimit();
  params.resetOptionSearchLimit();
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const BY_COUNTRY = "(empty({country:Array(String)}) OR country IN {country:Array(String)})";
const BY_ROUTE = "(empty({route:Array(String)}) OR route IN {route:Array(String)})";
const COUNTRY: ReportParameter = { id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT country FROM analytics.orders ORDER BY country" };
const ROUTE: ReportParameter = { id: "route", label: "Route", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: `SELECT DISTINCT route FROM analytics.orders WHERE ${BY_COUNTRY} ORDER BY route` };

function linkedSpec(parameters: ReportParameter[] = [COUNTRY, ROUTE]): ReportSpec {
  return {
    version: 1, specVersion: 3, sections: [], parameters,
    queries: [{ key: "orders", sql: `SELECT count() AS orders FROM analytics.orders WHERE ${BY_COUNTRY} AND ${BY_ROUTE}`, purpose: "Orders", createdBy: "agent" }],
    blocks: [{ id: "kpi", type: "kpi", title: "Orders", intent: "headline", queryKey: "orders", column: "orders" }]
  };
}

describe("D560: an options query reads only earlier parameters", () => {
  test("optionParentsOf follows array order", () => {
    expect(optionParentsOf(ROUTE, [COUNTRY, ROUTE])).toEqual(["country"]);
    expect(optionParentsOf(COUNTRY, [COUNTRY, ROUTE])).toEqual([]);
    // Declared after the child, the parent does not count (and the spec check refuses it).
    expect(optionParentsOf(ROUTE, [ROUTE, COUNTRY])).toEqual([]);
  });

  test("spec checks: an earlier parent with its exact type passes; a later one, an unknown one, or a wrong type is refused", () => {
    expect(checkSpecShape(linkedSpec()).ok).toBe(true);
    const errors = (spec: ReportSpec) => { const shape = checkSpecShape(spec); return shape.ok ? [] : shape.errors; };
    expect(errors(linkedSpec([ROUTE, COUNTRY])).join("\n")).toContain("parameter route: its optionsQuery reads {country:Array(String)}, which no parameter declared before it provides");
    const wrongType = { ...ROUTE, optionsQuery: "SELECT DISTINCT route FROM analytics.orders WHERE country IN {country:Array(Int64)}" } as ReportParameter;
    expect(errors(linkedSpec([COUNTRY, wrongType])).join("\n")).toContain("parameter route: its optionsQuery must write {country:Array(String)}");
    const own = { ...ROUTE, optionsQuery: "SELECT DISTINCT route FROM analytics.orders WHERE route IN {route:Array(String)}" } as ReportParameter;
    expect(errors(linkedSpec([COUNTRY, own])).join("\n")).toContain("its optionsQuery reads {route:Array(String)}, which no parameter declared before it provides");
    // Two parameters may not provide the same placeholder.
    const clash: ReportParameter = { id: "period_from", label: "From", type: "text", chType: "String", default: "" };
    const period: ReportParameter = { id: "period", label: "Period", type: "date_range", chType: "Date", default: { preset: "30d" } };
    expect(errors({ ...linkedSpec([period, clash]), queries: [{ key: "orders", sql: "SELECT count() AS orders FROM analytics.orders WHERE day >= {period_from:Date} AND day <= {period_to:Date}", purpose: "", createdBy: "agent" }] }).join("\n"))
      .toContain("parameter period_from: its placeholder {period_from} is also parameter period's");
  });

  test("D562: a narrowed options query reads its parents; the listed column of an options query", () => {
    expect(optionsQueryFor("db.t", "route", [{ paramId: "country", label: "Country", column: "country", type: "multi_select", chType: "Array(String)", operand: "`country`" }, { paramId: "plan", label: "Plan", column: "plan", type: "select", chType: "String", operand: "`plan`" }]))
      .toBe("SELECT toString(`route`) AS value FROM `db`.`t` WHERE (empty({country:Array(String)}) OR (`country` IN {country:Array(String)}) != {country_not:UInt8}) AND `plan` = {plan:String} GROUP BY value ORDER BY count() DESC LIMIT 200");
    expect(optionColumnOf(optionsQueryFor("db.t", "we`ird"))).toBe("we`ird");
    expect(optionColumnOf("SELECT DISTINCT country FROM analytics.orders ORDER BY country")).toBe("country");
    expect(optionColumnOf("SELECT toString(status) AS value FROM db.t")).toBe("status");
    expect(optionColumnOf("SELECT concat(a, b) FROM db.t")).toBeNull();
  });

  test("D673: an options query's expression of one column is recognized; anything else says why", () => {
    expect(optionSourceOf("SELECT lower(country) AS value FROM db.t GROUP BY value")).toEqual({ column: "country", expression: "lower(country)" });
    expect(optionSourceOf("SELECT DISTINCT toString(t.user_id) FROM db.t AS t")).toEqual({ column: "user_id", expression: "toString(t.user_id)" });
    expect(optionSourceOf("SELECT if(`plan tier` = '', 'none', `plan tier`) AS value FROM db.t")).toEqual({ column: "plan tier", expression: "if(`plan tier` = '', 'none', `plan tier`)" });
    expect(optionSourceOf("SELECT CAST(status AS String) AS value, count() AS n FROM db.t")).toEqual({ column: "status", expression: "CAST(status AS String)" });
    expect(optionSourceOf("SELECT country FROM db.t")).toEqual({ column: "country", expression: null });
    expect(optionSourceOf("SELECT toString(`country`) AS value FROM db.t")).toEqual({ column: "country", expression: null });
    expect(optionSourceOf("SELECT concat(a, '-', b) FROM db.t")).toEqual({ reason: "its choices read 2 columns (a, b)" });
    expect(optionSourceOf("SELECT 'x' AS value FROM db.t")).toEqual({ reason: "its choices are not read from a column" });
    expect(optionSourceOf("SELECT (SELECT max(a) FROM db.u) AS value FROM db.t")).toEqual({ reason: "its choices column holds a subquery" });
    expect(optionSourceOf("SELECT lower(a) FROM db.t WHERE x = {p:String}")).toEqual({ column: "a", expression: "lower(a)" });
    expect(optionSourceOf("SELECT concat(a, {p:String}) FROM db.t")).toEqual({ reason: "its choices column reads other filters" });
    expect(optionSourceOf("WITH x AS (SELECT 1) SELECT a FROM x")).toEqual({ reason: "its choices query is not a plain SELECT … FROM" });

    const catalog = new Map([["country", "LowCardinality(String)"], ["route", "String"], ["user_id", "UInt64"], ["amount", "Float64"]]);
    const columns = [
      { table: "db.t", column: "country", type: "LowCardinality(String)", chType: "Array(String)", comment: "", readBy: [], sensitive: false, kinds: ["multi_select", "text"] as never },
      { table: "db.t", column: "route", type: "String", chType: "Array(String)", comment: "", readBy: [], sensitive: false, kinds: ["multi_select", "text"] as never },
      { table: "db.t", column: "user_id", type: "UInt64", chType: "Array(UInt64)", comment: "", readBy: [], sensitive: false, kinds: ["multi_select", "number_range"] as never }
    ];
    const multi = (id: string, chType: string, optionsQuery: string): ReportParameter => ({ id, label: id.toUpperCase(), type: "multi_select", chType, default: [], optionsQuery });
    const spec = { parameters: [
      multi("lc", "Array(String)", "SELECT lower(country) AS value FROM db.t GROUP BY value"),
      multi("uid", "Array(String)", "SELECT toString(user_id) AS value FROM db.t GROUP BY value"),
      multi("uidn", "Array(UInt64)", "SELECT user_id + 1 AS value FROM db.t"),
      multi("other", "Array(String)", "SELECT country FROM db.u"),
      multi("two", "Array(String)", "SELECT concat(country, route) FROM db.t"),
      multi("gone", "Array(String)", "SELECT nope FROM db.t")
    ] };
    const { offered, skipped } = narrowChoices(spec, "db.t", columns, catalog, "db", "route");
    expect(offered).toEqual([
      { paramId: "lc", label: "LC", column: "country", type: "multi_select", chType: "Array(String)", operand: "toString(lower(country))", expression: "lower(country)" },
      { paramId: "uid", label: "UID", column: "user_id", type: "multi_select", chType: "Array(String)", operand: "toString(`user_id`)" }
    ]);
    expect(skipped).toEqual([
      { paramId: "uidn", label: "UIDN", reason: "its choices are numbers worked out by an expression, which only a text filter can follow" },
      { paramId: "other", label: "OTHER", reason: "its choices come from db.u, not db.t" },
      { paramId: "two", label: "TWO", reason: "its choices read 2 columns (country, route)" },
      { paramId: "gone", label: "GONE", reason: "its choices read nope, which db.t does not have" }
    ]);
    expect(optionsQueryFor("db.t", "route", offered.slice(0, 1))).toBe("SELECT toString(`route`) AS value FROM `db`.`t` WHERE (empty({lc:Array(String)}) OR (toString(lower(country)) IN {lc:Array(String)}) != {lc_not:UInt8}) GROUP BY value ORDER BY count() DESC LIMIT 200");
  });
});

describe("migration 069", () => {
  test("adds report_param_linked_options and report_param_views (one default per person and report; names unique regardless of case); re-running changes nothing", () => {
    const memory = new Database(":memory:", { strict: true });
    memory.exec("PRAGMA foreign_keys = ON");
    for (const migration of registeredMigrations.filter((item) => item.id <= 69)) migration.up(memory);
    reportFilterViewsMigration.up(memory);
    const at = "2026-10-22T00:00:00.000Z";
    memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    memory.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES ('r1', 'u1', 'R', ?, ?)").run(at, at);
    const view = (id: string, name: string, isDefault: number, json = "{}") => memory.query("INSERT INTO report_param_views (id, report_id, user_id, name, values_json, is_default, created_at, updated_at) VALUES (?, 'r1', 'u1', ?, ?, ?, ?, ?)").run(id, name, json, isDefault, at, at);
    view("v1", "Germany", 1);
    expect(() => view("v2", "germany", 0)).toThrow();
    expect(() => view("v3", "France", 1)).toThrow();
    view("v4", "France", 0);
    expect(() => view("v5", "Bad", 0, "{nope")).toThrow();
    expect(() => view("v6", "", 0)).toThrow();
    memory.query("INSERT INTO report_param_linked_options (report_id, param_id, parents_hash, sql, values_json, created_at, last_used_at) VALUES ('r1', 'route', ?, 'SELECT 1', '[]', ?, ?)").run("a".repeat(64), at, at);
    expect(() => memory.query("INSERT INTO report_param_linked_options (report_id, param_id, parents_hash, sql, values_json, created_at, last_used_at) VALUES ('r1', 'route', 'short', 'SELECT 1', '[]', ?, ?)").run(at, at)).toThrow();
    // They go with the report.
    memory.query("DELETE FROM reports WHERE id = 'r1'").run();
    expect(memory.query("SELECT count(*) AS n FROM report_param_views").get()).toEqual({ n: 0 });
    expect(memory.query("SELECT count(*) AS n FROM report_param_linked_options").get()).toEqual({ n: 0 });
  });
});

// ------------------------------------------------------------------------------- server

const admin = await createUser("Linked admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Linked owner");
const viewer = await createUser("Linked viewer");
const created = await send(admin, "POST", "/reports/admin/datasources", { name: "Linked warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;
await syncSchema(datasourceId).catch(() => undefined);

async function seededReport(spec: ReportSpec = linkedSpec()) {
  const report = await send(owner, "POST", "/reports", { title: "Linked orders", datasourceId });
  const id = report.body.report.id as string;
  db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(spec), id);
  expect((await send(owner, "PUT", `/reports/${id}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: viewer.userId, level: "view" }] })).status).toBe(200);
  await refresh.startRefresh(owner.userId, id, { trigger: "user" }).done;
  return id;
}
const enc = (values: unknown) => encodeURIComponent(JSON.stringify(values));
const routeRuns = () => fake.requests.filter((item) => item.sql.startsWith("SELECT * FROM (") && item.sql.includes("DISTINCT route")).length;

describe("D560: a linked filter's choices follow its parents", () => {
  test("the list is read for the parents' values, cached per values, and the parents it was read for are named", async () => {
    const reportId = await seededReport();
    const all = await send(viewer, "GET", `/reports/${reportId}/parameters/route/options`);
    expect(all.body.options).toMatchObject({ options: ["/de/a", "/fr/a", "/shared", "/us/a"], parents: { country: [] } });
    const de = await send(viewer, "GET", `/reports/${reportId}/parameters/route/options?values=${enc({ country: ["DE"] })}`);
    expect(de.body.options).toMatchObject({ options: ["/de/a", "/shared"], parents: { country: ["DE"] } });
    const before = routeRuns();
    // The same parents again (another reader, values in another order) is the cached list.
    expect((await send(owner, "GET", `/reports/${reportId}/parameters/route/options?values=${enc({ country: ["DE"], route: ["x"] })}`)).body.options.options).toEqual(["/de/a", "/shared"]);
    expect(routeRuns()).toBe(before);
    expect((await send(viewer, "GET", `/reports/${reportId}/parameters/route/options?values=${enc({ country: ["FR", "DE"] })}`)).body.options.options).toEqual(["/de/a", "/fr/a", "/shared"]);
    expect(routeRuns()).toBe(before + 1);
    // A parent value that does not fit its parameter is refused; the country list itself is not linked.
    expect((await send(viewer, "GET", `/reports/${reportId}/parameters/route/options?values=${enc({ country: "DE" })}`)).status).toBe(400);
    expect((await send(viewer, "GET", `/reports/${reportId}/parameters/country/options`)).body.options.parents).toBeUndefined();
  });

  test("at most 50 lists a report are kept, the most recently used", async () => {
    const reportId = await seededReport();
    const at = new Date(Date.now() - 60_000).toISOString();
    for (let index = 0; index < LINKED_OPTIONS.listsPerReport + 5; index += 1) {
      db.query("INSERT INTO report_param_linked_options (report_id, param_id, parents_hash, sql, values_json, created_at, last_used_at) VALUES (?, 'route', ?, ?, '[]', ?, ?)")
        .run(reportId, index.toString(16).padStart(64, "0"), ROUTE.type === "multi_select" ? ROUTE.optionsQuery : "", at, at);
    }
    await send(viewer, "GET", `/reports/${reportId}/parameters/route/options?values=${enc({ country: ["US"] })}`);
    expect((db.query("SELECT count(*) AS n FROM report_param_linked_options WHERE report_id = ?").get(reportId) as { n: number }).n).toBe(LINKED_OPTIONS.listsPerReport);
    // The new list is among the kept ones.
    expect((await send(viewer, "GET", `/reports/${reportId}/parameters/route/options?values=${enc({ country: ["US"] })}`)).body.options.options).toEqual(["/us/a"]);
  });

  test("a set whose linked value is not one of its parents' choices is refused, naming the filter; a fitting one runs", async () => {
    const reportId = await seededReport();
    const refused = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { country: ["DE"], route: ["/fr/a"] } });
    expect(refused).toMatchObject({ status: 400, body: { code: "INVALID", paramId: "route" } });
    expect(refused.body.error).toBe("/fr/a is not one of the choices for Route");
    const ran = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { country: ["DE"], route: ["/shared"] } });
    expect(ran.status).toBe(200);
    expect(ran.body.results[0].result.rows).toEqual([["1"]]);
  });

  test("search reads within the parents' values; MCP lists the parents and searches with them", async () => {
    const reportId = await seededReport();
    const found = await send(viewer, "GET", `/reports/${reportId}/parameters/route/options?q=a&values=${enc({ country: ["FR"] })}`);
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.options).toMatchObject({ options: ["/fr/a", "/shared"], query: "a", parents: { country: ["FR"] } });
    const key = { keyId: "k-linked", userId: viewer.userId, name: "k", scopes: ["reports:read"] as never };
    const report = await reportTools.find((item) => item.name === "get_report")!.handler({ reportId }, key) as Json;
    expect(report.optionParents).toEqual({ route: ["country"] });
    const searched = await reportTools.find((item) => item.name === "search_report_options")!.handler({ reportId, parameterId: "route", query: "a", parameters: { country: ["DE"] } }, key) as Json;
    expect(searched).toMatchObject({ options: ["/de/a", "/shared"], parents: { country: ["DE"] } });
  });
});
