import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startFakeClickhouse, type FakeRequest } from "./support/fakeClickhouse";
import type { ReportSpec } from "../shared/reports";
import type { ReportParameter } from "../shared/reportParams";

const refresh = await import("../server/reports/refresh");
const params = await import("../server/reports/params");

/**
 * Concurrent parameter runs (lane FILT2, D571; docs/plan/REPORT_FILTERS.md "Later" 5): readers' sets
 * run side by side under each reader's own query slots instead of queueing on the report's one-run lock
 * (409 and a 1.5 s client retry); the same query with the same values runs once while it is in flight.
 * `REPORT_PARAM_BENCH=1` prints the timings this decision was measured with.
 */

retireUsersAfterFile();
const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());
const LATENCY_MS = 150;
beforeEach(() => {
  fake.reset();
  fake.state.delayMs = LATENCY_MS;
  fake.state.select = (sql: string, req: FakeRequest) => sql.includes("DISTINCT country")
    ? { meta: [{ name: "country", type: "String" }], data: ["DE", "FR", "IN", "US", "BR", "GB"].map((country) => [country]) }
    : { meta: [{ name: "orders", type: "UInt64" }], data: [[String((req.params.param_country ?? "").length)]] };
  params.resetParamRateLimit();
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const COUNTRY: ReportParameter = { id: "country", label: "Country", type: "multi_select", chType: "Array(String)", default: [], optionsQuery: "SELECT DISTINCT country FROM analytics.orders" };
const BY_COUNTRY = "(empty({country:Array(String)}) OR country IN {country:Array(String)})";
const spec: ReportSpec = {
  version: 1, specVersion: 3, sections: [], parameters: [COUNTRY],
  queries: [
    { key: "a", sql: `SELECT count() AS orders FROM analytics.orders WHERE ${BY_COUNTRY}`, purpose: "", createdBy: "agent" },
    { key: "b", sql: `SELECT count() AS orders FROM analytics.orders WHERE ${BY_COUNTRY} AND 1 = 1`, purpose: "", createdBy: "agent" }
  ],
  blocks: [
    { id: "k1", type: "kpi", title: "A", intent: "headline", queryKey: "a", column: "orders", unit: "orders" },
    { id: "k2", type: "kpi", title: "B", intent: "headline", queryKey: "b", column: "orders", unit: "orders" }
  ]
};

const admin = await createUser("Concurrency admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Concurrency owner");
const readers = await Promise.all([1, 2, 3, 4].map((n) => createUser(`Concurrency reader ${n}`)));
const created = await send(admin, "POST", "/reports/admin/datasources", { name: "Concurrency warehouse", url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;

async function seeded() {
  const report = await send(owner, "POST", "/reports", { title: "Concurrent orders", datasourceId });
  const id = report.body.report.id as string;
  db.query("UPDATE reports SET spec_json = ? WHERE id = ?").run(JSON.stringify(spec), id);
  expect((await send(owner, "PUT", `/reports/${id}/sharing`, { visibility: "selected", shares: readers.map((reader) => ({ kind: "user", id: reader.userId, level: "view" })) })).status).toBe(200);
  fake.state.delayMs = 0;
  await refresh.startRefresh(owner.userId, id, { trigger: "user" }).done;
  fake.state.delayMs = LATENCY_MS;
  return id;
}

/** The client's loop (ReportView): read the set; run what is missing, waiting 1.5 s on RUN_IN_PROGRESS or BUSY. */
async function openWith(session: Session, reportId: string, values: Json): Promise<{ ms: number; retries: number }> {
  const started = performance.now();
  let retries = 0;
  const first = await send(session, "GET", `/reports/${reportId}/results?values=${encodeURIComponent(JSON.stringify(values))}`);
  if (first.body.set.missing.length) {
    for (;;) {
      const ran = await send(session, "POST", `/reports/${reportId}/param-runs`, { values });
      if (ran.status === 200) break;
      if (ran.body.code !== "RUN_IN_PROGRESS" && ran.body.code !== "BUSY") throw new Error(`${ran.status} ${JSON.stringify(ran.body)}`);
      retries += 1;
      await Bun.sleep(1500);
    }
  }
  return { ms: performance.now() - started, retries };
}

describe("D571: concurrent parameter runs", () => {
  test("four readers' sets run side by side; nobody waits on the report's lock", async () => {
    const reportId = await seededReport();
    const sets = [["DE"], ["FR"], ["IN"], ["US"]];
    const started = performance.now();
    const timings = await Promise.all(readers.map((reader, index) => openWith(reader, reportId, { country: sets[index] })));
    const total = performance.now() - started;
    if (process.env.REPORT_PARAM_BENCH) console.log(JSON.stringify({ latencyMs: LATENCY_MS, readers: readers.length, totalMs: Math.round(total), each: timings.map((item) => Math.round(item.ms)), retries: timings.map((item) => item.retries) }));
    expect(timings.every((item) => item.retries === 0)).toBe(true);
    // Each set is two queries of 150 ms (plus the guard's tree checks), run in parallel per reader: well under one client retry.
    expect(total).toBeLessThan(1400);
  });

  test("the same query with the same values runs once while in flight; a default refresh does not block a reader", async () => {
    const reportId = await seededReport();
    fake.requests.length = 0;
    await Promise.all([readers[0]!, readers[1]!].map((reader) => openWith(reader, reportId, { country: ["BR"] })));
    const runs = fake.requests.filter((item) => item.sql.startsWith("SELECT * FROM (") && item.params.param_country === "['BR']");
    expect(runs.length).toBe(2);
    let release!: () => void;
    fake.state.hold = new Promise<void>((resolve) => { release = resolve; });
    const running = refresh.startRefresh(owner.userId, reportId, { trigger: "user" });
    // Before D571 this answered 409 RUN_IN_PROGRESS at once; now it runs (and waits only for ClickHouse).
    const pending = send(readers[2]!, "POST", `/reports/${reportId}/param-runs`, { values: { country: ["GB"] } });
    await Bun.sleep(200);
    release();
    fake.state.hold = null;
    expect((await pending).status).toBe(200);
    await running.done;
  });
});

const seededReport = seeded;
