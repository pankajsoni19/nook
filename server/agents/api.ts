import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { countKeyUsage, type KeyActor } from "../apiKeys";
import { mcpResponse } from "../mcp";
import { consumeMcpLimits } from "../mcpRateLimit";
import { readBoundedBody } from "../validation";
import { EXTERNAL_BOUNDS } from "../../shared/agents";
import { cancelExternalRun, externalRunResult, runnableAgents, startExternalRun, type ExternalEvent, type ExternalRequest } from "./external";
import { AgentError } from "./status";

/**
 * The agents' REST API for general Nook keys, `/api/v1/agents/*` (Wave 42 "AC-C", plan §7.2,
 * D364). server/restV1.ts authenticates first (Bearer only, never a cookie or a URL; Host and
 * Origin checks; the key's surfaces, policy, and IP list) and sends general keys here; vault keys get
 * 403 `KEY_POLICY` as on every non-vault path.
 *
 *   GET  /agents                          the agents the key may run: id, name, description, model, tools
 *   POST /agents/:id/runs                 {input} or {messages}, stream?, label? → 200 the result, or SSE
 *   GET  /agents/:id/runs/:runId          the run (live or finished), for the key that started it only
 *   POST /agents/:id/runs/:runId/cancel   the same key only
 *
 * A key without the right (§7.1) gets the same 404 as a missing agent; another key's run is the
 * same 404. JSON only, `no-store`, the `/api/v1` error shape (`{error, code}`), 429 with
 * `Retry-After` for slots, budgets, and limits. Runs never create chats (D365); every one is in the
 * Audit log. The system prompt is never returned.
 */

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  mcpResponse(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
const refuse = (status: number, error: string, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => json(status, { error, code, ...extra }, headers);

const noNul = (value: string) => !value.includes("\u0000");
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const runSchema = z.object({
  input: z.string().min(1).refine((value) => value.trim().length > 0, "must not be blank").refine(noNul, "must not contain NUL characters")
    .refine((value) => bytes(value) <= EXTERNAL_BOUNDS.inputBytes, `must be at most ${EXTERNAL_BOUNDS.inputBytes / 1024} KiB`).optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).refine(noNul, "must not contain NUL characters") }).strict())
    .min(1).max(EXTERNAL_BOUNDS.messages)
    .refine((turns) => turns.reduce((sum, turn) => sum + bytes(turn.content), 0) <= EXTERNAL_BOUNDS.messagesBytes, `must be at most ${EXTERNAL_BOUNDS.messagesBytes / 1024} KiB in total`)
    .refine((turns) => turns.at(-1)?.role === "user", "must end with a user message").optional(),
  stream: z.boolean().optional(),
  label: z.string().trim().min(1).max(EXTERNAL_BOUNDS.label).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must be one line of text").optional()
}).strict().refine((value) => (value.input === undefined) !== (value.messages === undefined), "Send either input or messages");

export type AgentRoute = { name: "list" } | { name: "run"; agentId: string } | { name: "get"; agentId: string; runId: string } | { name: "cancel"; agentId: string; runId: string };
const ID = "([0-9a-fA-F-]{36})";
const ROUTES: Array<{ pattern: RegExp; methods: string[]; route: (match: RegExpExecArray) => AgentRoute }> = [
  { pattern: /^$/, methods: ["GET"], route: () => ({ name: "list" }) },
  { pattern: new RegExp(`^/${ID}/runs$`), methods: ["POST"], route: (match) => ({ name: "run", agentId: match[1]!.toLowerCase() }) },
  { pattern: new RegExp(`^/${ID}/runs/${ID}$`), methods: ["GET"], route: (match) => ({ name: "get", agentId: match[1]!.toLowerCase(), runId: match[2]!.toLowerCase() }) },
  { pattern: new RegExp(`^/${ID}/runs/${ID}/cancel$`), methods: ["POST"], route: (match) => ({ name: "cancel", agentId: match[1]!.toLowerCase(), runId: match[2]!.toLowerCase() }) }
];

/** The route a subpath of `/api/v1/agents` names, with its methods, or null (404). */
export function matchAgentRoute(subpath: string): { route: AgentRoute; methods: string[] } | null {
  for (const entry of ROUTES) {
    const match = entry.pattern.exec(subpath);
    if (match) return { route: entry.route(match), methods: entry.methods };
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function readBody(request: Request): Promise<z.infer<typeof runSchema> | Response> {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return refuse(415, "Send the run as JSON with Content-Type: application/json", "UNSUPPORTED_MEDIA_TYPE");
  let raw: Uint8Array;
  try {
    raw = await readBoundedBody(request);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 413) return refuse(413, "Request is too large", "TOO_LARGE");
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return refuse(400, "The body must be a JSON object", "INVALID_JSON");
  }
  const parsed = runSchema.safeParse(value);
  if (!parsed.success) return refuse(400, "Invalid request", "INVALID", { details: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`) });
  return parsed.data;
}

function fromAgentError(error: AgentError) {
  const retry = typeof error.details.retryAfterSeconds === "number" ? { "Retry-After": String(error.details.retryAfterSeconds) } : undefined;
  return json(error.status, { error: error.message, code: error.code, ...error.details }, retry);
}

/** One SSE frame (`id`, `event`, `data`). */
const frame = (seq: number, event: ExternalEvent) => `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;

/** Handles one authenticated general-key request on `/api/v1/agents…`. */
export async function handleAgentRest(request: Request, route: AgentRoute, auth: { id: string; actor: KeyActor }, clientIp: string | null): Promise<Response> {
  const keyId = auth.id;
  // The key's per-minute REST call bucket counts every request here, as on /api/v1/tools (Wave 34).
  const retryAfter = consumeMcpLimits({ keyId, userId: auth.actor.userId, limits: auth.actor.limits, surface: "rest" }, ["call"]);
  countKeyUsage(keyId, retryAfter ? "denied" : "call", "rest");
  if (retryAfter) return refuse(429, "Too many requests for this API key. Try again later.", "RATE_LIMITED", { retryAfterSeconds: retryAfter }, { "Retry-After": String(retryAfter) });
  try {
    if (route.name === "list") {
      const agents = runnableAgents(keyId, "rest").map(({ agent, tools }) => ({ id: agent.id, name: agent.name, description: agent.description, model: agent.model, maxSteps: agent.max_steps, tools }));
      return json(200, { agents });
    }
    if (!UUID.test(route.agentId)) return refuse(404, "Not found", "NOT_FOUND");
    if (route.name === "get") return json(200, externalRunResult(route.runId, route.agentId, keyId));
    if (route.name === "cancel") {
      // A body is optional here; when one is sent it must be JSON (as every POST on /api/v1).
      const raw = await readBoundedBody(request, 1024).catch(() => null);
      if (raw === null) return refuse(413, "Request is too large", "TOO_LARGE");
      if (raw.byteLength > 0 && request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return refuse(415, "Send JSON with Content-Type: application/json", "UNSUPPORTED_MEDIA_TYPE");
      return json(200, cancelExternalRun(route.runId, route.agentId, keyId));
    }
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const runRequest: ExternalRequest = { agentId: route.agentId, input: body.input, messages: body.messages, label: body.label ?? null };
    const started = startExternalRun({ keyId, surface: "rest", via: "api", clientIp }, runRequest);
    if (!body.stream) return json(200, await started.done);
    // SSE (plan §2.3 minus confirmations): a disconnect never cancels the run; GET …/runs/:runId answers afterwards.
    let unsubscribe: (() => void) | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let seq = 0;
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          if (keepAlive) clearInterval(keepAlive);
          unsubscribe?.();
          try { controller.close(); } catch { /* already closed */ }
        };
        const write = (text: string) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(text)); } catch { close(); }
        };
        write(frame(++seq, { type: "run", data: { runId: started.runId, agentId: route.agentId } }));
        unsubscribe = started.subscribe((event) => {
          if (event.type === "run") return;
          write(frame(++seq, event));
          if (event.type === "done") close();
        });
        keepAlive = setInterval(() => write(": ping\n\n"), 15_000);
        // A run that ended before the subscription (it cannot, but never hang): close on its result.
        void started.done.then((result) => { if (!closed) { write(frame(++seq, { type: "done", data: result })); close(); } });
      },
      cancel() {
        if (keepAlive) clearInterval(keepAlive);
        unsubscribe?.();
      }
    });
    return mcpResponse(stream, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" } });
  } catch (error) {
    if (error instanceof AgentError) return fromAgentError(error);
    if (error instanceof Error && error.name === "AgentSecretError") return refuse(500, "A stored agent secret failed its integrity check", "AGENT_SECRET_INTEGRITY");
    throw error;
  }
}
