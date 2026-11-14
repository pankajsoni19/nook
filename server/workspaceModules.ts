import type { Hono } from "hono";
import type { AppEnv } from "./auth";
// The registry first, so the module files below find registerWorkspaceModule ready (their import of
// this file resolves to the registry's binding while this file is still loading).
import { mountWorkspaceModuleRoutes, registerWorkspaceModule, registeredWorkspaceModules, type ModuleRouter, type WorkspaceModuleDef } from "./workspaceRegistry";
import { registerWorkspaceAccessRoutes } from "./access/workspaceItems";
import { registerWorkLinkRoutes } from "./links/routes";
import { registerItemActivityRoutes } from "./activity/routes";
import { registerPeopleRoutes } from "./people/routes";
import { registerDatasetRoutes } from "./datasets/routes";
import { registerUndoRoutes } from "./undo";
import { registerWorkspaceSettingsRoutes } from "./workspaceSettings";
import { mountPublicMiddleware } from "./public/middleware";
import { mountPublicRoutes } from "./public/routes";
import { startScheduleDispatcher } from "./schedules/dispatcher";
import "./public/verification";
import "./mcpWorkTools";
// The modules (docs/plan/WORKSPACE_MODULES.md §B.1): each lane fills its own index.ts.
import "./forms/index";
import "./time/index";
import "./goals/index";
import "./checkins/index";
import "./crm/index";
import "./bookings/index";
import "./townhall/index";
// Wave 3: flows across two modules (server/wiring, D1040–D1059).
import "./wiring/index";

export { registerWorkspaceModule, registeredWorkspaceModules, type ModuleRouter, type WorkspaceModuleDef };

/**
 * The one import point of the workspace modules on the server (D801, T500). server/index.ts calls:
 *
 * - `mountWorkspacePublic(app)` before the session middleware: the strict public headers and the
 *   public dispatcher for `/p/*` and `/api/public/*`;
 * - `mountWorkspaceModules(app)` after every guard: the foundation's routes (links, refs, item
 *   activity and comments, the generic Access sheet, people search, datasets, undo, workspace
 *   settings) and the modules' routes (one dispatcher).
 */
export function mountWorkspacePublicHeaders(app: Hono<AppEnv>) {
  mountPublicMiddleware(app);
}

export function mountWorkspacePublic(app: Hono<AppEnv>) {
  mountPublicRoutes(app);
}

export function mountWorkspaceModules(app: Hono<AppEnv>) {
  registerWorkspaceSettingsRoutes(app);
  registerWorkspaceAccessRoutes(app);
  registerWorkLinkRoutes(app);
  registerItemActivityRoutes(app);
  registerPeopleRoutes(app);
  registerDatasetRoutes(app);
  registerUndoRoutes(app);
  mountWorkspaceModuleRoutes(app);
}

/** Starts the schedules dispatcher (after migrations and boot sweeps). */
export function startWorkspaceTimers() {
  startScheduleDispatcher();
}
