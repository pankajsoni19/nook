import { registerWorkspaceModule } from "../workspaceModules";

/**
 * Standups (module id `checkins`): the module entry (docs/plan/WORKSPACE_MODULES.md §D.4). A stub from Wave 1 (W1-CORE):
 * lane CHECKINS fills this file with the module's registrations (routes, public routes, MCP tools, access
 * container, item and work kinds, Bin, Today, search, datasets, schedules, mail, proposals, digest) and
 * keeps everything else in server/checkins/. Migrations 099–101 (server/migrations/workspace/checkins.ts),
 * decisions D930–D959, threats T550–T559. The module stays hidden in the app until its client module is ready.
 */
registerWorkspaceModule({ id: "checkins" });
