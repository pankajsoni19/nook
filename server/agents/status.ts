import { config } from "../config";
import { db } from "../db";
import { verifySecrets } from "./secrets";

/**
 * Whether the agent chat module is on (plan §4.2, D354). Off when AGENT_SECRETS_KEY is unset, and
 * off (the app keeps running) when the configured key does not open a stored provider secret: a
 * changed or mistyped key on restore. Decided once at startup; the log line names the state, never
 * the key.
 */
export type AgentsStatus = { enabled: boolean; reason: "unset" | "key_mismatch" | null };

let status: AgentsStatus = { enabled: false, reason: "unset" };

export class AgentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AgentError";
  }
}

export function initAgentsStatus(log: (line: string) => void = (line) => console.log(line)): AgentsStatus {
  const key = config.agents.key;
  if (!key) {
    status = { enabled: false, reason: "unset" };
    log("Agents: AGENT_SECRETS_KEY is not set, so the Chat module is off (see docs/OPERATIONS.md, Agent chat).");
    return status;
  }
  const checked = verifySecrets(key);
  if (checked.failed > 0) {
    status = { enabled: false, reason: "key_mismatch" };
    log(`Agents: AGENT_SECRETS_KEY does not open ${checked.failed} of ${checked.total} stored provider and tool-server secrets, so the Chat module is off. Restore the key they were saved with, or remove and re-enter their credentials.`);
    return status;
  }
  const providers = (db.query("SELECT COUNT(*) AS count FROM agent_providers").get() as { count: number }).count;
  const servers = (db.query("SELECT COUNT(*) AS count FROM agent_tool_servers").get() as { count: number }).count;
  status = { enabled: true, reason: null };
  log(`Agents: on (${providers} ${providers === 1 ? "provider" : "providers"}, ${servers} tool ${servers === 1 ? "server" : "servers"}; the key comes from ${config.agents.source === "file" ? "AGENT_SECRETS_KEY_FILE" : "AGENT_SECRETS_KEY"}; outbound calls go only to configured provider endpoints and tool servers).`);
  return status;
}

export const agentsStatus = (): AgentsStatus => status;

/**
 * Whether this person sees the Chat module (`features.agents` on sign-in and /api/auth/me): never
 * for guests (AC-O2); with the module off, only admins (they get its "not configured" screen). UI
 * only (T97): the routes enforce access themselves.
 */
export const agentsFeature = (role: string) => role !== "guest" && (status.enabled || role === "admin");

/** 503 AGENTS_DISABLED while the module is off. */
export function requireAgentsEnabled() {
  if (!status.enabled) throw new AgentError(503, "AGENTS_DISABLED", "Agent chat is not configured on this server");
}

/** Test hook: switch the key in process and decide again (quietly). */
export function setAgentsKeyForTests(key: Buffer | null) {
  config.agents.key = key;
  config.agents.source = key ? "env" : null;
  return initAgentsStatus(() => undefined);
}
