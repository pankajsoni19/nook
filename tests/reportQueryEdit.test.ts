import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeClickhouse, type FakeRequest } from "./support/fakeClickhouse";
import { sampleAnswer, sampleSpec } from "./support/reportSeed";
import { retireUsersAfterFile } from "./support/retireUsers";
import type { ReportParameter } from "../shared/reportParams";
import type { ReportSpec } from "../shared/reports";
import { QUERY_EDIT_LIMITS } from "../shared/reportsQueryEdit";

const refresh = await import("../server/reports/refresh");
const { syncSchema } = await import("../server/reports/schemaCatalog");
const { resetQueryEditLimits } = await import("../server/reports/querySuggest");
const { reportTools } = await import("../server/reports/mcpTools");
const params = await import("../server/reports/params");

/**
 * Lane EDIT (D525–D531, T402): editing a saved query from Inspect → Query. The owner previews and saves
 * (a manual edit); the comment level previews and suggests (an instruction whose proposal is the
 * person's SQL, proposed with no agent run, applied or rejected by the owner); view level and Team
 * viewers are refused; the guard and the column checks hold; `{name:Type}` parameters keep working;
 * a suggestion moves onto a spec that changed elsewhere only when nothing it was checked against did.
 */

retireUsersAfterFile();
setDefaultTimeout(30_000);

const fake = startFakeClickhouse(0);
afterAll(() => fake.stop());

const BY_COUNTRY_3 = "SELECT country, sum(revenue) AS revenue FROM analytics.orders GROUP BY country ORDER BY revenue DESC LIMIT 3";
const NO_REVENUE = "SELECT country, count() AS orders FROM analytics.orders GROUP BY country";
const RECENT_10 = "SELECT order_id, country, revenue, created_at FROM analytics.orders ORDER BY created_at DESC LIMIT 10";

function answer(sql: string, req: FakeRequest) {
  if (sql.includes("count() AS orders FROM analytics.orders GROUP BY country")) return { meta: [{ name: "country", type: "String" }, { name: "orders", type: "UInt64" }], data: [["US", "4"], ["DE", "3"]] };
  if (sql.includes("{period_from:Date}")) return { meta: [{ name: "orders", type: "UInt64" }], data: [[req.params.param_period_from ? "70" : "0"]] };
  if (sql.includes("SELECT DISTINCT country")) return { meta: [{ name: "country", type: "String" }], data: [["DE"], ["US"]] };
  return sampleAnswer(sql);
}
beforeEach(() => {
  fake.reset();
  fake.state.select = answer;
  resetQueryEditLimits();
  params.resetParamRateLimit();
});

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const admin = await createUser("Query edit admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const owner = await createUser("Query edit owner");
const commenter = await createUser("Query edit commenter");
const reader = await createUser("Query edit reader");
const teamViewer = await createUser("Query edit team viewer");
db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(teamViewer.userId);
const stranger = await createUser("Query edit stranger");
fake.state.tables = [{ db: "analytics", name: "orders", engine: "MergeTree", sorting_key: "order_id", columns: [{ name: "order_id", type: "UInt64" }, { name: "revenue", type: "Decimal(18, 2)" }, { name: "country", type: "String" }, { name: "day", type: "Date" }] }];
const created = await send(admin, "POST", "/reports/admin/datasources", { name: `Query edit ${crypto.randomUUID().slice(0, 6)}`, url: fake.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
const datasourceId = created.body.datasource.id as string;
await syncSchema(datasourceId).catch(() => undefined);

async function seededReport(spec: ReportSpec = sampleSpec()) {
  const report = await send(owner, "POST", "/reports", { title: "Query edit", datasourceId });
  const id = report.body.report.id as string;
  db.query("UPDATE reports SET spec_json = ?, status = 'ready' WHERE id = ?").run(JSON.stringify(spec), id);
  await refresh.startRefresh(owner.userId, id, { trigger: "user" }).done;
  await send(owner, "PUT", `/reports/${id}/sharing`, { visibility: "selected", shares: [{ kind: "user", id: commenter.userId, level: "comment" }, { kind: "user", id: reader.userId, level: "view" }, { kind: "user", id: teamViewer.userId, level: "comment" }] });
  return id;
}
const sqlOf = (reportId: string, key: string) => (JSON.parse((db.query("SELECT spec_json FROM reports WHERE id = ?").get(reportId) as { spec_json: string }).spec_json) as ReportSpec).queries.find((query) => query.key === key)?.sql;
const auditOf = (event: string, reportId: string) => (db.query("SELECT metadata_json FROM audit_log WHERE event_type = ? AND metadata_json LIKE ? ORDER BY rowid").all(event, `%${reportId}%`) as Array<{ metadata_json: string }>).map((row) => JSON.parse(row.metadata_json) as Json);
const instructionOf = (id: string) => db.query("SELECT status, error, agent_run_id, suggested_query, proposal_json FROM report_instructions WHERE id = ?").get(id) as { status: string; error: string | null; agent_run_id: string | null; suggested_query: string | null; proposal_json: string | null };

describe("Run preview", () => {
  test("the owner and a commenter preview new SQL: the rows, and the columns the blocks would miss; nothing is saved", async () => {
    const reportId = await seededReport();
    const before = sqlOf(reportId, "by_country");
    const good = await send(owner, "POST", `/reports/${reportId}/queries/by_country/preview`, { sql: BY_COUNTRY_3 });
    expect(good.status).toBe(200);
    expect(good.body.preview.outcome.rows.length).toBe(8);
    expect(good.body.preview.blocks).toEqual([{ blockId: "country-bar", title: "Top countries", missing: [] }]);
    expect(good.body.preview.problems).toEqual([]);
    const missing = await send(commenter, "POST", `/reports/${reportId}/queries/by_country/preview`, { sql: NO_REVENUE });
    expect(missing.status).toBe(200);
    expect(missing.body.preview.blocks).toEqual([{ blockId: "country-bar", title: "Top countries", missing: ["revenue"] }]);
    expect(missing.body.preview.problems[0]).toContain("block country-bar: y revenue is not a column of by_country");
    expect(sqlOf(reportId, "by_country")).toBe(before);
    // Audited by SHA-256 and the level, never the SQL.
    const entries = auditOf("reports.query.preview", reportId);
    expect(entries.map((entry) => entry.level)).toEqual(["owner", "comment"]);
    expect(JSON.stringify(entries)).not.toContain("analytics.orders");
  });

  test("the guard refuses a preview (url(), writes); view level, Team viewers, and strangers are refused", async () => {
    const reportId = await seededReport();
    const ssrf = await send(commenter, "POST", `/reports/${reportId}/queries/by_country/preview`, { sql: "SELECT * FROM url('http://169.254.169.254/latest', CSV)" });
    expect(ssrf.status).toBe(400);
    expect(ssrf.body.code).toBe("GUARD");
    const write = await send(commenter, "POST", `/reports/${reportId}/queries/by_country/preview`, { sql: "INSERT INTO analytics.orders VALUES (1)" });
    expect(write.body.code).toBe("GUARD");
    const metadata = await send(commenter, "POST", `/reports/${reportId}/queries/by_country/preview`, { sql: "SHOW TABLES FROM analytics" });
    expect(metadata.body.code).toBe("GUARD");
    expect(fake.requests.some((item) => item.sql.includes("169.254"))).toBe(false);
    expect(auditOf("reports.query.preview_refused", reportId).length).toBe(3);
    expect((await send(reader, "POST", `/reports/${reportId}/queries/by_country/preview`, { sql: BY_COUNTRY_3 })).body.code).toBe("ROLE_READ_ONLY");
    expect((await send(teamViewer, "POST", `/reports/${reportId}/queries/by_country/preview`, { sql: BY_COUNTRY_3 })).status).toBe(403);
    expect((await send(stranger, "POST", `/reports/${reportId}/queries/by_country/preview`, { sql: BY_COUNTRY_3 })).status).toBe(404);
    expect((await send(owner, "POST", `/reports/${reportId}/queries/no_such/preview`, { sql: BY_COUNTRY_3 })).status).toBe(404);
  });

  test("previews are rate-limited per person", async () => {
    const reportId = await seededReport();
    for (let index = 0; index < QUERY_EDIT_LIMITS.previewsPerMinute; index += 1) {
      expect((await send(commenter, "POST", `/reports/${reportId}/queries/by_country/preview`, { sql: BY_COUNTRY_3 })).status).toBe(200);
    }
    const refused = await send(commenter, "POST", `/reports/${reportId}/queries/by_country/preview`, { sql: BY_COUNTRY_3 });
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe("BUSY");
    // Another person has their own allowance.
    expect((await send(owner, "POST", `/reports/${reportId}/queries/by_country/preview`, { sql: BY_COUNTRY_3 })).status).toBe(200);
  });
});

describe("Suggest an edit", () => {
  test("a commenter's suggestion is checked, proposed with no agent run, shown whole to its author, and applied by the owner as a hand edit", async () => {
    // A spec v3 page with no widths: the checks fill defaults, but only the blocks that read the query show as changed.
    const reportId = await seededReport({ ...sampleSpec(), specVersion: 3, sections: [], parameters: [] });
    const posted = await send(commenter, "POST", `/reports/${reportId}/queries/by_country/suggest`, { sql: BY_COUNTRY_3, note: "Top three is enough", blockId: "country-bar" });
    expect(posted.status).toBe(201);
    const instruction = posted.body.instruction as Json;
    expect(instruction).toMatchObject({ status: "proposed", suggestedQuery: "by_country", blockId: "country-bar", isMine: true, summary: "Top three is enough", agentRunId: null });
    expect(instructionOf(instruction.id).agent_run_id).toBeNull();
    // Its author sees the SQL and the rows (their own); a reader does not see the proposal at all.
    const mine = await send(commenter, "GET", `/reports/${reportId}/instructions/${instruction.id}/proposal`);
    expect(mine.body.proposal.redacted).toBeUndefined();
    expect(mine.body.proposal.queries).toEqual([{ key: "by_country", change: "updated", before: expect.stringContaining("LIMIT 8"), after: BY_COUNTRY_3 }]);
    expect(mine.body.proposal.blocks.map((change: Json) => [change.blockId, change.change])).toEqual([["country-bar", "updated"]]);
    expect((await send(reader, "GET", `/reports/${reportId}/instructions/${instruction.id}/proposal`)).status).toBe(404);
    // The owner's review draws the proposal's own rows.
    const review = await send(owner, "GET", `/reports/${reportId}/instructions/${instruction.id}/proposal`);
    expect(review.body.proposal.results.find((item: Json) => item.queryKey === "by_country").result.sql).toBe(BY_COUNTRY_3);
    // Only the owner applies.
    expect((await send(commenter, "POST", `/reports/${reportId}/instructions/${instruction.id}/apply`, {})).status).toBe(404);
    const applied = await send(owner, "POST", `/reports/${reportId}/instructions/${instruction.id}/apply`, {});
    expect(applied.body.instruction.status).toBe("applied");
    expect(sqlOf(reportId, "by_country")).toBe(BY_COUNTRY_3);
    const versions = (await send(owner, "GET", `/reports/${reportId}/versions`)).body.versions as Json[];
    expect(versions.find((item) => item.current)).toMatchObject({ source: "manual" });
    const suggested = auditOf("reports.query.suggest", reportId);
    expect(suggested).toEqual([expect.objectContaining({ instructionId: instruction.id, queryKey: "by_country", level: "comment", noteChars: 19 })]);
    expect(JSON.stringify(suggested)).not.toContain("LIMIT 3");
  });

  test("a suggestion that breaks a block's columns, or that the guard refuses, saves nothing; the owner may reject one", async () => {
    const reportId = await seededReport();
    const broken = await send(commenter, "POST", `/reports/${reportId}/queries/by_country/suggest`, { sql: NO_REVENUE });
    expect(broken.status).toBe(400);
    expect(broken.body.code).toBe("INVALID");
    expect(broken.body.details.join("\n")).toContain("block country-bar: y revenue is not a column of by_country");
    const refused = await send(commenter, "POST", `/reports/${reportId}/queries/by_country/suggest`, { sql: "SELECT * FROM file('/etc/passwd')" });
    expect(refused.status).toBe(400);
    expect((db.query("SELECT count(*) AS n FROM report_instructions WHERE report_id = ?").get(reportId) as { n: number }).n).toBe(0);
    expect((await send(commenter, "POST", `/reports/${reportId}/queries/by_country/suggest`, { sql: sqlOf(reportId, "by_country") })).body.error).toBe("That changes nothing");
    expect((await send(reader, "POST", `/reports/${reportId}/queries/by_country/suggest`, { sql: BY_COUNTRY_3 })).status).toBe(403);
    expect((await send(teamViewer, "POST", `/reports/${reportId}/queries/by_country/suggest`, { sql: BY_COUNTRY_3 })).status).toBe(403);

    const posted = await send(commenter, "POST", `/reports/${reportId}/queries/by_country/suggest`, { sql: BY_COUNTRY_3 });
    const rejected = await send(owner, "POST", `/reports/${reportId}/instructions/${posted.body.instruction.id}/reject`, {});
    expect(rejected.body.instruction.status).toBe("rejected");
    expect(sqlOf(reportId, "by_country")).not.toBe(BY_COUNTRY_3);
  });

  test("a suggestion waits behind another; it moves onto the new spec when its query and blocks are unchanged, and fails when they changed", async () => {
    const reportId = await seededReport();
    const first = (await send(commenter, "POST", `/reports/${reportId}/queries/by_country/suggest`, { sql: BY_COUNTRY_3 })).body.instruction as Json;
    const second = (await send(commenter, "POST", `/reports/${reportId}/queries/recent/suggest`, { sql: RECENT_10 })).body.instruction as Json;
    const third = (await send(commenter, "POST", `/reports/${reportId}/queries/by_country/suggest`, { sql: BY_COUNTRY_3.replace("LIMIT 3", "LIMIT 5") })).body.instruction as Json;
    expect([first.status, second.status, third.status]).toEqual(["proposed", "queued", "queued"]);
    await send(owner, "POST", `/reports/${reportId}/instructions/${first.id}/apply`, {});
    // `recent` did not change: the second suggestion moves onto the new spec and is proposed.
    expect(instructionOf(second.id)).toMatchObject({ status: "proposed", error: null });
    expect(auditOf("reports.query.suggest_rebased", reportId).length).toBe(1);
    const review = await send(owner, "GET", `/reports/${reportId}/instructions/${second.id}/proposal`);
    expect(review.body.proposal.outOfDate).toBe(false);
    expect(review.body.proposal.queries.map((query: Json) => query.key)).toEqual(["recent"]);
    await send(owner, "POST", `/reports/${reportId}/instructions/${second.id}/apply`, {});
    expect(sqlOf(reportId, "recent")).toBe(RECENT_10);
    expect(sqlOf(reportId, "by_country")).toBe(BY_COUNTRY_3);
    // The third was checked against the old by_country: it fails with a reason.
    expect(instructionOf(third.id)).toMatchObject({ status: "failed", error: "The report changed since this was suggested; suggest it again" });
  });

  test("an owner's Save keeps {name:Type} parameters working; preview binds the values on screen; a suggestion with an undeclared placeholder is refused", async () => {
    const PERIOD: ReportParameter = { id: "period", label: "Period", type: "date_range", chType: "Date", default: { preset: "30d" } };
    const where = "day >= {period_from:Date} AND day <= {period_to:Date}";
    const spec: ReportSpec = {
      version: 1, specVersion: 3, sections: [], parameters: [PERIOD],
      queries: [{ key: "totals", sql: `SELECT count() AS orders FROM analytics.orders WHERE ${where}`, purpose: "Orders", createdBy: "agent" }],
      blocks: [{ id: "kpi-orders", type: "kpi", title: "Orders", intent: "headline", queryKey: "totals", column: "orders", format: "number" }]
    };
    const reportId = await seededReport(spec);
    const edited = `SELECT count() AS orders FROM analytics.orders WHERE ${where} AND country = 'US'`;
    const preview = await send(commenter, "POST", `/reports/${reportId}/queries/totals/preview`, { sql: edited, values: { period: { preset: "custom", from: "2026-10-01", to: "2026-10-07" } } });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.outcome.params).toEqual({ period_from: "2026-10-01", period_to: "2026-10-07" });
    const undeclared = await send(commenter, "POST", `/reports/${reportId}/queries/totals/preview`, { sql: `${edited} AND region = {region:String}` });
    expect(undeclared.status).toBe(400);
    expect(undeclared.body.error).toContain("{region:String} is not a declared parameter");
    expect((await send(commenter, "POST", `/reports/${reportId}/queries/totals/suggest`, { sql: `${edited} AND region = {region:String}` })).status).toBe(400);
    const revision = (await send(owner, "GET", `/reports/${reportId}`)).body.report.revision as number;
    const saved = await send(owner, "POST", `/reports/${reportId}/spec/edit`, { ops: [{ op: "update_query", key: "totals", sql: edited }], expectedRevision: revision });
    expect(saved.body).toMatchObject({ version: expect.any(Number) });
    expect(sqlOf(reportId, "totals")).toBe(edited);
    const results = await send(owner, "GET", `/reports/${reportId}/results`);
    expect(results.body.results[0].result.params).toMatchObject({ period_from: expect.any(String), period_to: expect.any(String) });
  });
});

describe("MCP", () => {
  const tool = (name: string) => reportTools.find((item) => item.name === name)!;
  const keyOf = (session: Session) => ({ keyId: `key-${session.userId.slice(0, 8)}`, userId: session.userId, name: "k", scopes: ["reports:read", "reports:write"] as Array<"reports:read" | "reports:write"> });

  test("suggest_report_query queues a commenter's proposal (audited via mcp); a reader's key is refused", async () => {
    const reportId = await seededReport();
    const result = await tool("suggest_report_query").handler({ reportId, queryKey: "by_country", sql: BY_COUNTRY_3, note: "via a key" }, keyOf(commenter)) as Json;
    expect(result.instruction).toMatchObject({ status: "proposed", suggestedQuery: "by_country", via: "mcp" });
    expect(auditOf("reports.query.suggest", reportId)[0]).toMatchObject({ via: "mcp", keyId: keyOf(commenter).keyId });
    await expect(tool("suggest_report_query").handler({ reportId, queryKey: "by_country", sql: BY_COUNTRY_3 }, keyOf(reader))).rejects.toMatchObject({ code: "READ_ONLY" });
    await expect(tool("suggest_report_query").handler({ reportId, queryKey: "by_country", sql: NO_REVENUE }, keyOf(owner))).rejects.toMatchObject({ code: "INVALID" });
    const seen = await tool("get_report_instruction").handler({ reportId, instructionId: result.instruction.id }, keyOf(owner)) as Json;
    expect(seen.proposal.queries[0]).toMatchObject({ key: "by_country", after: BY_COUNTRY_3 });
  });
});
