import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeProvider } from "./support/fakeProvider";
import { retireUsersAfterFile } from "./support/retireUsers";

const { deleteProvider, parseKnowledgePolicy } = await import("../server/agents/providers");
const { readAgentSettings, writeAgentSettings } = await import("../server/agents/settings");
const { resetKnowledgeTimersForTests, whenKnowledgeIdle } = await import("../server/knowledge/index");
const { kbRow } = await import("../server/knowledge/service");

/**
 * The admin's knowledge policy per provider (2026-10-08, v0.33.0 review LOW-5): saved on the
 * provider row and audited, admin-only; Change embedding model's options filtered and its POST
 * refused off the policy (400 MODEL_NOT_ALLOWED / DIMS_TOO_LARGE / PROVIDER_NOT_ALLOWED); a new base
 * adjusted into a restrictive default provider's policy (or refused when the provider is not allowed);
 * a model's own size over the limit stops at its first answer; bases over a newer limit grandfathered.
 */

retireUsersAfterFile();
const fakeP = startFakeProvider(0, { models: ["gpt-6-luna", "text-embedding-3-small", "text-embedding-3-large", "nomic-embed-text"] });
const fakeQ = startFakeProvider(0, { nativeDims: 1536 });
let admin: Session;
let owner: Session;
let member: Session;
let pId: string;
let qId: string;
let formerDefault: string | null = null;

type Reply = { status: number; body: Record<string, any> };
async function send(session: Session, method: string, path: string, body?: unknown): Promise<Reply> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}
const settle = async () => { await whenKnowledgeIdle(); await whenKnowledgeIdle(); };
const revisionOf = (id: string) => (db.query("SELECT revision FROM agent_providers WHERE id = ?").get(id) as { revision: number }).revision;
const setPolicy = (session: Session, id: string, knowledge: Record<string, unknown>) => send(session, "PATCH", `/agents/admin/providers/${id}`, { knowledge, expectedRevision: revisionOf(id) });
const resetPolicy = async (id: string) => expect((await setPolicy(admin, id, { enabled: true, models: null, maxDims: null })).status).toBe(200);
const makeDefault = (id: string) => { db.query("UPDATE agent_providers SET is_default = 0").run(); db.query("UPDATE agent_providers SET is_default = 1 WHERE id = ?").run(id); };
const newBase = async (name: string) => {
  const created = await send(owner, "POST", "/knowledge", { name });
  expect(created.status).toBe(201);
  return created.body.knowledgeBase.id as string;
};
const addText = async (kbId: string, title: string, text: string) => {
  const added = await send(owner, "POST", `/knowledge/${kbId}/sources`, { kind: "text", title, text });
  expect(added.status).toBe(201);
  return added.body.source.id as string;
};
const sourceRow = (id: string) => db.query("SELECT status, error FROM kb_sources WHERE id = ?").get(id) as { status: string; error: string | null };
const embeddingCalls = (provider: typeof fakeP) => provider.calls.filter((call) => call.path === "/v1/embeddings").length;
const FAQ = "# Support\n\n## How do refunds work?\nRefunds are pro rata and arrive within five days.\n\n## Where is the office?\nThe office is on the third floor beside the library.";
/** Long enough for several embedding requests: at a model's own size a batch holds 10 inputs. */
const LONG = Array.from({ length: 30 }, (_, index) => `## Section ${index + 1}\n\n${`Paragraph ${index + 1} about refunds, offices, and holidays. `.repeat(70)}`).join("\n\n");

beforeAll(async () => {
  admin = await createUser("KBCAP admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("KBCAP owner");
  member = await createUser("KBCAP member");
  formerDefault = (db.query("SELECT id FROM agent_providers WHERE is_default = 1").get() as { id: string } | null)?.id ?? null;
  const p = await send(admin, "POST", "/agents/admin/providers", { name: "Fake P (model cap)", baseUrl: fakeP.baseUrl, apiKey: "sk-test-fake-key-kbcap-p", defaultModel: "gpt-6-luna", embeddingModel: "text-embedding-3-small", embeddingDims: 1024 });
  expect(p.status).toBe(201);
  pId = p.body.provider.id;
  const q = await send(admin, "POST", "/agents/admin/providers", { name: "Fake Q (model cap)", baseUrl: fakeQ.baseUrl, apiKey: "sk-test-fake-key-kbcap-q", defaultModel: "gpt-6-luna" });
  expect(q.status).toBe(201);
  qId = q.body.provider.id;
  makeDefault(pId);
  writeAgentSettings(admin.userId, { kbsPerUser: 50 }, readAgentSettings().revision);
});
beforeEach(() => resetKnowledgeTimersForTests());
afterAll(async () => {
  await settle();
  writeAgentSettings(admin.userId, { kbsPerUser: 10 }, readAgentSettings().revision);
  resetKnowledgeTimersForTests();
  if (formerDefault && db.query("SELECT 1 FROM agent_providers WHERE id = ?").get(formerDefault)) makeDefault(formerDefault);
  for (const id of (db.query("SELECT id FROM agent_providers WHERE name LIKE 'Fake%(model cap)'").all() as Array<{ id: string }>).map((row) => row.id)) deleteProvider(admin.userId, id);
  fakeP.stop();
  fakeQ.stop();
});

describe("the policy", () => {
  test("admins save it on the provider row (no migration) and it is audited; the default is stored as nothing", async () => {
    const saved = await setPolicy(admin, pId, { models: ["text-embedding-3-small", "text-embedding-3-large"], maxDims: 768 });
    expect(saved.status).toBe(200);
    expect(saved.body.provider.knowledge).toEqual({ enabled: true, models: ["text-embedding-3-small", "text-embedding-3-large"], maxDims: 768 });
    const row = db.query("SELECT compat_json FROM agent_providers WHERE id = ?").get(pId) as { compat_json: string };
    expect(JSON.parse(row.compat_json).knowledge).toEqual({ enabled: true, models: ["text-embedding-3-small", "text-embedding-3-large"], maxDims: 768 });
    // The compatibility options are untouched.
    expect(saved.body.provider.compat.tokenParam).toBe("max_completion_tokens");
    const audit = db.query("SELECT actor_id, metadata_json FROM audit_log WHERE event_type = 'agents.provider.update' ORDER BY rowid DESC LIMIT 1").get() as { actor_id: string; metadata_json: string };
    expect(audit.actor_id).toBe(admin.userId);
    const metadata = JSON.parse(audit.metadata_json);
    expect(metadata).toMatchObject({ providerId: pId, knowledgePolicy: { enabled: true, models: ["text-embedding-3-small", "text-embedding-3-large"], maxDims: 768 } });
    expect(audit.metadata_json).not.toContain(fakeP.baseUrl);
    expect(audit.metadata_json).not.toContain("sk-test");
    // A patch without `knowledge` keeps it; a change of other fields records no policy.
    const renamed = await send(admin, "PATCH", `/agents/admin/providers/${pId}`, { name: "Fake P (model cap)", expectedRevision: revisionOf(pId) });
    expect(renamed.body.provider.knowledge.maxDims).toBe(768);
    const second = JSON.parse((db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'agents.provider.update' ORDER BY rowid DESC LIMIT 1").get() as { metadata_json: string }).metadata_json);
    expect(second.knowledgePolicy).toBeUndefined();
    // A partial patch merges.
    expect((await setPolicy(admin, pId, { maxDims: null })).body.provider.knowledge).toEqual({ enabled: true, models: ["text-embedding-3-small", "text-embedding-3-large"], maxDims: null });
    await resetPolicy(pId);
    expect(JSON.parse((db.query("SELECT compat_json FROM agent_providers WHERE id = ?").get(pId) as { compat_json: string }).compat_json).knowledge).toBeUndefined();
  });

  test("bad policies are 400s; malformed stored JSON reads as the default", async () => {
    expect((await setPolicy(admin, pId, { models: [] })).status).toBe(400);
    expect((await setPolicy(admin, pId, { models: ["a b"] })).status).toBe(400);
    expect((await setPolicy(admin, pId, { models: ["x", "x"] })).status).toBe(400);
    expect((await setPolicy(admin, pId, { models: Array.from({ length: 21 }, (_, index) => `m-${index}`) })).status).toBe(400);
    expect((await setPolicy(admin, pId, { maxDims: 32 })).status).toBe(400);
    expect((await setPolicy(admin, pId, { maxDims: 4096 })).status).toBe(400);
    expect((await setPolicy(admin, pId, { maxDims: 512.5 })).status).toBe(400);
    expect((await setPolicy(admin, pId, { other: true })).status).toBe(400);
    expect(parseKnowledgePolicy("{\"knowledge\": {\"models\": \"x\", \"maxDims\": 9999, \"enabled\": \"no\"}}")).toEqual({ enabled: true, models: null, maxDims: null });
    expect(parseKnowledgePolicy("not json")).toEqual({ enabled: true, models: null, maxDims: null });
  });

  test("only admins set it; non-admins never see URLs or keys", async () => {
    // Admin routes answer non-admins as missing (404), as every /api/agents/admin route does.
    const refused = await setPolicy(member, pId, { maxDims: 256 });
    expect(refused.status).toBe(404);
    expect((await send(owner, "GET", `/agents/admin/providers/${pId}`)).status).toBe(404);
    expect(parseKnowledgePolicy((db.query("SELECT compat_json FROM agent_providers WHERE id = ?").get(pId) as { compat_json: string }).compat_json).maxDims).toBeNull();
    const kbId = await newBase("Options privacy");
    const options = await send(owner, "GET", `/knowledge/${kbId}/embedding-options`);
    expect(options.status).toBe(200);
    const text = JSON.stringify(options.body);
    expect(text).not.toContain(fakeP.baseUrl);
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("sk-test");
    expect(text).not.toContain("hint");
  });
});

describe("enforcement", () => {
  test("embedding-options lists only allowed providers, their allowed models, and the size limit", async () => {
    const kbId = await newBase("Options");
    expect((await setPolicy(admin, pId, { models: ["text-embedding-3-large"], maxDims: 768 })).status).toBe(200);
    expect((await setPolicy(admin, qId, { enabled: false })).status).toBe(200);
    const options = await send(owner, "GET", `/knowledge/${kbId}/embedding-options`);
    const ours = options.body.providers.filter((provider: { name: string }) => provider.name.endsWith("(model cap)"));
    expect(ours.map((provider: { id: string }) => provider.id)).toEqual([pId]);
    // The provider's own default (text-embedding-3-small, 1024) moved inside the policy.
    expect(ours[0]).toMatchObject({ anyModel: false, models: ["text-embedding-3-large"], maxDims: 768, embeddingModel: "text-embedding-3-large", embeddingDims: 768 });
    await resetPolicy(pId);
    await resetPolicy(qId);
    const open = (await send(owner, "GET", `/knowledge/${kbId}/embedding-options`)).body.providers.filter((provider: { name: string }) => provider.name.endsWith("(model cap)"));
    expect(open.map((provider: { id: string }) => provider.id).sort()).toEqual([pId, qId].sort());
    expect(open.find((provider: { id: string }) => provider.id === pId)).toMatchObject({ anyModel: true, maxDims: 3072, embeddingModel: "text-embedding-3-small", embeddingDims: 1024 });
  });

  test("POST …/model refuses a model off the list, a size over the limit, and a provider not allowed (400, nothing changes)", async () => {
    const kbId = await newBase("Refusals");
    const before = kbRow(kbId)!;
    expect((await setPolicy(admin, pId, { models: ["text-embedding-3-large"], maxDims: 768 })).status).toBe(200);
    expect((await setPolicy(admin, qId, { enabled: false })).status).toBe(200);
    const model = await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: pId, model: "text-embedding-3-small", dims: 512 });
    expect(model.status).toBe(400);
    expect(model.body).toMatchObject({ code: "MODEL_NOT_ALLOWED", field: "model", allowed: ["text-embedding-3-large"] });
    const dims = await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: pId, model: "text-embedding-3-large", dims: 1024 });
    expect(dims.status).toBe(400);
    expect(dims.body).toMatchObject({ code: "DIMS_TOO_LARGE", field: "dims", maxDims: 768 });
    expect(dims.body.error).toContain("768");
    const provider = await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: qId, model: "nomic-embed-text" });
    expect(provider.status).toBe(400);
    expect(provider.body.code).toBe("PROVIDER_NOT_ALLOWED");
    expect(kbRow(kbId)).toMatchObject({ provider_id: before.provider_id, embedding_model: before.embedding_model, dims: before.dims });
    // Inside the policy it goes through; with no size given the provider's default is capped.
    const ok = await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: pId, model: "text-embedding-3-large" });
    expect(ok.status).toBe(200);
    expect(kbRow(kbId)).toMatchObject({ embedding_model: "text-embedding-3-large", dims: 768 });
    await settle();
    await resetPolicy(pId);
    await resetPolicy(qId);
  });

  test("a new base under a restrictive default: the first allowed model and the largest allowed size; refused when the provider is not allowed", async () => {
    expect((await setPolicy(admin, pId, { models: ["text-embedding-3-large", "text-embedding-3-small"], maxDims: 256 })).status).toBe(200);
    const kbId = await newBase("Adjusted");
    // text-embedding-3-small is allowed (the provider's own default), at most 256.
    expect(kbRow(kbId)).toMatchObject({ provider_id: pId, embedding_model: "text-embedding-3-small", dims: 256 });
    expect((await setPolicy(admin, pId, { models: ["text-embedding-3-large"] })).status).toBe(200);
    const second = await newBase("Adjusted model");
    expect(kbRow(second)).toMatchObject({ embedding_model: "text-embedding-3-large", dims: 256 });
    // Indexed at the capped size.
    await addText(second, "FAQ", FAQ);
    await settle();
    const sent = fakeP.calls.filter((call) => call.path === "/v1/embeddings").at(-1)!.body as { model: string; dimensions: number };
    expect(sent).toMatchObject({ model: "text-embedding-3-large", dimensions: 256 });
    expect((await setPolicy(admin, pId, { enabled: false })).status).toBe(200);
    const refused = await send(owner, "POST", "/knowledge", { name: "Refused" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("PROVIDER_NOT_ALLOWED");
    expect(refused.body.error).toContain("Settings → AI");
    await resetPolicy(pId);
  });

  test("a model whose own size is over the limit: the sources go to error at the first answer, and no further batch is sent", async () => {
    makeDefault(qId);
    try {
      const kbId = await newBase("Native over");
      await settle();
      expect((await setPolicy(admin, qId, { maxDims: 1024 })).status).toBe(200);
      // One long source (several batches at the model's own size) and a short one behind it, indexed first at 512.
      const first = await addText(kbId, "Long", LONG);
      const second = await addText(kbId, "Short", FAQ);
      await settle();
      expect(sourceRow(first).status).toBe("ready");
      const before = embeddingCalls(fakeQ);
      expect((await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: qId, model: "nomic-embed-text" })).status).toBe(200);
      await settle();
      expect(embeddingCalls(fakeQ) - before).toBe(1);
      for (const id of [first, second]) {
        expect(sourceRow(id).status).toBe("error");
        expect(sourceRow(id).error).toContain("1,536 dimensions");
        expect(sourceRow(id).error).toContain("at most 1,024");
      }
      expect(db.query("SELECT COUNT(*) AS count FROM kb_chunks WHERE kb_id = ? AND length(embedding) > 0").get(kbId)).toEqual({ count: 0 });
      expect(kbRow(kbId)!.dims).toBeLessThanOrEqual(1024);
    } finally {
      await resetPolicy(qId);
      makeDefault(pId);
    }
  });

  test("a base over a newer limit is grandfathered: it keeps searching and indexing, says so, and Change embedding model offers only allowed choices", async () => {
    const kbId = await newBase("Grandfathered");
    await addText(kbId, "FAQ", FAQ);
    await settle();
    expect(kbRow(kbId)).toMatchObject({ embedding_model: "text-embedding-3-small", dims: 1024 });
    const vectors = db.query("SELECT COUNT(*) AS count FROM kb_chunks WHERE kb_id = ? AND length(embedding) = ?").get(kbId, 1024 * 4) as { count: number };
    expect(vectors.count).toBeGreaterThan(0);
    expect((await setPolicy(admin, pId, { models: ["text-embedding-3-large"], maxDims: 512 })).status).toBe(200);
    const calls = embeddingCalls(fakeP);
    await settle();
    // Nothing is embedded again by the policy change.
    expect(embeddingCalls(fakeP)).toBe(calls);
    const detail = await send(owner, "GET", `/knowledge/${kbId}`);
    expect(detail.body.knowledgeBase.notice).toContain("other embedding models");
    expect((await setPolicy(admin, pId, { models: null })).status).toBe(200);
    const notice = (await send(owner, "GET", `/knowledge/${kbId}`)).body.knowledgeBase.notice as string;
    expect(notice).toContain("1,024 dimensions");
    expect(notice).toContain("512");
    // Still hybrid search at its own size.
    const search = await send(owner, "POST", `/knowledge/${kbId}/search`, { query: "How do refunds work?" });
    expect(search.status).toBe(200);
    expect(search.body.mode).toBe("hybrid");
    expect(search.body.hits[0].ranks.vector).toBe(1);
    // A new source is still indexed at 1024.
    await addText(kbId, "More", "# Holidays\n\nThe office closes on public holidays.");
    await settle();
    expect(db.query("SELECT COUNT(*) AS count FROM kb_chunks WHERE kb_id = ? AND length(embedding) <> ?").get(kbId, 1024 * 4)).toEqual({ count: 0 });
    expect(kbRow(kbId)!.dims).toBe(1024);
    // The sheet's options are capped; a change to the same model at its old size is refused.
    const options = (await send(owner, "GET", `/knowledge/${kbId}/embedding-options`)).body;
    expect(options.current).toMatchObject({ providerId: pId, dims: 1024 });
    expect(options.providers.find((provider: { id: string }) => provider.id === pId)).toMatchObject({ maxDims: 512, embeddingDims: 512 });
    expect((await send(owner, "POST", `/knowledge/${kbId}/model`, { providerId: pId, model: "text-embedding-3-small", dims: 1024 })).body.code).toBe("DIMS_TOO_LARGE");
    await resetPolicy(pId);
    expect((await send(owner, "GET", `/knowledge/${kbId}`)).body.knowledgeBase.notice).toBeNull();
  });
});
