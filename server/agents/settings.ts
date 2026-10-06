import { config } from "../config";
import { db, now } from "../db";
import { AGENT_ROLE_OPTIONS, DEFAULT_AGENT_SETTINGS, type AgentRole, type AgentSettings } from "../../shared/agents";
import { AgentError } from "./status";

/**
 * Instance policy (plan §4.1): one `agent_settings` row per key, each with its own revision. The
 * settings' `revision` is the sum of the row revisions, so a change to any row moves it (CAS on
 * PUT). Unset rows take the defaults from shared/agents.ts.
 */

const KEYS: Record<keyof AgentSettings, string> = {
  createRoles: "create_roles", chatRoles: "chat_roles", dailyTokensUser: "daily_tokens_user", dailyTokensKey: "daily_tokens_key",
  dailyTokensInstance: "daily_tokens_instance", publicChatLinks: "public_chat_links", auditRetentionDays: "audit_retention_days",
  agentsPerUser: "agents_per_user", kbsPerUser: "kbs_per_user", defaultProviderId: "default_provider_id"
};

const roles = (value: unknown): AgentRole[] | null => Array.isArray(value) && value.every((item) => (AGENT_ROLE_OPTIONS as readonly string[]).includes(item)) ? value as AgentRole[] : null;
const integer = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;

export function readAgentSettings(): AgentSettings & { revision: number } {
  const rows = db.query("SELECT key, value_json, revision FROM agent_settings").all() as Array<{ key: string; value_json: string; revision: number }>;
  // Audit retention (Wave 42, D366): AGENT_AUDIT_RETENTION_DAYS (default 30) unless an admin stored a policy value.
  const settings: AgentSettings = { ...DEFAULT_AGENT_SETTINGS, createRoles: [...DEFAULT_AGENT_SETTINGS.createRoles], chatRoles: [...DEFAULT_AGENT_SETTINGS.chatRoles], auditRetentionDays: config.agents.auditRetentionDays };
  let revision = 0;
  for (const row of rows) {
    revision += row.revision;
    let value: unknown;
    try { value = JSON.parse(row.value_json); } catch { continue; }
    switch (row.key) {
      case "create_roles": settings.createRoles = roles(value) ?? settings.createRoles; break;
      case "chat_roles": settings.chatRoles = roles(value) ?? settings.chatRoles; break;
      case "daily_tokens_user": settings.dailyTokensUser = integer(value, 0, 1e9) ?? settings.dailyTokensUser; break;
      case "daily_tokens_key": settings.dailyTokensKey = integer(value, 0, 1e9) ?? settings.dailyTokensKey; break;
      case "daily_tokens_instance": settings.dailyTokensInstance = integer(value, 0, 1e10) ?? settings.dailyTokensInstance; break;
      case "public_chat_links": settings.publicChatLinks = value === true; break;
      case "audit_retention_days": settings.auditRetentionDays = integer(value, 7, 365) ?? settings.auditRetentionDays; break;
      case "agents_per_user": settings.agentsPerUser = integer(value, 1, 500) ?? settings.agentsPerUser; break;
      case "kbs_per_user": settings.kbsPerUser = integer(value, 1, 100) ?? settings.kbsPerUser; break;
      case "default_provider_id": settings.defaultProviderId = typeof value === "string" ? value : null; break;
      default: break;
    }
  }
  return { ...settings, revision };
}

export type SettingsPatch = Partial<Omit<AgentSettings, "publicChatLinks">> & { publicChatLinks?: boolean };

/** Writes the given keys (CAS on the summed revision) and returns the new settings. */
export function writeAgentSettings(actorId: string, patch: SettingsPatch, expectedRevision: number) {
  return db.transaction(() => {
    const current = readAgentSettings();
    if (current.revision !== expectedRevision) throw new AgentError(409, "REVISION_MISMATCH", "The settings changed elsewhere; reload and try again", { revision: current.revision });
    const timestamp = now();
    const upsert = db.query(`INSERT INTO agent_settings (key, value_json, revision, updated_by, updated_at) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, revision = agent_settings.revision + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
    for (const [field, column] of Object.entries(KEYS) as Array<[keyof AgentSettings, string]>) {
      if (!(field in patch)) continue;
      const value = patch[field];
      // AC-O1: public chat links stay off in this slice (AC-D adds the pages behind the policy).
      if (field === "publicChatLinks" && value === true) throw new AgentError(400, "INVALID", "Public chat links are not available yet");
      upsert.run(column, JSON.stringify(value ?? null), actorId, timestamp);
    }
    return readAgentSettings();
  })();
}

/** Whether a role may chat (policy `chat_roles`); guests never. */
export const roleMayChat = (role: string, settings = readAgentSettings()) => role !== "guest" && (settings.chatRoles as readonly string[]).includes(role);
/** Whether a role may create agents (policy `create_roles`); guests never. */
export const roleMayCreate = (role: string, settings = readAgentSettings()) => role !== "guest" && (settings.createRoles as readonly string[]).includes(role);
