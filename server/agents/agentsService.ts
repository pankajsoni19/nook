import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { AGENT_BOUNDS, type AgentDetail, type AgentSummary, type AgentToolRef } from "../../shared/agents";
import { readAgentSettings, roleMayCreate } from "./settings";
import { AgentError } from "./status";
import { agentToolRefs, linkRow, setAgentTools, trifectaOf } from "./tools";

/**
 * Agents (plan §5.1, D355): owner-private in AC-A (sharing through `agent_access` is AC-D). Create
 * needs the `create_roles` policy; the owner reads, edits (CAS on `revision`), and moves to the Bin.
 * Anyone who may chat lists the agents they can use: in this slice, their own.
 */

export type AgentRow = {
  id: string; owner_id: string; name: string; description: string; icon: string | null; color: string | null; system_prompt: string; starters_json: string;
  provider_id: string | null; model: string | null; max_steps: number; temperature: number | null; max_output_tokens: number | null; nook_direct_writes: number;
  visibility: string; all_users_level: string; revision: number; created_at: string; updated_at: string;
  deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null;
};

const starters = (json: string): string[] => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, AGENT_BOUNDS.starters) : [];
  } catch {
    return [];
  }
};

export const agentSummary = (row: AgentRow, userId: string): AgentSummary => {
  const tools = agentToolRefs(row.id);
  return {
    id: row.id, ownerId: row.owner_id, name: row.name, description: row.description, icon: row.icon, color: row.color,
    providerId: row.provider_id, model: row.model, maxSteps: row.max_steps, temperature: row.temperature, maxOutputTokens: row.max_output_tokens,
    starters: starters(row.starters_json), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, isOwner: row.owner_id === userId,
    tools, nookDirectWrites: row.nook_direct_writes === 1, linked: (linkRow(row.id, userId)?.nook_key_id ?? null) !== null, trifecta: trifectaOf(tools)
  };
};
export const agentDetail = (row: AgentRow, userId: string): AgentDetail => ({ ...agentSummary(row, userId), systemPrompt: row.system_prompt });

/** A live agent the person may use (AC-A: their own), or the 404. */
export function usableAgent(id: string, userId: string): AgentRow {
  const row = db.query("SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL").get(id) as AgentRow | null;
  if (!row || row.owner_id !== userId) throw new AgentError(404, "NOT_FOUND", "Not found");
  return row;
}

/** A live agent the person may edit (AC-A: the owner), or the 404. */
export const manageableAgent = usableAgent;

export function listUsableAgents(userId: string): AgentSummary[] {
  return (db.query("SELECT * FROM agents WHERE owner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC").all(userId) as AgentRow[]).map((row) => agentSummary(row, userId));
}

export type AgentInput = {
  name: string; description?: string; icon?: string | null; color?: string | null; systemPrompt?: string; providerId?: string | null; model?: string | null;
  maxSteps?: number; temperature?: number | null; maxOutputTokens?: number | null; starters?: string[];
  /** AC-B: the picked tools (replaces the list) and the direct-writes flag (AC-O11). */
  tools?: AgentToolRef[]; nookDirectWrites?: boolean;
};

function providerExists(id: string | null | undefined) {
  if (!id) return null;
  if (!db.query("SELECT 1 FROM agent_providers WHERE id = ?").get(id)) throw new AgentError(400, "INVALID", "That provider does not exist", { field: "providerId" });
  return id;
}

export function createAgent(actor: { userId: string; role: string }, input: AgentInput): AgentDetail {
  const settings = readAgentSettings();
  if (!roleMayCreate(actor.role, settings)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot create agents");
  return db.transaction(() => {
    const owned = (db.query("SELECT COUNT(*) AS count FROM agents WHERE owner_id = ? AND deleted_at IS NULL").get(actor.userId) as { count: number }).count;
    if (owned >= settings.agentsPerUser) throw new AgentError(409, "LIMIT_REACHED", `You can have up to ${settings.agentsPerUser} agents`);
    const id = crypto.randomUUID();
    const timestamp = now();
    db.query(`INSERT INTO agents (id, owner_id, name, description, icon, color, system_prompt, starters_json, provider_id, model, max_steps, temperature, max_output_tokens, nook_direct_writes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, actor.userId, input.name.trim(), input.description?.trim() ?? "", input.icon ?? null, input.color ?? null, input.systemPrompt ?? "",
      JSON.stringify((input.starters ?? []).slice(0, AGENT_BOUNDS.starters)), providerExists(input.providerId), input.model?.trim() || null,
      input.maxSteps ?? AGENT_BOUNDS.maxSteps.default, input.temperature ?? null, input.maxOutputTokens ?? null, input.nookDirectWrites ? 1 : 0, timestamp, timestamp
    );
    if (input.tools) setAgentTools(id, actor.role, input.tools);
    audit(actor.userId, null, "agents.agent.create", { agentId: id, tools: input.tools?.length ?? 0 });
    return agentDetail(usableAgent(id, actor.userId), actor.userId);
  })();
}

export function updateAgent(actor: { userId: string; role: string }, id: string, input: Partial<AgentInput> & { expectedRevision: number }): AgentDetail {
  // The same policy as create (review L11): a role removed from `create_roles` keeps its agents but cannot reshape them.
  if (!roleMayCreate(actor.role)) throw new AgentError(403, "ROLE_REFUSED", "Your role cannot edit agents");
  return db.transaction(() => {
    const row = manageableAgent(id, actor.userId);
    if (row.revision !== input.expectedRevision) throw new AgentError(409, "REVISION_MISMATCH", "This agent changed elsewhere; reload and try again", { revision: row.revision });
    db.query(`UPDATE agents SET name = ?, description = ?, icon = ?, color = ?, system_prompt = ?, starters_json = ?, provider_id = ?, model = ?, max_steps = ?, temperature = ?, max_output_tokens = ?,
      nook_direct_writes = ?, revision = revision + 1, updated_at = ? WHERE id = ?`).run(
      (input.name ?? row.name).trim(), input.description !== undefined ? input.description.trim() : row.description,
      input.icon !== undefined ? input.icon : row.icon, input.color !== undefined ? input.color : row.color,
      input.systemPrompt !== undefined ? input.systemPrompt : row.system_prompt,
      input.starters !== undefined ? JSON.stringify(input.starters.slice(0, AGENT_BOUNDS.starters)) : row.starters_json,
      input.providerId !== undefined ? providerExists(input.providerId) : row.provider_id,
      input.model !== undefined ? input.model?.trim() || null : row.model,
      input.maxSteps ?? row.max_steps, input.temperature !== undefined ? input.temperature : row.temperature,
      input.maxOutputTokens !== undefined ? input.maxOutputTokens : row.max_output_tokens,
      input.nookDirectWrites !== undefined ? (input.nookDirectWrites ? 1 : 0) : row.nook_direct_writes, now(), id
    );
    if (input.tools) setAgentTools(id, actor.role, input.tools);
    audit(actor.userId, null, "agents.agent.update", { agentId: id, ...(input.tools ? { tools: input.tools.length } : {}) });
    return agentDetail(usableAgent(id, actor.userId), actor.userId);
  })();
}

/** Moves the agent to the Bin (D363 parity). Its chats stay, readable; sending needs a live agent. */
export function deleteAgent(actor: { userId: string }, id: string) {
  manageableAgent(id, actor.userId);
  const timestamp = now();
  db.query("UPDATE agents SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(timestamp, actor.userId, purgeAfterFrom(new Date(timestamp)), timestamp, id);
  audit(actor.userId, null, "agents.agent.delete", { agentId: id });
  return { ok: true as const, purgeAfter: purgeAfterFrom(new Date(timestamp)) };
}
