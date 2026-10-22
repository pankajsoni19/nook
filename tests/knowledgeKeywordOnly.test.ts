import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startScriptedProvider } from "../scripts/fakeReportProvider";
import { startFakeVoyage } from "../scripts/fakeVoyageProvider";
import { KEYWORD_ONLY_HINT, NO_EMBEDDINGS_PROVIDER } from "../shared/knowledge";

const { deleteProvider } = await import("../server/agents/providers");
const { readAgentSettings, writeAgentSettings } = await import("../server/agents/settings");
const { resetKnowledgeTimersForTests, sweepKnowledge, whenKnowledgeIdle } = await import("../server/knowledge/index");
const { kbRow } = await import("../server/knowledge/service");
const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { resolveTools } = await import("../server/agents/tools");
const { runKnowledgeTool, KEYWORD_SEARCH_ADVICE } = await import("../server/knowledge/tool");
type AgentRow = import("../server/agents/agentsService").AgentRow;

/**
 * Knowledge bases without embeddings (2026-10-22, lane CLAUDE; D541). With only Claude configured
 * (Anthropic has no embeddings API) a new base is keyword-only: it is chunked into the BM25 index and
 * never calls an embeddings API, search answers from keywords with no "not available" note (Try it,
 * MCP, and an agent's tool, whose description tells the model to search several ways), and the
 * base's page says how to get meaning-based search. Change embedding model moves it to an embedding
 * provider (Voyage AI here, sized by `output_dimension`) and back. Fake servers only.
 */

retireUsersAfterFile();

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const claude = startScriptedProvider(0, () => ({ content: "ok" }), { anthropic: {} });
const voyage = startFakeVoyage(0);
let admin: Session;
let owner: Session;
let claudeId: string;
let voyageId: string;
let kbId: string;
/** Other files' providers, made to look embeddings-less while this file runs ("only Claude"), then restored. */
const masked = new Map<string, string>();
const FAQ = "# Billing FAQ\n\n## How do refunds work for annual plans?\nAnnual plans are refunded pro rata for the unused months.\n\n## Can I pause my subscription?\nYes, you can pause for up to three months.";
const settle = async () => { await whenKnowledgeIdle(); await whenKnowledgeIdle(); };
const embeddingRequests = () => claude.requests.filter((item) => item.path.includes("embeddings")).length + voyage.calls.length;
const chunkVectors = (id: string) => db.query("SELECT length(embedding) AS bytes FROM kb_chunks WHERE kb_id = ? ORDER BY id").all(id).map((row) => (row as { bytes: number }).bytes);

beforeAll(async () => {
  admin = await createUser("Keyword admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("Keyword owner");
  for (const row of db.query("SELECT id, compat_json FROM agent_providers").all() as Array<{ id: string; compat_json: string }>) {
    masked.set(row.id, row.compat_json);
    db.query("UPDATE agent_providers SET compat_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.compat_json || "{}"), embeddings: false }), row.id);
  }
  const created = await send(admin, "POST", "/agents/admin/providers", { name: `Claude (keyword) ${crypto.randomUUID().slice(0, 6)}`, baseUrl: claude.baseUrl, apiKey: "sk-ant-test-keyword-0001", defaultModel: "claude-opus-5-5", compat: { flavor: "anthropic" } });
  expect(created.status).toBe(201);
  claudeId = created.body.provider.id;
  writeAgentSettings(admin.userId, { kbsPerUser: 50 }, readAgentSettings().revision);
});
beforeEach(() => { resetKnowledgeTimersForTests(); resetMcpLimits(); });
afterAll(async () => {
  await settle();
  writeAgentSettings(admin.userId, { kbsPerUser: 10 }, readAgentSettings().revision);
  for (const [id, compat] of masked) db.query("UPDATE agent_providers SET compat_json = ? WHERE id = ?").run(compat, id);
  for (const id of [claudeId, voyageId]) if (id && db.query("SELECT 1 FROM agent_providers WHERE id = ?").get(id)) deleteProvider(admin.userId, id);
  claude.stop();
  voyage.stop();
});

describe("only Claude configured", () => {
  test("New knowledge base offers no embedding provider; a new base is keyword-only", async () => {
    const options = await send(owner, "GET", "/knowledge/embedding-options");
    expect(options.status).toBe(200);
    expect(options.body).toEqual({ providers: [], defaultProviderId: null });
    const created = await send(owner, "POST", "/knowledge", { name: "Keyword FAQ", description: "Billing answers" });
    expect(created.status).toBe(201);
    kbId = created.body.knowledgeBase.id;
    expect(created.body.knowledgeBase).toMatchObject({ keywordOnly: true, embeddingModel: "", providerName: null, notice: null, changingModel: false });
    expect(kbRow(kbId)).toMatchObject({ provider_id: null, embedding_model: "" });
    // Choosing Claude on purpose is refused: it makes no embeddings.
    const refused = await send(owner, "POST", "/knowledge", { name: "Claude embeddings", providerId: claudeId });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("NO_EMBEDDINGS");
    expect(NO_EMBEDDINGS_PROVIDER).toContain("Voyage AI");
    expect(KEYWORD_ONLY_HINT).toBe("Keyword search: add an embeddings provider for meaning-based search.");
  });

  test("indexing chunks the source for keyword search and makes no embedding call", async () => {
    const before = embeddingRequests();
    claude.requests.length = 0;
    const added = await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "text", title: "FAQ", text: FAQ });
    expect(added.status).toBe(201);
    await settle();
    const detail = (await send(owner, "GET", `/knowledge/${kbId}`)).body.knowledgeBase;
    expect(detail).toMatchObject({ status: "ready", keywordOnly: true, notice: null });
    expect(detail.sources[0]).toMatchObject({ status: "ready", error: null });
    expect(detail.chunkCount).toBeGreaterThan(0);
    expect(chunkVectors(kbId).every((bytes) => bytes === 0)).toBe(true);
    expect(embeddingRequests()).toBe(before);
    expect(claude.requests).toEqual([]);
    // The hourly sweep leaves it alone (no "provider removed" error, nothing queued again).
    const swept = await sweepKnowledge();
    expect(swept.changed).toBe(0);
    expect((await send(owner, "GET", `/knowledge/${kbId}`)).body.knowledgeBase.sources[0].status).toBe("ready");
  });

  test("Try it answers from keywords with no failure note, and charges no tokens", async () => {
    const usage = () => (db.query("SELECT COALESCE(SUM(prompt_tokens), 0) AS tokens FROM agent_usage_daily WHERE agent_id = ?").get(`kb:${kbId}`) as { tokens: number }).tokens;
    const found = await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "refunds annual plans" });
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ mode: "keyword", keywordOnly: true });
    expect(found.body).not.toHaveProperty("notice");
    expect(found.body.hits[0].heading).toContain("refunds");
    expect(found.body.hits[0].ranks).toEqual({ vector: null, keyword: 1 });
    expect(usage()).toBe(0);
  });

  test("MCP search_knowledge on a keyword base: keyword mode, flagged as by design", async () => {
    const key = createApiKey(owner.userId, { name: "Keyword key", surfaces: "mcp", grants: [{ module: "agents", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const result = await invokeMcpToolForTests("search_knowledge", { query: "pause subscription", kb: kbId }, key.id);
    const value = JSON.parse(result.content[0]!.text) as Json;
    expect(result.isError).not.toBe(true);
    expect(value).toMatchObject({ mode: "keyword", keywordOnly: true, bases: 1 });
    expect(value).not.toHaveProperty("note");
    expect(value.results[0].text).toContain("pause");
  });

  test("an agent's knowledge tool tells the model to search several ways, and finds passages with no failure note", async () => {
    const agent = await send(owner, "POST", "/agents", { name: "Keyword bot", providerId: claudeId, tools: [{ source: "knowledge", kbId }] });
    expect(agent.status).toBe(201);
    const row = db.query("SELECT * FROM agents WHERE id = ?").get(agent.body.agent.id) as AgentRow;
    const tool = resolveTools(row, { userId: owner.userId, role: "member" }).find((item) => item.kind === "knowledge")!;
    expect(tool.description).toContain(`Search ${KEYWORD_SEARCH_ADVICE}.`);
    expect(tool.knowledge!.kbs).toEqual([{ id: kbId, name: "Keyword FAQ", description: "Billing answers", keywordOnly: true }]);
    const hit = await runKnowledgeTool(tool.knowledge!, { query: "refunds" }, { agent: { id: row.id, owner_id: row.owner_id }, runner: { userId: owner.userId }, runId: crypto.randomUUID() });
    const parsed = JSON.parse(hit.text) as Json;
    expect(hit.ok).toBe(true);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed).not.toHaveProperty("note");
    const miss = JSON.parse((await runKnowledgeTool(tool.knowledge!, { query: "zebra" }, { agent: { id: row.id, owner_id: row.owner_id }, runner: { userId: owner.userId }, runId: crypto.randomUUID() })).text) as Json;
    expect(miss).toEqual({ results: [], note: "No passage matched these words; this knowledge base matches words only, so try other phrasings or key terms." });
  });
});

describe("Change embedding model: keyword-only to an embedding provider and back", () => {
  test("an admin adds Voyage AI: it becomes the default for new bases and an option for this one", async () => {
    const created = await send(admin, "POST", "/agents/admin/providers", { name: `Voyage (keyword) ${crypto.randomUUID().slice(0, 6)}`, baseUrl: voyage.baseUrl, apiKey: "pa-test-keyword-0001", compat: { flavor: "voyage" } });
    expect(created.status).toBe(201);
    voyageId = created.body.provider.id;
    const options = await send(owner, "GET", "/knowledge/embedding-options");
    expect(options.body.defaultProviderId).toBe(voyageId);
    expect(options.body.providers.map((item: Json) => item.id)).toEqual([voyageId]);
    const own = await send(owner, "GET", `/knowledge/${kbId}/embedding-options`);
    expect(own.body.current).toEqual({ providerId: null, model: "", dims: 512, keywordOnly: true });
    // A size Voyage does not take is refused.
    const odd = await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: voyageId, model: "voyage-3.5", dims: 768 });
    expect(odd.status).toBe(400);
    expect(odd.body.code).toBe("DIMS_NOT_OFFERED");
    // The existing base was not touched by the provider being added.
    expect(kbRow(kbId)).toMatchObject({ provider_id: null, embedding_model: "" });
  });

  test("to Voyage AI: every source embedded with output_dimension and input_type; search is hybrid", async () => {
    voyage.calls.length = 0;
    const changed = await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: voyageId, model: "voyage-3.5", dims: 1024 });
    expect(changed.status).toBe(200);
    expect(changed.body.knowledgeBase).toMatchObject({ keywordOnly: false, embeddingModel: "voyage-3.5", dims: 1024 });
    await settle();
    expect(voyage.calls.length).toBeGreaterThan(0);
    for (const call of voyage.calls) expect(call.body).toMatchObject({ model: "voyage-3.5", output_dimension: 1024, input_type: "document" });
    for (const call of voyage.calls) expect(call.body).not.toHaveProperty("encoding_format");
    expect(chunkVectors(kbId).every((bytes) => bytes === 1024 * 4)).toBe(true);
    voyage.calls.length = 0;
    const found = await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "refunds annual plans" });
    expect(found.body.mode).toBe("hybrid");
    expect(found.body).not.toHaveProperty("keywordOnly");
    expect(voyage.calls[0]!.body).toMatchObject({ input: ["refunds annual plans"], output_dimension: 1024, input_type: "query" });
    const audited = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'knowledge.model_change' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { metadata_json: string };
    expect(JSON.parse(audited.metadata_json)).toMatchObject({ kbId, providerId: voyageId, model: "voyage-3.5", dims: 1024, fromKeywordOnly: true });
  });

  test("and back to keyword search: vectors dropped, chunks kept, no embedding call", async () => {
    voyage.calls.length = 0;
    const back = await send(owner, "POST", `/knowledge/${kbId}/model`, { keywordOnly: true });
    expect(back.status).toBe(200);
    expect(back.body.knowledgeBase).toMatchObject({ keywordOnly: true, embeddingModel: "", providerName: null });
    await settle();
    expect(voyage.calls).toEqual([]);
    expect(chunkVectors(kbId).length).toBeGreaterThan(0);
    expect(chunkVectors(kbId).every((bytes) => bytes === 0)).toBe(true);
    expect((await send(owner, "GET", `/knowledge/${kbId}`)).body.knowledgeBase).toMatchObject({ status: "ready", changingModel: false, notice: null });
    const again = await send(owner, "POST", `/knowledge/${kbId}/model`, { keywordOnly: true });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("UNCHANGED");
    // Removing a provider never fails a keyword-only base.
    deleteProvider(admin.userId, voyageId);
    voyageId = "";
    expect((await send(owner, "GET", `/knowledge/${kbId}`)).body.knowledgeBase.sources[0].status).toBe("ready");
  });

  test("keyword search can be picked on purpose while a provider embeds", async () => {
    const created = await send(admin, "POST", "/agents/admin/providers", { name: `Voyage again ${crypto.randomUUID().slice(0, 6)}`, baseUrl: voyage.baseUrl, apiKey: "pa-test-keyword-0002", compat: { flavor: "voyage" } });
    voyageId = created.body.provider.id;
    const chosen = await send(owner, "POST", "/knowledge", { name: "Keyword on purpose", keywordOnly: true });
    expect(chosen.body.knowledgeBase.keywordOnly).toBe(true);
    const defaulted = await send(owner, "POST", "/knowledge", { name: "Embedded by default" });
    expect(defaulted.body.knowledgeBase).toMatchObject({ keywordOnly: false, embeddingModel: "voyage-3.5", dims: 512 });
    const both = await send(owner, "POST", "/knowledge", { name: "Both", keywordOnly: true, providerId: voyageId });
    expect(both.status).toBe(400);
  });
});
