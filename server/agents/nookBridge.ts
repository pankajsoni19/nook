import * as z from "zod/v4";
import { withAuditContext } from "../db";
import { KIND_TOOL, type ProposalKind } from "../inbox/kinds";
import { submitProposal, TITLE_MAX } from "../inbox/service";
import { hasScope, type McpScope } from "../mcpScopes";
import { loadLiveKey, mcpToolSpecs, runTool, toolVisible, McpToolError, type McpKeyContext, type McpToolSpec } from "../mcpTools";
import { keyReach } from "../keyResources";
import { PROPOSAL_KIND_DEFS } from "../inbox/kinds";
import type { NookCatalogTool } from "../../shared/agents";
import type { AgentRow } from "./agentsService";

/**
 * Nook's own tools for agents (plan §5.2, §5.3, §5.4, D353, D359; Wave 41 AC-B). They run in
 * process through `runTool(spec, args, keyId, "mcp")` with the runner's linked key, so grants ∩ the
 * owner's live access ∩ role ∩ policy apply per call, the key's rate limits count, and the agent
 * owner's access is never used (T311).
 *
 * What is offered: the read tools the key can see, and the write tools in one of two modes:
 * - **proposal** (the default, AC-O11): a write tool whose arguments the Inbox can carry as a
 *   proposal of an existing kind (`create_card` → `card_create`, `update_note_draft` →
 *   `note_draft`, …) is offered, asks first, and is turned into a pending proposal in the key
 *   owner's Inbox; nothing is applied. The key needs `inbox:write` plus the module's read scope,
 *   as `submit_proposals` does.
 * - **direct**: only with the agent's `nook_direct_writes` flag and the key's write grant; it still
 *   asks first in chats (D352). A write tool with no proposal kind is offered only in this mode.
 *
 * Never offered: proposal and routine machinery, uploads, Bin, key, vault, and the agent module's
 * own tools (`run_agent` of AC-C included; T318).
 */

const EXCLUDED = new Set([
  "submit_proposals", "list_my_proposals", "withdraw_proposal", "list_routines", "list_due_routines", "start_run", "finish_run",
  "begin_upload", "finish_upload", "list_agents", "list_chats", "get_chat", "run_agent"
]);
const isBinTool = (name: string) => name.startsWith("bin_") || name.startsWith("restore_");

/** The proposal kind a write tool's call becomes (plan §5.4). */
const TOOL_KIND: Record<string, ProposalKind> = {
  ...Object.fromEntries(Object.entries(KIND_TOOL).map(([kind, tool]) => [tool, kind as ProposalKind])),
  update_note_draft: "note_draft",
  create_note: "note_draft"
};

export const nookToolSpec = (name: string): McpToolSpec | null => mcpToolSpecs.find((spec) => spec.name === name) ?? null;

/** Every Nook tool an agent could pick, whether or not a key is linked. */
export const offeredSpecs = (): McpToolSpec[] => mcpToolSpecs.filter((spec) => !EXCLUDED.has(spec.name) && !isBinTool(spec.name));

const moduleOf = (scope: McpScope) => scope.split(":")[0]!;

/**
 * The picker's Nook group (plan §5.2): with a linked key, the tools that key can reach now; without
 * one, every offered tool (the editor sees what the agent could get; nothing runs without a key).
 */
export function nookCatalogFor(key: McpKeyContext | null): NookCatalogTool[] {
  return offeredSpecs().filter((spec) => !key || reachable(spec, key, true)).map((spec) => ({
    name: spec.name, title: spec.title, module: moduleOf(spec.scopes[0]!), write: spec.write, proposable: spec.write && spec.name in TOOL_KIND, scope: spec.scopes[0]!
  }));
}

/** Whether the key could run the tool in some mode (read, proposal, or direct). */
function reachable(spec: McpToolSpec, key: McpKeyContext, anyMode: boolean) {
  if (!spec.write) return toolVisible(spec, key);
  if (toolVisible(spec, key)) return true;
  return anyMode && spec.name in TOOL_KIND && proposalReach(spec, key);
}

/** The proposal path's rights: `inbox:write` and the kind's module read scope over something. */
function proposalReach(spec: McpToolSpec, key: McpKeyContext) {
  const kind = TOOL_KIND[spec.name];
  if (!kind || !hasScope(key.scopes, "inbox:write")) return false;
  return keyReach(key, PROPOSAL_KIND_DEFS[kind].scope) !== null;
}

export type NookMode = "read" | "proposal" | "direct";
/**
 * `surface` (AC-C): the surface the key's calls are made and counted on: `mcp` for a chat's linked
 * key (it must have MCP), and the calling key's own surface for an API or MCP run.
 */
export type NookResolved = { toolName: string; description: string; parameters: Record<string, unknown>; policy: "auto" | "confirm"; mode: NookMode; keyId: string; spec?: McpToolSpec; surface?: "mcp" | "rest" };

/** The agent's picked Nook tools this key may run now, each in the mode the rights allow (D353, D359). */
export function nookToolsFor(key: McpKeyContext, agent: Pick<AgentRow, "nook_direct_writes">, picked: readonly string[]): Omit<NookResolved, "spec">[] {
  const out: Omit<NookResolved, "spec">[] = [];
  for (const name of picked) {
    const spec = nookToolSpec(name);
    if (!spec || EXCLUDED.has(name) || isBinTool(name)) continue;
    let mode: NookMode | null = null;
    if (!spec.write) mode = toolVisible(spec, key) ? "read" : null;
    else if (agent.nook_direct_writes === 1 && toolVisible(spec, key)) mode = "direct";
    else if (spec.name in TOOL_KIND && proposalReach(spec, key)) mode = "proposal";
    if (!mode) continue;
    const schema = z.toJSONSchema(spec.inputSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete schema.$schema;
    const description = mode === "proposal" ? `${spec.description} In this chat the change is NOT applied: it becomes a proposal the person reviews in their Nook Inbox, and the result carries the proposal id.` : spec.description;
    out.push({ toolName: name, description: description.slice(0, 4096), parameters: schema, policy: spec.write ? "confirm" : "auto", mode, keyId: key.keyId });
  }
  return out;
}

export type NookOutcome = { text: string; ok: boolean; proposalId: string | null };

const titleOf = (spec: McpToolSpec, args: Record<string, unknown>) => {
  const hint = typeof args.title === "string" ? args.title : typeof args.name === "string" ? args.name : typeof args.markdown === "string" ? args.markdown.split("\n")[0]!.replace(/^#+\s*/, "") : "";
  return `${spec.title}${hint ? `: ${hint}` : ""}`.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
};

function proposalPayload(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "create_note") return { ...(typeof args.folderId === "string" ? { folderId: args.folderId } : {}), markdown: args.markdown, mode: "replace" };
  return args;
}

/**
 * Runs one Nook tool for the runner's key inside the run's audit context. A proposal-mode call
 * files an inbox proposal instead of writing (the result says so and names the proposal).
 */
export async function runNookTool(resolved: NookResolved, args: Record<string, unknown>, context: { runId: string; agentId: string; agentName: string; via?: "chat" | "api" | "mcp" }): Promise<NookOutcome> {
  const spec = resolved.spec ?? nookToolSpec(resolved.toolName);
  if (!spec) return { text: JSON.stringify({ error: "Unknown tool", code: "NOT_FOUND" }), ok: false, proposalId: null };
  const surface = resolved.surface ?? "mcp";
  return withAuditContext({ via: "agent", runId: context.runId, agentId: context.agentId }, async () => {
    if (resolved.mode === "proposal") {
      const kind = TOOL_KIND[spec.name];
      if (!kind) return { text: JSON.stringify({ error: "This change cannot be proposed through the Inbox, and the agent may not make it directly", code: "KIND_NOT_ALLOWED" }), ok: false, proposalId: null };
      const key = loadLiveKey(resolved.keyId, surface);
      if (!key) return { text: JSON.stringify({ error: "The linked Nook key is no longer active", code: "KEY_INACTIVE" }), ok: false, proposalId: null };
      try {
        const parsed = spec.inputSchema.safeParse(args);
        if (!parsed.success) return { text: JSON.stringify({ error: "Invalid arguments", code: "INVALID", details: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`) }), ok: false, proposalId: null };
        const result = await submitProposal(key, { kind, title: titleOf(spec, args), rationale: `Suggested by the agent ${context.agentName} ${context.via === "api" ? "in an API run" : context.via === "mcp" ? "in an MCP run" : "in a chat"}.`, payload: proposalPayload(spec.name, parsed.data as Record<string, unknown>) });
        return { text: JSON.stringify({ proposed: true, proposalId: result.proposalId, status: result.status, expiresAt: result.expiresAt, note: "Nothing was changed. The person reviews this proposal in their Nook Inbox." }), ok: true, proposalId: result.proposalId };
      } catch (error) {
        if (error instanceof McpToolError) return { text: JSON.stringify({ error: error.message, code: error.code, ...(error.details ?? {}) }), ok: false, proposalId: null };
        throw error;
      }
    }
    const result = await runTool(spec, args, resolved.keyId, surface);
    return { text: result.content.map((part) => part.text).join("\n"), ok: result.isError !== true, proposalId: null };
  });
}
