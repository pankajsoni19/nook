import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { qaEditScript, startScriptedProvider, withCondition } from "../scripts/fakeReportProvider";
import { DEFAULT_COMPAT } from "../shared/agents";
import type { ReportSpec } from "../shared/reports";
import topRoutes from "../evals/reports/cases/top_routes/case";
import { chExec, parseChUrl, seed } from "../evals/reports/clickhouse";

const { editDeps, liveEdits } = await import("../server/reports/edit");
const refresh = await import("../server/reports/refresh");
const { syncSchema } = await import("../server/reports/schemaCatalog");
const { resultFingerprint } = await import("../server/reports/filterChecks");

/**
 * D582: Add filter's identity check (D535) against a real ClickHouse, the variant of
 * tests/reportFiltersRequest.test.ts that runs where CLICKHOUSE_TEST_URL is set (as
 * tests/reportsClickhouseLive.test.ts: `http://nook:nooktest@127.0.0.1:22200`, or CLICKHOUSE_TEST_USER and
 * CLICKHOUSE_TEST_PASSWORD; skipped otherwise). It seeds the eval case `top_routes` (its seed drops and
 * recreates `eval_top_routes`), saves the case's golden report plus three queries a real server answers
 * in ways the fake cannot (rows that tie in their ORDER BY and come back in any order, Decimal
 * and Float columns, and a Float sum over the two parts the seed writes), asks for "a filter on
 * requests.route", and checks the scripted agent's proposal passes the identity check on the real
 * server and applies, then that a picked route narrows the filtered queries.
 */

const url = process.env.CLICKHOUSE_TEST_URL;

// Only when it runs: skipped, it creates nobody (and a fresh database has no admin to keep).
if (url) retireUsersAfterFile();
setDefaultTimeout(60_000);

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const EXCLUDED = "route NOT IN ('healthz', 'readyz')";
/** Every status's rows in one bucket (0): an ORDER BY made only of ties, so ClickHouse may return them in any order. */
const TIES_SQL = `SELECT status, intDiv(count(), 1000000) AS bucket\nFROM eval_top_routes.requests\nWHERE ${EXCLUDED}\nGROUP BY status\nORDER BY bucket`;
/** Decimal (sent as strings), a Float sum over two parts (the seed's two inserts), and an average, per day. */
const LATENCY_SQL = `SELECT toDate(ts) AS day, toDecimal64(sum(duration_ms) / 1000, 3) AS seconds, sum(duration_ms * 0.001) AS seconds_float, avg(duration_ms) AS avg_ms, toDecimal32(countIf(status >= 500) * 100 / count(), 2) AS error_pct\nFROM eval_top_routes.requests\nWHERE ${EXCLUDED}\nGROUP BY day\nORDER BY day`;
const CONDITION = "(empty({route:Array(String)}) OR route IN {route:Array(String)})";

function spec(): ReportSpec {
  return {
    version: 1, specVersion: 3, sections: [], parameters: [],
    queries: [
      ...topRoutes.golden.queries.map((query) => ({ ...query, createdBy: "agent" as const })),
      { key: "ties", sql: TIES_SQL, purpose: "Statuses, all in one bucket", createdBy: "agent" },
      { key: "latency", sql: LATENCY_SQL, purpose: "Time spent per day", createdBy: "agent" }
    ],
    blocks: [
      ...topRoutes.golden.blocks as ReportSpec["blocks"],
      { id: "ties", type: "table", title: "Statuses", intent: "detail", queryKey: "ties" },
      { id: "latency", type: "table", title: "Time spent per day", intent: "detail", queryKey: "latency" }
    ]
  };
}

describe.skipIf(!url)("Add filter's identity check on a real ClickHouse (CLICKHOUSE_TEST_URL)", () => {
  // In hooks, not the describe body: a skipped describe still runs its body, and must change nothing.
  let provider: ReturnType<typeof startScriptedProvider>;
  const originalConnection = editDeps.connection;
  beforeAll(() => {
    provider = startScriptedProvider(0, qaEditScript);
    editDeps.connection = () => ({ id: "scripted", baseUrl: provider.baseUrl, apiKey: null, model: "scripted-report-model", compat: DEFAULT_COMPAT });
  });
  afterAll(async () => {
    const until = Date.now() + 15_000;
    while (liveEdits().length && Date.now() < until) await Bun.sleep(20);
    editDeps.connection = originalConnection;
    provider.stop();
  });

  test("the seeded case answers Decimal and Float columns; the fingerprint is the same across runs on several threads", async () => {
    const ch = parseChUrl(url!);
    await seed(ch, await Bun.file(new URL("../evals/reports/cases/top_routes/seed.sql", import.meta.url)).text());
    const runs = await Promise.all(Array.from({ length: 4 }, () => chExec(ch, `${LATENCY_SQL} SETTINGS max_threads = 4`, "JSONCompact")));
    const parsed = runs.map((text) => JSON.parse(text) as { meta: Array<{ name: string; type: string }>; data: unknown[][] });
    expect(parsed[0]!.meta.map((column) => column.type)).toEqual(["Date", "Decimal(18, 3)", "Float64", "Float64", "Decimal(9, 2)"]);
    for (const run of parsed) expect(resultFingerprint({ columns: run.meta, rows: run.data })).toBe(resultFingerprint({ columns: parsed[0]!.meta, rows: parsed[0]!.data }));
  });

  test("the scripted agent's filter passes the identity check on ties, Decimal, and Float rows; it applies and a picked route narrows", async () => {
    const ch = parseChUrl(url!);
    const admin = await createUser("Live filter admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const owner = await createUser("Live filter owner");
    const created = await send(admin, "POST", "/reports/admin/datasources", { name: `Live routes ${crypto.randomUUID().slice(0, 6)}`, url: ch.base, username: ch.user, password: ch.password, database: "eval_top_routes", allowlist: ["eval_top_routes"] });
    expect(created.status).toBe(201);
    const datasourceId = created.body.datasource.id as string;
    await syncSchema(datasourceId);

    const report = await send(owner, "POST", "/reports", { title: "API traffic, live", datasourceId });
    const reportId = report.body.report.id as string;
    db.query("UPDATE reports SET spec_json = ?, status = 'ready' WHERE id = ?").run(JSON.stringify(spec()), reportId);
    const first = await refresh.startRefresh(owner.userId, reportId, { trigger: "user" }).done;
    expect(first.status).toBe("succeeded");

    const asked = await send(owner, "POST", `/reports/${reportId}/filters`, { table: "eval_top_routes.requests", column: "route", label: "Route" });
    expect(asked.status).toBe(201);
    const instructionId = asked.body.instruction.id as string;
    const until = Date.now() + 45_000;
    let row: { status: string; error: string | null };
    for (;;) {
      row = db.query("SELECT status, error FROM report_instructions WHERE id = ?").get(instructionId) as typeof row;
      if (row.status === "proposed" || row.status === "failed") break;
      if (Date.now() > until) throw new Error(`instruction still ${row.status}`);
      await Bun.sleep(25);
    }
    expect(row).toEqual({ status: "proposed", error: null });

    const proposal = (await send(owner, "GET", `/reports/${reportId}/instructions/${instructionId}/proposal`)).body.proposal;
    // Every query that reads requests without grouping by route took the filter and kept its default result.
    expect(proposal.filter.checked.map((check: Json) => check.key).sort()).toEqual(["errors", "latency", "ties"]);
    for (const check of proposal.filter.checked as Json[]) expect(check.rows).toBeGreaterThan(0);
    expect(proposal.filter.untouched.map((item: Json) => item.key)).toEqual(["routes"]);
    expect((proposal.queries as Json[]).find((query) => query.key === "latency")!.after).toBe(withCondition(LATENCY_SQL, CONDITION));

    expect((await send(owner, "POST", `/reports/${reportId}/instructions/${instructionId}/apply`, {})).status).toBe(200);
    const defaults = await send(owner, "GET", `/reports/${reportId}/results`);
    const errorRate = defaults.body.results.find((item: Json) => item.queryKey === "errors").result.rows[0][0] as number;
    expect(errorRate).toBeCloseTo(topRoutes.facts.find((fact) => fact.id === "error_rate")!.value as number, 4);
    const picked = await send(owner, "POST", `/reports/${reportId}/param-runs`, { values: { route: ["search"] } });
    expect(picked.status).toBe(200);
    const narrowed = picked.body.results.find((item: Json) => item.queryKey === "errors").result.rows[0][0] as number;
    expect(narrowed).toBeGreaterThan(errorRate);
    // The chart is the filter's click source: it keeps every route.
    expect(picked.body.results.find((item: Json) => item.queryKey === "routes").result.rows.length).toBe(4);
  });
});
