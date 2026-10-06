import type { Context, Hono, Next } from "hono";
import { streamSSE } from "hono/streaming";
import { z, ZodError } from "zod";
import type { AppEnv } from "../auth";
import { db } from "../db";
import { parseJson, uuid } from "../validation";
import { AGENT_BOUNDS, AGENT_ROLE_OPTIONS, DEFAULT_MODEL, SERVER_AUTH_KINDS, SERVER_AVAILABILITIES, TOOL_POLICIES } from "../../shared/agents";
import { createAgent, deleteAgent, agentDetail, listUsableAgents, manageableAgent, updateAgent, usableAgent } from "./agentsService";
import { chatDetail, createChat, deleteChat, listChats, messageOf, updateChat } from "./chats";
import { createProvider, deleteProvider, listProviders, providerModels, providerRow, providerSummary, testProvider, updateProvider } from "./providers";
import { activeRunForChat, cancelChatRuns, cancelRun, confirmRun, dailyUsage, pendingConfirmationFor, runOwnedBy, runSnapshot, startChatRun } from "./runs";
import { readAgentSettings, roleMayChat, roleMayCreate, writeAgentSettings } from "./settings";
import { AgentError, adminRecoveryAllowed, agentsStatus, recheckAgentsStatus, requireAgentsEnabled } from "./status";
import { declaredStdioServers, stdioEnabled } from "./stdio";
import { channelOf, sseFrame, type SequencedEvent } from "./stream";
import { catalogFor, currentLink, linkableKeys, setLink } from "./tools";
import { createServer, deleteServer, listServers, serverRow, serverSummary, setPolicies, syncServer, updateServer } from "./toolServers";
import { ProviderError } from "./loop";
import "./bin";

/**
 * The agent chat session API (plan §12, docs/plan/API_CONTRACTS.md § Agent chat): `/api/agents/*`,
 * `/api/chats/*`, and `/api/runs/*`. Every route needs a session; mutations need CSRF and pass the
 * role write gate (viewers chat through its allowlist). Guests get 404 everywhere (AC-O2). With the
 * module off every route but `/api/agents/status` answers 503 `AGENTS_DISABLED`. Admin routes live
 * under `/api/agents/admin/*`. Responses are `no-store` (all of /api); no error echoes input.
 */

const line = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must be one line of text");
const revision = z.number().int().min(1);
const roles = z.array(z.enum(AGENT_ROLE_OPTIONS)).max(3).refine((list) => new Set(list).size === list.length, "must not repeat");
const compat = z.object({
  tokenParam: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
  streamUsage: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  contextTokens: z.number().int().min(1024).max(10_000_000).optional()
}).strict();
const providerCreateSchema = z.object({
  name: line(AGENT_BOUNDS.providerName),
  baseUrl: z.string().trim().min(8).max(AGENT_BOUNDS.baseUrl).optional(),
  apiKey: z.string().trim().max(1024).nullish(),
  defaultModel: line(AGENT_BOUNDS.model).optional(),
  embeddingModel: line(AGENT_BOUNDS.model).nullish(),
  embeddingDims: z.number().int().min(64).max(3072).nullish(),
  compat: compat.optional(),
  isDefault: z.boolean().optional()
}).strict();
const providerPatchSchema = providerCreateSchema.partial().extend({ expectedRevision: revision, removeSecret: z.boolean().optional() }).strict();
const settingsSchema = z.object({
  createRoles: roles.optional(),
  chatRoles: roles.optional(),
  dailyTokensUser: z.number().int().min(0).max(1_000_000_000).optional(),
  dailyTokensKey: z.number().int().min(0).max(1_000_000_000).optional(),
  dailyTokensInstance: z.number().int().min(0).max(10_000_000_000).optional(),
  publicChatLinks: z.boolean().optional(),
  auditRetentionDays: z.number().int().min(7).max(365).optional(),
  agentsPerUser: z.number().int().min(1).max(500).optional(),
  kbsPerUser: z.number().int().min(1).max(100).optional(),
  defaultProviderId: uuid.nullable().optional(),
  expectedRevision: z.number().int().min(0)
}).strict();
const starters = z.array(z.string().trim().min(1).max(AGENT_BOUNDS.starterLength)).max(AGENT_BOUNDS.starters);
// AC-B: tool servers (admin), the agent's picks, the link, and confirmations.
const toolName = z.string().min(1).max(128);
const serverCreateSchema = z.object({
  name: line(AGENT_BOUNDS.serverName),
  slug: z.string().trim().min(1).max(AGENT_BOUNDS.serverSlug).optional(),
  url: z.string().trim().min(8).max(AGENT_BOUNDS.serverUrl).nullish(),
  stdioId: z.string().trim().min(1).max(24).nullish(),
  authKind: z.enum(SERVER_AUTH_KINDS).optional(),
  authHeader: z.string().trim().min(1).max(64).nullish(),
  secret: z.string().trim().max(4096).nullish(),
  timeoutMs: z.number().int().min(AGENT_BOUNDS.toolTimeoutMs.min).max(AGENT_BOUNDS.toolTimeoutMs.max).optional(),
  resultCapBytes: z.number().int().min(AGENT_BOUNDS.resultCapBytes.min).max(AGENT_BOUNDS.resultCapBytes.max).optional(),
  availability: z.enum(SERVER_AVAILABILITIES).optional(),
  enabled: z.boolean().optional()
}).strict();
const serverPatchSchema = serverCreateSchema.partial().extend({ expectedRevision: revision, removeSecret: z.boolean().optional() }).strict();
const policiesSchema = z.object({ policies: z.record(toolName, z.enum(TOOL_POLICIES)).refine((value) => Object.keys(value).length <= 500, "too many tools") }).strict();
const toolRefSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("server"), serverId: uuid, toolName, policy: z.enum(["confirm", "off"]).nullable() }).strict(),
  z.object({ source: z.literal("nook"), toolName }).strict()
]);
const linkSchema = z.object({ nookKeyId: uuid.nullable() }).strict();
// Review M1: the card is named by the server's nonce and the arguments' hash, never the model's call id.
const confirmSchema = z.object({ confirmationId: z.string().regex(/^[0-9a-f]{32}$/), argsHash: z.string().regex(/^[0-9a-f]{64}$/), decision: z.enum(["once", "deny"]) }).strict();
const agentCreateSchema = z.object({
  name: line(AGENT_BOUNDS.agentName),
  description: z.string().trim().max(AGENT_BOUNDS.description).optional(),
  icon: z.string().trim().max(16).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  systemPrompt: z.string().max(AGENT_BOUNDS.systemPrompt).refine((value) => !value.includes("\u0000"), "must not contain NUL characters").optional(),
  providerId: uuid.nullish(),
  model: z.string().trim().max(AGENT_BOUNDS.model).nullish(),
  maxSteps: z.number().int().min(AGENT_BOUNDS.maxSteps.min).max(AGENT_BOUNDS.maxSteps.max).optional(),
  temperature: z.number().min(0).max(2).nullish(),
  maxOutputTokens: z.number().int().min(1).max(AGENT_BOUNDS.maxOutputTokens.max).nullish(),
  starters: starters.optional(),
  tools: z.array(toolRefSchema).max(200).optional(),
  nookDirectWrites: z.boolean().optional()
}).strict();
const agentPatchSchema = agentCreateSchema.partial().extend({ expectedRevision: revision }).strict();
const chatCreateSchema = z.object({ agentId: uuid }).strict();
const chatPatchSchema = z.object({ title: line(AGENT_BOUNDS.chatTitle).optional(), pinned: z.boolean().optional(), activeLeafId: uuid.nullable().optional(), expectedRevision: revision }).strict();
const messageSchema = z.object({
  content: z.string().min(1).max(AGENT_BOUNDS.userMessageBytes).refine((value) => value.trim().length > 0, "must not be blank").refine((value) => !value.includes("\u0000"), "must not contain NUL characters"),
  parentId: uuid.nullable().optional()
}).strict();
const emptySchema = z.object({}).strict();

/** Ids in the path: anything that is not a UUID is the same 404 as a missing item. */
function id(c: Context<AppEnv>, name: string) {
  const parsed = uuid.safeParse(c.req.param(name)?.toLowerCase());
  if (!parsed.success) throw new AgentError(404, "NOT_FOUND", "Not found");
  return parsed.data;
}

function fail(c: Context<AppEnv>, error: unknown) {
  if (error instanceof AgentError) {
    if (error.status === 429 && typeof error.details.retryAfterSeconds === "number") c.header("Retry-After", String(error.details.retryAfterSeconds));
    return c.json({ error: error.message, code: error.code, ...error.details }, error.status as 400);
  }
  if (error instanceof ZodError) return c.json({ error: "Invalid request", code: "INVALID", details: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`) }, 400);
  if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON", code: "INVALID" }, 400);
  if (error instanceof Error && error.name === "AgentSecretError") return c.json({ error: "A stored agent secret failed its integrity check", code: "AGENT_SECRET_INTEGRITY" }, 500);
  throw error;
}

type Handler = (c: Context<AppEnv>) => unknown | Promise<unknown>;
const handle = (handler: Handler) => async (c: Context<AppEnv>) => {
  try {
    requireAgentsEnabled();
    const result = await handler(c);
    return result instanceof Response ? result : c.json(result as object);
  } catch (error) {
    return fail(c, error);
  }
};
/**
 * Admin provider routes that must work while the module is off by `key_mismatch` (review M3): the
 * list, one provider, PATCH (remove or re-enter the key), and DELETE. After a write the status is
 * decided again, so the module comes back once every stored secret opens.
 */
const handleRecovery = (handler: Handler) => async (c: Context<AppEnv>) => {
  try {
    if (!adminRecoveryAllowed()) requireAgentsEnabled();
    const result = await handler(c);
    if (c.req.method !== "GET") recheckAgentsStatus();
    return result instanceof Response ? result : c.json(result as object);
  } catch (error) {
    return fail(c, error);
  }
};
const adminOnly = (handler: Handler): Handler => (c) => {
  if (c.get("user").role !== "admin") throw new AgentError(404, "NOT_FOUND", "Not found");
  return handler(c);
};

/** Open SSE streams per run and per person (review L6): a browser needs one; a tab storm gets 429. */
export const STREAM_CAPS = { perRun: 4, perUser: 12 } as const;
const streamsPerRun = new Map<string, number>();
const streamsPerUser = new Map<string, number>();
const bump = (map: Map<string, number>, key: string, by: 1 | -1) => {
  const next = (map.get(key) ?? 0) + by;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
};
export const openStreamCounts = (runId: string, userId: string) => ({ run: streamsPerRun.get(runId) ?? 0, user: streamsPerUser.get(userId) ?? 0 });
const chatter = (handler: Handler): Handler => (c) => {
  if (!roleMayChat(c.get("user").role)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot chat with agents");
  return handler(c);
};
const actorOf = (c: Context<AppEnv>) => ({ userId: c.get("user").id, role: c.get("user").role, displayName: c.get("user").display_name });

/** Guests never reach the module (AC-O2): every path is 404 for them, as if it did not exist. */
async function agentGate(c: Context<AppEnv>, next: Next) {
  if (c.get("user")?.role === "guest") return c.json({ error: "Not found" }, 404);
  await next();
}

export function registerAgentRoutes(app: Hono<AppEnv>) {
  for (const prefix of ["/api/agents", "/api/chats", "/api/runs"]) {
    app.use(prefix, agentGate);
    app.use(`${prefix}/*`, agentGate);
  }

  // Whether the module is on. Why it is off is for admins only.
  app.get("/api/agents/status", (c) => {
    const status = agentsStatus();
    const role = c.get("user").role;
    return c.json({ enabled: status.enabled, reason: role === "admin" ? status.reason : null, canChat: status.enabled && roleMayChat(role), canCreate: status.enabled && roleMayCreate(role), defaultModel: DEFAULT_MODEL });
  });

  // --- Admin: providers and policy (plan §4.1) ---
  app.get("/api/agents/admin/settings", handle(adminOnly(() => ({ settings: readAgentSettings() }))));
  app.put("/api/agents/admin/settings", handle(adminOnly(async (c) => {
    const { expectedRevision, ...patch } = await parseJson(c.req.raw, settingsSchema);
    if (patch.defaultProviderId) providerRow(patch.defaultProviderId);
    return { settings: writeAgentSettings(c.get("user").id, patch, expectedRevision) };
  })));
  app.get("/api/agents/admin/providers", handleRecovery(adminOnly(() => ({ providers: listProviders() }))));
  app.post("/api/agents/admin/providers", handle(adminOnly(async (c) => c.json({ provider: createProvider(c.get("user").id, await parseJson(c.req.raw, providerCreateSchema)) }, 201))));
  app.get("/api/agents/admin/providers/:providerId", handleRecovery(adminOnly((c) => ({ provider: providerSummary(providerRow(id(c, "providerId"))) }))));
  app.patch("/api/agents/admin/providers/:providerId", handleRecovery(adminOnly(async (c) => ({ provider: updateProvider(c.get("user").id, id(c, "providerId"), await parseJson(c.req.raw, providerPatchSchema)) }))));
  app.delete("/api/agents/admin/providers/:providerId", handleRecovery(adminOnly((c) => { deleteProvider(c.get("user").id, id(c, "providerId")); return { ok: true }; })));
  app.post("/api/agents/admin/providers/:providerId/test", handle(adminOnly(async (c) => {
    const providerId = id(c, "providerId");
    await parseJson(c.req.raw, emptySchema);
    return { test: await testProvider(providerId) };
  })));
  app.get("/api/agents/admin/providers/:providerId/models", handle(adminOnly(async (c) => {
    const providerId = id(c, "providerId");
    try {
      return await providerModels(providerId, { fresh: c.req.query("fresh") === "1" });
    } catch (error) {
      if (error instanceof AgentError) throw error;
      // Admins get the fuller excerpt (review L3); chat runs get the redacted one.
      throw new AgentError(502, "PROVIDER_ERROR", error instanceof ProviderError ? error.adminMessage : error instanceof Error && "code" in error ? error.message : "The provider could not be reached");
    }
  })));
  // --- Admin: tool servers (plan §4.1, AC-B) ---
  app.get("/api/agents/admin/servers", handle(adminOnly(() => {
    const servers = listServers();
    const adopted = new Set(servers.map((server) => server.stdioId).filter((id): id is string => id !== null));
    const declared = stdioEnabled() ? declaredStdioServers() : [];
    return { servers, stdio: { enabled: stdioEnabled(), declared: declared.map((entry) => ({ id: entry.id, name: entry.name, command: entry.command, args: entry.args, envNames: Object.keys(entry.env), adopted: adopted.has(entry.id) })) } };
  })));
  app.post("/api/agents/admin/servers", handle(adminOnly(async (c) => c.json({ server: createServer(c.get("user").id, await parseJson(c.req.raw, serverCreateSchema)) }, 201))));
  app.get("/api/agents/admin/servers/:serverId", handle(adminOnly((c) => ({ server: serverSummary(serverRow(id(c, "serverId"))) }))));
  app.patch("/api/agents/admin/servers/:serverId", handle(adminOnly(async (c) => ({ server: updateServer(c.get("user").id, id(c, "serverId"), await parseJson(c.req.raw, serverPatchSchema)) }))));
  app.delete("/api/agents/admin/servers/:serverId", handle(adminOnly((c) => { deleteServer(c.get("user").id, id(c, "serverId")); return { ok: true }; })));
  app.post("/api/agents/admin/servers/:serverId/sync", handle(adminOnly(async (c) => {
    const serverId = id(c, "serverId");
    await parseJson(c.req.raw, emptySchema);
    return { server: await syncServer(c.get("user").id, serverId) };
  })));
  app.put("/api/agents/admin/servers/:serverId/policies", handle(adminOnly(async (c) => ({ server: setPolicies(c.get("user").id, id(c, "serverId"), (await parseJson(c.req.raw, policiesSchema)).policies) }))));

  // Usage (counts only, D73): tokens and runs per day per person or agent.
  app.get("/api/agents/admin/usage", handle(adminOnly((c) => {
    const group = c.req.query("group") === "agent" ? "agent" : "user";
    const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("from") ?? "") ? c.req.query("from")! : new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("to") ?? "") ? c.req.query("to")! : new Date().toISOString().slice(0, 10);
    const rows = group === "user"
      ? db.query(`SELECT u.day, u.user_id AS id, p.display_name AS name, SUM(u.runs) AS runs, SUM(u.prompt_tokens) AS prompt_tokens, SUM(u.completion_tokens) AS completion_tokens
          FROM agent_usage_daily u LEFT JOIN users p ON p.id = u.user_id WHERE u.day BETWEEN ? AND ? GROUP BY u.day, u.user_id ORDER BY u.day DESC, name LIMIT 2000`).all(from, to)
      : db.query(`SELECT u.day, u.agent_id AS id, a.name AS name, SUM(u.runs) AS runs, SUM(u.prompt_tokens) AS prompt_tokens, SUM(u.completion_tokens) AS completion_tokens
          FROM agent_usage_daily u LEFT JOIN agents a ON a.id = u.agent_id WHERE u.day BETWEEN ? AND ? GROUP BY u.day, u.agent_id ORDER BY u.day DESC, name LIMIT 2000`).all(from, to);
    return { from, to, group, rows: (rows as Array<{ day: string; id: string; name: string | null; runs: number; prompt_tokens: number; completion_tokens: number }>).map((row) => ({ day: row.day, id: row.id, name: row.name ?? "(removed)", runs: row.runs, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens })) };
  })));

  // The caller's own usage today, for the budget indicator (before the :agentId routes).
  app.get("/api/agents/usage", handle(chatter((c) => ({ usage: dailyUsage(c.get("user").id) }))));
  // The tool picker's catalog (plan §12): servers the caller may use, and Nook's tools (bounded by the linked key when `agentId` is given).
  app.get("/api/agents/catalog", handle(chatter((c) => {
    const raw = c.req.query("agentId");
    const agentId = raw ? uuid.safeParse(raw.toLowerCase()) : null;
    if (agentId && !agentId.success) throw new AgentError(404, "NOT_FOUND", "Not found");
    if (agentId) usableAgent(agentId.data, c.get("user").id);
    return { catalog: catalogFor(c.get("user").role, agentId ? agentId.data : null, c.get("user").id) };
  })));
  // Link Nook key (plan §5.3, D359): the caller's own live general key with the MCP surface, a pointer never a token.
  app.get("/api/agents/:agentId/link", handle(chatter((c) => {
    const agentId = id(c, "agentId");
    usableAgent(agentId, c.get("user").id);
    return { link: currentLink(agentId, c.get("user").id), keys: linkableKeys(c.get("user").id) };
  })));
  app.put("/api/agents/:agentId/link", handle(chatter(async (c) => {
    const agentId = id(c, "agentId");
    usableAgent(agentId, c.get("user").id);
    const body = await parseJson(c.req.raw, linkSchema);
    return { link: setLink(c.get("user").id, agentId, body.nookKeyId) };
  })));
  // --- Agents (plan §5.1): own agents in this slice ---
  app.get("/api/agents", handle(chatter((c) => ({ agents: listUsableAgents(c.get("user").id) }))));
  app.post("/api/agents", handle(async (c) => c.json({ agent: createAgent(actorOf(c), await parseJson(c.req.raw, agentCreateSchema)) }, 201)));
  app.get("/api/agents/:agentId", handle(chatter((c) => ({ agent: agentDetail(manageableAgent(id(c, "agentId"), c.get("user").id), c.get("user").id) }))));
  app.patch("/api/agents/:agentId", handle(async (c) => ({ agent: updateAgent(actorOf(c), id(c, "agentId"), await parseJson(c.req.raw, agentPatchSchema)) })));
  app.delete("/api/agents/:agentId", handle((c) => deleteAgent(actorOf(c), id(c, "agentId"))));

  // --- Chats (plan §6.1) ---
  app.get("/api/chats", handle(chatter((c) => ({ chats: listChats(c.get("user").id, { q: c.req.query("q")?.slice(0, 200) }) }))));
  app.post("/api/chats", handle(chatter(async (c) => c.json({ chat: createChat(c.get("user").id, (await parseJson(c.req.raw, chatCreateSchema)).agentId) }, 201))));
  app.get("/api/chats/:chatId", handle(chatter((c) => {
    const detail = chatDetail(id(c, "chatId"), c.get("user").id);
    return { ...detail, pendingConfirmation: pendingConfirmationFor(detail.activeRunId) };
  })));
  app.patch("/api/chats/:chatId", handle(chatter(async (c) => ({ chat: updateChat(c.get("user").id, id(c, "chatId"), await parseJson(c.req.raw, chatPatchSchema)) }))));
  app.delete("/api/chats/:chatId", handle(chatter((c) => {
    const chatId = id(c, "chatId");
    const result = deleteChat(c.get("user").id, chatId);
    cancelChatRuns(chatId);
    return result;
  })));
  // Send (plan §12): inserts the user turn and starts the run; the client follows it on /api/runs/:id/events.
  app.post("/api/chats/:chatId/messages", handle(chatter(async (c) => {
    const chatId = id(c, "chatId");
    const body = await parseJson(c.req.raw, messageSchema);
    const started = startChatRun(actorOf(c), chatId, { kind: "send", content: body.content, parentId: body.parentId });
    // The contract's camelCase message shape (QA Q12), the same as `messages[]` in GET /api/chats/:id.
    return c.json({ runId: started.runId, userMessage: started.userMessage ? messageOf(started.userMessage) : null, assistantMessage: messageOf(started.assistantMessage) }, 201);
  })));
  app.post("/api/chats/:chatId/messages/:messageId/regenerate", handle(chatter(async (c) => {
    const chatId = id(c, "chatId");
    const messageId = id(c, "messageId");
    await parseJson(c.req.raw, emptySchema);
    const started = startChatRun(actorOf(c), chatId, { kind: "regenerate", messageId });
    return c.json({ runId: started.runId, userMessage: null, assistantMessage: messageOf(started.assistantMessage) }, 201);
  })));
  app.get("/api/chats/:chatId/run", handle(chatter((c) => {
    const chatId = id(c, "chatId");
    chatDetail(chatId, c.get("user").id);
    const live = activeRunForChat(chatId);
    return { run: live ? { id: live.runId, messageId: live.messageId } : null };
  })));

  // --- Runs (plan §2.3): resume, cancel, and confirm (plan §5.4) ---
  app.post("/api/runs/:runId/cancel", handle(chatter(async (c) => {
    const runId = id(c, "runId");
    await parseJson(c.req.raw, emptySchema);
    return cancelRun(runId, c.get("user").id);
  })));
  app.post("/api/runs/:runId/confirm", handle(chatter(async (c) => {
    const runId = id(c, "runId");
    const body = await parseJson(c.req.raw, confirmSchema);
    return confirmRun(runId, c.get("user").id, { confirmationId: body.confirmationId, argsHash: body.argsHash }, body.decision);
  })));
  app.get("/api/runs/:runId/events", (c) => {
    try {
      requireAgentsEnabled();
      if (!roleMayChat(c.get("user").role)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot chat with agents");
      const runId = id(c, "runId");
      const run = runOwnedBy(runId, c.get("user").id);
      const afterRaw = c.req.query("after") ?? "0";
      const after = /^\d{1,9}$/.test(afterRaw) ? Number(afterRaw) : 0;
      const channel = channelOf(runId);
      const userId = c.get("user").id;
      const counts = openStreamCounts(runId, userId);
      if (counts.run >= STREAM_CAPS.perRun || counts.user >= STREAM_CAPS.perUser) throw new AgentError(429, "TOO_MANY_STREAMS", "Too many open streams; close another tab following this answer", { retryAfterSeconds: 2 });
      bump(streamsPerRun, runId, 1);
      bump(streamsPerUser, userId, 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        bump(streamsPerRun, runId, -1);
        bump(streamsPerUser, userId, -1);
      };
      c.header("X-Accel-Buffering", "no");
      // streamSSE sets no-cache; SSE replies carry chat text, so they are no-store like the rest of /api (T325).
      const follow = async (stream: Parameters<Parameters<typeof streamSSE>[1]>[0]) => {
        const send = (event: SequencedEvent) => stream.write(sseFrame(event));
        const snapshot = async () => {
          const fresh = runOwnedBy(runId, userId);
          await stream.write(`id: 0\nevent: snapshot\ndata: ${JSON.stringify(runSnapshot(fresh))}\n\n`);
        };
        if (!channel) {
          await snapshot();
          return;
        }
        // `after` past the ring (or past everything the run emitted) is an overflow too (review L7): a snapshot, not an empty stream.
        const replay = channel.replay(after);
        if (replay === "overflow") {
          await snapshot();
          if (channel.closed) return;
        } else {
          for (const event of replay) await send(event);
          if (channel.closed) return;
        }
        // Live: forward events until the run ends or the client leaves; a keep-alive comment every 15 s.
        let seen = replay === "overflow" ? channel.lastSeq : Math.max(after, replay.at(-1)?.seq ?? after);
        const queue: SequencedEvent[] = [];
        let wake: (() => void) | null = null;
        let ended = false;
        const unsubscribe = channel.subscribe((event) => {
          if (event === null) ended = true;
          else if (event.seq > seen) queue.push(event);
          wake?.();
        });
        const keepAlive = setInterval(() => { wake?.(); }, 15_000);
        let lastPing = Date.now();
        try {
          while (!ended || queue.length > 0) {
            if (queue.length === 0) {
              if (Date.now() - lastPing >= 15_000) {
                await stream.write(": ping\n\n");
                lastPing = Date.now();
              }
              if (stream.aborted) break;
              await new Promise<void>((resolve) => { wake = resolve; });
              wake = null;
              continue;
            }
            const event = queue.shift()!;
            seen = event.seq;
            await send(event);
          }
        } finally {
          clearInterval(keepAlive);
          unsubscribe();
        }
      };
      const response = streamSSE(c, async (stream) => {
        try {
          await follow(stream);
        } finally {
          release();
        }
      }, async () => { release(); });
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      return fail(c, error);
    }
  });
}
