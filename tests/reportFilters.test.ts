import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startFakeClickhouse, type FakeRequest } from "./support/fakeClickhouse";
import type { ReportSpec } from "../shared/reports";
import { DATE_PRESETS, readsOf, reachOf, resolveDateRange, todayIn, type ReportParameter } from "../shared/reportParams";
import { registeredMigrations } from "../server/migrations";
import { reportFiltersMigration } from "../server/migrations/066_report_filters";

const { reportTools } = await import("../server/mcpTools").then(() => import("../server/reports/mcpTools"));
const { syncSchema } = await import("../server/reports/schemaCatalog");
const refresh = await import("../server/reports/refresh");
const params = await import("../server/reports/params");
const { checkSpecShape } = await import("../server/reports/specValidate");

/**
 * Report filters, slice 1 (lane FILTERS, docs/plan/REPORT_FILTERS.md): D532 only the queries a filter
 * touches re-run (per-query result keys, default reuse; ClickHouse calls counted), D533 reach, D537
 * the new date presets, and migration 066.
 */

retireUsersAfterFile();
const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());

const COUNTRIES = ["DE", "FR", "IN", "US"];
function answer(sql: string, req: FakeRequest) {
  if (sql.includes("SELECT DISTINCT country")) return { meta: [{ name: "country", type: "String" }], data: COUNTRIES.map((country) => [country]) };
  const from = req.params.param_period_from;
  const to = req.params.param_period_to;
  const days = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 : 30;
  const picked = req.params.param_country ? [...req.params.param_country.matchAll(/'([^']*)'/g)].map((match) => match[1]!) : [];
  const countries = picked.length ? COUNTRIES.filter((country) => picked.includes(country)) : COUNTRIES;
  if (sql.includes("GROUP BY country")) return { meta: [{ name: "country", type: "String" }, { name: "orders", type: "UInt64" }], data: countries.map((country) => [country, String(days * 10)]) };
  if (sql.includes("AS plain")) return { meta: [{ name: "plain", type: "UInt64" }], data: [["7"]] };
  return { meta: [{ name: "orders", type: "UInt64" }], data: [[String(days * 10 * countries.length)]] };
}
beforeEach(() => {
  fake.reset();
  fake.state.select = answer;
  params.resetParamRateLimit();
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const PERIOD: ReportParameter = { id: "period", label: "Period", type: "date_range", chType: "Date", default: { preset: "30d" } };
const COUNTRY: ReportParameter = { id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT country FROM analytics.orders ORDER BY country" };
const BY_PERIOD = "day >= {period_from:Date} AND day <= {period_to:Date}";
const BY_COUNTRY = "(empty({country:Array(String)}) OR country IN {country:Array(String)})";

/** Four queries: one reads both filters, one only the period, one only the country, one neither. */
function filterSpec(): ReportSpec {
  return {
    version: 1, specVersion: 3, sections: [], parameters: [PERIOD, COUNTRY],
    queries: [
      { key: "totals", sql: `SELECT count() AS orders FROM analytics.orders WHERE ${BY_PERIOD} AND ${BY_COUNTRY}`, purpose: "Orders", createdBy: "agent" },
      { key: "trend", sql: `SELECT count() AS orders FROM analytics.orders WHERE ${BY_PERIOD}`, purpose: "Orders in the period", createdBy: "agent" },
      { key: "by_country", sql: `SELECT country, count() AS orders FROM analytics.orders WHERE ${BY_COUNTRY} GROUP BY country ORDER BY country`, purpose: "Orders by country", createdBy: "agent" },
      { key: "plain", sql: "SELECT 7 AS plain FROM analytics.orders LIMIT 1", purpose: "A constant", createdBy: "agent" }
    ],
    blocks: [
      { id: "kpi-orders", type: "kpi", title: "Orders", intent: "headline", queryKey: "totals", column: "orders" },
      { id: "kpi-trend", type: "kpi", title: "Orders in period", intent: "headline", queryKey: "trend", column: "orders" },
      { id: "by-country", type: "chart", title: "Orders by country", intent: "compare", kind: "bar", queryKey: "by_country", x: "country", y: ["orders"] },
      { id: "kpi-plain", type: "kpi", title: "Plain", intent: "headline", queryKey: "plain", column: "plain" }
    ]
  };
}

// ------------------------------------------------------------------------------- pure

describe("D537: more date presets, in the report's zone", () => {
  test("yesterday, ISO weeks, last month and quarter, year to date, and the last 12 months", () => {
    // 2026-10-22 is a Thursday.
    const r = (preset: string, today: string) => resolveDateRange({ preset } as never, today);
    expect(r("yesterday", "2026-10-22")).toEqual({ from: "2026-10-21", to: "2026-10-21" });
    expect(r("yesterday", "2026-01-01")).toEqual({ from: "2025-12-31", to: "2025-12-31" });
    expect(r("this_week", "2026-10-22")).toEqual({ from: "2026-10-19", to: "2026-10-22" });
    expect(r("this_week", "2026-10-19")).toEqual({ from: "2026-10-19", to: "2026-10-19" });
    // A Sunday is the last day of its ISO week.
    expect(r("this_week", "2026-10-25")).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    expect(r("last_week", "2026-10-22")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(r("last_week", "2026-01-01")).toEqual({ from: "2025-12-22", to: "2025-12-28" });
    expect(r("last_month", "2026-10-22")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(r("last_month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(r("last_month", "2028-03-31")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(r("last_quarter", "2026-10-22")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(r("last_quarter", "2026-02-10")).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(r("last_quarter", "2026-05-31")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(r("ytd", "2026-10-22")).toEqual({ from: "2026-01-01", to: "2026-10-22" });
    expect(r("12m", "2026-10-22")).toEqual({ from: "2025-10-23", to: "2026-10-22" });
    expect(r("12m", "2028-02-29")).toEqual({ from: "2027-03-01", to: "2028-02-29" });
    expect(r("12m", "2026-12-31")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  test("weeks and months turn over at the report zone's midnight (IST)", () => {
    // 18:45 UTC on Sunday 18 October is 00:15 IST on Monday 19 October.
    const today = todayIn("Asia/Kolkata", new Date("2026-10-18T18:45:00Z"));
    expect(resolveDateRange({ preset: "this_week" } as never, today)).toEqual({ from: "2026-10-19", to: "2026-10-19" });
    expect(resolveDateRange({ preset: "last_week" } as never, today)).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(resolveDateRange({ preset: "this_week" } as never, todayIn("UTC", new Date("2026-10-18T18:45:00Z")))).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    // 19:00 UTC on 31 December is 00:30 IST on 1 January: last month is December in IST, November in UTC.
    const newYear = new Date("2025-12-31T19:00:00Z");
    expect(resolveDateRange({ preset: "last_month" } as never, todayIn("Asia/Kolkata", newYear))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(resolveDateRange({ preset: "last_month" } as never, todayIn("UTC", newYear))).toEqual({ from: "2025-11-01", to: "2025-11-30" });
  });

  test("every preset is a valid default; stored specs with the old ones stay valid", () => {
    for (const preset of DATE_PRESETS.filter((item) => item !== "custom")) {
      const spec = { ...filterSpec(), parameters: [{ ...PERIOD, default: { preset } }, COUNTRY] };
      expect(checkSpecShape(spec).ok).toBe(true);
    }
    expect(checkSpecShape({ ...filterSpec(), parameters: [{ ...PERIOD, default: { preset: "2y" } }, COUNTRY] }).ok).toBe(false);
  });
});

describe("D532, D533: what a query reads, and its own result key", () => {
  test("readsOf and reachOf scan the placeholders (a date range by either end)", () => {
    const spec = filterSpec();
    expect(readsOf(spec.queries[0]!.sql, spec.parameters)).toEqual(["period", "country"]);
    expect(readsOf("SELECT 1 WHERE d <= {period_to:Date}", spec.parameters)).toEqual(["period"]);
    expect(readsOf(spec.queries[3]!.sql, spec.parameters)).toEqual([]);
    expect(reachOf(spec.parameters, spec.queries)).toEqual({ period: ["totals", "trend"], country: ["totals", "by_country"] });
  });

  test("queryHashOf keys on the SQL and the values it reads, nothing else", () => {
    const sql = filterSpec().queries[1]!.sql;
    const bound = [{ name: "period_from", type: "Date", value: "2026-10-01" }, { name: "period_to", type: "Date", value: "2026-10-22" }];
    const withCountry = [...bound, { name: "country", type: "Array(String)", value: "['DE']" }];
    expect(params.queryHashOf(sql, bound)).toBe(params.queryHashOf(sql, withCountry));
    expect(params.queryHashOf(sql, bound)).toBe(params.queryHashOf(sql, [...bound].reverse()));
    expect(params.queryHashOf(sql, bound)).not.toBe(params.queryHashOf(sql, [{ ...bound[0]!, value: "2026-10-02" }, bound[1]!]));
    expect(params.queryHashOf(sql, bound)).not.toBe(params.queryHashOf(`${sql} `, bound));
    expect(params.queryHashOf(sql, bound)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("migration 066", () => {
  test("adds report_param_results.query_hash (indexed) and report_instructions.request_json (JSON, at most 4 KiB); re-running changes nothing", () => {
    const memory = new Database(":memory:", { strict: true });
    memory.exec("PRAGMA foreign_keys = ON");
    for (const migration of registeredMigrations.filter((item) => item.id <= 66)) migration.up(memory);
    const columns = (table: string) => (memory.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns("report_param_results")).toContain("query_hash");
    expect(columns("report_instructions")).toContain("request_json");
    expect(memory.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'report_param_results_query'").get()).not.toBeNull();
    reportFiltersMigration.up(memory);
    expect(columns("report_instructions").filter((name) => name === "request_json")).toHaveLength(1);
    const at = "2026-10-22T00:00:00.000Z";
    memory.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    memory.query("INSERT INTO reports (id, owner_id, title, created_at, updated_at) VALUES ('r1', 'u1', 'R', ?, ?)").run(at, at);
    const insert = (id: string, json: string | null) => memory.query(`INSERT INTO report_instructions (id, report_id, text, author_id, via, status, position, created_at, updated_at, request_json)
      VALUES (?, 'r1', 'x', 'u1', 'web', 'cancelled', 1, ?, ?, ?)`).run(id, at, at, json);
    insert("i1", JSON.stringify({ kind: "add_filter", id: "route" }));
    insert("i2", null);
    expect(() => insert("i3", "{not json")).toThrow();
    expect(() => insert("i4", JSON.stringify({ text: "x".repeat(5000) }))).toThrow();
  });
});

// ------------------------------------------------------------------------------- server

const admin = await createUser("Filters admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Filters owner");
const viewer = await createUser("Filters viewer");

const created = await send(admin, "POST", "/reports/admin/datasources", { name: "Filters warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;
await syncSchema(datasourceId).catch(() => undefined);

async function seededReport(spec: ReportSpec = filterSpec()) {
  const report = await send(owner, "POST", "/reports", { title: "Filtered orders", datasourceId });
  const id = report.body.report.id as string;
  db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(spec), id);
  expect((await send(owner, "PUT", `/reports/${id}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: viewer.userId, level: "view" }] })).status).toBe(200);
  await refresh.startRefresh(owner.userId, id, { trigger: "user" }).done;
  return id;
}

/** The report queries ClickHouse ran (the guard wraps each one; options and tree checks left out). */
const ran = () => fake.requests.filter((item) => item.sql.startsWith("SELECT * FROM (") && !item.sql.includes("DISTINCT")).map((item) =>
  item.sql.includes("AS plain") ? "plain" : item.sql.includes("GROUP BY country") ? "by_country" : item.sql.includes("country IN") ? "totals" : "trend").sort();
const enc = (values: unknown) => encodeURIComponent(JSON.stringify(values));
const rows = (body: Json, key: string) => body.results.find((item: Json) => item.queryKey === key)?.result?.rows ?? null;

describe("D532: only the queries a filter touches re-run", () => {
  test("a country filter runs the two queries that read it; the others answer with the default results", async () => {
    const reportId = await seededReport();
    fake.requests.length = 0;
    const values = { country: ["DE"] };
    const before = await send(viewer, "GET", `/reports/${reportId}/results?values=${enc(values)}`);
    expect(before.body.set.missing.sort()).toEqual(["by_country", "totals"]);
    // The untouched queries answer at once, from the stored default results.
    expect(rows(before.body, "trend")).toEqual([["1200"]]);
    expect(rows(before.body, "plain")).toEqual([["7"]]);
    const run = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values });
    expect(run.status).toBe(200);
    expect(ran()).toEqual(["by_country", "totals"]);
    expect(rows(run.body, "totals")).toEqual([["300"]]);
    expect(rows(run.body, "by_country")).toEqual([["DE", "300"]]);
    expect(rows(run.body, "trend")).toEqual([["1200"]]);
    expect(run.body.set.missing).toEqual([]);
  });

  test("a query's result is found by its own key across sets: changing one filter re-runs only what reads it", async () => {
    const reportId = await seededReport();
    fake.requests.length = 0;
    await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { period: { preset: "7d" } } });
    expect(ran()).toEqual(["totals", "trend"]);
    fake.requests.length = 0;
    // Same period, a country picked: the period-only query is reused from the set before.
    const both = await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { period: { preset: "7d" }, country: ["FR", "US"] } });
    expect(ran()).toEqual(["by_country", "totals"]);
    expect(rows(both.body, "trend")).toEqual([["280"]]);
    expect(rows(both.body, "totals")).toEqual([["140"]]);
    fake.requests.length = 0;
    // Back to the default period with the same countries: by_country is reused, totals runs once more.
    await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { country: ["US", "FR"] } });
    expect(ran()).toEqual(["totals"]);
    fake.requests.length = 0;
    // Nothing new: nothing runs.
    await send(owner, "POST", `/reports/${reportId}/param-runs`, { values: { period: { preset: "7d" }, country: ["FR", "US"] } });
    expect(ran()).toEqual([]);
    // A default refresh makes the cached results stale; the default results stay the answer for untouched queries.
    await Bun.sleep(5);
    await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    const stale = await send(viewer, "GET", `/reports/${reportId}/results?values=${enc({ country: ["DE"] })}`);
    expect(stale.body.set.missing.sort()).toEqual(["by_country", "totals"]);
  });

  test("force re-runs only the queries the set reads non-default values in", async () => {
    const reportId = await seededReport();
    await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { country: ["IN"] } });
    fake.requests.length = 0;
    await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { country: ["IN"] }, force: true });
    expect(ran()).toEqual(["by_country", "totals"]);
  });

  test("rows from before 066 (no query_hash) are never matched; they re-run once", async () => {
    const reportId = await seededReport();
    await send(viewer, "POST", `/reports/${reportId}/param-runs`, { values: { country: ["DE"] } });
    db.query("UPDATE report_param_results SET query_hash = NULL WHERE report_id = ?").run(reportId);
    const view = await send(viewer, "GET", `/reports/${reportId}/results?values=${enc({ country: ["DE"] })}`);
    expect(view.body.set.missing.sort()).toEqual(["by_country", "totals"]);
  });
});

describe("D533: reach in the results and get_report", () => {
  test("the results view and MCP get_report name the queries each parameter reaches", async () => {
    const reportId = await seededReport();
    const expected = { period: ["totals", "trend"], country: ["totals", "by_country"] };
    expect((await send(viewer, "GET", `/reports/${reportId}/results`)).body.reach).toEqual(expected);
    expect((await send(viewer, "GET", `/reports/${reportId}/results?values=${enc({ country: ["DE"] })}`)).body.reach).toEqual(expected);
    const tool = reportTools.find((item) => item.name === "get_report")!;
    const report = await tool.handler({ reportId }, { keyId: "k-filters", userId: viewer.userId, name: "k", scopes: ["reports:read"] as never }) as Json;
    expect(report.reach).toEqual(expected);
  });
});
