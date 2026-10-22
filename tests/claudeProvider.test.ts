import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";
import { ANTHROPIC_FAKE_MODELS, ANTHROPIC_FORCED_REFUSAL, startScriptedProvider, type Script } from "../scripts/fakeReportProvider";
import { startFakeVoyage } from "../scripts/fakeVoyageProvider";
import { startFakeProvider } from "./support/fakeProvider";
import { ANTHROPIC_VERSION, DEFAULT_COMPAT, flavorDefaults, normalizeKnownBaseUrl, providerFlavor } from "../shared/agents";
import { takesDimensions } from "../shared/knowledge";

const { parseCompat, connectionFor, providerChoices, providerEmbeddingChoices, deleteProvider } = await import("../server/agents/providers");
const { providerHeaders, listModels, runLoop, refusesForcedToolChoice } = await import("../server/agents/loop");
const { embeddingBody } = await import("../server/knowledge/embed");
const { readAgentSettings } = await import("../server/agents/settings");

/**
 * Claude (Anthropic) and Voyage AI as model providers (2026-10-22, lane CLAUDE; D539–D542). Fake
 * servers only, never a real key: Anthropic's headers and `/v1` on its host (never on others), its
 * native models list and paging, the compat defaults a new Anthropic provider starts with, Test tool
 * calling's three probes (forced choice refused is the finding, `auto` works), the loop finishing a
 * final-tool run on `auto` only and learning a refused forced choice, and Voyage AI as an
 * embeddings-only provider sized by `output_dimension`.
 */

retireUsersAfterFile();

type Json = Record<string, any>;
async function send(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

const probeScript: Script = (context) => context.tools.includes("nook_probe") ? { toolCalls: [{ name: "nook_probe", arguments: { ok: true } }] } : { content: "ok" };
const claude = startScriptedProvider(0, probeScript, { anthropic: { pageSize: 3 } });
const plain = startFakeProvider(0);
const voyage = startFakeVoyage(0);
const KEY = "sk-ant-test-not-real-0001";
let admin: Session;
let member: Session;
const ids: Record<string, string> = {};
const compatOf = (id: string) => parseCompat((db.query("SELECT compat_json FROM agent_providers WHERE id = ?").get(id) as { compat_json: string }).compat_json);
const revisionOf = (id: string) => (db.query("SELECT revision FROM agent_providers WHERE id = ?").get(id) as { revision: number }).revision;

beforeAll(async () => {
  admin = await createUser("Claude admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  member = await createUser("Claude member");
  // A proxy in front of Anthropic (the fake on 127.0.0.1) says so with compat.flavor.
  const created = await send(admin, "POST", "/agents/admin/providers", { name: `Claude ${crypto.randomUUID().slice(0, 6)}`, baseUrl: claude.baseUrl, apiKey: KEY, defaultModel: "claude-opus-5-5", compat: { flavor: "anthropic" } });
  expect(created.status).toBe(201);
  ids.claude = created.body.provider.id;
  const other = await send(admin, "POST", "/agents/admin/providers", { name: `Plain ${crypto.randomUUID().slice(0, 6)}`, baseUrl: plain.baseUrl, apiKey: "sk-test-plain-0001", defaultModel: "gpt-6-luna" });
  expect(other.status).toBe(201);
  ids.plain = other.body.provider.id;
  const embeddingsOnly = await send(admin, "POST", "/agents/admin/providers", { name: `Voyage ${crypto.randomUUID().slice(0, 6)}`, baseUrl: voyage.baseUrl, apiKey: "pa-test-not-real-0001", compat: { flavor: "voyage" } });
  expect(embeddingsOnly.status).toBe(201);
  ids.voyage = embeddingsOnly.body.provider.id;
});
afterAll(() => {
  for (const id of Object.values(ids)) if (db.query("SELECT 1 FROM agent_providers WHERE id = ?").get(id)) deleteProvider(admin.userId, id);
  claude.stop();
  plain.stop();
  voyage.stop();
});

describe("Anthropic endpoints (D539)", () => {
  test("by host: api.anthropic.com is Anthropic and api.voyageai.com Voyage; other hosts only by an explicit flavor", () => {
    expect(providerFlavor("https://api.anthropic.com/v1")).toBe("anthropic");
    expect(providerFlavor("https://API.Anthropic.com/v1/")).toBe("anthropic");
    expect(providerFlavor("https://api.voyageai.com/v1")).toBe("voyage");
    expect(providerFlavor("https://api.openai.com/v1")).toBeNull();
    expect(providerFlavor("https://anthropic.example.com/v1")).toBeNull();
    expect(providerFlavor("https://api.anthropic.com.evil.test/v1")).toBeNull();
    expect(providerFlavor("https://llm-proxy.internal/v1", { flavor: "anthropic" })).toBe("anthropic");
  });

  test("a known host entered without /v1 gets it; other hosts and paths are left as entered", () => {
    expect(normalizeKnownBaseUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1");
    expect(normalizeKnownBaseUrl(" https://api.anthropic.com/ ")).toBe("https://api.anthropic.com/v1");
    expect(normalizeKnownBaseUrl("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com/v1");
    expect(normalizeKnownBaseUrl("https://api.voyageai.com")).toBe("https://api.voyageai.com/v1");
    expect(normalizeKnownBaseUrl("https://api.openai.com")).toBe("https://api.openai.com");
    expect(normalizeKnownBaseUrl("https://proxy.example.com/anthropic")).toBe("https://proxy.example.com/anthropic");
  });

  test("headers: Bearer for everyone; x-api-key and anthropic-version only for Anthropic; never a key in the URL", () => {
    expect(providerHeaders({ apiKey: KEY, flavor: "anthropic" }, "application/json")).toEqual({ Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, "x-api-key": KEY, "anthropic-version": ANTHROPIC_VERSION });
    expect(providerHeaders({ apiKey: "sk-plain", flavor: null }, "text/event-stream")).toEqual({ Accept: "text/event-stream", "Content-Type": "application/json", Authorization: "Bearer sk-plain" });
    expect(providerHeaders({ apiKey: "sk-voyage", flavor: "voyage" }, "application/json")).not.toHaveProperty("x-api-key");
    expect(providerHeaders({ apiKey: null, flavor: "anthropic" }, "application/json")).toEqual({ Accept: "application/json", "Content-Type": "application/json", "anthropic-version": ANTHROPIC_VERSION });
  });

  test("a new provider at api.anthropic.com: /v1 added, and the compat layer's defaults (max_tokens, usage, auto only, no embeddings)", async () => {
    const created = await send(admin, "POST", "/agents/admin/providers", { name: `Anthropic host ${crypto.randomUUID().slice(0, 6)}`, baseUrl: "https://api.anthropic.com", apiKey: KEY, defaultModel: "claude-opus-5-5" });
    expect(created.status).toBe(201);
    ids.host = created.body.provider.id;
    expect(created.body.provider.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(created.body.provider.compat).toEqual({ ...DEFAULT_COMPAT, tokenParam: "max_tokens", streamUsage: true, requiredToolChoice: false, namedToolChoice: false, embeddings: false, contextTokens: 200_000 });
    // The form's own values win over the defaults.
    const chosen = await send(admin, "POST", "/agents/admin/providers", { name: `Anthropic chosen ${crypto.randomUUID().slice(0, 6)}`, baseUrl: "https://api.anthropic.com/v1", apiKey: KEY, compat: { tokenParam: "max_completion_tokens", contextTokens: 1_000_000 } });
    expect(chosen.body.provider.compat).toMatchObject({ tokenParam: "max_completion_tokens", contextTokens: 1_000_000, embeddings: false });
    deleteProvider(admin.userId, chosen.body.provider.id);
    // The key is never in a read or the audit (only its hint).
    expect(JSON.stringify(created.body)).not.toContain(KEY);
    const audits = db.query("SELECT metadata_json AS details FROM audit_log WHERE event_type = 'agents.provider.create' ORDER BY created_at DESC, rowid DESC LIMIT 5").all() as Array<{ details: string }>;
    expect(audits.map((row) => row.details).join("\n")).not.toContain(KEY);
    // An Anthropic provider saved before these flags existed reads "Embeddings: none" by its host alone.
    db.query("UPDATE agent_providers SET compat_json = ? WHERE id = ?").run(JSON.stringify({ tokenParam: "max_completion_tokens", streamUsage: true, supportsTools: true, contextTokens: 128000 }), ids.host!);
    expect((await send(admin, "GET", `/agents/admin/providers/${ids.host}`)).body.provider.compat.embeddings).toBe(false);
    expect(providerEmbeddingChoices().some((item) => item.id === ids.host)).toBe(false);
    // An admin may still turn embeddings on (a gateway that adds them); it is then stored explicitly.
    const on = await send(admin, "PATCH", `/agents/admin/providers/${ids.host}`, { compat: { embeddings: true }, expectedRevision: revisionOf(ids.host!) });
    expect(on.body.provider.compat).not.toHaveProperty("embeddings");
    expect(JSON.parse((db.query("SELECT compat_json FROM agent_providers WHERE id = ?").get(ids.host!) as { compat_json: string }).compat_json).embeddings).toBe(true);
    const off = await send(admin, "PATCH", `/agents/admin/providers/${ids.host}`, { compat: { embeddings: false }, expectedRevision: revisionOf(ids.host!) });
    expect(off.body.provider.compat.embeddings).toBe(false);
    expect(JSON.parse((db.query("SELECT compat_json FROM agent_providers WHERE id = ?").get(ids.host!) as { compat_json: string }).compat_json)).not.toHaveProperty("embeddings");
    // Other hosts start from the OpenAI defaults.
    expect(compatOf(ids.plain!)).toEqual(DEFAULT_COMPAT);
    expect(flavorDefaults(null)).toEqual({});
  });

  test("Test: the native models list (with the headers it requires), read page by page; the completion asks for max_tokens", async () => {
    claude.requests.length = 0;
    claude.calls.length = 0;
    const tested = await send(admin, "POST", `/agents/admin/providers/${ids.claude}/test`);
    expect(tested.status).toBe(200);
    expect(tested.body.test).toMatchObject({ ok: true, models: { ok: true, count: ANTHROPIC_FAKE_MODELS.length }, completion: { ok: true } });
    const lists = claude.requests.filter((item) => item.path.startsWith("/v1/models"));
    // 7 models at 3 a page: three requests, each continuing after the last id.
    expect(lists.map((item) => item.path)).toEqual(["/v1/models?limit=1000", "/v1/models?limit=1000&after_id=claude-opus-4-8", "/v1/models?limit=1000&after_id=claude-sonnet-5"]);
    for (const item of claude.requests) expect(item.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": ANTHROPIC_VERSION, authorization: `Bearer ${KEY}` });
    for (const item of claude.requests) expect(item.path).not.toContain(KEY);
    const completion = claude.calls.at(-1) as Json;
    expect(completion).toMatchObject({ model: "claude-opus-5-5", stream: true, stream_options: { include_usage: true }, max_tokens: 16 });
    expect(completion).not.toHaveProperty("max_completion_tokens");
    // The model list feeds the agent editor's picker.
    expect(providerChoices().find((choice) => choice.id === ids.claude)!.models).toEqual([...ANTHROPIC_FAKE_MODELS].sort());
  });

  test("without the headers the native models list refuses (what the operator saw); a plain provider never gets them", async () => {
    const bare = await fetch(`${claude.baseUrl}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as Json).error.message).toBe("anthropic-version: header is required");
    plain.calls.length = 0;
    expect(await listModels(connectionFor(ids.plain!, null))).toContain("gpt-6-luna");
    expect(plain.calls[0]!.path).toBe("/v1/models");
    expect(plain.calls[0]!.headers).not.toHaveProperty("x-api-key");
    expect(plain.calls[0]!.headers).not.toHaveProperty("anthropic-version");
    expect(connectionFor(ids.plain!, null).flavor).toBeNull();
    expect(connectionFor(ids.claude!, null).flavor).toBe("anthropic");
  });
});

describe("Test tool calling (D540)", () => {
  test("forced choice refused is the finding: a third probe with auto confirms tools work; the flags stay false", async () => {
    claude.calls.length = 0;
    // An older provider: saved before this change, so its compat has no tool-choice flags.
    db.query("UPDATE agent_providers SET compat_json = ? WHERE id = ?").run(JSON.stringify({ tokenParam: "max_completion_tokens", streamUsage: true, supportsTools: true, contextTokens: 128000, flavor: "anthropic", embeddings: false }), ids.claude!);
    const probed = await send(admin, "POST", `/agents/admin/providers/${ids.claude}/test-tools`);
    expect(probed.status).toBe(200);
    const probe = probed.body.probe;
    expect(probe.required).toMatchObject({ ok: false, outcome: "unsupported", status: 400, forcedRefused: true });
    expect(probe.named).toMatchObject({ ok: false, outcome: "unsupported", status: 400, forcedRefused: true });
    expect(probe.required.error).toContain("not supported for this model");
    expect(probe.auto).toMatchObject({ ok: true, outcome: "supported", status: 200 });
    expect(probe.toolCalling).toBe("auto");
    expect(probe.inconclusive).toBe(false);
    expect(probe.compat).toEqual({ requiredToolChoice: false, namedToolChoice: false });
    expect(compatOf(ids.claude!)).toMatchObject({ requiredToolChoice: false, namedToolChoice: false });
    expect(claude.calls.map((body) => (body as Json).tool_choice)).toEqual(["required", { type: "function", function: { name: "nook_probe" } }, "auto"]);
    const audited = db.query("SELECT metadata_json AS details FROM audit_log WHERE event_type = 'agents.provider.probe_tools' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { details: string };
    expect(JSON.parse(audited.details)).toMatchObject({ required: "unsupported", named: "unsupported", auto: "supported", toolCalling: "auto" });
  });

  test("a provider whose forced choice works is not sent the auto probe (two requests, as before)", async () => {
    const works = startScriptedProvider(0, probeScript);
    const created = await send(admin, "POST", "/agents/admin/providers", { name: `Forced ${crypto.randomUUID().slice(0, 6)}`, baseUrl: works.baseUrl, apiKey: "sk-test-forced-0001" });
    try {
      const probed = await send(admin, "POST", `/agents/admin/providers/${created.body.provider.id}/test-tools`);
      expect(probed.body.probe).toMatchObject({ toolCalling: "forced", auto: null, required: { outcome: "supported" }, named: { outcome: "supported" } });
      expect(works.calls.length).toBe(2);
    } finally {
      deleteProvider(admin.userId, created.body.provider.id);
      works.stop();
    }
  });

  test("Anthropic's refusal text is recognized, also as the redacted excerpt Nook shows", () => {
    expect(refusesForcedToolChoice(JSON.stringify({ error: { message: ANTHROPIC_FORCED_REFUSAL } }))).toBe(true);
    expect(refusesForcedToolChoice("PROVIDER_ERROR: The provider refused the request (HTTP 400): toolchoice: type tool and any are not supported for this model.")).toBe(true);
    expect(refusesForcedToolChoice("The provider refused the request (HTTP 400): model not found")).toBe(false);
  });

  test("a final-tool run (report generation, the edit agent) finishes on auto only: nudged, then the final tool", async () => {
    claude.calls.length = 0;
    let turn = 0;
    claude.setScript(Object.assign((() => {
      turn += 1;
      return turn === 1 ? { content: "Here is my plan, in words." } : { toolCalls: [{ name: "submit", arguments: { done: true } }] };
    }) as Script, { unplanned: true }));
    const executed: string[] = [];
    const result = await runLoop({
      connection: connectionFor(ids.claude!, null), messages: [{ role: "user", content: "Write the report" }], maxSteps: 4, temperature: null, maxOutputTokens: null,
      signal: new AbortController().signal, sink: { delta: () => undefined, usage: () => undefined }, charge: () => undefined,
      tools: () => [{ name: "lookup", description: "Looks up", parameters: { type: "object", properties: {} } }, { name: "submit", description: "Submits", parameters: { type: "object", properties: { done: { type: "boolean" } } } }],
      execute: async (call) => { executed.push(call.name); return { content: "ok", stop: call.name === "submit" }; },
      toolChoice: (_step, last) => last ? { name: "submit" } : "auto",
      finalTool: { name: "submit", nudge: "Call submit now.", maxNudges: 2 }
    });
    expect(result).toMatchObject({ status: "stop", nudges: 1 });
    expect(executed).toEqual(["submit"]);
    // Never a forced choice on the wire (the provider's flags say auto only): no 400 and no retry.
    expect(claude.calls.map((body) => (body as Json).tool_choice)).toEqual(["auto", "auto"]);
    expect((claude.calls[1] as Json).tools.map((tool: Json) => tool.function.name)).toEqual(["submit"]);
    claude.setScript(probeScript);
  });

  test("live learning: a forced choice refused with Anthropic's 400 is retried with auto and saved false (audited)", async () => {
    db.query("UPDATE agent_providers SET compat_json = ? WHERE id = ?").run(JSON.stringify({ tokenParam: "max_tokens", streamUsage: true, supportsTools: true, contextTokens: 200000, flavor: "anthropic", embeddings: false }), ids.claude!);
    claude.calls.length = 0;
    const connection = connectionFor(ids.claude!, null);
    const tools = [{ name: "nook_probe", description: "Probe", parameters: { type: "object", properties: { ok: { type: "boolean" } } } }];
    const { completeStreaming } = await import("../server/agents/loop");
    const reply = await completeStreaming(connection, { messages: [{ role: "user", content: "go" }], tools, toolChoice: { name: "nook_probe" } }, new AbortController().signal, () => undefined);
    expect(reply.toolCalls[0]!.name).toBe("nook_probe");
    expect(claude.calls.map((body) => (body as Json).tool_choice)).toEqual([{ type: "function", function: { name: "nook_probe" } }, "auto"]);
    expect(compatOf(ids.claude!).namedToolChoice).toBe(false);
    // `required` is learned the same way on its first refusal; then nothing forced is sent again.
    await completeStreaming(connectionFor(ids.claude!, null), { messages: [{ role: "user", content: "go" }], tools, toolChoice: { name: "nook_probe" } }, new AbortController().signal, () => undefined);
    expect(compatOf(ids.claude!)).toMatchObject({ requiredToolChoice: false, namedToolChoice: false });
    claude.calls.length = 0;
    await completeStreaming(connectionFor(ids.claude!, null), { messages: [{ role: "user", content: "go" }], tools, toolChoice: { name: "nook_probe" } }, new AbortController().signal, () => undefined);
    expect(claude.calls.map((body) => (body as Json).tool_choice)).toEqual(["auto"]);
    const learned = db.query("SELECT metadata_json AS details FROM audit_log WHERE event_type = 'agents.provider.compat_learned' ORDER BY created_at DESC, rowid DESC LIMIT 2").all() as Array<{ details: string }>;
    expect(learned.map((row) => JSON.parse(row.details).reason)).toEqual(["The model does not support forced tool choice; Nook asks with auto", "The model does not support forced tool choice; Nook asks with auto"]);
  });
});

describe("Voyage AI, embeddings only (D542)", () => {
  test("created from its defaults: no chat, output_dimension in four sizes, voyage-3.5; never the default", async () => {
    const summary = (await send(admin, "GET", `/agents/admin/providers/${ids.voyage}`)).body.provider;
    expect(summary.compat).toMatchObject({ chat: false, supportsTools: false, dimensionsParam: "output_dimension", embeddingSizes: [256, 512, 1024, 2048], flavor: "voyage" });
    expect(summary).toMatchObject({ isDefault: false, embeddingModel: "voyage-3.5" });
    expect(providerChoices().some((choice) => choice.id === ids.voyage)).toBe(false);
    const choice = providerEmbeddingChoices().find((item) => item.id === ids.voyage)!;
    expect(choice).toMatchObject({ embeddingModel: "voyage-3.5", embeddingDims: 512, sizes: [256, 512, 1024, 2048], flavor: "voyage" });
    // Not a chat, report, or default provider.
    const settings = readAgentSettings();
    for (const field of ["defaultProviderId", "reportProviderId", "reportFallbackProviderId"]) {
      const refused = await send(admin, "PUT", "/agents/admin/settings", { [field]: ids.voyage, expectedRevision: settings.revision });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("CHAT_NONE");
    }
    const made = await send(admin, "PATCH", `/agents/admin/providers/${ids.voyage}`, { isDefault: true, expectedRevision: revisionOf(ids.voyage!) });
    expect(made.status).toBe(409);
    expect(made.body.code).toBe("CHAT_NONE");
    expect((await send(admin, "POST", `/agents/admin/providers/${ids.voyage}/test-tools`)).body.code).toBe("CHAT_NONE");
    // A chat run that names it falls back to the default provider (with that provider's model).
    const connection = connectionFor(ids.voyage!, "voyage-3.5");
    expect(connection.id).not.toBe(ids.voyage);
    expect(connection.model).not.toBe("voyage-3.5");
  });

  test("Test: no models list, no completion; one embedding with output_dimension, no encoding_format", async () => {
    voyage.calls.length = 0;
    const tested = await send(admin, "POST", `/agents/admin/providers/${ids.voyage}/test`);
    expect(tested.body.test).toMatchObject({ ok: true, models: { skipped: true }, completion: { skipped: true }, embeddings: { ok: true, model: "voyage-3.5", dims: 512 } });
    expect(voyage.calls.map((call) => call.path)).toEqual(["/v1/embeddings"]);
    expect(voyage.calls[0]!.body).toEqual({ model: "voyage-3.5", input: ["ok"], output_dimension: 512 });
    expect(voyage.calls[0]!.headers.authorization).toBe("Bearer pa-test-not-real-0001");
  });

  test("the request body: Voyage's output_dimension and input_type; OpenAI's dimensions and encoding_format; sized models only", () => {
    const voyageConnection = { compat: { ...DEFAULT_COMPAT, dimensionsParam: "output_dimension" as const }, flavor: "voyage" as const };
    expect(embeddingBody(voyageConnection, "voyage-3.5", 1024, ["a"], "document")).toEqual({ model: "voyage-3.5", input: ["a"], output_dimension: 1024, input_type: "document" });
    expect(embeddingBody(voyageConnection, "voyage-law-2", 1024, ["a"], "query")).toEqual({ model: "voyage-law-2", input: ["a"], input_type: "query" });
    expect(embeddingBody({ compat: DEFAULT_COMPAT, flavor: null }, "text-embedding-3-small", 512, ["a"], "query")).toEqual({ model: "text-embedding-3-small", input: ["a"], encoding_format: "float", dimensions: 512 });
    expect(takesDimensions("voyage-3.5", { dimensionsParam: "output_dimension" })).toBe(true);
    expect(takesDimensions("voyage-4-lite", { flavor: "voyage" })).toBe(true);
    expect(takesDimensions("voyage-finance-2", { flavor: "voyage" })).toBe(false);
    expect(takesDimensions("voyage-3.5")).toBe(false);
    expect(takesDimensions("text-embedding-3-large")).toBe(true);
  });

  test("an admin may mark any provider \"Embeddings: none\" and turn it back on", async () => {
    const off = await send(admin, "PATCH", `/agents/admin/providers/${ids.plain}`, { compat: { embeddings: false }, expectedRevision: revisionOf(ids.plain!) });
    expect(off.status).toBe(200);
    expect(off.body.provider.compat.embeddings).toBe(false);
    expect(providerEmbeddingChoices().some((item) => item.id === ids.plain)).toBe(false);
    const on = await send(admin, "PATCH", `/agents/admin/providers/${ids.plain}`, { compat: { embeddings: true }, expectedRevision: revisionOf(ids.plain!) });
    expect(on.body.provider.compat).not.toHaveProperty("embeddings");
    expect(providerEmbeddingChoices().some((item) => item.id === ids.plain)).toBe(true);
    // Anthropic is never offered for knowledge bases.
    expect(providerEmbeddingChoices().some((item) => item.id === ids.claude || item.id === ids.host)).toBe(false);
    // Members never see the admin routes.
    expect((await send(member, "PATCH", `/agents/admin/providers/${ids.plain}`, { compat: { embeddings: false }, expectedRevision: revisionOf(ids.plain!) })).status).toBe(404);
  });
});
