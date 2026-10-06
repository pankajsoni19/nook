import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { startFakeProvider } from "./support/fakeProvider";
import { startFakeMcpServer } from "./support/fakeMcpServer";
import { retireUsersAfterFile } from "./support/retireUsers";
import { runMarker, settleAgentRunsAfterEach } from "./support/agentRuns";

const { resetAgentRateLimitsForTests } = await import("../server/agents/limits");
const { deleteProvider } = await import("../server/agents/providers");
const { chatUpdateListeners } = await import("../server/agents/chatUpdates");
const { SERVER_IDLE_TIMEOUT_SECONDS, setSseTimingForTests, SSE_TIMING } = await import("../server/longRequests");
const { serverOptions } = await import("./support/harness");

/**
 * Wave 43 fixes, QA D1: Bun closes a connection idle for `idleTimeout` seconds (10 by default), and
 * the SSE streams pinged only every 15 s, so an idle shared chat (and an owner's run waiting on a
 * confirmation card) was cut about every 12 s. The streams now lift the idle timeout for themselves
 * (server/longRequests.ts), ping every 5 s, and re-check access on their own interval.
 */

retireUsersAfterFile();
settleAgentRunsAfterEach();
const fake = startFakeProvider(24666);
const mcp = startFakeMcpServer(24667);
let admin: Session;
let owner: Session;
let reader: Session;
let providerId: string;
let serverId: string;
const SLUG = "w43f2-tools";

type Reply = { status: number; body: Record<string, any> };
async function send(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await request(path, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  let parsed: Record<string, any> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}
async function share(session: Session, kind: "agents" | "chats", id: string, body: Record<string, unknown>) {
  const current = await send(session, "GET", `/${kind}/${id}/access`);
  expect(current.status).toBe(200);
  expect((await send(session, "PUT", `/${kind}/${id}/access`, { people: [], groups: [], ...body }, { "If-Match": current.body.etag })).status).toBe(200);
}

type SseEvent = { type: string; data: Record<string, any>; seq: number; at: number };
/** An open SSE stream that also counts its `: ping` comments, and says whether (and when) it ended. */
async function openStream(session: Session, path: string) {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api${path}`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
  expect(response.status).toBe(200);
  const state = { events: [] as SseEvent[], pings: 0, finishedAt: 0, error: "" };
  void (async () => {
    const body = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await body.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf("\n\n");
        while (at >= 0) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          at = buffer.indexOf("\n\n");
          if (frame === ": ping") state.pings += 1;
          if (frame.startsWith(":")) continue;
          const lines = Object.fromEntries(frame.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
          state.events.push({ type: lines.event!, data: JSON.parse(lines.data!), seq: Number(lines.id ?? 0), at: Date.now() });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) state.error = String(error);
    }
    state.finishedAt = Date.now();
  })();
  const waitFor = async (match: (events: SseEvent[]) => boolean, ms = 8000) => {
    const until = Date.now() + ms;
    while (!match(state.events)) {
      if (state.finishedAt || Date.now() > until) throw new Error(`stream ${path}: no matching event (${state.events.map((event) => event.type).join(", ")}; ${state.error || "open"})`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return state.events;
  };
  return { state, waitFor, close: () => controller.abort() };
}
const has = (type: string) => (events: SseEvent[]) => events.some((event) => event.type === type);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function untilListeners(chatId: string, count: number) {
  const until = Date.now() + 5000;
  while (chatUpdateListeners(chatId) !== count) {
    if (Date.now() > until) throw new Error(`listeners: ${chatUpdateListeners(chatId)}, expected ${count}`);
    await sleep(20);
  }
}

beforeAll(async () => {
  admin = await createUser("W43F2 admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("W43F2 owner");
  reader = await createUser("W43F2 reader");
  const provider = await send(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (W43 idle)", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-key-w43f2", defaultModel: "gpt-6-luna" });
  expect(provider.status).toBe(201);
  providerId = provider.body.provider.id;
  const server = await send(admin, "POST", "/agents/admin/servers", { name: "W43 Idle Tools", slug: SLUG, url: mcp.url, availability: "all", timeoutMs: 5000, resultCapBytes: 4096 });
  expect(server.status).toBe(201);
  serverId = server.body.server.id;
  expect((await send(admin, "POST", `/agents/admin/servers/${serverId}/sync`, {})).status).toBe(200);
});
beforeEach(() => { resetAgentRateLimitsForTests(); });
afterAll(() => {
  db.query("DELETE FROM agent_tools WHERE server_id = ?").run(serverId);
  db.query("DELETE FROM agent_tool_servers WHERE id = ?").run(serverId);
  deleteProvider(admin.userId, providerId);
  fake.stop();
  mcp.stop();
});

/** A chat of the owner's, shared read-only with the reader, whose agent has a confirm tool. */
async function sharedChat(name: string) {
  const agent = (await send(owner, "POST", "/agents", { name, providerId, tools: [{ source: "server", serverId, toolName: "write_thing", policy: null }] })).body.agent;
  await share(owner, "agents", agent.id, { audience: "selected", people: [{ id: reader.userId, level: "view" }] });
  const chat = (await send(owner, "POST", "/chats", { agentId: agent.id })).body.chat;
  await share(owner, "chats", chat.id, { audience: "selected", people: [{ id: reader.userId, level: "view" }] });
  return { chatId: chat.id as string };
}

describe("QA D1: idle SSE streams stay open past Bun's idle timeout", () => {
  test("the server keeps an explicit idle timeout for normal requests and pings well under it", () => {
    expect(serverOptions.idleTimeout).toBe(SERVER_IDLE_TIMEOUT_SECONDS);
    expect(SSE_TIMING.pingMs).toBeLessThanOrEqual(SERVER_IDLE_TIMEOUT_SECONDS * 1000 / 2);
    expect(SSE_TIMING.accessCheckMs).toBe(15_000);
  });

  test("with no bytes at all for longer than the idle timeout, a shared chat's updates and an owner's run waiting on a confirmation stay open", async () => {
    const { chatId } = await sharedChat("W43F2 idle");
    // No pings and no access re-checks while the streams open now: only the per-request timeout keeps them.
    const restore = setSseTimingForTests({ pingMs: 120_000, accessCheckMs: 120_000 });
    let updates: Awaited<ReturnType<typeof openStream>> | null = null;
    let run: Awaited<ReturnType<typeof openStream>> | null = null;
    try {
      const opened = await send(reader, "GET", `/chats/${chatId}`);
      updates = await openStream(reader, `/chats/${chatId}/updates?since=${opened.body.chat.revision}`);
      await untilListeners(chatId, 1);
      const marker = runMarker();
      const started = await send(owner, "POST", `/chats/${chatId}/messages`, { content: `tool:${SLUG}__write_thing:{"what":"${marker}"}` });
      expect(started.status).toBe(201);
      const runId = started.body.runId as string;
      run = await openStream(owner, `/runs/${runId}/events?after=0`);
      const card = (await run.waitFor(has("confirmation_required"), 10_000)).find((event) => event.type === "confirmation_required")!;
      await updates.waitFor(has("run_started"));
      await sleep(300);
      const quietFrom = Date.now();
      const seenBefore = run.state.events.length;
      await sleep((SERVER_IDLE_TIMEOUT_SECONDS + 5) * 1000);
      expect(run.state.finishedAt).toBe(0);
      expect(updates.state.finishedAt).toBe(0);
      expect(run.state.events.slice(seenBefore).map((event) => event.type)).toEqual([]);
      // Both still deliver: the owner's rename reaches the reader, the owner's Deny reaches the run stream.
      const detail = await send(owner, "GET", `/chats/${chatId}`);
      expect((await send(owner, "PATCH", `/chats/${chatId}`, { title: "Renamed after the quiet", expectedRevision: detail.body.chat.revision })).status).toBe(200);
      await updates.waitFor((events) => events.some((event) => event.type === "chat_changed" && event.at >= quietFrom));
      const denied = await send(owner, "POST", `/runs/${runId}/confirm`, { confirmationId: card.data.confirmationId, argsHash: card.data.argsHash, decision: "deny" });
      expect(denied.status).toBe(200);
      await run.waitFor(has("done"), 10_000);
    } finally {
      restore();
      updates?.close();
      run?.close();
    }
    await untilListeners(chatId, 0);
  }, 60_000);

  test("pings come on their own interval, and the access re-check runs on its own, decoupled from them", async () => {
    const { chatId } = await sharedChat("W43F2 pings");
    const restore = setSseTimingForTests({ pingMs: 100, accessCheckMs: 600 });
    let updates: Awaited<ReturnType<typeof openStream>> | null = null;
    try {
      const opened = await send(reader, "GET", `/chats/${chatId}`);
      updates = await openStream(reader, `/chats/${chatId}/updates?since=${opened.body.chat.revision}`);
      await untilListeners(chatId, 1);
      await sleep(450);
      expect(updates.state.pings).toBeGreaterThanOrEqual(2);
      // Taken off the chat with no event published (as a row changed elsewhere): the re-check ends the stream.
      db.query("UPDATE chats SET visibility = 'private' WHERE id = ?").run(chatId);
      await updates.waitFor(has("gone"), 5000);
    } finally {
      restore();
      updates?.close();
    }
    await untilListeners(chatId, 0);
  }, 30_000);
});
