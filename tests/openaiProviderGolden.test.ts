import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUser, db, request, type Session } from "./support/harness";
import { retireUsersAfterFile } from "./support/retireUsers";

const { connectionFor, deleteProvider } = await import("../server/agents/providers");
const { completeStreaming, listModels } = await import("../server/agents/loop");
const { embedTexts } = await import("../server/knowledge/embed");

/**
 * The OpenAI kind's wire behaviour, pinned to v0.43.0 (D543, lane LOCALEMB). A plain
 * OpenAI-compatible provider (the default kind) must send exactly what v0.43.0 sent: every request's
 * method, path and query, headers, and body, for Test, Test tool calling, chat with tools (required,
 * named, auto, a refused forced choice retried with auto), the models list, and embeddings (sized
 * and not). The goldens in tests/goldens/openai-provider-v0.43.0.json were captured by running this
 * same file against the v0.43.0 tag's code (`GOLDEN_WRITE=<path> bun --no-env-file test
 * tests/openaiProviderGolden.test.ts` in a `git archive v0.43.0` tree), so a change for another kind
 * (Anthropic, Voyage AI, the local model) cannot silently alter what OpenAI receives.
 */

retireUsersAfterFile();

type Json = Record<string, any>;
type Recorded = { method: string; path: string; headers: Record<string, string>; body: unknown };

/** Headers that depend on the run (the port, the body's length), never on Nook's choices. */
const VOLATILE = new Set(["host", "content-length"]);
const recorded: Recorded[] = [];
const encoder = new TextEncoder();
const sse = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

const recorder = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    // The version in the user agent moves with every release; that it is Nook's own agent is pinned.
    req.headers.forEach((value, key) => { if (!VOLATILE.has(key)) headers[key] = key === "user-agent" ? value.replace(/^Nook\/[\w.-]+$/, "Nook/<version>") : value; });
    const text = req.method === "GET" ? "" : await req.text();
    const body = text ? JSON.parse(text) as Json : null;
    recorded.push({ method: req.method, path: url.pathname + url.search, headers, body });
    if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "gpt-6-luna", object: "model" }, { id: "text-embedding-3-small", object: "model" }] });
    if (url.pathname === "/v1/embeddings") {
      const inputs = (body!.input as string[]);
      const dims = typeof body!.dimensions === "number" ? body!.dimensions : 1536;
      return Response.json({ object: "list", model: body!.model, data: inputs.map((input, index) => ({ object: "embedding", index, embedding: Array.from({ length: dims }, (_, at) => at === input.length % dims ? 3 : 0.5) })), usage: { prompt_tokens: inputs.length * 2, total_tokens: inputs.length * 2 } });
    }
    if (url.pathname === "/v1/chat/completions") {
      const last = JSON.stringify(body!.messages.at(-1));
      if (last.includes("refuse-forced") && body!.tool_choice !== "auto") return Response.json({ error: { message: "tool_choice required is not supported for this model" } }, { status: 400 });
      const tools = Array.isArray(body!.tools) ? (body!.tools as Json[]).map((tool) => tool.function.name as string) : [];
      const call = tools.includes("nook_probe") ? "nook_probe" : tools[0] ?? null;
      const stream = new ReadableStream({
        start(controller) {
          if (call) controller.enqueue(sse({ id: "c1", model: body!.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: call, arguments: "{\"ok\":true}" } }] }, finish_reason: null }] }));
          else controller.enqueue(sse({ id: "c1", model: body!.model, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] }));
          controller.enqueue(sse({ id: "c1", model: body!.model, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] }));
          controller.enqueue(sse({ id: "c1", model: body!.model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }
});

const KEY = "sk-golden-not-real-0001";
let admin: Session;
let providerId = "";
const steps: Record<string, unknown> = {};

async function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, admin);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Json : {} };
}

/** Latencies and durations vary run to run; everything else in an answer is pinned. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Json).map(([key, inner]) => [key, key === "latencyMs" || key === "ms" ? (inner === null ? null : "<ms>") : stable(inner)]));
  return value;
}

/** Runs one step and keeps the requests it sent (and, when given, what it answered). */
async function step(name: string, run: () => Promise<unknown>) {
  recorded.length = 0;
  const answer = await run();
  steps[name] = { requests: recorded.map((item) => ({ ...item, headers: Object.fromEntries(Object.entries(item.headers).sort(([a], [b]) => a.localeCompare(b))) })), ...(answer === undefined ? {} : { answer: stable(answer) }) };
}

const tools = [
  { name: "lookup", description: "Looks a thing up.", parameters: { type: "object", required: ["q"], properties: { q: { type: "string" } } } },
  { name: "submit", description: "Submits the answer.", parameters: { type: "object", properties: { done: { type: "boolean" } } } }
];
const messages = [{ role: "system" as const, content: "You are terse." }, { role: "user" as const, content: "Look up the weather." }];
const signal = () => new AbortController().signal;
const callsOf = (reply: { content: string; toolCalls: Array<{ name: string; arguments: string }>; finishReason: string | null; usage: unknown }) => ({ content: reply.content, finishReason: reply.finishReason, toolCalls: reply.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })), usage: reply.usage });

beforeAll(async () => {
  admin = await createUser("Golden admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  const created = await send("POST", "/agents/admin/providers", { name: "Golden OpenAI", baseUrl: `http://127.0.0.1:${recorder.port}/v1`, apiKey: KEY, defaultModel: "gpt-6-luna", embeddingModel: "text-embedding-3-small", embeddingDims: 512 });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
  steps.created = stable({ compat: created.body.provider.compat, defaultModel: created.body.provider.defaultModel, embeddingModel: created.body.provider.embeddingModel, embeddingDims: created.body.provider.embeddingDims, baseUrl: (created.body.provider.baseUrl as string).replace(String(recorder.port), "<port>") });

  await step("test", async () => (await send("POST", `/agents/admin/providers/${providerId}/test`)).body.test);
  await step("testTools", async () => {
    const probe = (await send("POST", `/agents/admin/providers/${providerId}/test-tools`)).body.probe as Json;
    // Fields lane CLAUDE added (auto, toolCalling) are new answers, not wire changes; the wire is what is pinned.
    return { required: probe.required, named: probe.named, compat: probe.compat, inconclusive: probe.inconclusive, model: probe.model };
  });
  await step("modelsList", async () => listModels(connectionFor(providerId, null)));
  await step("chatRequired", async () => callsOf(await completeStreaming(connectionFor(providerId, null), { messages, tools, toolChoice: "required", temperature: 0.2, maxOutputTokens: 200 }, signal(), () => undefined)));
  await step("chatNamed", async () => callsOf(await completeStreaming(connectionFor(providerId, null), { messages, tools, toolChoice: { name: "submit" }, maxOutputTokens: 300 }, signal(), () => undefined)));
  await step("chatAuto", async () => callsOf(await completeStreaming(connectionFor(providerId, "gpt-6-mini"), { messages, tools, toolChoice: "auto" }, signal(), () => undefined)));
  await step("chatText", async () => callsOf(await completeStreaming(connectionFor(providerId, null), { messages: [{ role: "user", content: "Say ok" }] }, signal(), () => undefined)));
  await step("chatForcedRefused", async () => callsOf(await completeStreaming(connectionFor(providerId, null), { messages: [{ role: "user", content: "refuse-forced please" }], tools, toolChoice: "required" }, signal(), () => undefined)));
  await step("embedSized", async () => {
    const result = await embedTexts(connectionFor(providerId, null), "text-embedding-3-small", 512, ["alpha", "beta gamma"], { inputType: "document" } as never);
    return { count: result.vectors.length, dims: result.vectors[0]!.length, tokens: result.tokens, estimated: result.estimated };
  });
  await step("embedQuery", async () => {
    const result = await embedTexts(connectionFor(providerId, null), "text-embedding-3-small", 512, ["what is alpha"], { inputType: "query" } as never);
    return { count: result.vectors.length, dims: result.vectors[0]!.length };
  });
  await step("embedNative", async () => {
    const result = await embedTexts(connectionFor(providerId, null), "text-embedding-ada-002", null, ["delta"]);
    return { count: result.vectors.length, dims: result.vectors[0]!.length };
  });
});

afterAll(() => {
  if (providerId && db.query("SELECT 1 FROM agent_providers WHERE id = ?").get(providerId)) deleteProvider(admin.userId, providerId);
  recorder.stop(true);
});

const GOLDEN = join(import.meta.dir, "goldens", "openai-provider-v0.43.0.json");

describe("an OpenAI-compatible provider sends what v0.43.0 sent (D543)", () => {
  test("every step's requests and answers match the v0.43.0 goldens", () => {
    if (process.env.GOLDEN_WRITE) {
      writeFileSync(process.env.GOLDEN_WRITE, `${JSON.stringify(steps, null, 2)}\n`);
      return;
    }
    expect(existsSync(GOLDEN)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>;
    expect(Object.keys(steps).sort()).toEqual(Object.keys(golden).sort());
    for (const name of Object.keys(golden)) expect({ [name]: steps[name] }).toEqual({ [name]: golden[name] });
  });

  test.skipIf(!existsSync(join(import.meta.dir, "..", "server", "agents", "providerKinds")) || process.env.GOLDEN_WRITE !== undefined)("loop.ts, providers.ts, and embed.ts hold no kind branches: each kind's choices live in its adapter", () => {
    for (const file of ["server/agents/loop.ts", "server/agents/providers.ts", "server/knowledge/embed.ts"]) {
      const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect({ file, branches: source.match(/[!=]==?\s*"(?:openai|anthropic|voyage|local)"|"(?:openai|anthropic|voyage|local)"\s*[!=]==?/g) ?? [] }).toEqual({ file, branches: [] });
    }
  });

  test("the key only ever travels as the Bearer header, never in a path or a body", () => {
    for (const value of Object.values(steps) as Array<{ requests?: Recorded[] }>) {
      for (const item of value.requests ?? []) {
        expect(item.headers.authorization).toBe(`Bearer ${KEY}`);
        expect(item.headers).not.toHaveProperty("x-api-key");
        expect(item.headers).not.toHaveProperty("anthropic-version");
        expect(item.path).not.toContain(KEY);
        expect(JSON.stringify(item.body ?? null)).not.toContain(KEY);
      }
    }
  });
});
