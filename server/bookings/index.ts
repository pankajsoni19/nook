import { registerWorkspaceModule } from "../workspaceModules";

/**
 * Bookings: the module entry (docs/plan/WORKSPACE_MODULES.md §D.6). A stub from Wave 1 (W1-CORE):
 * lane BOOK fills this file with the module's registrations (routes, public routes, MCP tools, access
 * container, item and work kinds, Bin, Today, search, datasets, schedules, mail, proposals, digest) and
 * keeps everything else in server/bookings/. Migrations 106–109 (server/migrations/workspace/bookings.ts),
 * decisions D1000–D1039, threats T575–T594. The module stays hidden in the app until its client module is ready.
 */
registerWorkspaceModule({ id: "bookings" });
