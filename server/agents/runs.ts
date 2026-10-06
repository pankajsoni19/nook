import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { audit, db, now } from "../db";
import { AGENT_BOUNDS, CHAT_RUN_TIMEOUT_S, CONFIRMATION_TTL_MS, PREAMBLE_VERSION, preambleFor, RUN_SLOTS, toolResultEnd, toolResultMarker, type DailyUsage, type PendingConfirmation, type RunErrorCode, type RunStatus, type TokenUsage, type ToolCallView } from "../../shared/agents";
import type { AgentRow } from "./agentsService";
import { chatAgent, finishAssistantMessage, flushAssistantText, flushToolCalls, insertAssistantPlaceholder, insertUserMessage, ownedChat, parseToolCalls, pathTo, type ChatRow, type MessageRow } from "./chats";
import { McpClientError } from "./mcpClient";
import { runNookTool } from "./nookBridge";
import { ProviderError, runLoop, type ChatTurn, type ModelToolCall, type ToolExecution } from "./loop";
import { connectionFor } from "./providers";
import { readAgentSettings, roleMayChat } from "./settings";
import { AgentError } from "./status";
import { channelOf, openChannel, type RunChannel } from "./stream";
import { identityOf, inactiveLinkMessage, liveRunner, liveToolFor, resolveTools, type ResolvedTool } from "./tools";
import { sessionFor } from "./toolServers";

/**
 * Runs (plan §2.2, §2.3, §2.4, D344, D345): every run is an `agent_runs` row and an in-memory
 * `RunChannel`. `startChatRun` checks the slots and budgets, inserts the streaming assistant row,
 * launches the loop without awaiting it, and answers at once; the browser follows the run on
 * `GET /api/runs/:id/events`. A disconnect never cancels a run; Stop, the wall clock, chat deletion,
 * and shutdown do (shutdown through the boot sweep, which marks what was live `interrupted`).
 *
 * Budgets are checked before the model call (`BUDGET_EXCEEDED` costs nothing) and charged after
 * it from the usage the provider reported (or estimated). `agent_events` of the plan are the
 * existing audit log here: counts and ids, never message bodies.
 */

/** A confirmation the run waits on (plan §5.4, D352, T324): a server nonce and the arguments' hash, single use (review M1). */
type PendingState = { confirmation: PendingConfirmation; resolve: (decision: "allowed" | "denied") => void };
export type ActiveRun = { runId: string; chatId: string; userId: string; messageId: string; controller: AbortController; startedAt: number; pending: PendingState | null; toolCalls: ToolCallView[] };
const active = new Map<string, ActiveRun>();

export const activeRuns = () => [...active.values()];
export const activeRunForChat = (chatId: string) => [...active.values()].find((run) => run.chatId === chatId) ?? null;

export const dayOf = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);

/** Tokens the person used today, every agent included (`agent_usage_daily`). */
export function dailyUsage(userId: string, day = dayOf()): DailyUsage {
  const row = db.query("SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens, COALESCE(SUM(runs), 0) AS runs FROM agent_usage_daily WHERE day = ? AND user_id = ? AND key_id = ''").get(day, userId) as { prompt_tokens: number; completion_tokens: number; runs: number };
  return { day, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens, runs: row.runs, budget: readAgentSettings().dailyTokensUser };
}

function instanceTokensToday(day = dayOf()) {
  const row = db.query("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens FROM agent_usage_daily WHERE day = ?").get(day) as { tokens: number };
  return row.tokens;
}

/** Budget check before a model call (plan §2.2): per user per day, and per instance when set. */
export function assertBudget(userId: string) {
  const settings = readAgentSettings();
  const usage = dailyUsage(userId);
  if (settings.dailyTokensUser > 0 && usage.promptTokens + usage.completionTokens >= settings.dailyTokensUser) {
    throw new AgentError(429, "BUDGET_EXCEEDED", `You have used today's budget of ${settings.dailyTokensUser.toLocaleString("en-US")} tokens; it resets at midnight UTC`, { retryAfterSeconds: secondsToMidnight() });
  }
  if (settings.dailyTokensInstance > 0 && instanceTokensToday() >= settings.dailyTokensInstance) {
    throw new AgentError(429, "BUDGET_EXCEEDED", "This Nook has used today's token budget; it resets at midnight UTC", { retryAfterSeconds: secondsToMidnight() });
  }
}

const secondsToMidnight = () => Math.max(1, Math.ceil((Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1) - Date.now()) / 1000));

function chargeUsage(userId: string, agentId: string, usage: TokenUsage, runs: number) {
  db.query(`INSERT INTO agent_usage_daily (day, user_id, key_id, agent_id, runs, prompt_tokens, completion_tokens) VALUES (?, ?, '', ?, ?, ?, ?)
    ON CONFLICT(day, user_id, key_id, agent_id) DO UPDATE SET runs = runs + excluded.runs, prompt_tokens = prompt_tokens + excluded.prompt_tokens, completion_tokens = completion_tokens + excluded.completion_tokens`)
    .run(dayOf(), userId, agentId, runs, usage.promptTokens, usage.completionTokens);
}

/** Concurrency slots (plan §2.2): 503 for the instance, 429 per user, 409 per chat. */
function assertSlots(userId: string, chatId: string) {
  const runs = [...active.values()];
  if (runs.some((run) => run.chatId === chatId)) throw new AgentError(409, "RUN_ACTIVE", "This chat is already answering; stop it first");
  if (runs.filter((run) => run.userId === userId).length >= RUN_SLOTS.user) throw new AgentError(429, "AGENT_BUSY", `You can run ${RUN_SLOTS.user} chats at once; wait for one to finish`, { retryAfterSeconds: 5 });
  if (runs.length >= config.agents.maxConcurrentRuns) throw new AgentError(503, "AGENT_BUSY", "This Nook is answering as many chats as it can; try again in a moment", { retryAfterSeconds: 5 });
}

/**
 * The model's view of the branch (plan §2.1 `window`): the preamble and prompt, the first user
 * message, and as many recent complete turns as fit the provider's context (characters ÷ 4).
 */
export function windowTurns(agent: AgentRow, displayName: string, path: MessageRow[], contextTokens: number): ChatTurn[] {
  const system: ChatTurn = { role: "system", content: `${preambleFor(displayName)}\n\n${agent.system_prompt}`.trim() };
  const turns = path.filter((row) => (row.role === "user" || row.role === "assistant") && row.content.length > 0 && (row.role === "user" || row.status === "complete" || row.status === "step_limit" || row.status === "cancelled"))
    .map((row): ChatTurn => ({ role: row.role as "user" | "assistant", content: row.content }));
  const budget = Math.max(2048, contextTokens - 1024) * 4;
  let used = system.content.length;
  const kept: ChatTurn[] = [];
  const first = turns[0];
  if (first) used += first.content.length;
  for (let index = turns.length - 1; index >= 1; index -= 1) {
    const turn = turns[index]!;
    if (used + turn.content.length > budget) break;
    used += turn.content.length;
    kept.unshift(turn);
  }
  return [system, ...(first ? [first] : []), ...kept.filter((turn) => turn !== first)];
}

export type StartInput =
  /** `parentId` undefined = under the active leaf; null = a new root (an edit of the first message). */
  | { kind: "send"; content: string; parentId?: string | null }
  | { kind: "regenerate"; messageId: string };

/** Starts a run on an owned chat. Answers once the rows exist; the loop runs in the background. */
export function startChatRun(actor: { userId: string; role: string; displayName: string }, chatId: string, input: StartInput): { runId: string; userMessage: MessageRow | null; assistantMessage: MessageRow } {
  const settings = readAgentSettings();
  if (!roleMayChat(actor.role, settings)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot chat with agents");
  const chat = ownedChat(chatId, actor.userId);
  const agent = chatAgent(chat);
  assertSlots(actor.userId, chatId);
  assertBudget(actor.userId);
  // The provider is resolved (and its secret opened) before any row is written: a missing provider is a clean 409.
  const connection = connectionFor(agent.provider_id, agent.model);

  let userMessage: MessageRow | null = null;
  let parentId: string;
  if (input.kind === "send") {
    if (Buffer.byteLength(input.content, "utf8") > AGENT_BOUNDS.userMessageBytes) throw new AgentError(400, "TOO_LARGE", "A message can be at most 32 KiB");
    userMessage = insertUserMessage(chat, actor.userId, input.content, input.parentId === undefined ? chat.active_leaf_id : input.parentId);
    parentId = userMessage.id;
  } else {
    const target = db.query("SELECT * FROM chat_messages WHERE id = ? AND chat_id = ?").get(input.messageId, chat.id) as MessageRow | null;
    if (!target) throw new AgentError(404, "NOT_FOUND", "Not found");
    // Regenerate an assistant turn: a sibling under the same user message. Retry a user turn: a child.
    const parent = target.role === "assistant" ? target.parent_id : target.id;
    if (!parent) throw new AgentError(400, "INVALID", "That message cannot be regenerated");
    parentId = parent;
  }

  const runId = crypto.randomUUID();
  const timestamp = now();
  const assistantMessage = db.transaction(() => {
    db.query(`INSERT INTO agent_runs (id, via, agent_id, agent_revision, prompt_sha256, preamble_version, chat_id, user_id, provider_id, model, status, queued_at)
      VALUES (?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`).run(runId, agent.id, agent.revision, createHash("sha256").update(agent.system_prompt).digest("hex"), PREAMBLE_VERSION, chat.id, actor.userId, connection.id, connection.model, timestamp);
    return insertAssistantPlaceholder(chat, parentId, runId, connection.model);
  })();

  const controller = new AbortController();
  const run: ActiveRun = { runId, chatId: chat.id, userId: actor.userId, messageId: assistantMessage.id, controller, startedAt: Date.now(), pending: null, toolCalls: [] };
  active.set(runId, run);
  const channel = openChannel(runId);
  channel.emit({ type: "run", data: { runId, chatId: chat.id, messageId: assistantMessage.id, userMessageId: userMessage?.id ?? null } });
  audit(actor.userId, null, "agents.run.start", { runId, chatId: chat.id, agentId: agent.id });
  void execute(run, channel, agent, actor, chat, assistantMessage.id, parentId, connection);
  return { runId, userMessage, assistantMessage };
}

type CancelReason = "stop" | "timeout" | "chat_deleted";

const preview = (value: string) => value.length > AGENT_BOUNDS.toolPreviewChars ? `${value.slice(0, AGENT_BOUNDS.toolPreviewChars - 1)}…` : value;
const argsPreviewOf = (raw: string) => {
  try { return preview(JSON.stringify(JSON.parse(raw), null, 2)); } catch { return preview(raw); }
};

/** Cuts a result to the server's cap in UTF-8 bytes (D350), on a character boundary. */
export function capResultText(text: string, capBytes: number): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= capBytes) return { text, truncated: false, bytes };
  let cut = Buffer.from(text, "utf8").subarray(0, capBytes).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return { text: cut, truncated: true, bytes };
}

const toolError = (code: string, message: string) => JSON.stringify({ error: message, code });

/**
 * Runs the tool calls of a run (plan §2.1 `gate` and `execute`, §2.2, §5.4): resolves the model's
 * name, parses the arguments, asks on the card for `confirm` tools (15 minutes, then Deny), runs the
 * call with the server's timeout, caps the text, prepends the untrusted-data marker, and discloses
 * everything on the stream and the message. Only ids, names, and counts reach the audit log.
 */
function toolExecutor(run: ActiveRun, channel: RunChannel, agent: AgentRow, messageId: string) {
  let resolved: ResolvedTool[] = [];
  const seenCallIds = new Set<string>();
  const persist = () => flushToolCalls(messageId, run.toolCalls);
  const tools = () => {
    resolved = [];
    if (run.toolCalls.length >= AGENT_BOUNDS.toolCallsPerRun) return [];
    // The agent row and the runner's role are read live at every step (review M3), not kept from the run's start.
    const live = liveRunner(agent.id, run.userId);
    if (!live) return [];
    resolved = resolveTools(live.agent, { userId: run.userId, role: live.role });
    return resolved.map((tool) => ({ name: tool.modelName, description: tool.description, parameters: tool.parameters }));
  };
  const finish = (view: ToolCallView, outcome: { ok: boolean; text: string; truncated: boolean; durationMs: number; proposalId?: string | null; decision?: ToolCallView["decision"] }) => {
    view.ok = outcome.ok;
    view.resultPreview = preview(outcome.text);
    view.truncated = outcome.truncated;
    view.durationMs = outcome.durationMs;
    view.proposalId = outcome.proposalId ?? null;
    if (outcome.decision) view.decision = outcome.decision;
    channel.emit({ type: "tool_result", data: { messageId, callId: view.id, ok: outcome.ok, resultPreview: view.resultPreview, truncated: outcome.truncated, durationMs: outcome.durationMs, decision: view.decision, proposalId: view.proposalId } });
    persist();
  };
  const execute = async (call: ModelToolCall): Promise<ToolExecution> => {
    const started = Date.now();
    const offered = resolved.find((item) => item.modelName === call.name) ?? null;
    // A Nook tool through a link whose key died is named as such (QA Q4), not as an unknown tool.
    const deadLink = !offered && call.name.startsWith("nook__") ? inactiveLinkMessage(agent.id, run.userId) : null;
    const view: ToolCallView = { id: call.id, tool: offered?.toolName ?? (deadLink ? call.name.slice("nook__".length) : call.name), server: offered?.server ?? (deadLink ? "nook" : ""), serverId: offered?.serverId ?? null, argsPreview: argsPreviewOf(call.arguments), resultPreview: null, ok: null, truncated: false, durationMs: null, decision: null, proposalId: null };
    const fail = (code: string, message: string, extra: { decision?: ToolCallView["decision"] } = {}) => {
      const text = toolError(code, message);
      finish(view, { ok: false, text, truncated: false, durationMs: Date.now() - started, ...extra });
      audit(run.userId, null, "agents.tool.call", { runId: run.runId, agentId: agent.id, serverId: view.serverId, server: view.server, tool: view.tool, ok: false, code });
      return { content: text };
    };
    // Call ids are minted by the loop (`call_<step>_<index>`); a repeat is refused before anything is shown (review M1).
    if (seenCallIds.has(call.id)) return { content: toolError("DUPLICATE_CALL", "This call id was already used in this answer; the call was not run") };
    seenCallIds.add(call.id);
    run.toolCalls.push(view);
    channel.emit({ type: "tool_call", data: { messageId, callId: call.id, tool: view.tool, server: view.server, serverId: view.serverId, argsPreview: view.argsPreview } });
    if (run.toolCalls.length > AGENT_BOUNDS.toolCallsPerRun) return fail("TOOL_LIMIT", `This run has used its ${AGENT_BOUNDS.toolCallsPerRun} tool calls; answer with what you have`);
    if (!offered) return deadLink ? fail("KEY_INACTIVE", deadLink) : fail("UNKNOWN_TOOL", "unknown tool");
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      args = parsed as Record<string, unknown>;
    } catch {
      return fail("INVALID_ARGUMENTS", "arguments were not valid JSON");
    }
    // Rights are live per call (review M3): the tool is re-resolved against the live agent row, role,
    // server row (same revision), policy, and key before the gate, and again after any confirmation.
    const identity = identityOf(offered);
    const unavailable = () => {
      const dead = identity.kind === "nook" ? inactiveLinkMessage(agent.id, run.userId) : null;
      return dead ? fail("KEY_INACTIVE", dead) : unavailableTool();
    };
    const unavailableTool = () => fail("TOOL_UNAVAILABLE", "This tool is no longer available to this agent (it was disabled, removed, changed, or the rights changed); the call was not run");
    let tool = liveToolFor(agent.id, run.userId, identity);
    if (!tool) return unavailable();
    if (tool.policy === "confirm") {
      const decision = await awaitConfirmation(run, channel, messageId, {
        confirmationId: randomBytes(16).toString("hex"), argsHash: argsHashOf(args), callId: call.id, tool: tool.toolName, server: tool.server, args,
        expiresAt: new Date(Date.now() + confirmationTimeouts.ttlMs).toISOString(), proposal: tool.nook?.mode === "proposal"
      });
      if (decision === "cancelled") {
        // The run is ending (Stop, the wall clock, the chat deleted): the call is recorded cancelled, never as the person's refusal.
        view.decision = "cancelled";
        throw new Error("cancelled");
      }
      if (decision === "expired") return fail("EXPIRED", "The person did not answer the confirmation in time, so the call was not run. Continue without it, or ask them.", { decision });
      if (decision !== "allowed") return fail("DENIED", "The person refused this call", { decision });
      view.decision = "allowed";
      tool = liveToolFor(agent.id, run.userId, identity);
      if (!tool) return unavailable();
    }
    let text: string;
    let ok: boolean;
    let proposalId: string | null = null;
    try {
      if (tool.nook) {
        // The same per-call timeout as a server's (review L9); the result of a late call is discarded.
        const outcome = await withTimeout(runNookTool(tool.nook, args, { runId: run.runId, agentId: agent.id, agentName: agent.name }), tool.timeoutMs, run.controller.signal);
        text = outcome.text;
        ok = outcome.ok;
        proposalId = outcome.proposalId;
      } else {
        const outcome = await withTimeout(sessionFor(tool.serverRow!).callTool(tool.toolName, args, run.controller.signal), tool.timeoutMs, run.controller.signal);
        text = outcome.text;
        ok = !outcome.isError;
      }
    } catch (error) {
      if (run.controller.signal.aborted) throw error;
      if (error instanceof McpClientError) return fail(error.code === "MCP_TIMEOUT" ? "TOOL_TIMEOUT" : error.code, error.message);
      if (error instanceof AgentError) return fail(error.code, error.message);
      console.error("Agent tool call failed", error instanceof Error ? error.name : "Unknown error");
      return fail("INTERNAL", "The tool could not be run");
    }
    const capped = capResultText(text, tool.resultCapBytes);
    // The fence's nonce is made after the result exists, so the result cannot close the fence (review L7).
    const nonce = randomBytes(6).toString("hex");
    const content = `${toolResultMarker(tool.server, tool.toolName, nonce)}\n${capped.text}${capped.truncated ? `\n[truncated: the result was ${capped.bytes} bytes; the first ${tool.resultCapBytes} are shown]` : ""}\n${toolResultEnd(nonce)}`;
    finish(view, { ok, text: capped.text, truncated: capped.truncated, durationMs: Date.now() - started, proposalId });
    audit(run.userId, null, "agents.tool.call", { runId: run.runId, agentId: agent.id, serverId: view.serverId, server: view.server, tool: view.tool, ok, truncated: capped.truncated, durationMs: view.durationMs, proposalId });
    return { content };
  };
  return { tools, execute };
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpClientError("MCP_TIMEOUT", "The tool did not answer in time")), ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error("cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

/** The confirmation wait (15 minutes, then Deny), on an object so tests can shorten it. */
export const confirmationTimeouts = { ttlMs: CONFIRMATION_TTL_MS };

/**
 * The run's wall clock (plan §2.2, Wave 41 QA Q3): it counts the run's own work only. It pauses
 * while a card waits (the card has its own 15-minute cap) and resumes with what was left.
 */
type WallClock = { remainingMs: number; startedAt: number; timer: ReturnType<typeof setTimeout> | null };
const wallClocks = new WeakMap<ActiveRun, WallClock>();

function startWallClock(run: ActiveRun, ms: number) {
  const clock: WallClock = { remainingMs: ms, startedAt: Date.now(), timer: null };
  wallClocks.set(run, clock);
  resumeWallClock(run);
}
function resumeWallClock(run: ActiveRun) {
  const clock = wallClocks.get(run);
  if (!clock || clock.timer) return;
  clock.startedAt = Date.now();
  clock.timer = setTimeout(() => run.controller.abort("timeout" satisfies CancelReason), Math.max(0, clock.remainingMs));
}
function pauseWallClock(run: ActiveRun) {
  const clock = wallClocks.get(run);
  if (!clock?.timer) return;
  clearTimeout(clock.timer);
  clock.timer = null;
  clock.remainingMs -= Date.now() - clock.startedAt;
}
function stopWallClock(run: ActiveRun) {
  const clock = wallClocks.get(run);
  if (clock?.timer) clearTimeout(clock.timer);
  wallClocks.delete(run);
}

/**
 * Pauses the run on the card (plan §5.4): Allow once, Deny, 15 minutes (then `expired`, and the
 * model is told the person did not answer), or the run ending (`cancelled`, never blamed on the person).
 */
function awaitConfirmation(run: ActiveRun, channel: RunChannel, messageId: string, confirmation: PendingConfirmation): Promise<"allowed" | "denied" | "expired" | "cancelled"> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (decision: "allowed" | "denied" | "expired" | "cancelled") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.controller.signal.removeEventListener("abort", onAbort);
      run.pending = null;
      resumeWallClock(run);
      db.query("UPDATE agent_runs SET status = 'running' WHERE id = ? AND status = 'awaiting_confirmation'").run(run.runId);
      db.query("UPDATE chat_messages SET status = 'streaming' WHERE id = ? AND status = 'awaiting_confirmation'").run(messageId);
      channel.emit({ type: "confirmation_resolved", data: { messageId, confirmationId: confirmation.confirmationId, callId: confirmation.callId, decision } });
      audit(run.userId, null, "agents.tool.confirm", { runId: run.runId, callId: confirmation.callId, server: confirmation.server, tool: confirmation.tool, decision });
      resolve(decision);
    };
    const onAbort = () => settle("cancelled");
    const timer = setTimeout(() => settle("expired"), Math.max(0, Date.parse(confirmation.expiresAt) - Date.now()));
    timer.unref?.();
    pauseWallClock(run);
    run.pending = { confirmation, resolve: settle };
    db.query("UPDATE agent_runs SET status = 'awaiting_confirmation' WHERE id = ?").run(run.runId);
    db.query("UPDATE chat_messages SET status = 'awaiting_confirmation' WHERE id = ? AND status = 'streaming'").run(messageId);
    channel.emit({ type: "confirmation_required", data: { messageId, ...confirmation } });
    run.controller.signal.addEventListener("abort", onAbort, { once: true });
    if (run.controller.signal.aborted) onAbort();
  });
}

const argsHashOf = (args: unknown) => createHash("sha256").update(JSON.stringify(args)).digest("hex");
const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Allow once or Deny (POST /api/runs/:id/confirm): the chat's owner, the pending card only, single
 * use (T324, review M1). The card is named by the server's nonce and the hash of the arguments it
 * showed; a settled card's nonce never matches again, so a replayed or stale answer is a 409.
 */
export function confirmRun(runId: string, userId: string, answer: { confirmationId: string; argsHash: string }, decision: "once" | "deny") {
  runOwnedBy(runId, userId);
  const live = active.get(runId);
  const pending = live?.pending;
  if (!pending || !sameText(pending.confirmation.confirmationId, answer.confirmationId) || !sameText(pending.confirmation.argsHash, answer.argsHash)) {
    throw new AgentError(409, "NO_PENDING_CONFIRMATION", "This run is not waiting on that confirmation");
  }
  pending.resolve(decision === "once" ? "allowed" : "denied");
  return { ok: true as const, decision: decision === "once" ? "allowed" as const : "denied" as const };
}

/** The confirmation a live run waits on, for a reload of the chat. */
export const pendingConfirmationFor = (runId: string | null): PendingConfirmation | null => (runId ? active.get(runId)?.pending?.confirmation ?? null : null);

async function execute(run: ActiveRun, channel: RunChannel, agent: AgentRow, actor: { userId: string; role: string; displayName: string }, chat: ChatRow, messageId: string, parentId: string, connection: ReturnType<typeof connectionFor>) {
  const displayName = actor.displayName;
  const timeoutS = config.agents.runTimeoutS || CHAT_RUN_TIMEOUT_S;
  startWallClock(run, timeoutS * 1000);
  const executor = toolExecutor(run, channel, agent, messageId);
  let text = "";
  let flushedAt = Date.now();
  let flushedLength = 0;
  let pendingDelta = "";
  let deltaTimer: ReturnType<typeof setTimeout> | null = null;
  let firstToken = false;
  const flushDelta = () => {
    deltaTimer = null;
    if (!pendingDelta) return;
    channel.emit({ type: "delta", data: { messageId, text: pendingDelta } });
    pendingDelta = "";
  };
  const persist = (force = false) => {
    if (!force && Date.now() - flushedAt < 1000 && text.length - flushedLength < 2048) return;
    flushedAt = Date.now();
    flushedLength = text.length;
    flushAssistantText(messageId, text);
  };
  let usage: TokenUsage | null = null;
  let model: string | null = null;
  let status: RunStatus = "running";
  let errorCode: RunErrorCode | null = null;
  let errorMessage: string | null = null;
  let toolCallCount = 0;
  let droppedToolCalls = 0;
  try {
    db.query("UPDATE agent_runs SET status = 'running', started_at = ? WHERE id = ?").run(now(), run.runId);
    const turns = windowTurns(agent, displayName, pathTo(chat.id, parentId), connection.compat.contextTokens);
    const result = await runLoop({
      connection,
      messages: turns,
      maxSteps: Math.min(agent.max_steps, AGENT_BOUNDS.maxSteps.max),
      temperature: agent.temperature,
      maxOutputTokens: agent.max_output_tokens,
      signal: run.controller.signal,
      sink: {
        delta: (chunk) => {
          if (!firstToken) {
            firstToken = true;
            db.query("UPDATE agent_runs SET first_token_at = ? WHERE id = ?").run(now(), run.runId);
          }
          // Past the stored bound nothing more is kept or streamed (review L5): the final cut adds its marker,
          // and the browser never lexes more than it will ever show. One extra character marks the overflow.
          const cap = AGENT_BOUNDS.assistantMessageChars;
          if (text.length > cap) return;
          const room = cap - text.length;
          const kept = chunk.length > room ? chunk.slice(0, room) : chunk;
          text += chunk.length > room ? chunk.slice(0, room + 1) : chunk;
          pendingDelta += kept;
          // Coalesced to at most one event every 50 ms (plan §2.3).
          deltaTimer ??= setTimeout(flushDelta, 50);
          persist();
        },
        usage: (stepUsage, stepModel) => {
          channel.emit({ type: "usage", data: { messageId, usage: stepUsage } });
          model = stepModel ?? model;
        }
      },
      charge: (stepUsage, more) => {
        chargeUsage(run.userId, agent.id, stepUsage, 0);
        // The next step would exceed the budget (plan §2.2): the run ends `budget` before another model call.
        if (more) assertBudget(run.userId);
      },
      tools: executor.tools,
      execute: executor.execute,
      noToolsReason: () => inactiveLinkMessage(agent.id, run.userId)
    });
    usage = result.usage;
    model = result.model ?? model;
    toolCallCount = result.toolCalls;
    droppedToolCalls = result.droppedToolCalls;
    status = result.status === "step_limit" ? "step_limit" : "ok";
  } catch (error) {
    const reason = run.controller.signal.aborted ? (run.controller.signal.reason as CancelReason | undefined) ?? "stop" : null;
    if (reason === "timeout") status = "timeout";
    else if (reason) status = "cancelled";
    else if (error instanceof ProviderError) {
      status = "error";
      errorCode = error.code;
      errorMessage = error.message;
    } else if (error instanceof AgentError && error.code === "BUDGET_EXCEEDED") {
      status = "budget";
      errorCode = "BUDGET_EXCEEDED";
      errorMessage = error.message;
    } else {
      status = "error";
      errorCode = "INTERNAL";
      errorMessage = "Something went wrong while answering";
      console.error("Agent run failed", error instanceof Error ? error.name : "Unknown error");
    }
  } finally {
    stopWallClock(run);
    if (deltaTimer) clearTimeout(deltaTimer);
    flushDelta();
    active.delete(run.runId);
  }
  const messageStatus = status === "ok" ? "complete" : status === "step_limit" ? "step_limit" : status === "cancelled" || status === "timeout" ? "cancelled" : "error";
  // A call still open when the run ended (Stop during a tool, a timeout) is closed on the message.
  for (const view of run.toolCalls) if (view.ok === null) { view.ok = false; view.resultPreview ??= status === "cancelled" || status === "timeout" ? "Stopped" : "The run ended before the tool answered"; }
  try {
    db.transaction(() => {
      finishAssistantMessage(messageId, { status: messageStatus, content: text, errorCode, usage, model, toolCalls: run.toolCalls });
      db.query("UPDATE agent_runs SET status = ?, error_code = ?, steps = ?, tool_calls = ?, prompt_tokens = ?, completion_tokens = ?, tokens_estimated = ?, finished_at = ? WHERE id = ?")
        .run(status, errorCode, usage ? 1 : 0, toolCallCount || run.toolCalls.length, usage?.promptTokens ?? 0, usage?.completionTokens ?? 0, usage?.estimated ? 1 : 0, now(), run.runId);
      chargeUsage(run.userId, agent.id, { promptTokens: 0, completionTokens: 0, estimated: false }, 1);
      db.query("UPDATE chats SET updated_at = ? WHERE id = ?").run(now(), chat.id);
    })();
  } catch (error) {
    // Never leave the row streaming (QA Q4): the message ends as an error with a message, the run as recorded as it can be.
    console.error("Agent run could not be recorded", error instanceof Error ? error.name : "Unknown error");
    status = "error";
    errorCode = "INTERNAL";
    errorMessage = "The answer could not be saved";
    try {
      db.query("UPDATE chat_messages SET content = CASE WHEN length(content) > ? THEN substr(content, 1, ?) ELSE content END, status = 'error', error_code = 'INTERNAL', finished_at = ? WHERE id = ?")
        .run(AGENT_BOUNDS.assistantMessageChars, AGENT_BOUNDS.assistantMessageChars, now(), messageId);
      db.query("UPDATE agent_runs SET status = 'error', error_code = 'INTERNAL', finished_at = ? WHERE id = ?").run(now(), run.runId);
    } catch (again) {
      console.error("Agent run could not be marked failed", again instanceof Error ? again.name : "Unknown error");
    }
  }
  audit(run.userId, null, "agents.run.finish", { runId: run.runId, chatId: chat.id, status, errorCode, toolCalls: run.toolCalls.length, droppedToolCalls, promptTokens: usage?.promptTokens ?? 0, completionTokens: usage?.completionTokens ?? 0 });
  if (errorCode && errorMessage) channel.emit({ type: "error", data: { code: errorCode, message: errorMessage } });
  channel.emit({ type: "done", data: { status, messageId } });
  channel.close();
}

/** Stop (plan §2.2): the chat's owner aborts its live run. */
export function cancelRun(runId: string, userId: string, reason: CancelReason = "stop") {
  const run = runOwnedBy(runId, userId);
  const live = active.get(runId);
  if (!live) return { status: run.status };
  live.controller.abort(reason);
  return { status: "cancelled" as const };
}

export type RunRow = { id: string; chat_id: string | null; user_id: string; status: RunStatus; error_code: string | null; prompt_tokens: number; completion_tokens: number; tokens_estimated: number; model: string; queued_at: string; finished_at: string | null };

/** A run of a chat this person owns, or the 404 (T325). */
export function runOwnedBy(runId: string, userId: string): RunRow {
  const row = db.query("SELECT * FROM agent_runs WHERE id = ? AND via = 'chat' AND user_id = ?").get(runId, userId) as RunRow | null;
  if (!row) throw new AgentError(404, "NOT_FOUND", "Not found");
  return row;
}

/** The assistant message a run writes, for the snapshot a resume gets once the ring is gone. */
export function runSnapshot(run: RunRow) {
  const message = db.query("SELECT id, content, status, usage_json, error_code, tool_calls_json FROM chat_messages WHERE run_id = ? AND role = 'assistant'").get(run.id) as { id: string; content: string; status: MessageRow["status"]; usage_json: string | null; error_code: string | null; tool_calls_json: string | null } | null;
  let usage: TokenUsage | null = null;
  try { usage = message?.usage_json ? JSON.parse(message.usage_json) as TokenUsage : null; } catch { usage = null; }
  const live = active.get(run.id);
  return {
    status: run.status, messageId: message?.id ?? "", content: message?.content ?? "", messageStatus: message?.status ?? "error", usage, errorCode: message?.error_code ?? null,
    toolCalls: live ? live.toolCalls : parseToolCalls(message?.tool_calls_json ?? null), pendingConfirmation: live?.pending?.confirmation ?? null
  };
}

/** Cancels every live run of a chat (deleting the chat, plan §2.2). */
export function cancelChatRuns(chatId: string) {
  for (const run of active.values()) if (run.chatId === chatId) run.controller.abort("chat_deleted" satisfies CancelReason);
}

/**
 * Boot (plan §2.2 "Restart"): runs the previous process left live become `interrupted`, and their
 * streaming assistant rows keep the text that was flushed, marked `interrupted`. Returns the count.
 */
export function markInterruptedRuns(log: (line: string) => void = (line) => console.log(line)) {
  const changed = db.transaction(() => {
    const runs = db.query("UPDATE agent_runs SET status = 'interrupted', error_code = NULL, finished_at = ? WHERE status IN ('queued','running','awaiting_confirmation')").run(now()).changes;
    db.query("UPDATE chat_messages SET status = 'interrupted', finished_at = ? WHERE status IN ('streaming','awaiting_confirmation')").run(now());
    return runs;
  })();
  if (changed > 0) log(`Agents: ${changed} ${changed === 1 ? "run" : "runs"} the previous process left running ${changed === 1 ? "is" : "are"} marked interrupted.`);
  return changed;
}

/** The channel a resume reads, or null when the run has ended and its ring is gone. */
export const runChannel = (runId: string) => channelOf(runId);

/** Test hook: forget every live run (their loops end on their own). */
export function resetRunsForTests() {
  for (const run of active.values()) run.controller.abort("stop" satisfies CancelReason);
  active.clear();
}
