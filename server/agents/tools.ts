import { audit, db, now } from "../db";
import { listApiKeys, ownApiKey } from "../apiKeys";
import { loadLiveKey, type McpKeyContext } from "../mcpTools";
import type { AgentToolPolicy, AgentToolRef, LinkableKey, NookLink, ToolCatalog, ToolPolicy } from "../../shared/agents";
import type { AgentRow } from "./agentsService";
import { nookCatalogFor, nookToolSpec, nookToolsFor, type NookResolved } from "./nookBridge";
import { AgentError } from "./status";
import { defaultPolicy, parseTools, serverAvailableTo, serverPolicies, serverRowOrNull, serversAvailableTo, type ToolServerRow } from "./toolServers";

/**
 * An agent's tools (plan §5.2, §5.3, D358, D359; Wave 41 AC-B): the picks in `agent_tools`, the
 * runner's linked Nook key in `agent_user_links`, the catalog the picker shows, and the per-step
 * resolution of what the model may call right now. Rights are live (T81): a server that was
 * disabled, a policy set to `off`, or a key that was revoked drops its tools at the next step.
 *
 * Model-facing names are `<slug>__<tool>` (Nook: `nook__<tool>`), `[A-Za-z0-9_-]`, at most 64
 * characters, unique per agent; the resolved list maps them back.
 */

export type ResolvedTool = {
  modelName: string;
  kind: "server" | "nook";
  serverId: string | null;
  /** The slug (servers) or "nook". */
  server: string;
  serverName: string;
  toolName: string;
  description: string;
  parameters: Record<string, unknown>;
  policy: Exclude<ToolPolicy, "off">;
  openWorld: boolean;
  resultCapBytes: number;
  timeoutMs: number;
  serverRow: ToolServerRow | null;
  nook: NookResolved | null;
};

type ToolRow = { agent_id: string; source: "server" | "nook" | "knowledge"; server_id: string | null; tool_name: string | null; kb_id: string | null; policy: AgentToolPolicy };

export function agentToolRefs(agentId: string): AgentToolRef[] {
  const rows = db.query("SELECT * FROM agent_tools WHERE agent_id = ? ORDER BY source, server_id, tool_name").all(agentId) as ToolRow[];
  const refs: AgentToolRef[] = [];
  for (const row of rows) {
    if (row.source === "server" && row.server_id && row.tool_name) refs.push({ source: "server", serverId: row.server_id, toolName: row.tool_name, policy: row.policy });
    else if (row.source === "nook" && row.tool_name) refs.push({ source: "nook", toolName: row.tool_name });
  }
  return refs;
}

/** Replaces the agent's picks (PATCH `tools`): every server tool must exist in a catalog the editor may see; every Nook tool must be offered. */
export function setAgentTools(agentId: string, role: string, refs: AgentToolRef[]) {
  const visible = new Map(serversAvailableTo(role).map((row) => [row.id, new Set(parseTools(row.tools_json).map((tool) => tool.name))]));
  const nook = new Set(nookCatalogFor(null).map((tool) => tool.name));
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = ref.source === "server" ? `server:${ref.serverId}:${ref.toolName}` : `nook:${ref.toolName}`;
    if (seen.has(key)) throw new AgentError(400, "INVALID", "A tool is listed twice", { field: "tools" });
    seen.add(key);
    if (ref.source === "server" && !visible.get(ref.serverId)?.has(ref.toolName)) throw new AgentError(400, "INVALID", "A picked tool is not in a server you can use", { field: "tools" });
    if (ref.source === "nook" && !nook.has(ref.toolName)) throw new AgentError(400, "INVALID", "A picked Nook tool is not offered to agents", { field: "tools" });
  }
  db.query("DELETE FROM agent_tools WHERE agent_id = ?").run(agentId);
  const insert = db.query("INSERT INTO agent_tools (agent_id, source, server_id, tool_name, kb_id, policy) VALUES (?, ?, ?, ?, NULL, ?)");
  for (const ref of refs) {
    if (ref.source === "server") insert.run(agentId, "server", ref.serverId, ref.toolName, ref.policy);
    else insert.run(agentId, "nook", null, ref.toolName, null);
  }
}

// --- Links (plan §5.3, D359): a pointer to one of the runner's own keys, never a token ---------------

type LinkRow = { agent_id: string; user_id: string; nook_key_id: string | null; pinned: number };

export function linkRow(agentId: string, userId: string): LinkRow | null {
  return db.query("SELECT * FROM agent_user_links WHERE agent_id = ? AND user_id = ?").get(agentId, userId) as LinkRow | null;
}

/** Whether a key may be linked: the caller's own live general key with the MCP surface. */
function linkableKey(userId: string, keyId: string) {
  const key = ownApiKey(userId, keyId);
  if (!key || key.kind !== "general" || key.surfaces === "rest" || (key.state !== "active" && key.state !== "grace")) return null;
  return key;
}

const linkable = (key: ReturnType<typeof listApiKeys>["keys"][number]): LinkableKey => ({
  id: key.id, name: key.name, prefix: key.prefix, state: key.state, expiresAt: key.expiresAt,
  grants: key.grants.map((grant) => ({ module: grant.module, permission: grant.permission, resource: grant.resource ? { kind: grant.resource.kind, name: grant.resource.name } : null, active: grant.active }))
});

/** The keys the Link Nook key sheet lists: the caller's own live general keys with the MCP surface. */
export function linkableKeys(userId: string): LinkableKey[] {
  return listApiKeys(userId).keys.filter((key) => key.kind === "general" && key.surfaces !== "rest" && (key.state === "active" || key.state === "grace")).map(linkable);
}

export function currentLink(agentId: string, userId: string): NookLink {
  const row = linkRow(agentId, userId);
  if (!row?.nook_key_id) return null;
  const key = ownApiKey(userId, row.nook_key_id);
  if (!key) return null;
  return { keyId: key.id, name: key.name, prefix: key.prefix, state: key.state };
}

/** Sets or clears the caller's link on an agent they may use. A key that is not theirs or not live is the same 404. */
export function setLink(userId: string, agentId: string, keyId: string | null): NookLink {
  if (keyId !== null && !linkableKey(userId, keyId)) throw new AgentError(404, "NOT_FOUND", "Not found");
  db.query(`INSERT INTO agent_user_links (agent_id, user_id, nook_key_id) VALUES (?, ?, ?)
    ON CONFLICT(agent_id, user_id) DO UPDATE SET nook_key_id = excluded.nook_key_id`).run(agentId, userId, keyId);
  audit(userId, null, keyId ? "agents.link.set" : "agents.link.clear", { agentId, keyId });
  return currentLink(agentId, userId);
}

/**
 * The runner's linked key as it stands now (plan §5.3): theirs, live, general, with the MCP
 * surface; null when any of that fails (the Nook tools then vanish at this step, T311, T319).
 */
export function liveLinkedKey(agentId: string, userId: string): McpKeyContext | null {
  const row = linkRow(agentId, userId);
  if (!row?.nook_key_id) return null;
  const key = loadLiveKey(row.nook_key_id, "mcp");
  if (!key || key.userId !== userId || key.kind !== "general") return null;
  return key;
}

// --- The catalog (plan §12 `GET /api/agents/catalog`) -----------------------------------------------

export function catalogFor(role: string, agentId: string | null, userId: string): ToolCatalog {
  const servers = serversAvailableTo(role).map((row) => {
    const policies = serverPolicies(row.id);
    return {
      id: row.id, slug: row.slug, name: row.name, enabled: row.enabled === 1, status: row.status as ToolCatalog["servers"][number]["status"], availability: row.visibility === "all_users" ? "all" as const : "admins" as const,
      tools: parseTools(row.tools_json).map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, readOnly: tool.readOnly, openWorld: tool.openWorld, policy: policies.get(tool.name) ?? defaultPolicy(tool) }))
    };
  });
  const key = agentId ? liveLinkedKey(agentId, userId) : null;
  return { servers, nook: { linked: key !== null, tools: nookCatalogFor(key) } };
}

// --- Per-step resolution (plan §2.1 `toolCatalog`, D358) ---------------------------------------------

const MODEL_NAME = /[^A-Za-z0-9_-]/g;

function uniqueName(base: string, taken: Set<string>) {
  let name = base.replace(MODEL_NAME, "_").slice(0, 64);
  let suffix = 2;
  while (taken.has(name)) {
    const tail = `_${suffix++}`;
    name = `${base.replace(MODEL_NAME, "_").slice(0, 64 - tail.length)}${tail}`;
  }
  taken.add(name);
  return name;
}

/**
 * How an API or MCP run resolves tools (AC-C, plan §2, §5.4, D352): Nook's tools run with the
 * calling key (on its surface) instead of a linked key, and only tools that run on their own are
 * offered: remote tools whose policy is `auto`, Nook read tools, and Nook writes in proposal mode
 * (they file inbox proposals and change nothing). A `confirm` tool and a direct Nook write never are.
 */
export type ExternalToolOptions = { nookKey: McpKeyContext | null; surface: "mcp" | "rest" };

/** The agent's remote and Nook tools the runner may call at this step; disabled, `off`, and unreachable rights drop silently. */
export function resolveTools(agent: AgentRow, runner: { userId: string; role: string }, external: ExternalToolOptions | null = null): ResolvedTool[] {
  const refs = agentToolRefs(agent.id);
  const taken = new Set<string>();
  const resolved: ResolvedTool[] = [];
  const servers = new Map<string, { row: ToolServerRow; tools: Map<string, ReturnType<typeof parseTools>[number]>; policies: Map<string, ToolPolicy> } | null>();
  for (const ref of refs) {
    if (ref.source !== "server") continue;
    if (!servers.has(ref.serverId)) {
      const row = serverRowOrNull(ref.serverId);
      servers.set(ref.serverId, row && row.enabled === 1 && serverAvailableTo(row, runner.role) ? { row, tools: new Map(parseTools(row.tools_json).map((tool) => [tool.name, tool])), policies: serverPolicies(row.id) } : null);
    }
    const server = servers.get(ref.serverId);
    const tool = server?.tools.get(ref.toolName);
    if (!server || !tool) continue;
    const admin = server.policies.get(tool.name) ?? defaultPolicy(tool);
    // The agent can only be stricter (D358): off wins, then confirm, then the admin's policy.
    const policy: ToolPolicy = admin === "off" || ref.policy === "off" ? "off" : ref.policy === "confirm" ? "confirm" : admin;
    if (policy === "off") continue;
    if (external && policy !== "auto") continue;
    resolved.push({
      modelName: uniqueName(`${server.row.slug}__${tool.name}`, taken), kind: "server", serverId: server.row.id, server: server.row.slug, serverName: server.row.name, toolName: tool.name,
      description: tool.description, parameters: tool.inputSchema, policy, openWorld: tool.openWorld, resultCapBytes: server.row.result_cap_bytes, timeoutMs: server.row.timeout_ms, serverRow: server.row, nook: null
    });
  }
  const nookRefs = refs.filter((ref): ref is Extract<AgentToolRef, { source: "nook" }> => ref.source === "nook");
  if (nookRefs.length > 0) {
    const key = external ? external.nookKey : liveLinkedKey(agent.id, runner.userId);
    if (key) {
      for (const item of nookToolsFor(key, agent, nookRefs.map((ref) => ref.toolName))) {
        if (external && item.mode === "direct") continue;
        const spec = nookToolSpec(item.toolName)!;
        // Over the API a proposal runs on its own: it changes nothing until the key's owner approves it in the Inbox.
        const policy = external ? "auto" as const : item.policy;
        resolved.push({
          modelName: uniqueName(`nook__${item.toolName}`, taken), kind: "nook", serverId: null, server: "nook", serverName: "Nook", toolName: item.toolName,
          description: item.description, parameters: item.parameters, policy, openWorld: false, resultCapBytes: 16_384, timeoutMs: 30_000, serverRow: null,
          nook: { ...item, policy, spec, surface: external?.surface ?? "mcp" }
        });
      }
    }
  }
  return resolved;
}

/** The trifecta (plan §5.2 [14]): private data (Nook tools) plus an open-world remote tool. */
export function trifectaOf(refs: AgentToolRef[]): boolean {
  const hasNook = refs.some((ref) => ref.source === "nook");
  if (!hasNook) return false;
  const servers = new Map<string, Map<string, boolean>>();
  for (const ref of refs) {
    if (ref.source !== "server") continue;
    if (!servers.has(ref.serverId)) {
      const row = serverRowOrNull(ref.serverId);
      servers.set(ref.serverId, new Map(row ? parseTools(row.tools_json).map((tool) => [tool.name, tool.openWorld]) : []));
    }
    if (servers.get(ref.serverId)!.get(ref.toolName) !== false && servers.get(ref.serverId)!.has(ref.toolName)) return true;
  }
  return false;
}

/** Test and purge hook: the link rows of an agent (purging an agent cascades them). */
export const clearLinksForTests = (agentId: string) => { db.query("DELETE FROM agent_user_links WHERE agent_id = ?").run(agentId); };

export const linkTimestamp = now;
