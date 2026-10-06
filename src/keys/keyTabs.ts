import { KEYS_TAB_LABELS, KEYS_TABS, type KeysTab } from "../router";
import type { ApiKey } from "./keysApi";

/**
 * Settings → API keys' tabs: General, Vault, and Agents. Pure, so which tab lists a key, the tabs on
 * show, and their counts are unit tested (tests/keysTabs.test.tsx). Each key is listed on exactly one tab.
 */

export { KEYS_TAB_LABELS, KEYS_TABS, type KeysTab };

/** What turns tabs on: the Vault (`features.vault`) and Chat (`features.agents`). */
export type KeysTabFeatures = { vault: boolean; agents: boolean };

/** Grants the Agents tab's keys hold: running and reading agents, and Chat's knowledge bases when present. */
const AGENT_MODULES: ReadonlySet<string> = new Set(["agents", "knowledge_base"]);

/** Whether a key holds any agents grant (a General key that does carries an "Agents" chip). */
export const holdsAgentGrants = (key: Pick<ApiKey, "grants">) => key.grants.some((grant) => grant.module === "agents");

/**
 * The tab that lists a key. A vault key (`nkv_`) is on Vault, or on General while the Vault is off. A
 * general key whose grants are all agents (`agents:run`, `agents:read`) or knowledge base grants is
 * on Agents while Chat is available; every other general key, including one that holds agents grants
 * beside other modules, is on General.
 */
export function keyTabOf(key: Pick<ApiKey, "kind" | "grants">, features: KeysTabFeatures): KeysTab {
  if (key.kind === "vault") return features.vault ? "vault" : "general";
  const agentsOnly = key.grants.length > 0 && holdsAgentGrants(key) && key.grants.every((grant) => AGENT_MODULES.has(grant.module));
  return agentsOnly && features.agents ? "agents" : "general";
}

/** The tabs on show, in order. General always; Vault with the Vault on; Agents while Chat is available. */
export const visibleKeysTabs = (features: KeysTabFeatures): KeysTab[] =>
  KEYS_TABS.filter((tab) => tab === "general" || (tab === "vault" ? features.vault : features.agents));

/** The tab a URL's tab opens: itself when on show, else General. */
export const shownKeysTab = (tab: KeysTab, features: KeysTabFeatures): KeysTab => visibleKeysTabs(features).includes(tab) ? tab : "general";

/** Live keys (not revoked) per tab, for the tab labels ("Vault 2"). */
export function keysTabCounts(keys: readonly Pick<ApiKey, "kind" | "grants" | "state">[], features: KeysTabFeatures): Record<KeysTab, number> {
  const counts: Record<KeysTab, number> = { general: 0, vault: 0, agents: 0 };
  for (const key of keys) if (key.state !== "revoked") counts[keyTabOf(key, features)] += 1;
  return counts;
}

/** The kind the New key builder starts as, and its first permission row, on each tab. */
export function keysTabPreset(tab: KeysTab): { kind: "general" | "vault"; firstRow: { module: "notes" | "agents"; permission: "read" | "run" } } {
  if (tab === "vault") return { kind: "vault", firstRow: { module: "notes", permission: "read" } };
  if (tab === "agents") return { kind: "general", firstRow: { module: "agents", permission: "run" } };
  return { kind: "general", firstRow: { module: "notes", permission: "read" } };
}

/** One line under the tabs: what the keys on this tab are for. */
export const KEYS_TAB_INTROS: Record<KeysTab, string> = {
  general: "Keys for Notes, Files, Tasks, and the other modules.",
  vault: "Vault keys (nkv_) reach only the vaults and environments you give them, and nothing outside the Vault.",
  agents: "Keys that only run or read your agents, for scripts and AI clients that start agent runs."
};

/** Where the one-time panel says a new key is listed when it was made on another tab. */
export const listedOnLine = (tab: KeysTab) => `This key is listed on the ${KEYS_TAB_LABELS[tab]} tab.`;
