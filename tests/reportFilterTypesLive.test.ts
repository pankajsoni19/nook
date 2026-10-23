import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { qaEditScript, startScriptedProvider } from "../scripts/fakeReportProvider";
import { DEFAULT_COMPAT } from "../shared/agents";
import type { ReportSpec } from "../shared/reports";
import { bindValues, type ReportParameter } from "../shared/reportParams";
import { chExec, parseChUrl, seed } from "../evals/reports/clickhouse";

const { editDeps, liveEdits } = await import("../server/reports/edit");
const refresh = await import("../server/reports/refresh");
const { syncSchema } = await import("../server/reports/schemaCatalog");
const { usableDatasource } = await import("../server/reports/datasources");
const { runGuarded } = await import("../server/reports/runner");
const { runOptionsQuery } = await import("../server/reports/params");
const { filterCondition, optionsQueryFor } = await import("../server/reports/filterRequest");
const { instanceTimeZone } = await import("../server/reports/paramZone");

/**
 * D675 (lane FILT3): the filter types of D567–D570 and D671–D673 and the linked lists of D560/D562,
 * against a real ClickHouse where CLICKHOUSE_TEST_URL is set (as tests/reportsClickhouseLive.test.ts:
 * `http://nook:nooktest@127.0.0.1:22200`; skipped otherwise). It seeds its own database,
 * `eval_filter_types` (dropped and recreated), with NULL and NaN amounts, a Decimal, an Int128, a
 * LowCardinality status, and a UTC DateTime near midnight, and checks what the fake ClickHouse cannot:
 * Float64 `-inf`/`inf` ends against Float, Decimal, and wide integer columns; that Add filter's number
 * range keeps every row (NULL and NaN too) at Any, so its identity check holds; the `_not` flag;
 * `positionCaseInsensitive` on LowCardinality; a linked options query whose parent lists an expression
 * (`lower(country)`); a DateTime's day in another zone; and an Add filter number range end to end
 * (the scripted agent, the identity check on the real server, apply, then Remove filter at Any).
 */

const url = process.env.CLICKHOUSE_TEST_URL;
if (url) retireUsersAfterFile();
setDefaultTimeout(60_000);

const DB = "eval_filter_types";
const SEED = `
DROP DATABASE IF EXISTS ${DB};
CREATE DATABASE ${DB};
CREATE TABLE ${DB}.orders (
  id UInt32,
  country LowCardinality(String),
  status LowCardinality(String),
  amount Nullable(Float64),
  price Decimal(10, 2),
  big Int128,
  ts DateTime('UTC'),
  ts_local DateTime
) ENGINE = MergeTree ORDER BY id;
INSERT INTO ${DB}.orders VALUES
  (1, 'DE', 'Shipped', 10.5, 10.50, 1, '2026-01-01 20:00:00', '2026-01-01 20:00:00'),
  (2, 'DE', 'pending', 99, 99.00, 170141183460469231731687303715884105727, '2026-01-01 10:00:00', '2026-01-01 10:00:00'),
  (3, 'FR', 'SHIPPED', NULL, 5.25, -5, '2026-01-02 01:00:00', '2026-01-02 01:00:00'),
  (4, 'FR', 'cancelled', nan, 1000.00, 42, '2026-01-02 19:00:00', '2026-01-02 19:00:00'),
  (5, 'US', 'shipped', 250, 0.01, 0, '2026-01-03 12:00:00', '2026-01-03 12:00:00'),
  (6, 'de', 'returned', -3, 12.00, 7, '2026-01-03 23:30:00', '2026-01-03 23:30:00');
`;

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const range = (id: string): ReportParameter => ({ id, label: id, type: "number_range", chType: "Float64", default: { min: null, max: null } });

describe.skipIf(!url)("Filter types and linked lists on a real ClickHouse (CLICKHOUSE_TEST_URL)", () => {
  let provider: ReturnType<typeof startScriptedProvider>;
  const originalConnection = editDeps.connection;
  let owner: Session;
  let datasourceId: string;
  beforeAll(async () => {
    provider = startScriptedProvider(0, qaEditScript);
    editDeps.connection = () => ({ id: "scripted", baseUrl: provider.baseUrl, apiKey: null, model: "scripted-report-model", compat: DEFAULT_COMPAT });
    await seed(parseChUrl(url!), SEED);
    const ch = parseChUrl(url!);
    const admin = await createUser("Live types admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    owner = await createUser("Live types owner");
    const created = await send(admin, "POST", "/reports/admin/datasources", { name: `Live types ${crypto.randomUUID().slice(0, 6)}`, url: ch.base, username: ch.user, password: ch.password, database: DB, allowlist: [DB] });
    expect(created.status).toBe(201);
    datasourceId = created.body.datasource.id as string;
    await syncSchema(datasourceId);
  });
  afterAll(async () => {
    const until = Date.now() + 15_000;
    while (liveEdits().length && Date.now() < until) await Bun.sleep(20);
    editDeps.connection = originalConnection;
    provider.stop();
  });

  /** Runs SQL through Nook's guard with the parameters bound as Nook binds them; answers the first column of each row. */
  async function column(sql: string, params: readonly ReportParameter[], values: Record<string, unknown>): Promise<unknown[]> {
    const outcome = await runGuarded(usableDatasource(datasourceId), sql, { classes: ["select"], maxRows: 100, queryId: `filt3-live-${crypto.randomUUID().slice(0, 8)}`, userId: owner.userId, params: bindValues(params, values as never, "2026-01-05") });
    return outcome.rows.map((row) => row[0]);
  }

  test("Float64 -inf/inf ends: Add filter's number range keeps every row (NULL and NaN) at Any; ends work on Float, Decimal, and Int128", async () => {
    const ids = (condition: string) => `SELECT id FROM ${DB}.orders WHERE ${condition} ORDER BY id`;
    const amount = filterCondition("number_range", "amount", "amount", "Float64");
    expect(await column(ids(amount), [range("amount")], {})).toEqual([1, 2, 3, 4, 5, 6]);
    // D567's plain BETWEEN (generation's form) drops NULL and NaN at Any: why Add filter writes the Any guard.
    expect(await column(ids("amount BETWEEN {amount_min:Float64} AND {amount_max:Float64}"), [range("amount")], {})).toEqual([1, 2, 5, 6]);
    expect(await column(ids(amount), [range("amount")], { amount: { min: 10, max: null } })).toEqual([1, 2, 5]);
    expect(await column(ids(amount), [range("amount")], { amount: { min: null, max: 10.5 } })).toEqual([1, 6]);
    expect(await column(ids(filterCondition("number_range", "price", "price", "Float64")), [range("price")], { price: { min: 5.25, max: 99 } })).toEqual([1, 2, 3, 6]);
    expect(await column(ids(filterCondition("number_range", "big", "big", "Float64")), [range("big")], { big: { min: 0, max: 50 } })).toEqual([1, 4, 5, 6]);
    expect(await column(ids(filterCondition("number_range", "big", "big", "Float64")), [range("big")], { big: { min: 1e30, max: null } })).toEqual([2]);
  });

  test("the _not flag: a list keeps or leaves out its picks, and All keeps everything", async () => {
    const country: ReportParameter = { id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: optionsQueryFor(`${DB}.orders`, "country") };
    const sql = `SELECT id FROM ${DB}.orders WHERE ${filterCondition("multi_select", "country", "country", "Array(String)", true)} ORDER BY id`;
    expect(await column(sql, [country], {})).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await column(sql, [country], { country: ["DE"] })).toEqual([1, 2]);
    expect(await column(sql, [country], { country: { not: ["DE", "FR"] } })).toEqual([5, 6]);
  });

  test("text contains: positionCaseInsensitive on a LowCardinality column, empty text keeps every row", async () => {
    const status: ReportParameter = { id: "status", label: "Status", type: "text", chType: "String", default: "" };
    const sql = `SELECT id FROM ${DB}.orders WHERE ${filterCondition("text", "status", "status", "String")} ORDER BY id`;
    expect(await column(sql, [status], {})).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await column(sql, [status], { status: "shipped" })).toEqual([1, 3, 5]);
    expect(await column(sql, [status], { status: "ENDING" })).toEqual([2]);
  });

  test("a linked options query: a parent that lists lower(country) narrows the child's choices; All keeps them all", async () => {
    const parent: ReportParameter = { id: "lc", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: `SELECT lower(country) AS value FROM ${DB}.orders GROUP BY value ORDER BY value` };
    const linked = optionsQueryFor(`${DB}.orders`, "status", [{ paramId: "lc", label: "Country", column: "country", type: "multi_select", chType: "Array(String)", operand: "toString(lower(country))", expression: "lower(country)" }]);
    const run = async (values: Record<string, unknown>) => (await runOptionsQuery(usableDatasource(datasourceId), linked, { userId: owner.userId, queryId: `filt3-opt-${crypto.randomUUID().slice(0, 8)}`, params: bindValues([parent], values as never, "2026-01-05") })).options.sort();
    expect((await runOptionsQuery(usableDatasource(datasourceId), parent.optionsQuery, { userId: owner.userId, queryId: `filt3-p-${crypto.randomUUID().slice(0, 8)}` })).options).toEqual(["de", "fr", "us"]);
    expect(await run({})).toEqual(["SHIPPED", "Shipped", "cancelled", "pending", "returned", "shipped"]);
    // "de" picks both DE and de rows (the parent's own values), and leaving it out keeps the rest.
    expect(await run({ lc: ["de"] })).toEqual(["Shipped", "pending", "returned"]);
    expect(await run({ lc: { not: ["de"] } })).toEqual(["SHIPPED", "cancelled", "shipped"]);
  });

  test("D672: a UTC DateTime's day in the report's zone (toDate(col, zone)) moves rows across midnight", async () => {
    const period: ReportParameter = { id: "period", label: "Period", type: "date_range", chType: "Date", default: { preset: "custom", from: "2026-01-02", to: "2026-01-02" } };
    const day = (zone: string | null) => `SELECT id FROM ${DB}.orders WHERE ${filterCondition("date_range", "period", "ts", "Date", false, zone)} ORDER BY id`;
    expect(await column(day(null), [period], {})).toEqual([3, 4]);
    expect(await column(day("Asia/Kolkata"), [period], {})).toEqual([1, 3]);
    expect(await column(day("America/New_York"), [period], {})).toEqual([4]);
  });

  test("Add filter's number range end to end: the identity check holds with NULL and NaN amounts, a range narrows, and Remove filter is checked at Any", async () => {
    const spec: ReportSpec = {
      version: 1, specVersion: 3, sections: [], parameters: [],
      queries: [
        { key: "count", sql: `SELECT count() AS orders FROM ${DB}.orders`, purpose: "Orders", createdBy: "agent" },
        { key: "by_country", sql: `SELECT country, count() AS orders FROM ${DB}.orders GROUP BY country ORDER BY country`, purpose: "Orders by country", createdBy: "agent" }
      ],
      blocks: [
        { id: "count", type: "kpi", title: "Orders", intent: "headline", queryKey: "count", column: "orders", unit: "orders" },
        { id: "by_country", type: "table", title: "Orders by country", intent: "detail", queryKey: "by_country" }
      ]
    };
    const report = await send(owner, "POST", "/reports", { title: "Orders, live types", datasourceId });
    const reportId = report.body.report.id as string;
    db.query("UPDATE reports SET spec_json = ?, status = 'ready' WHERE id = ?").run(JSON.stringify(spec), reportId);
    expect((await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done).status).toBe("succeeded");

    const preview = await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: `${DB}.orders`, column: "amount" });
    expect(preview.body.preview).toMatchObject({ kind: "number_range", numbers: { min: -3, max: 250 } });
    // D672: a DateTime without a zone asks the server's (`SELECT timezone()` passes the guard); one in UTC is read as UTC.
    const serverZone = (await chExec(parseChUrl(url!), "SELECT timezone()")).trim();
    const reportZone = instanceTimeZone();
    const local = await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: `${DB}.orders`, column: "ts_local" });
    expect(local.status, JSON.stringify(local.body)).toBe(200);
    expect(local.body.preview.dayZone).toBe(serverZone === reportZone ? null : reportZone);
    const utc = await send(owner, "POST", `/reports/${reportId}/filters/preview`, { table: `${DB}.orders`, column: "ts" });
    expect(utc.body.preview.dayZone).toBe(reportZone === "UTC" ? null : reportZone);
    expect(utc.body.preview.range).toEqual(reportZone === "UTC" ? { from: "2026-01-01", to: "2026-01-03" } : expect.objectContaining({ from: expect.any(String) }));
    const wait = async (id: string) => {
      const until = Date.now() + 45_000;
      for (;;) {
        const row = db.query("SELECT status, error FROM report_instructions WHERE id = ?").get(id) as { status: string; error: string | null };
        if (row.status === "proposed" || row.status === "failed") return row;
        if (Date.now() > until) throw new Error(`instruction still ${row.status}`);
        await Bun.sleep(25);
      }
    };
    const asked = await send(owner, "POST", `/reports/${reportId}/filters`, { table: `${DB}.orders`, column: "amount", label: "Amount" });
    expect(asked.status).toBe(201);
    expect(await wait(asked.body.instruction.id)).toEqual({ status: "proposed", error: null });
    const proposal = (await send(owner, "GET", `/reports/${reportId}/instructions/${asked.body.instruction.id}/proposal`)).body.proposal;
    expect(proposal.filter.checked.map((item: Json) => item.key).sort()).toEqual(["by_country", "count"]);
    expect((await send(owner, "POST", `/reports/${reportId}/instructions/${asked.body.instruction.id}/apply`, {})).status).toBe(200);
    const narrowed = await send(owner, "POST", `/reports/${reportId}/param-runs`, { values: { amount: { min: 10, max: null } } });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.results.find((item: Json) => item.queryKey === "count").result.rows[0][0]).toBe(3);

    const removal = await send(owner, "DELETE", `/reports/${reportId}/filters/amount`);
    expect(await wait(removal.body.instruction.id)).toEqual({ status: "proposed", error: null });
    expect((await send(owner, "POST", `/reports/${reportId}/instructions/${removal.body.instruction.id}/apply`, {})).status).toBe(200);
    const after = JSON.parse((db.query("SELECT spec_json FROM reports WHERE id = ?").get(reportId) as { spec_json: string }).spec_json) as ReportSpec;
    expect([after.parameters, after.queries.map((query) => query.sql)]).toEqual([[], spec.queries.map((query) => query.sql)]);
    // The seeded database stays for a rerun's inspection; the next run drops and recreates it.
    expect(await chExec(parseChUrl(url!), `SELECT count() FROM ${DB}.orders`)).toBe("6\n");
  });
});
