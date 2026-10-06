import { api, ApiError, getCsrfToken, noteRequestOutcome } from "../api";
import type { AgentApiUsage, AuditRunDetail, AuditRunSummary, AgentDetail, AgentSettings, AgentSummary, AgentToolRef, ChatDetail, ChatMessage, ChatSummary, DailyUsage, DeclaredStdioServer, LinkableKey, NookLink, ProviderCompat, ProviderSummary, RunEvent, ServerAuthKind, ServerAvailability, ToolCatalog, ToolPolicy, ToolServerSummary } from "../../shared/agents";

/** The agent chat API (docs/plan/API_CONTRACTS.md § Agent chat), plus the SSE reader for runs. */

export type AgentsStatus = { enabled: boolean; reason: "unset" | "key_mismatch" | null; canChat: boolean; canCreate: boolean; defaultModel: string; auditVisible?: boolean };

// The Audit log (AC-C, plan §7.3): the key's owner in full, admins metadata only.
export type AuditFilter = { key?: string | null; agent?: string | null; status?: string | null; from?: string | null; to?: string | null };
const auditQuery = (filter: AuditFilter, extra: Record<string, string> = {}) => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries({ ...filter, ...extra })) if (value) params.set(name, value);
  const text = params.toString();
  return text ? `?${text}` : "";
};
export const listAudit = (filter: AuditFilter, cursor?: string | null) => api<{ runs: AuditRunSummary[]; nextCursor: string | null }>(`/agents/audit${auditQuery(filter, cursor ? { cursor } : {})}`);
export const getAuditRun = (runId: string) => api<{ run: AuditRunDetail }>(`/agents/audit/${runId}`);
/** The export's URL (a same-origin GET with the session; the browser saves the attachment). */
export const auditExportUrl = (filter: AuditFilter, runId?: string | null) => `/api/agents/audit/export${auditQuery(filter, runId ? { runId } : {})}`;
export const agentApiUsage = (agentId: string) => api<{ usage: AgentApiUsage }>(`/agents/${agentId}/api-usage`);
export const agentsStatus = () => api<AgentsStatus>("/agents/status");

export const listAgents = () => api<{ agents: AgentSummary[] }>("/agents");
export const getAgent = (id: string) => api<{ agent: AgentDetail }>(`/agents/${id}`);
export type AgentInput = { name: string; description?: string; icon?: string | null; color?: string | null; systemPrompt?: string; providerId?: string | null; model?: string | null; maxSteps?: number; temperature?: number | null; maxOutputTokens?: number | null; starters?: string[]; tools?: AgentToolRef[]; nookDirectWrites?: boolean };
export const createAgent = (input: AgentInput) => api<{ agent: AgentDetail }>("/agents", { method: "POST", body: JSON.stringify(input) });
export const updateAgent = (id: string, input: Partial<AgentInput> & { expectedRevision: number }) => api<{ agent: AgentDetail }>(`/agents/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteAgent = (id: string) => api<{ ok: true }>(`/agents/${id}`, { method: "DELETE", body: "{}" });
export const myUsage = () => api<{ usage: DailyUsage }>("/agents/usage");

export const listChats = (q?: string) => api<{ chats: ChatSummary[] }>(`/chats${q ? `?q=${encodeURIComponent(q)}` : ""}`);
export const getChat = (id: string) => api<ChatDetail>(`/chats/${id}`);
export const createChat = (agentId: string) => api<{ chat: ChatSummary }>("/chats", { method: "POST", body: JSON.stringify({ agentId }) });
export const updateChat = (id: string, input: { title?: string; pinned?: boolean; activeLeafId?: string | null; expectedRevision: number }) => api<{ chat: ChatSummary }>(`/chats/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteChat = (id: string) => api<{ ok: true }>(`/chats/${id}`, { method: "DELETE", body: "{}" });
export type StartedRun = { runId: string; userMessage: ChatMessage | null; assistantMessage: ChatMessage };
/** `parentId` undefined: under the active leaf; null: a new first message (an edit of the first turn). */
export const sendMessage = (chatId: string, content: string, parentId?: string | null) => api<StartedRun>(`/chats/${chatId}/messages`, { method: "POST", body: JSON.stringify({ content, ...(parentId !== undefined ? { parentId } : {}) }) });
export const regenerate = (chatId: string, messageId: string) => api<StartedRun>(`/chats/${chatId}/messages/${messageId}/regenerate`, { method: "POST", body: "{}" });
export const cancelRun = (runId: string) => api<{ status: string }>(`/runs/${runId}/cancel`, { method: "POST", body: "{}" });
// AC-B: confirmations, the tool catalog, and the Link Nook key sheet.
/** Answers the card it was shown (review M1): the server's nonce and the arguments' hash, never the model's call id. */
export const confirmRun = (runId: string, card: { confirmationId: string; argsHash: string }, decision: "once" | "deny") => api<{ ok: true; decision: "allowed" | "denied" }>(`/runs/${runId}/confirm`, { method: "POST", body: JSON.stringify({ confirmationId: card.confirmationId, argsHash: card.argsHash, decision }) });
export const toolCatalog = (agentId?: string | null) => api<{ catalog: ToolCatalog }>(`/agents/catalog${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`);
export const agentLink = (agentId: string) => api<{ link: NookLink; keys: LinkableKey[] }>(`/agents/${agentId}/link`);
export const setAgentLink = (agentId: string, nookKeyId: string | null) => api<{ link: NookLink }>(`/agents/${agentId}/link`, { method: "PUT", body: JSON.stringify({ nookKeyId }) });

// Admin (Settings → AI).
export type ProviderInput = { name: string; baseUrl?: string; apiKey?: string | null; defaultModel?: string; compat?: Partial<ProviderCompat>; isDefault?: boolean };
export const listProviders = () => api<{ providers: ProviderSummary[] }>("/agents/admin/providers");
export const createProvider = (input: ProviderInput) => api<{ provider: ProviderSummary }>("/agents/admin/providers", { method: "POST", body: JSON.stringify(input) });
export const updateProvider = (id: string, input: Partial<ProviderInput> & { expectedRevision: number; removeSecret?: boolean }) => api<{ provider: ProviderSummary }>(`/agents/admin/providers/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteProvider = (id: string) => api<{ ok: true }>(`/agents/admin/providers/${id}`, { method: "DELETE", body: "{}" });
export type ProviderTest = { ok: boolean; models: { ok: boolean; count: number | null; latencyMs: number | null; error: string | null }; completion: { ok: boolean; model: string | null; latencyMs: number | null; error: string | null } };
export const testProvider = (id: string) => api<{ test: ProviderTest }>(`/agents/admin/providers/${id}/test`, { method: "POST", body: "{}" });
export const providerModels = (id: string) => api<{ models: string[]; cachedAt: string }>(`/agents/admin/providers/${id}/models`);
export type ToolServerInput = { name: string; slug?: string; url?: string | null; stdioId?: string | null; authKind?: ServerAuthKind; authHeader?: string | null; secret?: string | null; timeoutMs?: number; resultCapBytes?: number; availability?: ServerAvailability; enabled?: boolean };
export type ToolServerList = { servers: ToolServerSummary[]; stdio: { enabled: boolean; declared: DeclaredStdioServer[] } };
export const listServers = () => api<ToolServerList>("/agents/admin/servers");
export const createServer = (input: ToolServerInput) => api<{ server: ToolServerSummary }>("/agents/admin/servers", { method: "POST", body: JSON.stringify(input) });
export const updateServer = (id: string, input: Partial<ToolServerInput> & { expectedRevision: number; removeSecret?: boolean }) => api<{ server: ToolServerSummary }>(`/agents/admin/servers/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteServer = (id: string) => api<{ ok: true }>(`/agents/admin/servers/${id}`, { method: "DELETE", body: "{}" });
export const syncServer = (id: string) => api<{ server: ToolServerSummary }>(`/agents/admin/servers/${id}/sync`, { method: "POST", body: "{}" });
export const setServerPolicies = (id: string, policies: Record<string, ToolPolicy>) => api<{ server: ToolServerSummary }>(`/agents/admin/servers/${id}/policies`, { method: "PUT", body: JSON.stringify({ policies }) });
export const readSettings = () => api<{ settings: AgentSettings & { revision: number } }>("/agents/admin/settings");
export const writeSettings = (patch: Partial<AgentSettings> & { expectedRevision: number }) => api<{ settings: AgentSettings & { revision: number } }>("/agents/admin/settings", { method: "PUT", body: JSON.stringify(patch) });

export function errorCode(reason: unknown): string | null {
  if (reason instanceof ApiError && reason.payload && typeof reason.payload === "object" && "code" in reason.payload) return String((reason.payload as { code: unknown }).code);
  return null;
}
export const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;

export type SequencedRunEvent = RunEvent & { seq: number };

/**
 * Follows a run's events (plan §2.3) over `fetch` plus a ReadableStream: EventSource cannot send
 * the CSRF header, and `credentials: "same-origin"` keeps the session. Resumes from `after`. The
 * promise settles when the run ends (`done` or `snapshot`), the signal aborts, or the connection
 * drops (then it rejects, and the caller reconnects with the last seq it saw).
 */
export async function followRun(runId: string, after: number, onEvent: (event: SequencedRunEvent) => void, signal: AbortSignal): Promise<"ended" | "aborted"> {
  let response: Response;
  try {
    response = await fetch(`/api/runs/${runId}/events?after=${after}`, { headers: { Accept: "text/event-stream", "X-CSRF-Token": getCsrfToken() }, credentials: "same-origin", signal });
  } catch (error) {
    if (signal.aborted) return "aborted";
    noteRequestOutcome(false);
    throw error;
  }
  noteRequestOutcome(response.status < 500);
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`, response.status, payload);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  // Wave 41 QA L8: after `done` the server closes the stream itself; reading on to that close (with a
  // short fallback) ends the response cleanly instead of cancelling it mid-body, which browsers log.
  let fallback: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { closed = true; break; }
      if (ended) continue;
      buffer += decoder.decode(value, { stream: true });
      let at = buffer.indexOf("\n\n");
      while (at >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        at = buffer.indexOf("\n\n");
        const event = parseFrame(frame);
        if (!event) continue;
        onEvent(event);
        if (event.type === "done" || event.type === "snapshot") ended = true;
      }
      if (ended && !fallback) fallback = setTimeout(() => { reader.cancel().catch(() => undefined); }, 2000);
    }
  } catch (error) {
    if (signal.aborted) return "aborted";
    if (!ended) throw error;
  } finally {
    if (fallback) clearTimeout(fallback);
    // A body the server finished is left alone (cancelling it then is logged as an aborted request).
    if (!closed) { try { reader.cancel().catch(() => undefined); } catch { /* closed */ } }
  }
  if (ended) return "ended";
  if (signal.aborted) return "aborted";
  throw new Error("The connection to the run was lost");
}

/** One SSE frame → an event, or null for comments and malformed frames. Exported for tests. */
export function parseFrame(frame: string): SequencedRunEvent | null {
  if (!frame.trim() || frame.startsWith(":")) return null;
  let seq = 0;
  let type = "";
  let data = "";
  for (const line of frame.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") seq = Number(value) || 0;
    else if (field === "event") type = value;
    else if (field === "data") data += value;
  }
  if (!type) return null;
  try {
    return { seq, type, data: JSON.parse(data) } as SequencedRunEvent;
  } catch {
    return null;
  }
}
