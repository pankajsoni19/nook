import { registerWorkspaceModule } from "../workspaceModules";

/**
 * Townhall: the module entry (docs/plan/WORKSPACE_MODULES.md §G.1). A stub from Wave 1 (W1-CORE):
 * lane TOWNHALL fills this file with the module's registrations (routes, public routes, MCP tools, access
 * container, item and work kinds, Bin, Today, search, datasets, schedules, mail, proposals, digest) and
 * keeps everything else in server/townhall/. Migrations 115–117 (server/migrations/workspace/townhall.ts),
 * decisions D1070–D1099, threats T610–T619. The module stays hidden in the app until its client module is ready.
 */
registerWorkspaceModule({ id: "townhall" });
