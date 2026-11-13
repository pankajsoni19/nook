import { registerWorkspaceModule } from "../workspaceModules";

/**
 * Goals: the module entry (docs/plan/WORKSPACE_MODULES.md §D.3). A stub from Wave 1 (W1-CORE):
 * lane GOALS fills this file with the module's registrations (routes, public routes, MCP tools, access
 * container, item and work kinds, Bin, Today, search, datasets, schedules, mail, proposals, digest) and
 * keeps everything else in server/goals/. Migrations 096–098 (server/migrations/workspace/goals.ts),
 * decisions D900–D929, threats T540–T549. The module stays hidden in the app until its client module is ready.
 */
registerWorkspaceModule({ id: "goals" });
