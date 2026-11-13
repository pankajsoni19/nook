import type { McpToolSpec } from "./mcpToolKit";

/**
 * Registered MCP tools and resources (docs/plan/WORKSPACE_MODULES.md §B.1, §B.15, D801, D814): the
 * workspace modules add their tools here (through `registerWorkspaceModule({ mcpTools })`), and
 * server/mcpTools.ts appends them to `mcpToolSpecs`, so MCP, REST v1 (`/api/v1/tools`), and agents
 * see them exactly like the built-in tools. Nothing here imports a service, so any module may import it.
 *
 * Tool names are global: registering a name twice throws (at startup, before anything is served).
 */

const registered: McpToolSpec[] = [];
const listeners: Array<(spec: McpToolSpec) => void> = [];
const reservedNames = new Set<string>();

/** Names server/mcpTools.ts already uses; a registered tool may not take one. */
export function reserveToolNames(names: Iterable<string>) {
  for (const name of names) {
    if (registered.some((spec) => spec.name === name)) throw new Error(`MCP tool ${name} is already defined`);
    reservedNames.add(name);
  }
}

export function registerMcpTools(specs: readonly McpToolSpec[]) {
  for (const spec of specs) {
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(spec.name)) throw new Error(`Invalid MCP tool name ${spec.name}`);
    if (reservedNames.has(spec.name) || registered.some((item) => item.name === spec.name)) throw new Error(`MCP tool ${spec.name} is already defined`);
    registered.push(spec);
    for (const listener of listeners) listener(spec);
  }
}

/** The registered tools, in registration order. */
export const registeredToolSpecs = (): readonly McpToolSpec[] => registered;

/** Called for every tool registered from now on (server/mcpTools.ts appends them to mcpToolSpecs). */
export function onToolRegistered(listener: (spec: McpToolSpec) => void) {
  listeners.push(listener);
}

/** Test hook: removes registered tools by name (the throwaway test module unregisters itself). */
export function unregisterMcpToolsForTests(names: readonly string[], sink?: McpToolSpec[]) {
  for (const name of names) {
    const index = registered.findIndex((spec) => spec.name === name);
    if (index >= 0) registered.splice(index, 1);
    if (sink) {
      const at = sink.findIndex((spec) => spec.name === name);
      if (at >= 0) sink.splice(at, 1);
    }
  }
}

// ---------------------------------------------------------------- resources (§B.15)

/**
 * An MCP resource template `nook://<kind>/<id>`: read through the same access checks as the
 * matching `get_*` tool. `scopes`: the key needs any one of them; `read` returns text (JSON) or null
 * for "not found" (missing, unreadable, and outside the key's grant look the same, T205).
 */
export type McpResourceSpec = {
  kind: string;
  title: string;
  description: string;
  scopes: readonly import("./mcpScopes").McpScope[];
  /** The item kind (key grants) the id names, for chosen-item keys. */
  itemKind?: import("./keyResources").ItemKind;
  read: (id: string, key: import("./mcpToolKit").McpKeyContext) => Promise<unknown | null> | unknown | null;
};

const resources = new Map<string, McpResourceSpec>();

export function registerMcpResource(spec: McpResourceSpec) {
  if (!/^[a-z][a-z_]{1,31}$/.test(spec.kind)) throw new Error(`Invalid resource kind ${spec.kind}`);
  if (resources.has(spec.kind)) throw new Error(`MCP resource nook://${spec.kind} is already registered`);
  resources.set(spec.kind, spec);
}

export const registeredMcpResources = () => [...resources.values()];
export const mcpResource = (kind: string) => resources.get(kind) ?? null;
