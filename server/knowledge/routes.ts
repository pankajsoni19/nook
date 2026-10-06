import type { Context, Hono, Next } from "hono";
import { z, ZodError } from "zod";
import type { AppEnv } from "../auth";
import { audit } from "../db";
import { keepRequestOpen } from "../longRequests";
import { parseJson, uuid } from "../validation";
import { KNOWLEDGE_BOUNDS } from "../../shared/knowledge";
import { readShareAccess, writeShareAccess } from "../agents/sharing";
import { roleMayChat } from "../agents/settings";
import { AgentError, requireAgentsEnabled } from "../agents/status";
import { reindexAll, scheduleKnowledge } from "./index";
import { presentHits, searchBases } from "./search";
import { addSource, createKnowledge, deleteKnowledge, knowledgeDetail, listKnowledge, manageableKb, readableKb, removeSource, sourceCandidates, updateKnowledge } from "./service";
import "./bin";

/**
 * The knowledge base session API (plan §12 "Knowledge", docs/plan/API_CONTRACTS.md § Knowledge
 * bases): `/api/knowledge/*`. Every route needs a session and a role that may chat; mutations need
 * CSRF and pass the role write gate. Guests get 404 everywhere (AC-O2), mutations included (QA LOW-1:
 * the role write gate answers a guest's write there with the same 404); with the module off every
 * route answers 503 `AGENTS_DISABLED`. Missing and forbidden are the same 404 (D73); a viewer of a
 * base who tries to change it gets 403 `READ_ONLY`.
 */

const line = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must be one line of text");
const createSchema = z.object({ name: line(KNOWLEDGE_BOUNDS.name), description: z.string().trim().max(KNOWLEDGE_BOUNDS.description).optional() }).strict();
const patchSchema = z.object({ name: line(KNOWLEDGE_BOUNDS.name).optional(), description: z.string().trim().max(KNOWLEDGE_BOUNDS.description).optional() }).strict();
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), noteId: uuid }).strict(),
  z.object({ kind: z.literal("document"), documentId: uuid }).strict(),
  z.object({
    kind: z.literal("text"),
    title: line(KNOWLEDGE_BOUNDS.textTitle),
    text: z.string().min(1).max(KNOWLEDGE_BOUNDS.textBytes).refine((value) => value.trim().length > 0, "must not be blank").refine((value) => !value.includes("\u0000"), "must not contain NUL characters")
  }).strict()
]);
const searchSchema = z.object({ query: z.string().trim().min(1).max(KNOWLEDGE_BOUNDS.queryChars), k: z.number().int().min(1).max(KNOWLEDGE_BOUNDS.k.max).optional() }).strict();
const emptySchema = z.object({}).strict();
const sharePrincipal = z.object({ id: uuid, level: z.enum(["view", "manage", "comment", "edit"]) }).strict();
const shareAccessSchema = z.object({
  audience: z.enum(["private", "selected", "all_users", "inherit"]),
  audienceLevel: z.enum(["view", "comment", "edit", "manage"]).optional(),
  people: z.array(sharePrincipal).max(100).default([]),
  groups: z.array(sharePrincipal).max(20).default([])
}).strict();

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
    if (!roleMayChat(c.get("user").role)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot use agents or knowledge bases");
    const result = await handler(c);
    return result instanceof Response ? result : c.json(result as object);
  } catch (error) {
    return fail(c, error);
  }
};

async function guestGate(c: Context<AppEnv>, next: Next) {
  if (c.get("user")?.role === "guest") return c.json({ error: "Not found" }, 404);
  await next();
}

export function registerKnowledgeRoutes(app: Hono<AppEnv>) {
  app.use("/api/knowledge", guestGate);
  app.use("/api/knowledge/*", guestGate);
  const actor = (c: Context<AppEnv>) => ({ userId: c.get("user").id, role: c.get("user").role });

  app.get("/api/knowledge", handle((c) => ({ knowledgeBases: listKnowledge(c.get("user").id) })));
  app.post("/api/knowledge", handle(async (c) => c.json({ knowledgeBase: createKnowledge(actor(c), await parseJson(c.req.raw, createSchema)) }, 201)));
  app.get("/api/knowledge/:kbId", handle((c) => {
    const { kb, level } = readableKb(id(c, "kbId"), c.get("user").id);
    return { knowledgeBase: knowledgeDetail(kb, c.get("user").id, level) };
  }));
  app.patch("/api/knowledge/:kbId", handle(async (c) => {
    const kbId = id(c, "kbId");
    return { knowledgeBase: updateKnowledge(actor(c), kbId, await parseJson(c.req.raw, patchSchema)) };
  }));
  app.delete("/api/knowledge/:kbId", handle((c) => deleteKnowledge(actor(c), id(c, "kbId"))));

  // Sources (manage): add (then indexed in the background), remove, and the pickers' candidates.
  app.post("/api/knowledge/:kbId/sources", handle(async (c) => {
    const kbId = id(c, "kbId");
    const body = await parseJson(c.req.raw, sourceSchema);
    const source = addSource(actor(c), kbId, body);
    scheduleKnowledge(kbId);
    return c.json({ source }, 201);
  }));
  app.delete("/api/knowledge/:kbId/sources/:sourceId", handle((c) => removeSource(actor(c), id(c, "kbId"), id(c, "sourceId"))));
  app.get("/api/knowledge/:kbId/candidates", handle((c) => {
    const kbId = id(c, "kbId");
    const kind = c.req.query("kind") === "document" ? "document" : "note";
    return { candidates: sourceCandidates(actor(c), kbId, kind, (c.req.query("q") ?? "").slice(0, 200)) };
  }));
  app.post("/api/knowledge/:kbId/reindex", handle(async (c) => {
    const kbId = id(c, "kbId");
    await parseJson(c.req.raw, emptySchema);
    const { kb } = manageableKb(kbId, c.get("user").id);
    return reindexAll(actor(c), kb);
  }));

  // Try it (view): the ranked hits with their heading paths and scores. The query's embedding is charged to the person searching.
  app.post("/api/knowledge/:kbId/search", handle(async (c) => {
    const kbId = id(c, "kbId");
    const body = await parseJson(c.req.raw, searchSchema);
    const { kb } = readableKb(kbId, c.get("user").id);
    // The query's embedding may take up to 30 s to its first byte: no idle timeout (server/longRequests.ts).
    keepRequestOpen(c.req.raw);
    const outcome = await searchBases([kb], body.query, body.k ?? KNOWLEDGE_BOUNDS.k.default, { userId: c.get("user").id });
    audit(c.get("user").id, null, "knowledge.search", { via: "web", kbId, hits: outcome.hits.length, mode: outcome.mode });
    return { hits: presentHits(outcome.hits, c.get("user").id, new Map([[kb.id, kb.name]])), mode: outcome.mode, ...(outcome.notice ? { notice: outcome.notice } : {}) };
  }));

  // The Access sheet (owner and managers; managers share at view only), as for agents.
  app.get("/api/knowledge/:kbId/access", handle((c) => {
    const access = readShareAccess("knowledge_base", id(c, "kbId"), c.get("user").id);
    c.header("ETag", access.etag);
    return access;
  }));
  app.put("/api/knowledge/:kbId/access", handle(async (c) => {
    const kbId = id(c, "kbId");
    const body = await parseJson(c.req.raw, shareAccessSchema);
    const access = writeShareAccess("knowledge_base", kbId, { userId: c.get("user").id }, body, c.req.header("If-Match"));
    c.header("ETag", access.etag);
    return access;
  }));
}
