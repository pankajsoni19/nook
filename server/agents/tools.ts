import { audit, db, now } from "../db";
import { keyHoldsAgentRun, listApiKeys, ownApiKey } from "../apiKeys";
import { hasScope } from "../mcpScopes";
import { loadLiveKey, type McpKeyContext } from "../mcpTools";
import type { AgentToolPolicy, AgentToolRef, LinkableKey, LinkState, NookLink, ToolCatalog, ToolPolicy } from "../../shared/agents";
import type { AgentRow } from "./agentsService";
import { missingNookScope, nookCatalogFor, nookToolSpec, nookToolsFor, type NookResolved } from "./nookBridge";
import { roleMayChat } from "./settings";
import { shareLevel } from "./sharing";
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
  // Wave 43 (AC-D): a manager may not see every server the owner picked from; picks already on the
  // agent stay valid as they are (only new picks must come from the editor's own catalog).
  const kept = new Set(agentToolRefs(agentId).filter((ref) => ref.source === "server").map((ref) => `server:${ref.serverId}:${ref.toolName}`));
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = ref.source === "server" ? `server:${ref.serverId}:${ref.toolName}` : `nook:${ref.toolName}`;
    if (seen.has(key)) throw new AgentError(400, "INVALID", "A tool is listed twice", { field: "tools" });
    seen.add(key);
    if (ref.source === "server" && !kept.has(key) && !visible.get(ref.serverId)?.has(ref.toolName)) throw new AgentError(400, "INVALID", "A picked tool is not in a server you can use", { field: "tools" });
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

/** A key that can run agents is never an agent's Nook key (Wave 42 review M1, T318): its tools could start runs. */
const runsAgents = (key: { id: string; grants: ReadonlyArray<{ module: string; permission: string }> }) => key.grants.some((grant) => grant.module === "agents" && grant.permission === "run");

const linkable = (key: ReturnType<typeof listApiKeys>["keys"][number]): LinkableKey => ({
  id: key.id, name: key.name, prefix: key.prefix, state: key.state, expiresAt: key.expiresAt,
  grants: key.grants.map((grant) => ({ module: grant.module, permission: grant.permission, resource: grant.resource ? { kind: grant.resource.kind, name: grant.resource.name } : null, active: grant.active }))
});

/** The keys the Link Nook key sheet lists: the caller's own live general keys with the MCP surface. */
export function linkableKeys(userId: string): LinkableKey[] {
  return listApiKeys(userId).keys.filter((key) => key.kind === "general" && key.surfaces !== "rest" && (key.state === "active" || key.state === "grace") && !runsAgents(key)).map(linkable);
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
  if (keyId !== null && keyHoldsAgentRun(keyId)) throw new AgentError(409, "KEY_RUNS_AGENTS", "This key can run agents (“Run agents”), so it cannot be an agent's Nook key: the agent's tools could start other runs. Link a key without it.");
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
  // Never a key that can run agents (review M1), whatever was linked before the rule.
  if (hasScope(key.scopes, "agents:run")) return null;
  return key;
}

/**
 * The caller's link as the editor and the chat show it (Wave 41 QA Q4): none, live, or a key that is
 * no longer live (revoked, expired, or otherwise inactive), named so the person can link another.
 */
export function linkStateOf(agentId: string, userId: string): { state: LinkState; keyName: string | null } {
  const row = linkRow(agentId, userId);
  if (!row?.nook_key_id) return { state: "none", keyName: null };
  if (liveLinkedKey(agentId, userId)) return { state: "live", keyName: ownApiKey(userId, row.nook_key_id)?.name ?? null };
  const key = ownApiKey(userId, row.nook_key_id);
  if (!key) return { state: "inactive", keyName: null };
  return { state: key.state === "revoked" ? "revoked" : key.state === "expired" ? "expired" : "inactive", keyName: key.name };
}

/** The tool-result text for a Nook call through a link whose key is gone (QA Q4): names the key, says what to do. */
export function inactiveLinkMessage(agentId: string, userId: string): string | null {
  const link = linkStateOf(agentId, userId);
  if (link.state === "none" || link.state === "live") return null;
  const name = link.keyName ? `"${link.keyName}"` : "";
  const why = link.state === "revoked" ? "was revoked" : link.state === "expired" ? "has expired" : "is no longer active";
  return `The linked Nook key ${name}${name ? " " : ""}${why}, so Nook's tools are off for this agent. The person can link another key in the agent's settings.`;
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
  // Without a live key the picker lists none of Nook's tools (QA Q4): what runs is bounded by the key.
  return { servers, nook: { linked: key !== null, linkState: agentId ? linkStateOf(agentId, userId).state : "none", tools: key ? nookCatalogFor(key) : [] } };
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

/** What a resolved tool was at offer time, to compare against live rows before a call runs (review M3). */
export type ToolIdentity =
  | { kind: "server"; serverId: string; toolName: string; revision: number }
  | { kind: "nook"; toolName: string; mode: NookResolved["mode"]; keyId: string };

export const identityOf = (tool: ResolvedTool): ToolIdentity => tool.kind === "server"
  ? { kind: "server", serverId: tool.serverId!, toolName: tool.toolName, revision: tool.serverRow!.revision }
  : { kind: "nook", toolName: tool.toolName, mode: tool.nook!.mode, keyId: tool.nook!.keyId };

/** The agent row and the runner's role as they stand now (the agent not in the Bin, the account active, the role allowed to chat). */
export function liveRunner(agentId: string, userId: string): { agent: AgentRow; role: string } | null {
  const agent = db.query("SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL").get(agentId) as AgentRow | null;
  if (!agent) return null;
  const user = db.query("SELECT role FROM users WHERE id = ? AND disabled_at IS NULL").get(userId) as { role: string } | null;
  if (!user || !roleMayChat(user.role)) return null;
  // Wave 43 (AC-D): the runner can still open the agent (their own, or shared with them now); a share
  // withdrawn mid-run ends the run at its next step or tool call.
  if (shareLevel("agent", agent, userId) === "none") return null;
  return { agent, role: user.role };
}

/**
 * The one tool a call is about to run, re-resolved against live rows just before it runs (review
 * M3): the live agent row (its picks and `nook_direct_writes`), the runner's live role and account,
 * the live server row (enabled, available to the runner, the same revision), the live policy, and
 * the live key with the same mode (the linked key in a chat; the calling key, re-read, in an API or
 * MCP run, with the run's auto-only set). Null when anything changed: the call is refused.
 */
export function liveToolFor(agentId: string, userId: string, identity: ToolIdentity, external: ExternalToolOptions | null = null): ResolvedTool | null {
  const live = liveRunner(agentId, userId);
  if (!live) return null;
  const match = resolveTools(live.agent, { userId, role: live.role }, external, identity).find((tool) => identity.kind === "server"
    ? tool.kind === "server" && tool.serverId === identity.serverId && tool.toolName === identity.toolName && tool.serverRow!.revision === identity.revision
    : tool.kind === "nook" && tool.toolName === identity.toolName && tool.nook!.mode === identity.mode && tool.nook!.keyId === identity.keyId);
  return match ?? null;
}

/**
 * Why a call's live re-check found no tool (AC-B verification M2), so the card says why: the
 * key is no longer live (`KEY_INACTIVE`), it lost a scope the tool needs in its mode
 * (`SCOPE_REQUIRED`, naming the scope), or anything else changed (`TOOL_UNAVAILABLE`: the server
 * was disabled, removed, or edited, a policy or the agent's picks changed, another key was linked).
 */
export function liveToolFailure(agentId: string, userId: string, identity: ToolIdentity, external: ExternalToolOptions | null = null): { code: "KEY_INACTIVE" | "SCOPE_REQUIRED" | "TOOL_UNAVAILABLE"; message: string; scope?: string } {
  const unavailable = { code: "TOOL_UNAVAILABLE" as const, message: "This tool is no longer available to this agent (it was disabled, removed, changed, or the rights changed); the call was not run" };
  if (identity.kind !== "nook") return unavailable;
  const key = external ? external.nookKey : liveLinkedKey(agentId, userId);
  if (!key) {
    const dead = external ? null : inactiveLinkMessage(agentId, userId);
    return { code: "KEY_INACTIVE", message: dead ?? "The Nook key this tool runs with is no longer active; the call was not run" };
  }
  if (key.keyId !== identity.keyId) return unavailable;
  const scope = missingNookScope(key, identity.toolName, identity.mode);
  if (scope) return { code: "SCOPE_REQUIRED", scope, message: `The ${external ? "calling" : "linked"} Nook key no longer has the ${scope} permission this tool needs${identity.mode === "proposal" ? " to file a proposal" : ""}; the call was not run` };
  return unavailable;
}

/** The agent's remote and Nook tools the runner may call at this step; disabled, `off`, and unreachable rights drop silently. */
export function resolveTools(agent: AgentRow, runner: { userId: string; role: string }, external: ExternalToolOptions | null = null, only?: ToolIdentity): ResolvedTool[] {
  const all = agentToolRefs(agent.id);
  const refs = all.filter((ref) => !only || (only.kind === "server" ? ref.source === "server" && ref.serverId === only.serverId && ref.toolName === only.toolName : ref.source === "nook" && ref.toolName === only.toolName));
  // The trifecta (plan §5.2 [14], review L10): with Nook tools picked, an open-world remote tool asks first.
  const hasNook = all.some((ref) => ref.source === "nook");
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
    let policy: ToolPolicy = admin === "off" || ref.policy === "off" ? "off" : ref.policy === "confirm" ? "confirm" : admin;
    if (policy === "off") continue;
    if (policy === "auto" && hasNook && tool.openWorld) policy = "confirm";
    // An API or MCP run never waits on a person (D352): only what runs on its own is offered.
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
