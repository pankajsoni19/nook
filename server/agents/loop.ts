import { AGENT_BOUNDS, MODEL_TIMEOUTS, type ProviderCompat, type TokenUsage } from "../../shared/agents";
import { EgressError, egressFetch, readEgressText, type EgressResponse } from "./egress";

/**
 * The model adapter and the agent loop (plan §2.1, D341, D342): OpenAI-compatible Chat Completions
 * over plain `fetch` through the egress guard, streamed, with `stream_options.include_usage`. No
 * SDK. AC-A ships the loop without tools, so a run is one model call; the step loop keeps its
 * shape (the last step goes out without tools; `max_steps` bounds the calls) for AC-B, which adds
 * tool calls, confirmations, and result caps.
 *
 * Errors never carry the provider's response body beyond a bounded, letter-only excerpt of its
 * `error.message` (a key never appears there), and never the API key (T309).
 */

export type ProviderConnection = { id: string; baseUrl: string; apiKey: string | null; model: string; compat: ProviderCompat };
/** A tool call as the model emitted it (plan §2.1): `arguments` is the raw JSON text. */
export type ModelToolCall = { id: string; name: string; arguments: string };
/** The wire turns (OpenAI Chat Completions): an assistant turn may carry `tool_calls`; a `tool` turn answers one. */
export type ChatTurn =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };
/** A tool as offered to the model (`tools: [{type: "function", function}]`). */
export type ModelTool = { name: string; description: string; parameters: Record<string, unknown> };
export type CompletionRequest = { messages: ChatTurn[]; model?: string; temperature?: number | null; maxOutputTokens?: number; tools?: ModelTool[] };
export type CompletionResult = { content: string; finishReason: string | null; usage: TokenUsage; model: string | null; toolCalls: ModelToolCall[] };

export class ProviderError extends Error {
  /** The fuller excerpt for admin surfaces (Test, the models list); `message` is what a chat's owner sees (review L3). */
  readonly adminMessage: string;
  constructor(readonly code: "PROVIDER_ERROR" | "MODEL_TIMEOUT" | "EGRESS_REFUSED" | "TOO_LARGE", message: string, readonly status: number | null = null, adminMessage?: string) {
    super(message);
    this.name = "ProviderError";
    this.adminMessage = adminMessage ?? message;
  }
}

/** The model-call timeouts (plan §2.2), on an object so tests can shorten them. */
export const modelTimeouts = { ...MODEL_TIMEOUTS };

/**
 * The byte cap on a model stream (plan §3.2 item 5) and on the models list. Memory worst case: a
 * stream is parsed chunk by chunk and its text is kept only up to the stored bound (256 KiB plus one
 * character), so a provider that sends the full 8 MiB costs at most one SSE event's buffer plus
 * 256 KiB of text per run, times the instance's run slots (`AGENT_MAX_CONCURRENT_RUNS`, 4 by
 * default): about 1 MiB, bounded and transient (review L5, L11; QA Q4). The live stream to browsers
 * stops at the same bound.
 */
export const MODEL_STREAM_MAX_BYTES = 8 * 1024 * 1024;
export const MODELS_LIST_MAX_BYTES = 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 64 * 1024;

const headersFor = (connection: ProviderConnection, accept: string) => ({
  Accept: accept,
  "Content-Type": "application/json",
  ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {})
});

/** Characters ÷ 4, the estimate used when a server sends no usage chunk (plan §2.1). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * What a provider's error body may carry into Nook's error text (T309, review L3). Admins get the
 * fuller excerpt: letters, digits, spaces, and plain punctuation, with tokens of 24+ characters
 * elided. Everyone else (a chat's owner, through the run's error event) gets it with every `sk-…`
 * token and every token of 12+ characters elided too, so a key fragment the provider echoes never
 * reaches a non-admin.
 */
export function excerpt(body: string): { admin: string; redacted: string } | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    const message = typeof parsed.error === "string" ? parsed.error : typeof parsed.error?.message === "string" ? parsed.error.message : null;
    if (!message) return null;
    const admin = message.replace(/[^A-Za-z0-9 .,:;()'-]/g, "").replace(/\b[A-Za-z0-9-]{24,}\b/g, "…").slice(0, 160);
    if (!admin) return null;
    return { admin, redacted: redactTokens(admin) };
  } catch {
    return null;
  }
}

/** `sk-…` tokens and any run of 12+ word characters become `…`; repeated ellipses collapse. */
export const redactTokens = (text: string) => text.replace(/\bsk-[A-Za-z0-9_-]+/g, "…").replace(/[A-Za-z0-9_-]{12,}/g, "…").replace(/…(\s*…)+/g, "…");

function rethrow(error: unknown): never {
  if (error instanceof ProviderError) throw error;
  if (error instanceof EgressError) {
    if (error.code === "TIMEOUT") throw new ProviderError("MODEL_TIMEOUT", error.message);
    if (error.code === "TOO_LARGE") throw new ProviderError("TOO_LARGE", error.message);
    if (error.code === "NETWORK") throw new ProviderError("PROVIDER_ERROR", error.message);
    throw new ProviderError("EGRESS_REFUSED", error.message);
  }
  throw error;
}

async function failedResponse(response: EgressResponse): Promise<never> {
  let detail: ReturnType<typeof excerpt> = null;
  try {
    detail = excerpt(await readEgressText(response, ERROR_BODY_MAX_BYTES));
  } catch {
    detail = null;
  }
  const status = response.status;
  const base = status === 401 || status === 403 ? "The provider refused the API key" : status === 404 ? "The provider has no such model or endpoint" : status === 429 ? "The provider is rate limiting this key" : status >= 500 ? "The provider is unavailable" : "The provider refused the request";
  throw new ProviderError("PROVIDER_ERROR", `${base} (HTTP ${status})${detail ? `: ${detail.redacted}` : ""}`, status, `${base} (HTTP ${status})${detail ? `: ${detail.admin}` : ""}`);
}

/** `GET {baseUrl}/models` → model ids (at most 500, sorted). */
export async function listModels(connection: ProviderConnection): Promise<string[]> {
  let response: Awaited<ReturnType<typeof egressFetch>>;
  try {
    response = await egressFetch(`${connection.baseUrl}/models`, { method: "GET", headers: headersFor(connection, "application/json") }, { maxBytes: MODELS_LIST_MAX_BYTES, firstByteMs: modelTimeouts.firstByteMs, idleMs: modelTimeouts.idleMs, totalMs: modelTimeouts.totalMs });
  } catch (error) {
    rethrow(error);
  }
  if (response.status < 200 || response.status >= 300) await failedResponse(response);
  let text: string;
  try {
    text = await readEgressText(response, MODELS_LIST_MAX_BYTES);
  } catch (error) {
    rethrow(error);
  }
  let parsed: { data?: Array<{ id?: unknown }> };
  try { parsed = JSON.parse(text) as { data?: Array<{ id?: unknown }> }; } catch { throw new ProviderError("PROVIDER_ERROR", "The provider's model list was not JSON"); }
  const ids = (Array.isArray(parsed.data) ? parsed.data : []).map((item) => typeof item?.id === "string" ? item.id : null).filter((id): id is string => id !== null && id.length <= 128);
  return [...new Set(ids)].sort().slice(0, 500);
}

type StreamChunk = {
  model?: string;
  choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
};

/**
 * One streamed Chat Completions call. `onDelta` receives content as it arrives. Tool calls are
 * accumulated by index (for AC-B) and returned; the request itself sends no `tools` in AC-A.
 */
export async function completeStreaming(connection: ProviderConnection, request: CompletionRequest, signal: AbortSignal, onDelta: (text: string) => void): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model: request.model ?? connection.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    [connection.compat.tokenParam]: request.maxOutputTokens ?? 4096
  };
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    body.tool_choice = "auto";
  }
  let response: Awaited<ReturnType<typeof egressFetch>>;
  try {
    response = await egressFetch(`${connection.baseUrl}/chat/completions`, { method: "POST", headers: headersFor(connection, "text/event-stream"), body: JSON.stringify(body), signal },
      { maxBytes: MODEL_STREAM_MAX_BYTES, firstByteMs: modelTimeouts.firstByteMs, idleMs: modelTimeouts.idleMs, totalMs: modelTimeouts.totalMs });
  } catch (error) {
    rethrow(error);
  }
  if (response.status < 200 || response.status >= 300) await failedResponse(response);

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let model: string | null = null;
  let usage: TokenUsage | null = null;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const handleChunk = (chunk: StreamChunk) => {
    if (typeof chunk.model === "string" && !model) model = chunk.model.slice(0, 128);
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) {
      // Kept up to the stored bound plus one character (so the caller sees the overflow); the rest is
      // read and dropped, and an estimated usage counts what was kept (QA Q4, review L5/L11).
      if (content.length <= AGENT_BOUNDS.assistantMessageChars) content += choice.delta.content.slice(0, AGENT_BOUNDS.assistantMessageChars + 1 - content.length);
      onDelta(choice.delta.content);
    }
    for (const call of choice?.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      calls.set(index, current);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage && typeof chunk.usage.prompt_tokens === "number") {
      usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens ?? 0, estimated: false, ...(typeof chunk.usage.prompt_tokens_details?.cached_tokens === "number" ? { cachedTokens: chunk.usage.prompt_tokens_details.cached_tokens } : {}) };
    }
  };
  const handleEvent = (event: string) => {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        handleChunk(JSON.parse(data) as StreamChunk);
      } catch {
        // A malformed chunk is skipped; the stream's end decides the outcome.
      }
    }
  };
  try {
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        handleEvent(buffer.slice(0, separator).replace(/\r/g, ""));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(buffer.replace(/\r/g, ""));
  } catch (error) {
    rethrow(error);
  }
  if (!usage) {
    const promptChars = request.messages.reduce((sum, turn) => sum + (turn.content?.length ?? 0), 0);
    usage = { promptTokens: Math.ceil(promptChars / 4), completionTokens: estimateTokens(content), estimated: true };
  }
  return { content, finishReason, usage, model, toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call) };
}

export type LoopSink = { delta: (text: string) => void; usage: (usage: TokenUsage, model: string | null) => void };
/** What a tool call produced: the text the model sees (already capped and marked by the executor). */
export type ToolExecution = { content: string };
export type LoopInput = {
  connection: ProviderConnection;
  messages: ChatTurn[];
  maxSteps: number;
  temperature: number | null;
  maxOutputTokens: number | null;
  signal: AbortSignal;
  sink: LoopSink;
  /** Charged after every step; `more` says another step follows. Throws to stop the run (budgets, revocation). */
  charge: (usage: TokenUsage, more: boolean) => void;
  /**
   * AC-B (plan §2.1): the tools the model may call at this step, re-resolved every step (rights
   * are live, D358). Not called on the last step, which goes out without tools (D342).
   */
  tools?: (step: number) => Promise<ModelTool[]> | ModelTool[];
  /** Runs one call (gate, confirmation, timeout, cap, and marker are the executor's); returns the tool turn's content. */
  execute?: (call: ModelToolCall, step: number) => Promise<ToolExecution>;
  /** Calls run per step and per run (defaults: AGENT_BOUNDS); calls past either are dropped, not executed. */
  limits?: { perStep: number; perRun: number };
};
export type LoopResult = { status: "stop" | "step_limit"; content: string; steps: number; usage: TokenUsage; model: string | null; toolCalls: number; droppedToolCalls: number };

/** The one line an old tool result becomes once it falls out of the run's window (review L4). */
export const OMITTED_TOOL_RESULT = "[An earlier tool result was omitted to keep the conversation short; call the tool again if you need it.]";

/**
 * Keeps the last `keep` tool results of the run whole and replaces older ones with a one-line
 * placeholder (the `tool` turns stay, so every call still has its answer on the wire).
 */
export function windowToolResults(messages: ChatTurn[], keep: number) {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turn = messages[index]!;
    if (turn.role !== "tool") continue;
    seen += 1;
    if (seen > keep && turn.content !== OMITTED_TOOL_RESULT) turn.content = OMITTED_TOOL_RESULT;
  }
}

/**
 * The loop (plan §2.1, D342, D343). Each step is one model call. Tool calls run one at a time in
 * the model's order; their results go back as `tool` turns and the loop continues. The last step
 * goes out without tools and ends `step_limit` when the model still wanted one. Without tools
 * offered, a call the model invents anyway ends the run as a plain answer.
 */
export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const total: TokenUsage = { promptTokens: 0, completionTokens: 0, estimated: false };
  let content = "";
  let model: string | null = null;
  let toolCalls = 0;
  let droppedToolCalls = 0;
  let offeredAny = false;
  const perStep = input.limits?.perStep ?? AGENT_BOUNDS.toolCallsPerStep;
  const perRun = input.limits?.perRun ?? AGENT_BOUNDS.toolCallsPerRun;
  for (let step = 1; step <= input.maxSteps; step += 1) {
    const last = step === input.maxSteps;
    const tools = last || !input.tools || !input.connection.compat.supportsTools || toolCalls >= perRun ? [] : await input.tools(step);
    offeredAny ||= tools.length > 0;
    windowToolResults(input.messages, AGENT_BOUNDS.toolResultsWindow);
    const reply = await completeStreaming(input.connection, { messages: input.messages, temperature: input.temperature, maxOutputTokens: input.maxOutputTokens ?? undefined, tools }, input.signal, input.sink.delta);
    total.promptTokens += reply.usage.promptTokens;
    total.completionTokens += reply.usage.completionTokens;
    total.estimated = total.estimated || reply.usage.estimated;
    model = reply.model ?? model;
    if (reply.content) content += (content && reply.toolCalls.length === 0 && !content.endsWith("\n") ? "\n\n" : "") + reply.content;
    input.sink.usage(reply.usage, reply.model);
    const execute = input.execute;
    const wantedCalls = tools.length > 0 && execute ? reply.toolCalls.filter((call) => call.name) : [];
    // Per step and per run (review L4): calls past either cap are dropped here, never executed, with
    // no event or audit row each; the run's finish row counts them, and the model is told once.
    const room = Math.max(0, Math.min(perStep, perRun - toolCalls));
    // Call ids are Nook's, never the model's (review M1): `call_<step>_<index>`, unique in the run.
    const calls = wantedCalls.slice(0, room).map((call, index) => ({ ...call, id: `call_${step}_${index}` }));
    const dropped = wantedCalls.length - calls.length;
    droppedToolCalls += dropped;
    // Charged after every step; with more steps ahead a used-up budget ends the run here (plan §2.2).
    input.charge(reply.usage, calls.length > 0);
    if (calls.length === 0 || !execute) {
      input.messages.push({ role: "assistant", content: reply.content });
      // On the last step the model got no tools (D342); still wanting one after earlier steps had them is the step limit.
      const wanted = last && offeredAny && reply.toolCalls.length > 0;
      return { status: wanted ? "step_limit" : "stop", content, steps: step, usage: total, model, toolCalls, droppedToolCalls };
    }
    input.messages.push({ role: "assistant", content: reply.content, tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) });
    for (const [index, call] of calls.entries()) {
      toolCalls += 1;
      const outcome = await execute(call, step);
      const note = dropped > 0 && index === calls.length - 1 ? `\n[${dropped} more tool ${dropped === 1 ? "call" : "calls"} in this step ${dropped === 1 ? "was" : "were"} dropped: at most ${perStep} calls run per step and ${perRun} per answer.]` : "";
      input.messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content + note });
    }
  }
  return { status: "step_limit", content, steps: input.maxSteps, usage: total, model, toolCalls, droppedToolCalls };
}
