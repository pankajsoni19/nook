import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { startFakeProvider } from "./support/fakeProvider";
import { retireUsersAfterFile } from "./support/retireUsers";
import { routeGateModules, unavailableModules, type ModuleId } from "../src/modules";

const { deleteProvider } = await import("../server/agents/providers");
const { readAgentSettings, writeAgentSettings } = await import("../server/agents/settings");
const { accessNoticeHref } = await import("../server/access/notices");
const { chatRoleOff, mayChatNow } = await import("../server/agents/status");

/**
 * TODO "Chat role message": with Chat on but "Who can chat" leaving out the person's role,
 * `/api/auth/me` says `features.chatRoleOff`, so /chat shows "Chat is off for your role" instead of
 * Home with "not available on this server"; and a shared-chat or shared-agent bell line no longer
 * links into Chat for that person (it opens the bell list, `/notifications`).
 */

retireUsersAfterFile();
const fake = startFakeProvider(0);
let admin: Session;
let owner: Session;
let reader: Session;
let guest: Session;
let providerId: string;
let agentId: string;
let chatId: string;

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
const features = async (session: Session) => (await send(session, "GET", "/auth/me")).body.features as { agents: boolean; chatRoleOff: boolean };

/** Runs `body` with "Who can chat" set to `roles`, then puts the setting back. */
async function withChatRoles(roles: Array<"admin" | "member" | "viewer">, body: () => Promise<void>) {
  const before = readAgentSettings();
  writeAgentSettings(admin.userId, { chatRoles: roles }, before.revision);
  try {
    await body();
  } finally {
    writeAgentSettings(admin.userId, { chatRoles: before.chatRoles }, readAgentSettings().revision);
  }
}

beforeAll(async () => {
  admin = await createUser("Lows2 chat admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("Lows2 chat owner");
  reader = await createUser("Lows2 chat reader");
  db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(reader.userId);
  guest = await createUser("Lows2 chat guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
  const created = await send(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (chat role)", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-key-lows2", defaultModel: "gpt-6-luna" });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
  agentId = (await send(owner, "POST", "/agents", { name: "Role helper", providerId })).body.agent.id;
  chatId = (await send(owner, "POST", "/chats", { agentId })).body.chat.id;
  await share(owner, "agents", agentId, { audience: "selected", people: [{ id: reader.userId, level: "view" }] });
  await share(owner, "chats", chatId, { audience: "selected", people: [{ id: reader.userId, level: "view" }] });
});
afterAll(() => {
  deleteProvider(admin.userId, providerId);
  fake.stop();
});

describe("Chat is off for your role (server)", () => {
  test("features: chatRoleOff only while Chat is on and the role is left out; guests and admins never", async () => {
    expect(await features(reader)).toMatchObject({ agents: true, chatRoleOff: false });
    await withChatRoles(["admin", "member"], async () => {
      expect(await features(reader)).toMatchObject({ agents: false, chatRoleOff: true });
      expect(await features(owner)).toMatchObject({ agents: true, chatRoleOff: false });
      expect(await features(admin)).toMatchObject({ agents: true, chatRoleOff: false });
      expect(await features(guest)).toMatchObject({ agents: false, chatRoleOff: false });
      // /api/agents/status, which the Chat page reads, agrees: on, but not for this role.
      expect((await send(reader, "GET", "/agents/status")).body).toMatchObject({ enabled: true, canChat: false });
      expect(chatRoleOff("viewer")).toBe(true);
      expect(mayChatNow("viewer")).toBe(false);
    });
    expect(chatRoleOff("guest")).toBe(false);
    expect(await features(reader)).toMatchObject({ agents: true, chatRoleOff: false });
  });

  test("shared-chat and shared-agent bell lines link into Chat only for a role that can chat; otherwise /notifications", async () => {
    const href = (kind: string, resourceKind: string, id: string) => accessNoticeHref({ kind, resource_kind: resourceKind, resource_id: id }, reader.userId);
    expect(href("chat_shared", "chat", chatId)).toBe(`/chat/${chatId}`);
    expect(href("agent_shared", "agent", agentId)).toBe(`/chat/new?agent=${agentId}`);
    // Sharing them (beforeAll) told the reader on the bell, once each.
    const bellHrefs = async () => ((await send(reader, "GET", "/notifications?limit=50")).body.items as Array<{ kind: string; title: string; href: string }>)
      .filter((item) => item.title.startsWith("Lows2 chat owner shared")).map((item) => [item.kind, item.href]);
    expect((await bellHrefs()).sort()).toEqual([["access", `/chat/${chatId}`], ["access", `/chat/new?agent=${agentId}`]].sort());
    await withChatRoles(["admin", "member"], async () => {
      expect(href("chat_shared", "chat", chatId)).toBe("/notifications");
      expect(href("agent_shared", "agent", agentId)).toBe("/notifications");
      // A chat that is gone too, and the owner's own removal notice about a chat.
      expect(href("chat_shared", "chat", crypto.randomUUID())).toBe("/notifications");
      expect(href("share_removed", "chat", chatId)).toBe("/notifications");
      // The agent's editor (Settings → AI) is not Chat: unchanged.
      expect(href("agent_changed", "agent", crypto.randomUUID())).toBe("/settings/agents");
      expect(await bellHrefs()).toEqual([["access", "/notifications"], ["access", "/notifications"]]);
      // A member whose role still chats keeps the deep link.
      expect(accessNoticeHref({ kind: "chat_shared", resource_kind: "chat", resource_id: chatId }, owner.userId)).toBe(`/chat/${chatId}`);
    });
    expect(href("chat_shared", "chat", chatId)).toBe(`/chat/${chatId}`);
  });
});

describe("Chat is off for your role (client route gate)", () => {
  const off: ModuleId[] = ["agents"];
  test("the gate lets /chat through only for chatRoleOff, unless the person turned Chat off themselves", () => {
    expect(unavailableModules({ agents: false })).toEqual(["agents"]);
    expect(routeGateModules(off, [], { agents: false, chatRoleOff: true } as never)).toEqual([]);
    expect(routeGateModules(off, [], { agents: false })).toEqual(off);
    expect(routeGateModules(off, [], undefined)).toEqual(off);
    expect(routeGateModules(off, ["agents"], { chatRoleOff: true })).toEqual(off);
    const both: ModuleId[] = ["vault", "agents"];
    expect(routeGateModules(both, [], { chatRoleOff: true })).toEqual(["vault"]);
    expect(routeGateModules(["vault"], [], { chatRoleOff: true })).toEqual(["vault"]);
  });

  test("App gates routes with routeDisabled; tiles keep disabledModules; ChatApp loads nothing a role-off person cannot", async () => {
    const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
    expect(app).toContain("routeGateModules(disabledModules, preferredDisabled, session?.features)");
    expect(app).toContain("hiddenModuleForApp(routeDisabled, route.app)");
    expect(app).toContain("hiddenModuleForApp(routeDisabled, activeApp)");
    expect(app).toContain("!isAppEnabled(routeDisabled, activeApp)");
    // "Not available on this server" stays for a module the server really does not offer.
    expect(app).toContain("is not available on this server.");
    const chat = await Bun.file(new URL("../src/chat/ChatApp.tsx", import.meta.url)).text();
    expect(chat).toContain("if (!status?.enabled || !status.canChat) return;");
    expect(chat).toContain("if (accessLost(reason)) { if (liveRef.current) loseAccess(); else void loadStatus(); }");
    expect(chat).toContain("<ChatOffNotice revoked={revoked} />");
  });
});
