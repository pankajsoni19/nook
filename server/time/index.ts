import { registerWorkspaceModule } from "../workspaceModules";

/**
 * Time: the module entry (docs/plan/WORKSPACE_MODULES.md §D.2). A stub from Wave 1 (W1-CORE):
 * lane TIME fills this file with the module's registrations (routes, public routes, MCP tools, access
 * container, item and work kinds, Bin, Today, search, datasets, schedules, mail, proposals, digest) and
 * keeps everything else in server/time/. Migrations 093–095 (server/migrations/workspace/time.ts),
 * decisions D870–D899, threats T530–T539. The module stays hidden in the app until its client module is ready.
 */
registerWorkspaceModule({ id: "time" });
