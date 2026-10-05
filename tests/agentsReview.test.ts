import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { api, makeKey, ok } from "./support/mcpClient";
import { startFakeProvider } from "./support/fakeProvider";
import { retireUsersAfterFile } from "./support/retireUsers";

const { config } = await import("../server/config");
const { setAgentsKeyForTests, agentsStatus } = await import("../server/agents/status");
const { secretHint } = await import("../server/agents/secrets");
const { windowTurns } = await import("../server/agents/runs");
const { channelOf } = await import("../server/agents/stream");
const { listChats } = await import("../server/agents/chats");

/**
 * Wave 40 security review probes for the session API: the owner-privacy matrix across every role,
 * CSRF and anonymous access, the module-off lockout, the search index, the Bin's agent purge, the
 * resume endpoint's edges, SSE fan-out, the message window, and the secret hint.
 */

retireUsersAfterFile();
const fake = startFakeProvider(24447);
let admin: Session;
let owner: Session;
let member: Session;
let viewer: Session;
let providerId: string;

const sseText = async (session: Session, runId: string, after = 0) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${origin}/api/runs/${runId}/events?after=${after}`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
    const text = response.ok ? await response.text().catch(() => "") : "";
    return { status: response.status, headers: response.headers, text };
  } finally {
    clearTimeout(timer);
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  admin = await createUser("Review admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("Review owner");
  member = await createUser("Review member");
  viewer = await createUser("Review viewer");
  db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
  const created = await api(admin, "POST", "/agents/admin/providers", { name: "Review fake", baseUrl: fake.baseUrl, apiKey: "sk-test-review-0001", defaultModel: "gpt-6-luna" });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
});
afterAll(() => fake.stop());

describe("review: owner privacy on every route (T325, D73)", () => {
  test("another member, a viewer, and an admin get 404 on an owner's agent, chat, run, events, cancel, and Bin items", async () => {
    const agent = (await api(owner, "POST", "/agents", { name: "Private", systemPrompt: "SECRET-PROMPT-7731", providerId })).body.agent as { id: string; revision: number };
    const chat = (await api(owner, "POST", "/chats", { agentId: agent.id })).body.chat as { id: string; revision: number };
    const started = await api(owner, "POST", `/chats/${chat.id}/messages`, { content: "slow:60:a b c d e f g h i j k l m n o p q r s t u v w x y z" });
    expect(started.status).toBe(201);
    const runId = started.body.runId as string;
    const messageId = started.body.assistantMessage.id as string;
    for (const other of [member, viewer, admin]) {
      const probes: Array<[string, string, unknown?]> = [
        ["GET", `/agents/${agent.id}`], ["PATCH", `/agents/${agent.id}`, { name: "x", expectedRevision: 1 }], ["DELETE", `/agents/${agent.id}`],
        ["POST", "/chats", { agentId: agent.id }],
        ["GET", `/chats/${chat.id}`], ["PATCH", `/chats/${chat.id}`, { title: "x", expectedRevision: 1 }], ["DELETE", `/chats/${chat.id}`],
        ["POST", `/chats/${chat.id}/messages`, { content: "hi" }], ["POST", `/chats/${chat.id}/messages/${messageId}/regenerate`, {}],
        ["GET", `/chats/${chat.id}/run`], ["POST", `/runs/${runId}/cancel`, {}],
        ["POST", `/bin/chat/${chat.id}/restore`, {}], ["DELETE", `/bin/chat/${chat.id}`], ["POST", `/bin/agent/${agent.id}/restore`, {}], ["DELETE", `/bin/agent/${agent.id}`]
      ];
      for (const [method, path, body] of probes) {
        const response = await api(other, method, path, body);
        // Viewers are stopped by the role write gate (403) before the handler on the few writes it does not allowlist for them.
        const accepted = other === viewer && method !== "GET" ? [403, 404] : [404];
        expect({ who: other === viewer ? "viewer" : other === admin ? "admin" : "member", method, path, ok: accepted.includes(response.status) }).toMatchObject({ ok: true });
        expect(JSON.stringify(response.body)).not.toContain("SECRET-PROMPT");
      }
      // The live stream and the snapshot after the ring: 404, nothing streamed, for any `after`.
      for (const after of [0, 1, 999]) {
        const stream = await sseText(other, runId, after);
        expect({ after, status: stream.status, text: stream.text }).toEqual({ after, status: 404, text: "" });
      }
      // Lists never show it.
      expect((await api(other, "GET", "/chats")).body.chats?.some((item: { id: string }) => item.id === chat.id) ?? false).toBe(false);
      expect((await api(other, "GET", "/agents")).body.agents?.some((item: { id: string }) => item.id === agent.id) ?? false).toBe(false);
    }
    // The owner's own stream carries no-store and the run is still theirs.
    const mine = await sseText(owner, runId, 0);
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("no-store");
    await api(owner, "POST", `/runs/${runId}/cancel`, {});
    // MCP: a stranger's key with agents:read sees none of it, with or without a search.
    const stranger = makeKey(member, ["agents:read"]);
    expect((await ok(stranger, "list_chats", { query: "slow" })).chats).toEqual([]);
    expect((await ok(stranger, "list_agents")).agents.some((item: { id: string }) => item.id === agent.id)).toBe(false);
    await sleep(100);
  });

  test("anonymous requests are 401 everywhere in the module; writes without the CSRF header are 403", async () => {
    for (const path of ["/agents/status", "/agents", "/chats", `/runs/${crypto.randomUUID()}/events`, "/agents/admin/providers"]) {
      const response = await request(path);
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
    }
    const noCsrf = await request("/chats", { method: "POST", body: JSON.stringify({ agentId: crypto.randomUUID() }), headers: { Cookie: owner.cookie, Origin: origin } });
    expect(noCsrf.status).toBe(403);
    const adminNoCsrf = await request(`/agents/admin/providers/${providerId}`, { method: "PATCH", body: JSON.stringify({ name: "x", expectedRevision: 1 }), headers: { Cookie: admin.cookie, Origin: origin } });
    expect(adminNoCsrf.status).toBe(403);
  });
});

describe("review: module off by key mismatch", () => {
  test("with a key that does not open the stored secrets, admins cannot remove or re-enter provider keys through the API (lockout)", async () => {
    const key = config.agents.key;
    try {
      expect(setAgentsKeyForTests(Buffer.alloc(32, 123))).toEqual({ enabled: false, reason: "key_mismatch" });
      const remove = await api(admin, "PATCH", `/agents/admin/providers/${providerId}`, { removeSecret: true, expectedRevision: 1 });
      const del = await api(admin, "DELETE", `/agents/admin/providers/${providerId}`);
      const list = await api(admin, "GET", "/agents/admin/providers");
      // Evidence: the documented remedy ("remove and re-enter their API keys") has no API path while the module is off.
      expect([remove.status, del.status, list.status]).toEqual([503, 503, 503]);
      expect((await api(admin, "GET", "/agents/status")).body).toMatchObject({ enabled: false, reason: "key_mismatch" });
    } finally {
      setAgentsKeyForTests(key);
    }
    expect(agentsStatus().enabled).toBe(true);
  });

  test("the hint reveals most of a short secret", () => {
    expect(secretHint("sk-abcdefg")).toBe("sk-…defg");
    expect(secretHint("sk-abcdefg").replace("…", "").length).toBe(7);
  });
});

describe("review: search, Bin, and resume edges", () => {
  test("a search of only a double quote does not crash the route", async () => {
    const response = await api(owner, "GET", `/chats?q=${encodeURIComponent('"')}`);
    expect([200, 400]).toContain(response.status);
  });

  test("the FTS stage is not scoped to the owner: 500 matching rows of other chats crowd out the owner's own hit", async () => {
    const agent = (await api(owner, "POST", "/agents", { name: "Search", providerId })).body.agent as { id: string };
    const chat = (await api(owner, "POST", "/chats", { agentId: agent.id })).body.chat as { id: string };
    const marker = `zq${crypto.randomUUID().slice(0, 8)}`;
    const others = Array.from({ length: 600 }, () => crypto.randomUUID());
    const insert = db.query("INSERT INTO chat_fts (chat_id, title, body) VALUES (?, '', ?)");
    const remove = db.query("DELETE FROM chat_fts WHERE chat_id = ?");
    db.transaction(() => { for (const [index, id] of others.entries()) insert.run(id, `${marker} filler ${index}`); })();
    try {
      // The owner's hit lands after 600 distinct other chats; the FTS stage returns 500 ids before the owner filter.
      insert.run(chat.id, `${marker} mine`);
      const found = listChats(owner.userId, { q: marker }).map((item) => item.id);
      expect(found).toEqual([]);
      // Without the filler, the same search finds it.
      db.transaction(() => { for (const id of others) remove.run(id); })();
      expect(listChats(owner.userId, { q: marker }).map((item) => item.id)).toEqual([chat.id]);
    } finally {
      db.transaction(() => { for (const id of [...others, chat.id]) remove.run(id); })();
    }
  });

  test("purging an agent that has chats fails with a foreign-key error and leaves the Bin item stuck", async () => {
    const agent = (await api(owner, "POST", "/agents", { name: "With chats", providerId })).body.agent as { id: string };
    const chat = (await api(owner, "POST", "/chats", { agentId: agent.id })).body.chat as { id: string };
    expect((await api(owner, "DELETE", `/agents/${agent.id}`)).status).toBe(200);
    const purge = await api(owner, "DELETE", `/bin/agent/${agent.id}`);
    // Evidence: chats.agent_id REFERENCES agents(id) without ON DELETE, so the hard delete fails (500), the
    // transaction rolls back, and the agent stays in the Bin where purge and the hourly sweep keep failing.
    expect(purge.status).toBe(500);
    const stillThere = db.query("SELECT deleted_at, purge_started_at FROM agents WHERE id = ?").get(agent.id) as { deleted_at: string | null; purge_started_at: string | null } | null;
    expect(stillThere).toMatchObject({ purge_started_at: null });
    expect(stillThere?.deleted_at).not.toBeNull();
    expect((await api(owner, "GET", "/bin")).body.items.some((item: { type: string; id: string }) => item.type === "agent" && item.id === agent.id)).toBe(true);
    // The chat (still the owner's) is readable, and the Bin item stays. Cleanup: purge the chat first, then the agent.
    expect((await api(owner, "GET", `/chats/${chat.id}`)).status).toBe(200);
    await api(owner, "DELETE", `/chats/${chat.id}`);
    expect((await api(owner, "DELETE", `/bin/chat/${chat.id}`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/bin/agent/${agent.id}`)).status).toBe(200);
  });

  test("a resume with `after` beyond the ring of a finished run gets neither a snapshot nor a done event", async () => {
    const agent = (await api(owner, "POST", "/agents", { name: "Resume", providerId })).body.agent as { id: string };
    const chat = (await api(owner, "POST", "/chats", { agentId: agent.id })).body.chat as { id: string };
    const started = await api(owner, "POST", `/chats/${chat.id}/messages`, { content: "echo:done quickly" });
    const runId = started.body.runId as string;
    await sseText(owner, runId, 0);
    await sleep(100);
    expect(channelOf(runId)?.closed).toBe(true);
    const beyond = await sseText(owner, runId, 999_999);
    expect(beyond.status).toBe(200);
    expect(beyond.text).toBe("");
  });

  test("SSE fan-out on one run is unbounded per user", async () => {
    const agent = (await api(owner, "POST", "/agents", { name: "Fanout", providerId })).body.agent as { id: string };
    const chat = (await api(owner, "POST", "/chats", { agentId: agent.id })).body.chat as { id: string };
    const started = await api(owner, "POST", `/chats/${chat.id}/messages`, { content: "slow:80:a b c d e f g h i j k l m n o p q r s t u v w x y z" });
    const runId = started.body.runId as string;
    const controllers = Array.from({ length: 25 }, () => new AbortController());
    const opened = await Promise.all(controllers.map((controller) => fetch(`${origin}/api/runs/${runId}/events`, { headers: { Cookie: owner.cookie, Origin: origin }, signal: controller.signal })));
    expect(opened.every((response) => response.status === 200)).toBe(true);
    await sleep(100);
    expect(channelOf(runId)?.listenerCount ?? 0).toBeGreaterThanOrEqual(25);
    for (const controller of controllers) controller.abort();
    await api(owner, "POST", `/runs/${runId}/cancel`, {});
    await sleep(150);
  });

  test("the message window keeps the system turn and the first message, then the newest turns that fit", () => {
    const agentRow = { system_prompt: "P".repeat(100) } as Parameters<typeof windowTurns>[0];
    const row = (id: string, role: "user" | "assistant", content: string) => ({ id, role, content, status: "complete", parent_id: null } as unknown as Parameters<typeof windowTurns>[2][number]);
    const path = [row("1", "user", "first ".padEnd(1000, "f")), row("2", "assistant", "a".repeat(3000)), row("3", "user", "b".repeat(3000)), row("4", "assistant", "c".repeat(3000)), row("5", "user", "tail".padEnd(500, "t"))];
    const turns = windowTurns(agentRow, "Reviewer", path, 1024);
    // Budget: max(2048, 1024-1024) * 4 = 8192 characters.
    expect(turns[0]!.role).toBe("system");
    expect(turns[1]!.content.startsWith("first")).toBe(true);
    expect(turns.at(-1)!.content.startsWith("tail")).toBe(true);
    const total = turns.reduce((sum, turn) => sum + turn.content.length, 0);
    expect(total).toBeLessThanOrEqual(8192);
    // 100 + 1000 + 500 + 3000 + 3000 = 7600 fits; the oldest assistant turn (3000 more) does not.
    expect(turns.map((turn) => turn.content[0])).toEqual(["Y", "f", "b", "c", "t"]);
  });

  test("cleanup: the review provider is removed so other files' agents fall back to their own default", async () => {
    // Runs as a test, not in afterAll: retireUsersAfterFile's hook blocks the admin before any afterAll here.
    expect((await api(admin, "DELETE", `/agents/admin/providers/${providerId}`)).status).toBe(200);
  });
});
