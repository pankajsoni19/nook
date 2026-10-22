import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startFakeClickhouse, type FakeRequest } from "./support/fakeClickhouse";
import type { ReportSpec } from "../shared/reports";
import { bindValues, canonicalValues, defaultValues, excludableIds, isDefaultSet, resolveValues, valueLabel, valueProblem, valuesFromSearch, valuesToSearch, type ReportParameter } from "../shared/reportParams";
import { formatReportParams, parseReportParams } from "../src/router";

const refresh = await import("../server/reports/refresh");
const params = await import("../server/reports/params");
const { checkSpecShape } = await import("../server/reports/specValidate");

/**
 * More filter types (lane FILT2, D567, D568; docs/plan/REPORT_FILTERS.md "Later" 4): a number range
 * (`<id>_min`/`<id>_max`, an open end binding the type's lowest or highest value) and a multi-select
 * readers may leave values out of (`{ not: [...] }`, the `{<id>_not:UInt8}` flag), in values, binding,
 * the URL, labels, spec checks, and a run.
 */

retireUsersAfterFile();
const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
  fake.state.select = (sql: string, req: FakeRequest) => sql.includes("DISTINCT country")
    ? { meta: [{ name: "country", type: "String" }], data: [["DE"], ["FR"], ["US"]] }
    : { meta: [{ name: "orders", type: "UInt64" }], data: [["1"]] };
  params.resetParamRateLimit();
});

const AMOUNT: ReportParameter = { id: "amount", label: "Amount", type: "number_range", chType: "Float64", default: { min: null, max: null } };
const QTY: ReportParameter = { id: "qty", label: "Quantity", type: "number_range", chType: "UInt32", default: { min: 1, max: null } };
const COUNTRY: ReportParameter = { id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT country FROM analytics.orders" };
const EXCLUDING = "(empty({country:Array(String)}) OR (country IN {country:Array(String)}) != {country_not:UInt8})";

describe("D567: a number range", () => {
  test("values, binding with open ends, labels, and the URL", () => {
    expect(valueProblem(AMOUNT, { min: 1.5, max: null })).toBeNull();
    expect(valueProblem(AMOUNT, { min: 5, max: 1 })).toBe("min must not be more than max");
    expect(valueProblem(AMOUNT, { min: 1 })).toBe("takes only min and max");
    expect(valueProblem(QTY, { min: 1.5, max: null })).toBe("must be whole numbers");
    expect(valueProblem(QTY, { min: -1, max: null })).toBe("must not be negative");
    expect(bindValues([AMOUNT, QTY], { amount: { min: null, max: 99.5 }, qty: { min: 2, max: null } }, "2026-10-22")).toEqual([
      { name: "amount_min", type: "Float64", value: "-inf" }, { name: "amount_max", type: "Float64", value: "99.5" },
      { name: "qty_min", type: "UInt32", value: "2" }, { name: "qty_max", type: "UInt32", value: "4294967295" }
    ]);
    expect([valueLabel(AMOUNT, { min: null, max: null }), valueLabel(AMOUNT, { min: 1000, max: null }), valueLabel(AMOUNT, { min: null, max: 5 }), valueLabel(AMOUNT, { min: 1, max: 2500 })]).toEqual(["Any", "≥ 1,000", "≤ 5", "1–2,500"]);
    // Key order does not matter: the same range is the same set.
    expect(isDefaultSet([QTY], { qty: { max: null, min: 1 } as never })).toBe(true);
    const search = valuesToSearch([AMOUNT, QTY], { amount: { min: -1.5, max: 2 }, qty: { min: 1, max: null } });
    expect(search).toEqual({ amount: ["-1.5..2"] });
    expect(valuesFromSearch([AMOUNT, QTY], { amount: ["10.."], qty: ["..7"] })).toEqual({ amount: { max: null, min: 10 }, qty: { max: 7, min: null } });
    expect(valuesFromSearch([AMOUNT], { amount: ["nonsense"] })).toEqual({ amount: { min: null, max: null } });
  });

  test("spec checks: the schema, its type, and the placeholders it provides", () => {
    const spec: ReportSpec = {
      version: 1, specVersion: 3, sections: [], parameters: [AMOUNT],
      queries: [{ key: "q", sql: "SELECT count() AS orders FROM analytics.orders WHERE amount BETWEEN {amount_min:Float64} AND {amount_max:Float64}", purpose: "", createdBy: "agent" }],
      blocks: [{ id: "kpi", type: "kpi", title: "Orders", intent: "headline", queryKey: "q", column: "orders", unit: "orders" }]
    };
    expect(checkSpecShape(spec).ok).toBe(true);
    const wrong = checkSpecShape({ ...spec, queries: [{ ...spec.queries[0]!, sql: spec.queries[0]!.sql.replace("{amount_max:Float64}", "{amount_max:Int64}") }] });
    expect(wrong.ok ? [] : wrong.errors.join("\n")).toContain("must be written {amount_max:Float64}");
    expect(checkSpecShape({ ...spec, parameters: [{ ...AMOUNT, default: { min: 3, max: 1 } }] }).ok).toBe(false);
  });
});

describe("D568: leaving values out", () => {
  test("values, the flag, labels, the URL (p.<id>.not), and which multi-selects may exclude", () => {
    expect(valueProblem(COUNTRY, { not: ["DE"] })).toBeNull();
    expect(valueProblem(COUNTRY, { not: "DE" })).toBe("must be a list, or { not: [values] } to leave them out");
    expect(resolveValues([COUNTRY], { country: { not: ["FR", "DE"] } }).values).toEqual({ country: { not: ["DE", "FR"] } });
    // An empty exclusion is All.
    expect(canonicalValues([COUNTRY], { country: { not: [] } })).toBe(canonicalValues([COUNTRY], defaultValues([COUNTRY])));
    expect(bindValues([COUNTRY], { country: { not: ["DE"] } }, "2026-10-22")).toEqual([{ name: "country", type: "Array(String)", value: "['DE']" }, { name: "country_not", type: "UInt8", value: "1" }]);
    expect(valueLabel(COUNTRY, { not: ["DE"] })).toBe("All but DE");
    expect(valuesToSearch([COUNTRY], { country: { not: ["DE"] } })).toEqual({ "country.not": ["DE"] });
    expect(valuesFromSearch([COUNTRY], { "country.not": ["DE"] })).toEqual({ country: { not: ["DE"] } });
    expect(parseReportParams("?p.country.not=DE&p.country.nope=1")).toEqual({ "country.not": ["DE"] });
    expect(formatReportParams({ "country.not": ["DE"] })).toBe("?p.country.not=DE");
    const reads = [{ sql: `SELECT 1 WHERE ${EXCLUDING}` }];
    expect([...excludableIds([COUNTRY], reads)]).toEqual(["country"]);
    expect([...excludableIds([COUNTRY], [...reads, { sql: "SELECT 1 WHERE country IN {country:Array(String)}" }])]).toEqual([]);
  });
});

// ------------------------------------------------------------------------------- server

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}
const admin = await createUser("Types admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Types owner");
const created = await send(admin, "POST", "/reports/admin/datasources", { name: "Types warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;

async function seeded(sql: string, parameters: ReportParameter[]) {
  const report = await send(owner, "POST", "/reports", { title: "Typed orders", datasourceId });
  const id = report.body.report.id as string;
  const spec: ReportSpec = { version: 1, specVersion: 3, sections: [], parameters, queries: [{ key: "q", sql, purpose: "", createdBy: "agent" }], blocks: [{ id: "kpi", type: "kpi", title: "Orders", intent: "headline", queryKey: "q", column: "orders", unit: "orders" }] };
  db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(spec), id);
  await refresh.startRefresh(owner.userId, id, { trigger: "user" }).done;
  return id;
}

describe("runs", () => {
  test("a number range binds both ends; leaving values out sends the flag, and is refused where the SQL does not read it", async () => {
    const ranged = await seeded("SELECT count() AS orders FROM analytics.orders WHERE amount BETWEEN {amount_min:Float64} AND {amount_max:Float64}", [AMOUNT]);
    fake.requests.length = 0;
    expect((await send(owner, "POST", `/reports/${ranged}/param-runs`, { values: { amount: { min: 10, max: null } } })).status).toBe(200);
    expect(fake.requests.some((item) => item.params.param_amount_min === "10" && item.params.param_amount_max === "inf")).toBe(true);

    const excluding = await seeded(`SELECT count() AS orders FROM analytics.orders WHERE ${EXCLUDING}`, [COUNTRY]);
    fake.requests.length = 0;
    expect((await send(owner, "POST", `/reports/${excluding}/param-runs`, { values: { country: { not: ["DE"] } } })).status).toBe(200);
    expect(fake.requests.some((item) => item.params.param_country === "['DE']" && item.params.param_country_not === "1")).toBe(true);

    const plain = await seeded("SELECT count() AS orders FROM analytics.orders WHERE (empty({country:Array(String)}) OR country IN {country:Array(String)})", [COUNTRY]);
    const refused = await send(owner, "POST", `/reports/${plain}/param-runs`, { values: { country: { not: ["DE"] } } });
    expect(refused).toMatchObject({ status: 400, body: { code: "INVALID", paramId: "country" } });
  });
});
