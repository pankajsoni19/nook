import { registerWorkspaceModule } from "../workspaceModules";

/**
 * Contacts (module id `crm`): the module entry (docs/plan/WORKSPACE_MODULES.md §D.5). A stub from Wave 1 (W1-CORE):
 * lane CRM fills this file with the module's registrations (routes, public routes, MCP tools, access
 * container, item and work kinds, Bin, Today, search, datasets, schedules, mail, proposals, digest) and
 * keeps everything else in server/crm/. Migrations 102–105 (server/migrations/workspace/crm.ts),
 * decisions D960–D999, threats T560–T574. The module stays hidden in the app until its client module is ready.
 */
registerWorkspaceModule({ id: "crm" });
