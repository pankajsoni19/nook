import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { createUser, db, origin, type Session } from "./support/harness";
import { api } from "./support/mcpClient";
import { startFakeProvider } from "./support/fakeProvider";
import { startFakeClickhouse } from "./support/fakeClickhouse";
import { startFakeMcpServer } from "./support/fakeMcpServer";
import { retireUsersAfterFile } from "./support/retireUsers";
import { withoutNookAutoTools } from "./support/nookAuto";
import { completionsWith, runMarker, settleAgentRunsAfterEach } from "./support/agentRuns";

const { syncSchema } = await import("../server/reports/schemaCatalog");
const { deleteProvider } = await import("../server/agents/providers");
const { deleteServer, resetToolServersForTests } = await import("../server/agents/toolServers");
const { resolveTools } = await import("../server/agents/tools");
const { mcpToolSpecs } = await import("../server/mcpTools");
const { snapshotOf } = await import("../server/agents/publicShares");
const { resetDataToolRateForTests, runDataTool } = await import("../server/agents/dataSources");
const { DATA_TOOL_BOUNDS, DATA_TOOL_NAMES } = await import("../shared/agents");

/**
 * Chat agents and report data sources (lane AGENTSQL, D590–D599, T425–T429): the admin policy (off by
 * default, roles), picks in the agent editor, the data tools in a chat with the fake provider calling
 * them (the guard, the allowlist, row caps to the model and to the table, the audit by SHA-256), the
 * stored result read by who may use the data source, tool servers asking first after data was read,
 * and never over MCP, API keys, or a public link.
 */

retireUsersAfterFile();
withoutNookAutoTools();
settleAgentRunsAfterEach();
setDefaultTimeout(30_000);

const fake = startFakeProvider(0);
const clickhouse = startFakeClickhouse(0);
const mcp = startFakeMcpServer(0);
let admin: Session;
let member: Session;
let providerId = "";
let datasourceId = "";
let serverId = "";
let revision = 1;

type Json = Record<string, any>;
type SseEvent = { seq: number; type: string; data: Json };

async function readEvents(session: Session, runId: string, until: (events: SseEvent[]) => boolean = (events) => events.some((event) => event.type === "done")): Promise<SseEvent[]> {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/runs/${runId}/events?after=0`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
  expect(response.status).toBe(200);
  const events: SseEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at = buffer.indexOf("\n\n");
      while (at >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        at = buffer.indexOf("\n\n");
        if (frame.startsWith(":")) continue;
        const lines = Object.fromEntries(frame.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
        events.push({ seq: Number(lines.id), type: lines.event, data: JSON.parse(lines.data) });
      }
      if (until(events)) { controller.abort(); break; }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

async function setPolicy(agentUse: "off" | "admins" | "members") {
  const patched = await api(admin, "PATCH", `/reports/admin/datasources/${datasourceId}`, { agentUse, expectedRevision: revision });
  expect(patched.status).toBe(200);
  revision = patched.body.datasource.revision;
  expect(patched.body.datasource.agentUse).toBe(agentUse);
}

async function newAgent(session: Session, tools: unknown[] = [{ source: "datasource", datasourceId }]) {
  const created = await api(session, "POST", "/agents", { name: "Analyst", systemPrompt: "Answer with data.", providerId, maxSteps: 6, tools });
  return created;
}
async function newChat(session: Session, agentId: string) {
  const created = await api(session, "POST", "/chats", { agentId });
  expect(created.status).toBe(201);
  return created.body.chat.id as string;
}
async function send(session: Session, chatId: string, content: string, until?: (events: SseEvent[]) => boolean) {
  const started = await api(session, "POST", `/chats/${chatId}/messages`, { content });
  expect(started.status).toBe(201);
  return { runId: started.body.runId as string, messageId: started.body.assistantMessage.id as string, events: await readEvents(session, started.body.runId, until) };
}
type Completion = { messages: Array<{ role: string; content: string | null }>; tools?: Array<{ function: { name: string; description: string } }> };
const completions = (marker: string) => completionsWith(fake.calls, marker).map((call) => call.body as Completion);
const toolNamesOf = (body: Completion) => (body.tools ?? []).map((tool) => tool.function.name);

const ROWS = 1500;
beforeAll(async () => {
  admin = await createUser("Agent SQL admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  member = await createUser("Agent SQL member");
  const provider = await api(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (agent SQL)", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-agentsql-0001", defaultModel: "gpt-6-luna" });
  expect(provider.status).toBe(201);
  providerId = provider.body.provider.id;
  clickhouse.state.tables = [
    { db: "analytics", name: "orders", engine: "MergeTree", comment: "One row per order", columns: [{ name: "day", type: "Date" }, { name: "country", type: "String" }, { name: "revenue", type: "Decimal(18, 2)" }] },
    { db: "secret", name: "salaries", engine: "MergeTree", columns: [{ name: "name", type: "String" }, { name: "salary", type: "UInt64" }] }
  ];
  clickhouse.state.select = (sql) => sql.includes("analytics.orders")
    ? { meta: [{ name: "country", type: "String" }, { name: "revenue", type: "Decimal(18, 2)" }], data: Array.from({ length: ROWS }, (_, index) => [`C${index}`, `${index}.50`]), rowsRead: ROWS }
    : { meta: [{ name: "n", type: "UInt64" }], data: [["1"]] };
  const created = await api(admin, "POST", "/reports/admin/datasources", { name: `Warehouse ${crypto.randomUUID().slice(0, 6)}`, url: clickhouse.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"] });
  expect(created.status).toBe(201);
  datasourceId = created.body.datasource.id;
  revision = created.body.datasource.revision;
  // D590: off by default.
  expect(created.body.datasource.agentUse).toBe("off");
  await syncSchema(datasourceId);
  const server = await api(admin, "POST", "/agents/admin/servers", { name: "AgentSQL tools", slug: "agentsqltools", url: mcp.url, availability: "all", timeoutMs: 5000 });
  expect(server.status).toBe(201);
  serverId = server.body.server.id;
});
afterAll(async () => {
  deleteServer(admin.userId, serverId);
  deleteProvider(admin.userId, providerId);
  await resetToolServersForTests();
  fake.stop();
  clickhouse.stop();
  mcp.stop();
});

describe("the admin policy and the agent's picks (D590, D591)", () => {
  test("off: the catalog lists nothing and a pick is refused; on for members: listed and picked; admins only: a member is refused", async () => {
    await setPolicy("off");
    expect((await api(member, "GET", "/agents/catalog")).body.catalog.datasources).toEqual([]);
    expect((await newAgent(member)).status).toBe(400);
    await setPolicy("members");
    const catalog = (await api(member, "GET", "/agents/catalog")).body.catalog.datasources as Json[];
    expect(catalog.map((item) => item.id)).toEqual([datasourceId]);
    expect(catalog[0]).toMatchObject({ database: "analytics", tables: 1 });
    const created = await newAgent(member);
    expect(created.status).toBe(201);
    expect(created.body.agent.tools).toEqual([{ source: "datasource", datasourceId }]);
    // A data source is private data: with an open-world tool this is the trifecta.
    await setPolicy("admins");
    expect((await api(member, "GET", "/agents/catalog")).body.catalog.datasources).toEqual([]);
    expect((await newAgent(member)).status).toBe(400);
    expect((await api(admin, "GET", "/agents/catalog")).body.catalog.datasources.length).toBe(1);
    // The member's earlier pick stays on the agent (it is theirs), and the audit names the policy change.
    expect((await api(member, "GET", `/agents/${created.body.agent.id}`)).body.agent.tools).toEqual([{ source: "datasource", datasourceId }]);
    const updates = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'reports.datasource.update' AND metadata_json LIKE ?").all(`%${datasourceId}%`) as Array<{ metadata_json: string }>;
    expect(updates.some((row) => JSON.parse(row.metadata_json).agentUse === "admins")).toBe(true);
    await setPolicy("off");
  });

  test("an invalid policy word is a 400", async () => {
    expect((await api(admin, "PATCH", `/reports/admin/datasources/${datasourceId}`, { agentUse: "guests", expectedRevision: revision })).status).toBe(400);
  });
});

describe("the data tools in a chat (D592–D596)", () => {
  test("the fake provider calls run_sql: guarded, capped for the model, the table stored for the person, audited by SHA-256", async () => {
    await setPolicy("members");
    const agent = (await newAgent(member)).body.agent;
    const chatId = await newChat(member, agent.id);
    const marker = runMarker();
    const sql = "SELECT country, revenue FROM analytics.orders ORDER BY revenue DESC";
    const { messageId, events } = await send(member, chatId, `tool:data__run_sql:${JSON.stringify({ sql, purpose: marker })}`);
    const bodies = completions(marker);
    // Offered: the five data tools, each with the data source as an enum.
    expect(toolNamesOf(bodies[0]!).filter((name) => name.startsWith("data__")).sort()).toEqual(DATA_TOOL_NAMES.map((name) => `data__${name}`).sort());
    const result = events.find((event) => event.type === "tool_result")!;
    expect(result.data.ok).toBe(true);
    expect(result.data.sqlResult).toMatchObject({ datasourceId, rowCount: DATA_TOOL_BOUNDS.uiRows, truncated: true, columnCount: 2 });
    // The excerpt is a summary, never rows; the SQL is not on the message.
    expect(result.data.resultPreview).toContain("1,000 rows");
    expect(result.data.resultPreview).not.toContain("C10");
    const call = events.find((event) => event.type === "tool_call")!;
    expect(call.data.argsPreview).not.toContain("analytics.orders");
    // The model's share: at most 50 rows inside the untrusted-data fence, within 16 KB.
    const toolTurn = bodies.at(-1)!.messages.find((turn) => turn.role === "tool")!.content!;
    expect(toolTurn).toContain("Untrusted tool result");
    const payload = JSON.parse(toolTurn.split("\n").slice(1, -1).join("\n")) as Json;
    expect(payload.rows.length).toBeLessThanOrEqual(DATA_TOOL_BOUNDS.modelRows);
    expect(payload).toMatchObject({ rowCount: DATA_TOOL_BOUNDS.uiRows, truncated: true });
    expect(Buffer.byteLength(toolTurn, "utf8")).toBeLessThan(DATA_TOOL_BOUNDS.modelBytes + 600);
    // ClickHouse got the guarded, wrapped statement with Nook's limits.
    const sent = clickhouse.requests.filter((request) => request.sql.includes("analytics.orders") && !request.sql.startsWith("EXPLAIN"));
    expect(sent.at(-1)!.params.readonly).toBe("2");
    // The table: up to 1,000 rows, read back by the owner with the SQL.
    const detail = await api(member, "GET", `/chats/${chatId}/sql-results/${result.data.sqlResult.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.result).toMatchObject({ sql, rowCount: 1000, truncated: true });
    expect(detail.body.result.rows.length).toBe(1000);
    expect(detail.body.result.columns.map((column: Json) => column.name)).toEqual(["country", "revenue"]);
    // The stored message carries the reference.
    const chat = await api(member, "GET", `/chats/${chatId}`);
    const message = chat.body.messages.find((item: Json) => item.id === messageId);
    expect(message.toolCalls[0].sqlResult.id).toBe(result.data.sqlResult.id);
    // Audit: the SQL's SHA-256, never the SQL or rows.
    const rows = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'agents.sql.run'").all(member.userId) as Array<{ metadata_json: string }>;
    const last = JSON.parse(rows.at(-1)!.metadata_json) as Json;
    expect(last).toMatchObject({ tool: "run_sql", ok: true, datasourceId, sha256: createHash("sha256").update(sql).digest("hex"), rows: 1000 });
    expect(rows.at(-1)!.metadata_json).not.toContain("analytics.orders");
  });

  test("the guard and the allowlist refuse, and the model is told why", async () => {
    await setPolicy("members");
    const agent = (await newAgent(member)).body.agent;
    const chatId = await newChat(member, agent.id);
    for (const [sql, guard] of [["SELECT * FROM secret.salaries", "NOT_ALLOWED_TABLE"], ["INSERT INTO analytics.orders VALUES (1)", null], ["SELECT * FROM url('http://169.254.169.254/', CSV)", null]] as const) {
      const { events } = await send(member, chatId, `tool:data__run_sql:${JSON.stringify({ sql })}`);
      const result = events.find((event) => event.type === "tool_result")!;
      expect(result.data.ok).toBe(false);
      const parsed = JSON.parse(result.data.resultPreview) as Json;
      expect(parsed.code).toBe("GUARD");
      if (guard) expect(parsed.guard).toBe(guard);
      expect(result.data.sqlResult).toBeUndefined();
    }
    expect(clickhouse.requests.some((request) => request.sql.includes("secret.salaries") || request.sql.includes("INSERT") || request.sql.includes("169.254"))).toBe(false);
  });

  test("policy off or a role it does not cover: the tools are absent, and a stale call is refused", async () => {
    await setPolicy("members");
    const agent = (await newAgent(member)).body.agent;
    const chatId = await newChat(member, agent.id);
    await setPolicy("off");
    const marker = runMarker();
    const { events } = await send(member, chatId, `tool:data__search_schema:${JSON.stringify({ query: marker })}`);
    expect(toolNamesOf(completions(marker)[0]!).some((name) => name.startsWith("data__"))).toBe(false);
    // With no tool offered at all, the call is never run.
    expect(events.some((event) => event.type === "tool_result" && event.data.ok)).toBe(false);
    expect(clickhouse.requests.some((request) => request.sql.includes(marker))).toBe(false);
    // A call offered before the policy changed is re-checked when it runs (T425).
    const stale = await runDataTool({ tool: "run_sql", sources: [{ id: datasourceId, name: "Warehouse", database: "analytics" }] }, { sql: "SELECT 1 FROM analytics.orders" },
      { userId: member.userId, agentId: agent.id, runId: crypto.randomUUID(), chatId: null, messageId: "m", callId: "c", signal: new AbortController().signal, queries: { count: 0 } });
    expect(JSON.parse(stale.text).code).toBe("DATASOURCE_UNAVAILABLE");
    // An admin's agent shared with everyone, the policy admins only: the admin gets the tools, the member none.
    await setPolicy("admins");
    const shared = (await newAgent(admin)).body.agent;
    db.query("UPDATE agents SET visibility = 'all_users' WHERE id = ?").run(shared.id);
    const memberMarker = runMarker();
    await send(member, await newChat(member, shared.id), `echo:${memberMarker}`);
    expect(toolNamesOf(completions(memberMarker)[0]!).some((name) => name.startsWith("data__"))).toBe(false);
    const adminMarker = runMarker();
    await send(admin, await newChat(admin, shared.id), `echo:${adminMarker}`);
    expect(toolNamesOf(completions(adminMarker)[0]!).filter((name) => name.startsWith("data__")).length).toBe(DATA_TOOL_NAMES.length);
    await setPolicy("off");
  });

  test("a reader of a shared chat who may not use the data source sees no rows or SQL (D595)", async () => {
    await setPolicy("admins");
    const agent = (await newAgent(admin)).body.agent;
    const chatId = await newChat(admin, agent.id);
    const { events } = await send(admin, chatId, `tool:data__run_sql:${JSON.stringify({ sql: "SELECT country, revenue FROM analytics.orders LIMIT 5" })}`);
    const ref = events.find((event) => event.type === "tool_result")!.data.sqlResult as Json;
    expect(ref).toBeDefined();
    db.query("UPDATE chats SET visibility = 'all_users' WHERE id = ?").run(chatId);
    db.query("UPDATE agents SET visibility = 'all_users' WHERE id = ?").run(agent.id);
    const hidden = await api(member, "GET", `/chats/${chatId}/sql-results/${ref.id}`);
    expect(hidden.status).toBe(403);
    expect(hidden.body.code).toBe("DATASOURCE_UNAVAILABLE");
    expect(JSON.stringify(hidden.body)).not.toContain("analytics.orders");
    await setPolicy("members");
    expect((await api(member, "GET", `/chats/${chatId}/sql-results/${ref.id}`)).status).toBe(200);
    // A public link never carries a data tool's arguments or summary, even with tool results included.
    const snapshot = snapshotOf(db.query("SELECT * FROM chats WHERE id = ?").get(chatId) as never, true);
    const calls = snapshot.messages.flatMap((message) => message.toolCalls);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect("args" in call || "result" in call).toBe(false);
    await setPolicy("off");
  });

  test("after data was read, a tool server's auto tool asks first (D596)", async () => {
    await setPolicy("members");
    expect((await api(admin, "POST", `/agents/admin/servers/${serverId}/sync`, {})).status).toBe(200);
    const agent = (await newAgent(member, [{ source: "datasource", datasourceId }, { source: "server", serverId, toolName: "echo", policy: null }])).body.agent;
    const chatId = await newChat(member, agent.id);
    const started = await api(member, "POST", `/chats/${chatId}/messages`, { content: `seq:data__run_sql:${JSON.stringify({ sql: "SELECT country, revenue FROM analytics.orders LIMIT 3" })}|agentsqltools__echo:{"text":"C1 revenue"}` });
    expect(started.status).toBe(201);
    const events = await readEvents(member, started.body.runId, (list) => list.some((event) => event.type === "confirmation_required" || event.type === "done"));
    const card = events.find((event) => event.type === "confirmation_required");
    expect(card?.data).toMatchObject({ tool: "echo", server: "agentsqltools", afterData: true });
    expect(mcp.calls.some((item) => item.method === "tools/call" && JSON.stringify(item).includes("C1 revenue"))).toBe(false);
    await api(member, "POST", `/runs/${started.body.runId}/confirm`, { confirmationId: card!.data.confirmationId, argsHash: card!.data.argsHash, decision: "deny" });
    await readEvents(member, started.body.runId);
    await setPolicy("off");
  });

  test("the per-person rate and the per-answer query cap", async () => {
    await setPolicy("members");
    resetDataToolRateForTests();
    const source = { id: datasourceId, name: "Warehouse", database: "analytics" };
    const context = (queries = { count: 0 }) => ({ userId: member.userId, agentId: "a", runId: crypto.randomUUID(), chatId: null, messageId: "m", callId: "c", signal: new AbortController().signal, queries });
    const outcomes = [];
    for (let index = 0; index < DATA_TOOL_BOUNDS.perMinute + 1; index += 1) outcomes.push(await runDataTool({ tool: "search_schema", sources: [source] }, { query: "orders" }, context()));
    expect(outcomes.slice(0, DATA_TOOL_BOUNDS.perMinute).every((outcome) => outcome.ok)).toBe(true);
    expect(JSON.parse(outcomes.at(-1)!.text).code).toBe("BUSY");
    resetDataToolRateForTests();
    const capped = await runDataTool({ tool: "run_sql", sources: [source] }, { sql: "SELECT 1 FROM analytics.orders" }, context({ count: DATA_TOOL_BOUNDS.queriesPerRun }));
    expect(JSON.parse(capped.text).code).toBe("LIMIT_REACHED");
    resetDataToolRateForTests();
    await setPolicy("off");
  });
});

describe("migration 073", () => {
  test("picks go with the data source and the agent; the column defaults to off", async () => {
    const second = await api(admin, "POST", "/reports/admin/datasources", { name: `Second ${crypto.randomUUID().slice(0, 6)}`, url: clickhouse.url, username: "nook_ro", database: "analytics", allowlist: ["analytics"], agentUse: "admins" });
    expect(second.status).toBe(201);
    const id = second.body.datasource.id as string;
    expect(db.query("SELECT agent_use FROM report_datasources WHERE id = ?").get(id)).toEqual({ agent_use: "admins" });
    const agent = (await newAgent(admin, [{ source: "datasource", datasourceId: id }])).body.agent;
    expect((db.query("SELECT COUNT(*) AS n FROM agent_datasources WHERE agent_id = ?").get(agent.id) as { n: number }).n).toBe(1);
    expect((await api(admin, "DELETE", `/reports/admin/datasources/${id}`, {})).status).toBe(200);
    expect((db.query("SELECT COUNT(*) AS n FROM agent_datasources WHERE agent_id = ?").get(agent.id) as { n: number }).n).toBe(0);
    expect(() => db.query("UPDATE report_datasources SET agent_use = 'guests' WHERE id = ?").run(datasourceId)).toThrow();
  });
});

describe("never over MCP, API keys, or REST (D597, T361)", () => {
  test("MCP lists no data tool, and an API or MCP run resolves none", async () => {
    const names = new Set(mcpToolSpecs.map((spec) => spec.name));
    for (const name of ["run_sql", "search_schema", "describe_tables", "sample_rows", "estimate", "run_schema_query"]) expect(names.has(name)).toBe(false);
    await setPolicy("members");
    const agent = (await newAgent(member)).body.agent;
    const row = db.query("SELECT * FROM agents WHERE id = ?").get(agent.id) as never;
    expect(resolveTools(row, { userId: member.userId, role: "member" }).filter((tool) => tool.kind === "datasource").length).toBe(DATA_TOOL_NAMES.length);
    for (const surface of ["mcp", "rest"] as const) expect(resolveTools(row, { userId: member.userId, role: "member" }, { nookKey: null, surface }).some((tool) => tool.kind === "datasource")).toBe(false);
    await setPolicy("off");
  });
});
