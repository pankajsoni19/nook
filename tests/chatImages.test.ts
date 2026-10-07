import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, type Session } from "./support/harness";
import { api, makeKey } from "./support/mcpClient";
import { startFakeProvider } from "./support/fakeProvider";
import { startFakeMcpServer } from "./support/fakeMcpServer";
import { retireUsersAfterFile } from "./support/retireUsers";
import { settleAgentRunsAfterEach } from "./support/agentRuns";
import { GIF_1X1, makePng, SVG_IMAGE } from "./support/images";

const { config } = await import("../server/config");
const { chargeImageLoad, IMAGE_PROXY_LIMITS, imageLoadsInFlight } = await import("../server/agents/images");
const { deleteProvider } = await import("../server/agents/providers");
const { resetToolServersForTests } = await import("../server/agents/toolServers");
const { toolImageOf } = await import("../server/agents/mcpClient");

/**
 * Images in chats (D370 as amended, T304): the image proxy (`GET /api/agents/image-proxy`) and tool
 * images (`GET /api/chats/:chatId/tool-images/:imageId`). The proxy needs a session and its header,
 * never takes an API key, goes out through the egress guard (private hosts, redirects, caps), answers
 * only sniffed PNG/JPEG/GIF/WebP bytes with the strict header set, and is rate-limited per person.
 * Tool images are checked by their bytes, capped, stored with the chat, served to its readers only,
 * and kept by a continued copy; the model is told only that an image was shown.
 */

retireUsersAfterFile();
settleAgentRunsAfterEach();

const IMAGE_PORT = 24795;
const PNG = makePng(32, 20);
const BIG = new Uint8Array(IMAGE_PROXY_LIMITS.maxBytes + 1024);
BIG.set(PNG.subarray(0, 16));
const received: Array<{ path: string; headers: Record<string, string> }> = [];
const imageHost = Bun.serve({
  hostname: "127.0.0.1", port: IMAGE_PORT,
  fetch(request) {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    received.push({ path: url.pathname, headers });
    switch (url.pathname) {
      case "/chart.png": return new Response(PNG, { headers: { "Content-Type": "image/png" } });
      // The upstream's type is never trusted: these bytes are a GIF.
      case "/pixel": return new Response(GIF_1X1, { headers: { "Content-Type": "text/html" } });
      case "/page.png": return new Response("<html><body>not an image</body></html>", { headers: { "Content-Type": "image/png" } });
      case "/logo": return new Response(SVG_IMAGE, { headers: { "Content-Type": "image/png" } });
      case "/big.png": return new Response(BIG, { headers: { "Content-Type": "image/png" } });
      case "/stream-big.png": return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(PNG.subarray(0, 64));
          const block = new Uint8Array(512 * 1024);
          for (let sent = 0; sent < IMAGE_PROXY_LIMITS.maxBytes + block.length; sent += block.length) controller.enqueue(block);
          controller.close();
        }
      }), { headers: { "Content-Type": "image/png" } });
      case "/moved.png": return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${IMAGE_PORT}/chart.png` } });
      default: return new Response("missing", { status: 404 });
    }
  }
});
const fake = startFakeProvider(24796);
const mcp = startFakeMcpServer(24797);
let member: Session;
let admin: Session;
let reader: Session;
let stranger: Session;
let providerId: string;
let serverId: string;

const imageUrl = (path: string) => `http://127.0.0.1:${IMAGE_PORT}${path}`;
async function proxy(session: Session | null, url: string, headers: Record<string, string> = { "X-Nook-Image-Proxy": "1" }) {
  return fetch(`${origin}/api/agents/image-proxy?url=${encodeURIComponent(url)}`, { headers: { ...(session ? { Cookie: session.cookie } : {}), ...headers } });
}
const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;

beforeAll(async () => {
  member = await createUser("Images member");
  admin = await createUser("Images admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  reader = await createUser("Images reader");
  stranger = await createUser("Images stranger");
  const created = await api(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (images)", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-key-0009", defaultModel: "gpt-6-luna" });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
  const server = await api(admin, "POST", "/agents/admin/servers", { name: "Fake Images", url: mcp.url, availability: "all", timeoutMs: 5000 });
  expect(server.status).toBe(201);
  serverId = server.body.server.id;
  expect((await api(admin, "POST", `/agents/admin/servers/${serverId}/sync`, {})).status).toBe(200);
});
afterAll(async () => {
  deleteProvider(admin.userId, providerId);
  await resetToolServersForTests();
  imageHost.stop(true);
  fake.stop();
  mcp.stop();
});

describe("the image proxy (T304)", () => {
  test("loads a picture for a signed-in person: sniffed type, inline, the strict header set, and nothing of the session sent out", async () => {
    received.length = 0;
    const response = await proxy(member, `${imageUrl("/chart.png")}?q=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    const sent = received.at(-1)!;
    expect(sent.path).toBe("/chart.png");
    expect(sent.headers.cookie).toBeUndefined();
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers["user-agent"]).toMatch(/^Nook\//);
    // The type comes from the bytes, not from what the host said.
    const gif = await proxy(member, imageUrl("/pixel"));
    expect(gif.status).toBe(200);
    expect(gif.headers.get("content-type")).toBe("image/gif");
    expect(imageLoadsInFlight(member.userId)).toBe(0);
  });

  test("needs a session and its header; API keys, other sites, and guests never reach it", async () => {
    expect((await proxy(null, imageUrl("/chart.png"))).status).toBe(401);
    const key = makeKey(member, ["notes:read"]);
    expect((await proxy(null, imageUrl("/chart.png"), { "X-Nook-Image-Proxy": "1", Authorization: `Bearer ${key.token}` })).status).toBe(401);
    // An <img>, a link, or a form cannot send the header.
    const bare = await proxy(member, imageUrl("/chart.png"), {});
    expect(bare.status).toBe(400);
    expect((await proxy(member, imageUrl("/chart.png"), { "X-Nook-Image-Proxy": "1", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const guest = await createUser("Images guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    expect((await proxy(guest, imageUrl("/chart.png"))).status).toBe(404);
  });

  test("refuses private hosts, Nook itself, other schemes, credentials, and SVG addresses before fetching", async () => {
    const previous = config.agents.allowedPrivateHosts;
    config.agents.allowedPrivateHosts = [];
    try {
      const refused = await proxy(member, imageUrl("/chart.png"));
      // Plain http to a host that is not on the list is refused, as https to a private address would be.
      expect([400, 403]).toContain(refused.status);
      expect(["URL_REFUSED", "PRIVATE_ADDRESS"]).toContain(await codeOf(refused));
      const literal = await proxy(member, "https://127.0.0.1:9/x.png");
      expect(literal.status).toBe(403);
      expect(await codeOf(literal)).toBe("PRIVATE_ADDRESS");
    } finally {
      config.agents.allowedPrivateHosts = previous;
    }
    received.length = 0;
    expect((await proxy(member, `${origin}/api/files/x/content`)).status).toBe(400);
    expect((await proxy(member, "ftp://images.example.test/a.png")).status).toBe(400);
    expect((await proxy(member, "https://user:pass@images.example.test/a.png")).status).toBe(400);
    expect((await proxy(member, "javascript:alert(1)")).status).toBe(400);
    const svg = await proxy(member, imageUrl("/logo.svg"));
    expect(svg.status).toBe(415);
    expect((await proxy(member, `https://images.example.test/${"a".repeat(2100)}.png`)).status).toBe(400);
    expect(received.length).toBe(0);
  });

  test("answers only image bytes: HTML and SVG labelled as images are refused, and so is anything over the cap", async () => {
    const html = await proxy(member, imageUrl("/page.png"));
    expect(html.status).toBe(415);
    expect(await codeOf(html)).toBe("NOT_AN_IMAGE");
    const svg = await proxy(member, imageUrl("/logo"));
    expect(svg.status).toBe(415);
    const big = await proxy(member, imageUrl("/big.png"));
    expect(big.status).toBe(413);
    expect(await codeOf(big)).toBe("IMAGE_TOO_LARGE");
    const streamed = await proxy(member, imageUrl("/stream-big.png"));
    expect(streamed.status).toBe(413);
    expect(imageLoadsInFlight(member.userId)).toBe(0);
  });

  test("redirects are refused, not followed (as egressFetch does), and a missing picture is a 502", async () => {
    received.length = 0;
    const moved = await proxy(member, imageUrl("/moved.png"));
    expect(moved.status).toBe(502);
    expect(await codeOf(moved)).toBe("REDIRECT_REFUSED");
    expect(received.map((entry) => entry.path)).toEqual(["/moved.png"]);
    const missing = await proxy(member, imageUrl("/nope.png"));
    expect(missing.status).toBe(502);
    expect(await codeOf(missing)).toBe("IMAGE_UNAVAILABLE");
  });

  test("is rate-limited per person (a sliding minute), with Retry-After; others are unaffected", async () => {
    const busy = await createUser("Images busy");
    for (let index = 0; index < IMAGE_PROXY_LIMITS.perMinute; index += 1) expect(chargeImageLoad(busy.userId)).toBe(0);
    const limited = await proxy(busy, imageUrl("/chart.png"));
    expect(limited.status).toBe(429);
    expect(await codeOf(limited)).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await proxy(member, imageUrl("/chart.png"))).status).toBe(200);
  });
});

describe("tool images (MCP image content)", () => {
  type SseEvent = { type: string; data: Record<string, any> };
  async function sendAndWait(session: Session, chatId: string, content: string) {
    const started = await api(session, "POST", `/chats/${chatId}/messages`, { content });
    expect(started.status).toBe(201);
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/runs/${started.body.runId}/events?after=0`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
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
          events.push({ type: lines.event!, data: JSON.parse(lines.data!) });
        }
        if (events.some((event) => event.type === "done" || event.type === "snapshot")) { controller.abort(); break; }
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
    } finally {
      clearTimeout(timer);
    }
    return { messageId: started.body.assistantMessage.id as string, events };
  }
  const imageGet = (session: Session, chatId: string, imageId: string) => fetch(`${origin}/api/chats/${chatId}/tool-images/${imageId}`, { headers: { Cookie: session.cookie } });

  test("checks an image part by its bytes: real pictures kept (at most 4 a call), SVG and junk refused", () => {
    expect(toolImageOf(Buffer.from(PNG).toString("base64"))).toEqual({ mimeType: "image/png", bytes: PNG });
    expect(toolImageOf(Buffer.from(GIF_1X1).toString("base64"))?.mimeType).toBe("image/gif");
    expect(toolImageOf(Buffer.from(SVG_IMAGE).toString("base64"))).toBeNull();
    expect(toolImageOf("AAAA")).toBeNull();
    expect(toolImageOf("not base64!")).toBeNull();
    expect(toolImageOf(Buffer.from(new Uint8Array(2 * 1024 * 1024 + 16).fill(0x89)).toString("base64"))).toBeNull();
  });

  test("a tool's picture is stored with the chat, shown to its readers, never sent to the model, and kept by a copy", async () => {
    const agent = await api(member, "POST", "/agents", { name: "Painter", systemPrompt: "Draw.", providerId, tools: [{ source: "server", serverId, toolName: "image", policy: null }] });
    expect(agent.status).toBe(201);
    const chat = (await api(member, "POST", "/chats", { agentId: agent.body.agent.id })).body.chat as { id: string };
    const { messageId, events } = await sendAndWait(member, chat.id, 'tool:fake-images__image:{"kind":"png"}');
    const result = events.find((event) => event.type === "tool_result")!;
    expect(result.data.ok).toBe(true);
    expect(result.data.images).toHaveLength(1);
    const ref = result.data.images[0] as { id: string; mimeType: string; bytes: number };
    expect(ref.mimeType).toBe("image/png");
    // The model saw a line about the picture, never its bytes.
    const lastTurn = (fake.calls.filter((call) => call.path === "/v1/chat/completions").at(-1)!.body as { messages: Array<{ role: string; content: string | null }> }).messages.at(-1)!;
    expect(lastTurn.role).toBe("tool");
    expect(lastTurn.content).toContain("[image: image/png");
    expect(lastTurn.content).not.toContain(Buffer.from(PNG).toString("base64").slice(0, 40));
    // The message keeps the reference; the route serves the bytes with the strict headers.
    const detail = await api(member, "GET", `/chats/${chat.id}`);
    const stored = (detail.body.messages as Array<{ id: string; toolCalls: Array<{ images?: unknown[] }> }>).find((message) => message.id === messageId)!;
    expect(stored.toolCalls[0]!.images).toEqual([ref]);
    const served = await imageGet(member, chat.id, ref.id);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(makePng(48, 32));
    // Someone the chat is not shared with gets 404, as for the chat itself; a reader it is shared with sees it.
    expect((await imageGet(stranger, chat.id, ref.id)).status).toBe(404);
    expect((await imageGet(reader, chat.id, ref.id)).status).toBe(404);
    const access = await api(member, "GET", `/chats/${chat.id}/access`);
    const shared = await fetch(`${origin}/api/chats/${chat.id}/access`, { method: "PUT", headers: { Cookie: member.cookie, Origin: origin, "X-CSRF-Token": member.csrf, "Content-Type": "application/json", "If-Match": access.body.etag }, body: JSON.stringify({ audience: "selected", people: [{ id: reader.userId, level: "view" }], groups: [] }) });
    expect(shared.status).toBe(200);
    expect((await imageGet(reader, chat.id, ref.id)).status).toBe(200);
    // A wrong pairing of chat and image is 404.
    const other = (await api(member, "POST", "/chats", { agentId: agent.body.agent.id })).body.chat as { id: string };
    expect((await imageGet(member, other.id, ref.id)).status).toBe(404);
    // Continue as a copy: the copy's tool calls still show the picture.
    const fork = await api(member, "POST", `/chats/${chat.id}/fork`, { messageId });
    expect(fork.status).toBe(201);
    expect((await imageGet(member, fork.body.chat.id, ref.id)).status).toBe(200);
  });

  test("an SVG part is refused and a call keeps at most 4 pictures", async () => {
    const agent = await api(member, "POST", "/agents", { name: "Painter 2", systemPrompt: "Draw.", providerId, tools: [{ source: "server", serverId, toolName: "image", policy: null }] });
    const chat = (await api(member, "POST", "/chats", { agentId: agent.body.agent.id })).body.chat as { id: string };
    const svg = await sendAndWait(member, chat.id, 'tool:fake-images__image:{"kind":"svg"}');
    const svgResult = svg.events.find((event) => event.type === "tool_result")!;
    expect(svgResult.data.images).toBeUndefined();
    expect(svgResult.data.resultPreview).toContain("[image omitted]");
    const many = await sendAndWait(member, chat.id, 'tool:fake-images__image:{"kind":"many"}');
    expect(many.events.find((event) => event.type === "tool_result")!.data.images).toHaveLength(4);
    expect((db.query("SELECT COUNT(*) AS count FROM chat_tool_images WHERE chat_id = ?").get(chat.id) as { count: number }).count).toBe(4);
  });
});
