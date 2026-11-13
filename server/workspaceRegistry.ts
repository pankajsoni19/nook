import type { Handler, Hono } from "hono";
import type { AppEnv } from "./auth";
import { DynamicRoutes } from "./dynamicRoutes";
import { registerAccessContainer, type AccessContainer } from "./access/workspaceItems";
import { registerItemKind, type Anchor, type WorkspaceItemKind } from "./keyResources";
import { registerWorkKind, type WorkKindAdapter } from "./links/adapters";
import { registerMcpResource, registerMcpTools, type McpResourceSpec } from "./mcpRegistry";
import type { McpToolSpec } from "./mcpToolKit";
import { registerAgentTools } from "./agents/nookBridge";
import { registerBinProvider, type BinProvider, type ProvidedBinType } from "./bin";
import { registerTodayProvider, type TodayProvider } from "./today/registry";
import { registerSearchScope, type SearchScopeDef } from "./searchRegistry";
import { registerDataset, type DatasetDef } from "./datasets/registry";
import { registerScheduleHandler, type ScheduleHandler } from "./schedules/service";
import { registerProgressSource, type ProgressSource } from "./goalsProgress";
import { registerMailTemplate, type RegisteredMailTemplate } from "./mail/registry";
import { registerProposalKind, type KindDef } from "./inbox/kinds";
import { registerDigestSection, type DigestSection } from "./mail/digest";
import { registerPublicRoutes, type PublicRouter } from "./public/routes";
import { registerUndoKind } from "./undo";
import { registerReadOnlyWrite } from "./team/writeGate";
import { isWorkspaceModuleId, type WorkspaceModuleId, type WorkspaceProposalKind } from "../shared/workspaceModules";

/**
 * The workspace module registry (docs/plan/WORKSPACE_MODULES.md §B.1, D801, T500). A module lane fills
 * its own `server/<module>/index.ts` with one `registerWorkspaceModule({...})` call; everything it
 * needs from the shared registries is wired from here, so no lane edits a shared file:
 *
 * - `routes(router)`: its `/api/...` routes, served behind every session, CSRF, two-factor, and
 *   role-write guard (one dispatcher mounted after them, server/dynamicRoutes.ts). The router refuses
 *   `/api/public/…` and anything outside `/api/` (T500).
 * - `publicRoutes(router)`: its `/p/…` pages and `/api/public/…` JSON, before the session guards,
 *   behind the strict public headers (server/public/*).
 * - Tools (`mcpTools`, `mcpResources`, `agentTools`), access (`accessContainer`, `itemKinds`),
 *   links (`workKinds`), Bin, Today, search, datasets, schedules, progress sources, mail templates,
 *   proposal kinds, digest sections, and undo kinds: each handed to its registry at once.
 *
 * Registering is idempotent per id only in the sense that a second registration of an id throws.
 */

export type ModuleRouter = {
  get: (path: `/api/${string}`, ...handlers: Handler<AppEnv>[]) => void;
  post: (path: `/api/${string}`, ...handlers: Handler<AppEnv>[]) => void;
  put: (path: `/api/${string}`, ...handlers: Handler<AppEnv>[]) => void;
  patch: (path: `/api/${string}`, ...handlers: Handler<AppEnv>[]) => void;
  delete: (path: `/api/${string}`, ...handlers: Handler<AppEnv>[]) => void;
};

export type WorkspaceModuleDef = {
  /** A workspace module id (shared/workspaceModules.ts), or `test_*` under tests (the throwaway module). */
  id: WorkspaceModuleId | `test_${string}`;
  routes?: (router: ModuleRouter) => void;
  publicRoutes?: (router: PublicRouter) => void;
  mcpTools?: readonly McpToolSpec[];
  mcpResources?: readonly McpResourceSpec[];
  /** How chat agents may use the module's tools (§B.15): offered, or never. Every tool must be in one. */
  agentTools?: { allowed?: readonly string[]; never?: readonly string[] };
  accessContainer?: AccessContainer;
  itemKinds?: ReadonlyArray<{ kind: WorkspaceItemKind; anchors: (id: string) => Anchor[] | null }>;
  workKinds?: readonly WorkKindAdapter[];
  binProviders?: ReadonlyArray<{ type: ProvidedBinType; provider: BinProvider }>;
  todayProviders?: ReadonlyArray<{ name: string; provider: TodayProvider }>;
  searchScopes?: readonly SearchScopeDef[];
  datasets?: readonly DatasetDef[];
  scheduleHandlers?: Readonly<Record<string, ScheduleHandler>>;
  progressSources?: ReadonlyArray<{ kind: string; source: Omit<ProgressSource, "kind"> }>;
  mailTemplates?: Readonly<Record<string, RegisteredMailTemplate<never>>>;
  proposalKinds?: ReadonlyArray<{ kind: WorkspaceProposalKind; def: KindDef & { tool: string } }>;
  digestSections?: readonly DigestSection[];
  undoKinds?: Readonly<Record<string, Parameters<typeof registerUndoKind>[1]>>;
  /** Writes read-only roles may send (guests answering a form or standup, asking in a townhall); the handler still checks who may. */
  readOnlyWrites?: ReadonlyArray<Parameters<typeof registerReadOnlyWrite>[0]>;
};

const modules = new Map<string, WorkspaceModuleDef>();
export const moduleRoutes = new DynamicRoutes("modules");
/** Every module route registered, with its owner, for tests (T500). */
export const moduleRoutePaths: Array<{ owner: string; method: string; path: string }> = [];

function routerFor(owner: string): ModuleRouter {
  const add = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE") => (path: string, ...handlers: Handler<AppEnv>[]) => {
    if (!path.startsWith("/api/") || path.startsWith("/api/public/") || path.includes("..")) throw new Error(`Module route ${method} ${path} of ${owner} must be under /api/ and not /api/public/`);
    moduleRoutePaths.push({ owner, method, path });
    moduleRoutes.add(method, path, ...handlers);
  };
  return { get: add("GET"), post: add("POST"), put: add("PUT"), patch: add("PATCH"), delete: add("DELETE") };
}

export function registerWorkspaceModule(def: WorkspaceModuleDef) {
  const testModule = /^test_[a-z]+$/.test(def.id) && process.env.NODE_ENV === "test";
  if (!isWorkspaceModuleId(def.id) && !testModule) throw new Error(`Unknown workspace module ${def.id}`);
  if (modules.has(def.id)) throw new Error(`Workspace module ${def.id} is already registered`);
  modules.set(def.id, def);
  if (def.accessContainer) registerAccessContainer(def.accessContainer);
  for (const item of def.itemKinds ?? []) registerItemKind(item.kind, item.anchors);
  for (const adapter of def.workKinds ?? []) registerWorkKind(adapter);
  if (def.mcpTools?.length) registerMcpTools(def.mcpTools);
  for (const resource of def.mcpResources ?? []) registerMcpResource(resource);
  if (def.agentTools) registerAgentTools(def.agentTools);
  for (const { type, provider } of def.binProviders ?? []) registerBinProvider(type, provider);
  for (const { name, provider } of def.todayProviders ?? []) registerTodayProvider(name, provider);
  for (const scope of def.searchScopes ?? []) registerSearchScope(scope);
  for (const dataset of def.datasets ?? []) registerDataset(dataset);
  for (const [purpose, handler] of Object.entries(def.scheduleHandlers ?? {})) registerScheduleHandler(purpose, handler);
  for (const { kind, source } of def.progressSources ?? []) registerProgressSource(kind, source);
  for (const [name, template] of Object.entries(def.mailTemplates ?? {})) registerMailTemplate(name, template);
  for (const { kind, def: kindDef } of def.proposalKinds ?? []) registerProposalKind(kind, kindDef);
  for (const section of def.digestSections ?? []) registerDigestSection(section);
  for (const [kind, undo] of Object.entries(def.undoKinds ?? {})) registerUndoKind(kind, undo);
  for (const entry of def.readOnlyWrites ?? []) registerReadOnlyWrite(entry);
  if (def.publicRoutes) registerPublicRoutes(def.id, def.publicRoutes);
  if (def.routes) def.routes(routerFor(def.id));
}

export const registeredWorkspaceModules = () => [...modules.keys()];

/** Mounts the module routes' dispatcher (server/index.ts, after every guard, before the /api 404). */
export function mountWorkspaceModuleRoutes(app: Hono<AppEnv>) {
  app.use("/api/*", moduleRoutes.middleware());
}
