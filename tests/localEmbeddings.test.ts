import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { startScriptedProvider } from "../scripts/fakeReportProvider";
import { LOCAL_BASE_URL, LOCAL_MODEL } from "../shared/localEmbedding";
import { NO_EMBEDDINGS_PROVIDER } from "../shared/knowledge";
import { providerFlavor } from "../shared/agents";

const { config, parseLocalEmbeddings } = await import("../server/config");
const { connectionFor, deleteProvider, firstEmbeddingProvider, providerChoices, providerEmbeddingChoices } = await import("../server/agents/providers");
const { embedTexts } = await import("../server/knowledge/embed");
const { readAgentSettings, writeAgentSettings } = await import("../server/agents/settings");
const { resetKnowledgeTimersForTests, whenKnowledgeIdle } = await import("../server/knowledge/index");
const { kbRow } = await import("../server/knowledge/service");
const { LOCAL_EMBED_BOUNDS, localEmbed, localEmbedStats, localQueueForTests, resetLocalEmbedderForTests } = await import("../server/knowledge/local/embedder");
const { adapterFor } = await import("../server/agents/providerKinds");

/**
 * The embedding model built into Nook (2026-10-22, lane LOCALEMB; D544–D547), with the worker's stub
 * model (a hash embedding of the same size, no files): the "Local (built into Nook)" kind's rules
 * (embeddings only, no key, no address, at most one, never the default, its kind fixed), the
 * LOCAL_EMBEDDINGS switch, Test, deterministic unit vectors of 384 dimensions, the worker's bounds
 * (one text at a time, searches first, the batch and queue limits, the per-text timeout, the idle
 * stop), and knowledge bases on it: D541's default rule picks it when it is the only provider that
 * embeds, and Change embedding model moves bases to and from it (keyword-only ones too).
 * tests/localEmbeddingsModel.test.ts runs the real model (opt-in).
 */

retireUsersAfterFile();

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const claude = startScriptedProvider(0, () => ({ content: "ok" }), { anthropic: {} });
let admin: Session;
let owner: Session;
let claudeId = "";
let localId = "";
/** Other files' providers, made to look embeddings-less while this file runs ("only Claude"), then restored. */
const masked = new Map<string, string>();
const settle = async () => { await whenKnowledgeIdle(); await whenKnowledgeIdle(); };
/**
 * A promise's rejection message ("resolved" when it did not reject). Bun's `expect(promise).rejects`
 * does not let a worker thread's messages through while it waits, so these promises are awaited first.
 */
const rejection = (promise: Promise<unknown>) => promise.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));
const norm = (vector: Float32Array) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
const chunkVectors = (id: string) => db.query("SELECT length(embedding) AS bytes FROM kb_chunks WHERE kb_id = ? ORDER BY id").all(id).map((row) => (row as { bytes: number }).bytes);
const FAQ = "# Classes\n\n## When do morning classes start?\nMorning yoga classes start at seven every weekday.\n\n## How do I reset my password?\nOpen Settings, choose Security, and pick Reset password.";

beforeAll(async () => {
  config.localEmbeddings.stub = { delayMs: 0 };
  config.localEmbeddings.enabled = true;
  admin = await createUser("Local admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("Local owner");
  for (const row of db.query("SELECT id, compat_json FROM agent_providers").all() as Array<{ id: string; compat_json: string }>) {
    masked.set(row.id, row.compat_json);
    db.query("UPDATE agent_providers SET compat_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(row.compat_json || "{}"), embeddings: false }), row.id);
  }
  const created = await send(admin, "POST", "/agents/admin/providers", { name: `Claude (local) ${crypto.randomUUID().slice(0, 6)}`, baseUrl: claude.baseUrl, apiKey: "sk-ant-test-local-0001", defaultModel: "claude-opus-5-5", compat: { flavor: "anthropic" }, isDefault: true });
  expect(created.status).toBe(201);
  claudeId = created.body.provider.id;
  writeAgentSettings(admin.userId, { kbsPerUser: 50 }, readAgentSettings().revision);
});
beforeEach(() => { resetKnowledgeTimersForTests(); });
afterAll(async () => {
  await settle();
  writeAgentSettings(admin.userId, { kbsPerUser: 10 }, readAgentSettings().revision);
  for (const [id, compat] of masked) db.query("UPDATE agent_providers SET compat_json = ? WHERE id = ?").run(compat, id);
  for (const id of [claudeId, localId]) if (id && db.query("SELECT 1 FROM agent_providers WHERE id = ?").get(id)) deleteProvider(admin.userId, id);
  resetLocalEmbedderForTests();
  config.localEmbeddings.stub = null;
  config.localEmbeddings.enabled = true;
  claude.stop();
});

describe("the LOCAL_EMBEDDINGS switch (D544)", () => {
  test("on by default, off forbids it; the directory is absolute and outside DATA_DIR", () => {
    expect(parseLocalEmbeddings({}, "/data").enabled).toBe(true);
    expect(parseLocalEmbeddings({ LOCAL_EMBEDDINGS: "OFF" }, "/data").enabled).toBe(false);
    expect(parseLocalEmbeddings({ LOCAL_EMBEDDINGS_DIR: "/opt/models/e5" }, "/data").dir).toBe("/opt/models/e5");
    expect(() => parseLocalEmbeddings({ LOCAL_EMBEDDINGS: "maybe" }, "/data")).toThrow("LOCAL_EMBEDDINGS must be on or off");
    expect(() => parseLocalEmbeddings({ LOCAL_EMBEDDINGS_DIR: "models" }, "/data")).toThrow("absolute");
    expect(() => parseLocalEmbeddings({ LOCAL_EMBEDDINGS_DIR: "/data/models" }, "/data")).toThrow("outside DATA_DIR");
  });

  test("off: Settings → AI says so, and no local provider can be added", async () => {
    config.localEmbeddings.enabled = false;
    try {
      const listed = await send(admin, "GET", "/agents/admin/providers");
      expect(listed.body.local).toMatchObject({ allowed: false, available: false, added: false, model: LOCAL_MODEL.id, dims: 384 });
      expect(listed.body.local.reason).toContain("LOCAL_EMBEDDINGS=off");
      const refused = await send(admin, "POST", "/agents/admin/providers", { name: "Local", baseUrl: LOCAL_BASE_URL });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("LOCAL_EMBEDDINGS_OFF");
      expect(await rejection(localEmbed(["hello"], "query"))).toContain("turned off on this server");
    } finally {
      config.localEmbeddings.enabled = true;
    }
  });
});

describe("the Local (built into Nook) provider kind (D544)", () => {
  test("added with no key and no address: embeddings only, the model's own size, never fetched", async () => {
    const listed = await send(admin, "GET", "/agents/admin/providers");
    expect(listed.body.local).toMatchObject({ allowed: true, available: true, added: false, reason: null });
    const created = await send(admin, "POST", "/agents/admin/providers", { name: "Local embeddings", baseUrl: LOCAL_BASE_URL, apiKey: "sk-ignored-0001" });
    expect(created.status).toBe(201);
    localId = created.body.provider.id;
    expect(created.body.provider).toMatchObject({ baseUrl: LOCAL_BASE_URL, hasSecret: false, hint: null, isDefault: false, defaultModel: LOCAL_MODEL.id, embeddingModel: LOCAL_MODEL.id, embeddingDims: 384 });
    expect(created.body.provider.compat).toMatchObject({ chat: false });
    expect(created.body.provider.compat).not.toHaveProperty("embeddings");
    expect(providerFlavor(LOCAL_BASE_URL)).toBe("local");
    expect(providerFlavor("https://example.com/v1", { flavor: "local" })).toBeNull();
    expect((await send(admin, "GET", "/agents/admin/providers")).body.local.added).toBe(true);
    expect(connectionFor(localId, null, "embeddings")).toMatchObject({ baseUrl: LOCAL_BASE_URL, apiKey: null, flavor: "local" });
  });

  test("at most one; it is never the default or a chat model; its kind and capabilities are fixed", async () => {
    const again = await send(admin, "POST", "/agents/admin/providers", { name: "Local again", baseUrl: "local://elsewhere" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("PROVIDER_EXISTS");
    const revision = (await send(admin, "GET", `/agents/admin/providers/${localId}`)).body.provider.revision;
    const asDefault = await send(admin, "PATCH", `/agents/admin/providers/${localId}`, { isDefault: true, expectedRevision: revision });
    expect(asDefault.status).toBe(409);
    expect(asDefault.body.code).toBe("CHAT_NONE");
    const moved = await send(admin, "PATCH", `/agents/admin/providers/${localId}`, { baseUrl: claude.baseUrl, expectedRevision: revision });
    expect(moved.status).toBe(400);
    expect(moved.body.code).toBe("KIND_FIXED");
    const claudeRevision = (await send(admin, "GET", `/agents/admin/providers/${claudeId}`)).body.provider.revision;
    const intoLocal = await send(admin, "PATCH", `/agents/admin/providers/${claudeId}`, { baseUrl: LOCAL_BASE_URL, expectedRevision: claudeRevision });
    expect(intoLocal.status).toBe(400);
    expect(intoLocal.body.code).toBe("KIND_FIXED");
    const chatty = await send(admin, "PATCH", `/agents/admin/providers/${localId}`, { name: "Local (built into Nook)", compat: { chat: true }, apiKey: "sk-still-ignored", expectedRevision: revision });
    expect(chatty.status).toBe(200);
    expect(chatty.body.provider).toMatchObject({ name: "Local (built into Nook)", hasSecret: false, compat: { chat: false } });
    expect(providerChoices().map((choice) => choice.id)).not.toContain(localId);
    const tools = await send(admin, "POST", `/agents/admin/providers/${localId}/test-tools`);
    expect(tools.status).toBe(409);
    expect(tools.body.code).toBe("CHAT_NONE");
    const models = await send(admin, "GET", `/agents/admin/providers/${localId}/models`);
    expect(models.status).toBe(200);
    expect(models.body.models).toEqual([]);
    // A chat run that names it goes to the default instead.
    expect(connectionFor(localId, null).id).toBe(claudeId);
  });

  test("Test embeds one sentence and reports its size and time", async () => {
    const tested = await send(admin, "POST", `/agents/admin/providers/${localId}/test`);
    expect(tested.status).toBe(200);
    expect(tested.body.test).toMatchObject({ ok: true, models: { ok: true, skipped: true }, completion: { skipped: true }, embeddings: { ok: true, model: LOCAL_MODEL.id, dims: 384, error: null } });
    expect(typeof tested.body.test.embeddings.latencyMs).toBe("number");
    config.localEmbeddings.enabled = false;
    try {
      const off = await send(admin, "POST", `/agents/admin/providers/${localId}/test`);
      expect(off.body.test).toMatchObject({ ok: false, embeddings: { ok: false } });
      expect(off.body.test.embeddings.error).toContain("LOCAL_EMBEDDINGS=off");
    } finally {
      config.localEmbeddings.enabled = true;
    }
  });

  test("vectors are deterministic, unit length, and 384 wide; queries and passages are prefixed apart", async () => {
    const connection = connectionFor(localId, null, "embeddings");
    const first = await embedTexts(connection, LOCAL_MODEL.id, null, ["Morning classes start at seven.", "Reset your password in Settings."], { inputType: "document" });
    const again = await embedTexts(connection, LOCAL_MODEL.id, null, ["Morning classes start at seven.", "Reset your password in Settings."], { inputType: "document" });
    expect(first.vectors.length).toBe(2);
    for (const vector of first.vectors) {
      expect(vector.length).toBe(384);
      expect(Math.abs(norm(vector) - 1)).toBeLessThan(1e-5);
    }
    expect(Array.from(again.vectors[0]!)).toEqual(Array.from(first.vectors[0]!));
    expect(first.tokens).toBe(0);
    const query = await embedTexts(connection, LOCAL_MODEL.id, null, ["Morning classes start at seven."], { inputType: "query" });
    expect(Array.from(query.vectors[0]!)).not.toEqual(Array.from(first.vectors[0]!));
    expect(await rejection(embedTexts(connection, "text-embedding-3-small", null, ["x"]))).toContain("has only multilingual-e5-small");
    expect(await rejection(embedTexts(connection, LOCAL_MODEL.id, 512, ["x"]))).toContain("384 dimensions; this knowledge base uses 512");
    expect(adapterFor("local").takesDimensions(LOCAL_MODEL.id, {})).toBe(false);
  });
});

describe("the worker's bounds (D546)", () => {
  test("one worker, one text at a time; a batch over 8 and a full queue are refused at once", async () => {
    resetLocalEmbedderForTests();
    config.localEmbeddings.stub = { delayMs: 20 };
    try {
      expect(await rejection(localEmbed(Array.from({ length: LOCAL_EMBED_BOUNDS.batch + 1 }, (_, index) => `text ${index}`), "document"))).toContain(`At most ${LOCAL_EMBED_BOUNDS.batch} texts`);
      const queue = LOCAL_EMBED_BOUNDS.queue;
      LOCAL_EMBED_BOUNDS.queue = 4;
      try {
        // Four texts: one runs, three wait; two more would make five waiting.
        const running = localEmbed(["a", "b", "c", "d"], "document");
        expect(await rejection(localEmbed(["e", "f"], "query"))).toContain("busy");
        await running;
        expect(localEmbedStats.maxQueued).toBeLessThanOrEqual(4);
      } finally {
        LOCAL_EMBED_BOUNDS.queue = queue;
      }
      await localEmbed(["e", "f"], "document");
      expect(localEmbedStats.started).toBe(1);
      expect(localEmbedStats.embedded).toBe(6);
    } finally {
      config.localEmbeddings.stub = { delayMs: 0 };
    }
  });

  test("a search waits only for the text in progress, never behind the indexing queue", async () => {
    resetLocalEmbedderForTests();
    config.localEmbeddings.stub = { delayMs: 30 };
    try {
      const finished: string[] = [];
      const indexing = localEmbed(["d1", "d2", "d3", "d4", "d5"], "document").then(() => finished.push("documents"));
      await Bun.sleep(10);
      const search = localEmbed(["where is the studio"], "query").then(() => finished.push("query"));
      await Promise.all([indexing, search]);
      expect(finished).toEqual(["query", "documents"]);
    } finally {
      config.localEmbeddings.stub = { delayMs: 0 };
    }
  });

  test("a text past its time stops the worker; the next text starts a fresh one; an idle worker is let go", async () => {
    resetLocalEmbedderForTests();
    const jobMs = LOCAL_EMBED_BOUNDS.jobMs;
    const idleMs = LOCAL_EMBED_BOUNDS.idleMs;
    config.localEmbeddings.stub = { delayMs: 400 };
    LOCAL_EMBED_BOUNDS.jobMs = 100;
    try {
      expect(await rejection(localEmbed(["slow"], "document"))).toContain("took longer than");
      expect(localQueueForTests()).toMatchObject({ running: false, worker: false });
      config.localEmbeddings.stub = { delayMs: 0 };
      LOCAL_EMBED_BOUNDS.jobMs = jobMs;
      LOCAL_EMBED_BOUNDS.idleMs = 50;
      const done = await localEmbed(["quick"], "document");
      expect(done.vectors[0]!.length).toBe(384);
      expect(localEmbedStats.started).toBe(2);
      await Bun.sleep(150);
      expect(localQueueForTests().worker).toBe(false);
    } finally {
      LOCAL_EMBED_BOUNDS.jobMs = jobMs;
      LOCAL_EMBED_BOUNDS.idleMs = idleMs;
      config.localEmbeddings.stub = { delayMs: 0 };
    }
  });

  test("a stopped search is taken out of the queue", async () => {
    resetLocalEmbedderForTests();
    config.localEmbeddings.stub = { delayMs: 40 };
    try {
      const busy = localEmbed(["one", "two"], "document");
      const controller = new AbortController();
      const search = localEmbed(["never"], "query", controller.signal);
      controller.abort();
      expect(await rejection(search)).toContain("Stopped");
      await busy;
      expect(localEmbedStats.embedded).toBe(2);
    } finally {
      config.localEmbeddings.stub = { delayMs: 0 };
    }
  });
});

describe("knowledge bases on the local model (D541, D547)", () => {
  let kbId = "";
  let keywordKbId = "";

  test("the only provider that embeds is the default for a new base, which is indexed and searched locally", async () => {
    expect(firstEmbeddingProvider()?.id).toBe(localId);
    const options = await send(owner, "GET", "/knowledge/embedding-options");
    expect(options.body.defaultProviderId).toBe(localId);
    expect(options.body.providers).toEqual([expect.objectContaining({ id: localId, embeddingModel: LOCAL_MODEL.id, embeddingDims: 384, models: [LOCAL_MODEL.id], anyModel: false, flavor: "local" })]);
    expect(providerEmbeddingChoices().find((choice) => choice.id === localId)).not.toHaveProperty("sizes");
    expect(NO_EMBEDDINGS_PROVIDER).toContain("Local embeddings");
    const created = await send(owner, "POST", "/knowledge", { name: "Studio FAQ" });
    expect(created.status).toBe(201);
    kbId = created.body.knowledgeBase.id;
    expect(kbRow(kbId)).toMatchObject({ provider_id: localId, embedding_model: LOCAL_MODEL.id, dims: 384 });
    const embeddedBefore = localEmbedStats.embedded;
    expect((await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "text", title: "FAQ", text: FAQ })).status).toBe(201);
    await settle();
    const detail = (await send(owner, "GET", `/knowledge/${kbId}`)).body.knowledgeBase;
    expect(detail).toMatchObject({ status: "ready", keywordOnly: false, embeddingModel: LOCAL_MODEL.id, dims: 384 });
    expect(chunkVectors(kbId).every((bytes) => bytes === 384 * 4)).toBe(true);
    expect(localEmbedStats.embedded).toBeGreaterThan(embeddedBefore);
    const found = await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "password reset" });
    expect(found.status).toBe(200);
    expect(found.body.mode).toBe("hybrid");
    expect(found.body.hits[0].ranks.vector).not.toBeNull();
    // No provider tokens: nothing is charged to the owner's budget.
    const used = db.query("SELECT COALESCE(SUM(prompt_tokens), 0) AS tokens FROM agent_usage_daily WHERE user_id = ?").get(owner.userId) as { tokens: number };
    expect(used.tokens).toBe(0);
    expect(claude.requests.filter((item) => item.path.includes("embeddings"))).toEqual([]);
  });

  test("Change embedding model: keyword-only to local, local to keyword-only, and only its own model", async () => {
    const keyword = await send(owner, "POST", "/knowledge", { name: "Words only", keywordOnly: true });
    keywordKbId = keyword.body.knowledgeBase.id;
    expect((await send(owner, "POST", `/knowledge/${keywordKbId}/sources`, { kind: "text", title: "FAQ", text: FAQ })).status).toBe(201);
    await settle();
    expect(chunkVectors(keywordKbId).every((bytes) => bytes === 0)).toBe(true);
    const wrong = await send(owner, "POST", `/knowledge/${keywordKbId}/model`, { providerId: localId, model: "text-embedding-3-small" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("MODEL_NOT_OFFERED");
    const moved = await send(owner, "POST", `/knowledge/${keywordKbId}/model`, { providerId: localId, model: LOCAL_MODEL.id });
    expect(moved.status).toBe(200);
    expect(moved.body.knowledgeBase).toMatchObject({ keywordOnly: false, embeddingModel: LOCAL_MODEL.id, dims: 384 });
    await settle();
    expect(chunkVectors(keywordKbId).every((bytes) => bytes === 384 * 4)).toBe(true);
    resetKnowledgeTimersForTests();
    const back = await send(owner, "POST", `/knowledge/${kbId}/model`, { keywordOnly: true });
    expect(back.status).toBe(200);
    expect(back.body.knowledgeBase).toMatchObject({ keywordOnly: true, embeddingModel: "" });
    await settle();
    expect(chunkVectors(kbId).every((bytes) => bytes === 0)).toBe(true);
    resetKnowledgeTimersForTests();
    const forth = await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: localId, model: LOCAL_MODEL.id });
    expect(forth.status).toBe(200);
    await settle();
    expect(kbRow(kbId)).toMatchObject({ provider_id: localId, embedding_model: LOCAL_MODEL.id, dims: 384 });
    expect(chunkVectors(kbId).every((bytes) => bytes === 384 * 4)).toBe(true);
  });

  test("turned off on the server: its bases fail closed to keyword search, with the reason on the source", async () => {
    config.localEmbeddings.enabled = false;
    try {
      const found = await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "morning classes" });
      expect(found.status).toBe(200);
      expect(found.body.mode).toBe("keyword");
      const reindexed = await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "text", title: "More", text: "# Studio\n\nThe studio opens at six on Saturdays." });
      expect(reindexed.status).toBe(201);
      await settle();
      const detail = (await send(owner, "GET", `/knowledge/${kbId}`)).body.knowledgeBase;
      const added = detail.sources.find((source: Json) => source.title === "More");
      expect(added.status).toBe("error");
      expect(added.error).toContain("LOCAL_EMBEDDINGS=off");
    } finally {
      config.localEmbeddings.enabled = true;
    }
  });
});
