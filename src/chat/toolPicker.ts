import type { AgentToolPolicy, AgentToolRef, NookCatalogTool, ToolCatalog, ToolPolicy } from "../../shared/agents";

/**
 * The tool picker's model (agent chat plan §5.2; Wave 41 AC-B), pure so tests can drive it: the
 * agent's picks as a set keyed by source, toggling, the stricter-only policy rule (D358), groups
 * (one per server; Nook's tools by module), and counts for the section headings.
 */

export const refKey = (ref: AgentToolRef) => ref.source === "server" ? `server:${ref.serverId}:${ref.toolName}` : `nook:${ref.toolName}`;

export const hasRef = (refs: readonly AgentToolRef[], ref: AgentToolRef) => refs.some((item) => refKey(item) === refKey(ref));

/** Adds or removes a pick (a server pick starts with the admin's policy, `null`). */
export function toggleRef(refs: readonly AgentToolRef[], ref: AgentToolRef): AgentToolRef[] {
  return hasRef(refs, ref) ? refs.filter((item) => refKey(item) !== refKey(ref)) : [...refs, ref];
}

/** Sets the agent's own policy on a picked server tool: only stricter than the admin's (confirm or off), or null for the admin's. */
export function setRefPolicy(refs: readonly AgentToolRef[], serverId: string, toolName: string, policy: AgentToolPolicy): AgentToolRef[] {
  return refs.map((item) => item.source === "server" && item.serverId === serverId && item.toolName === toolName ? { ...item, policy } : item);
}

/** The policies an agent may choose for a tool, given the admin's: never looser (D358). */
export function policyOptions(admin: ToolPolicy): Array<{ value: "admin" | "confirm" | "off"; label: string }> {
  const options: Array<{ value: "admin" | "confirm" | "off"; label: string }> = [{ value: "admin", label: `Admin's policy (${POLICY_LABELS[admin]})` }];
  if (admin === "auto") options.push({ value: "confirm", label: "Ask first" });
  if (admin !== "off") options.push({ value: "off", label: "Off" });
  return options;
}

export const POLICY_LABELS: Record<ToolPolicy, string> = { auto: "runs on its own", confirm: "asks first", off: "off" };
export const POLICY_BADGES: Record<ToolPolicy, string> = { auto: "Auto", confirm: "Asks first", off: "Off" };

export const MODULE_NAMES: Record<string, string> = { notes: "Notes", files: "Files", tasks: "Tasks", calendar: "Calendar", collections: "Collections", today: "Today", team: "Team", inbox: "Inbox", whiteboards: "Whiteboards", agents: "Chat" };

/** Nook's tools grouped by module, in a fixed order. */
export function nookGroups(tools: readonly NookCatalogTool[]): Array<{ module: string; label: string; tools: NookCatalogTool[] }> {
  const order = Object.keys(MODULE_NAMES);
  const groups = new Map<string, NookCatalogTool[]>();
  for (const tool of tools) groups.set(tool.module, [...(groups.get(tool.module) ?? []), tool]);
  return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([module, items]) => ({ module, label: MODULE_NAMES[module] ?? module, tools: items }));
}

/** "3 of 9" per server, and the totals the Tools heading shows. */
export function pickCounts(refs: readonly AgentToolRef[], catalog: ToolCatalog) {
  const perServer = new Map(catalog.servers.map((server) => [server.id, refs.filter((ref) => ref.source === "server" && ref.serverId === server.id).length]));
  const nook = refs.filter((ref) => ref.source === "nook").length;
  return { perServer, nook, total: refs.length };
}

/** Picks that no longer exist in the catalog (a removed server or tool): shown so the person can clear them. */
export function orphanRefs(refs: readonly AgentToolRef[], catalog: ToolCatalog): AgentToolRef[] {
  const known = new Set<string>();
  for (const server of catalog.servers) for (const tool of server.tools) known.add(`server:${server.id}:${tool.name}`);
  for (const tool of catalog.nook.tools) known.add(`nook:${tool.name}`);
  // Without a live key the catalog lists no Nook tools (QA Q4): those picks are inactive, not orphans.
  return refs.filter((ref) => !known.has(refKey(ref)) && (ref.source !== "nook" || catalog.nook.linked));
}

/** What a Nook write tool does in a chat, from the catalog's flags and the agent's direct-writes setting. */
export function nookWriteMode(tool: NookCatalogTool, directWrites: boolean): "read" | "proposal" | "direct" | "needs-direct" {
  if (!tool.write) return "read";
  if (directWrites) return "direct";
  return tool.proposable ? "proposal" : "needs-direct";
}
