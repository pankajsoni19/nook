import { db } from "../db";
import { McpToolError, type McpKeyContext, type McpToolSpec } from "../mcpToolKit";
import type { McpScope } from "../mcpScopes";
import type { ItemKind } from "../keyResources";
import type { KindDef, PreviewField, ProposalRef, StoredProposal, TargetType } from "./kinds";

/**
 * A workspace proposal kind made from one MCP write tool (docs/plan/WORKSPACE_MODULES.md §B.7, §B.15,
 * D1047): the tool's arguments are the payload, its schema validates them when the agent submits (as
 * the key's owner, who must be able to read the target: NOT_FOUND otherwise, T90), and its handler
 * applies them when the person approves in the Inbox, as the approver, so the module's own checks
 * decide again at approval (D148). The key that suggested it must still exist (time_log's rule).
 * Modules give only what is theirs: where the target is, how to show it, and where it opens.
 */
export type ToolProposalSpec = {
  tool: McpToolSpec;
  /** The module read scope the key needs besides inbox:write (D151). */
  scope: McpScope;
  label: string;
  /** The payload field naming the target and its item kind, for keys limited to chosen items. */
  target?: { field: string; kind: ItemKind };
  /** Finds the target as the key's owner; throws McpToolError NOT_FOUND when they cannot read it. May normalize the payload. */
  locate: (userId: string, data: Record<string, unknown>) => { targetType: TargetType; targetId: string; payload?: Record<string, unknown> };
  /** The applied change's reference, from the tool's result. */
  applied: (result: Record<string, unknown>, payload: Record<string, unknown>) => ProposalRef;
  /** The change as fields for the reviewer, or null when they cannot read the target (restricted). */
  fields: (viewerId: string, payload: Record<string, unknown>) => PreviewField[] | null;
  targetLabel: (viewerId: string, payload: Record<string, unknown>) => string | null;
  digest: (payload: Record<string, unknown>) => string;
  targetHref: (payload: Record<string, unknown>) => string | null;
};

function parse(tool: McpToolSpec, payload: unknown): Record<string, unknown> {
  const result = tool.inputSchema.safeParse(payload ?? {});
  if (!result.success) throw new McpToolError("INVALID", "Invalid payload", { details: result.error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`) });
  return result.data as Record<string, unknown>;
}

function approverKey(approverId: string, proposal: StoredProposal): McpKeyContext {
  if (!proposal.key_id) throw new McpToolError("NOT_FOUND", "The key that suggested this change no longer exists");
  if (db.query("SELECT 1 FROM mcp_api_keys WHERE id = ? AND revoked_at IS NOT NULL").get(proposal.key_id)) throw new McpToolError("NOT_FOUND", "The key that suggested this change was revoked");
  return { keyId: proposal.key_id, userId: approverId, name: proposal.key_name, scopes: [], person: true };
}

/** Shows a payload value in a preview field (null when absent). */
export const shown = (value: unknown): string | null => value === undefined || value === null || value === "" ? null
  : typeof value === "string" ? value.slice(0, 2000) : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value).slice(0, 2000);

/** Preview fields for the payload keys named here, in order, skipping absent ones. */
export const fieldsOf = (payload: Record<string, unknown>, names: ReadonlyArray<[key: string, label: string]>): PreviewField[] =>
  names.flatMap(([key, label]) => { const after = shown(payload[key]); return after === null ? [] : [{ name: label, before: null, after }]; });

export function toolProposalKind(spec: ToolProposalSpec): KindDef & { tool: string } {
  return {
    tool: spec.tool.name, scope: spec.scope, label: spec.label, ...(spec.target ? { target: spec.target } : {}),
    submit: async (key, payload) => {
      const data = parse(spec.tool, payload);
      const located = spec.locate(key.userId, data);
      return { targetType: located.targetType, targetId: located.targetId, payload: located.payload ?? data };
    },
    apply: async (approverId, proposal) => {
      const result = await spec.tool.handler(parse(spec.tool, proposal.payload) as never, approverKey(approverId, proposal)) as Record<string, unknown>;
      return spec.applied(result, proposal.payload);
    },
    preview: (viewerId, proposal) => {
      const fields = spec.fields(viewerId, proposal.payload);
      return fields === null ? { restricted: true } : { fields };
    },
    targetLabel: (viewerId, proposal) => spec.targetLabel(viewerId, proposal.payload),
    digest: (payload) => spec.digest(payload).slice(0, 200),
    targetHref: (proposal) => spec.targetHref(proposal.payload)
  };
}
