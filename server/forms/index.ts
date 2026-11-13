import { registerWorkspaceModule } from "../workspaceModules";

/**
 * Forms & Polls: the module entry (docs/plan/WORKSPACE_MODULES.md §D.1). A stub from Wave 1 (W1-CORE):
 * lane FORMS fills this file with the module's registrations (routes, public routes, MCP tools, access
 * container, item and work kinds, Bin, Today, search, datasets, schedules, mail, proposals, digest) and
 * keeps everything else in server/forms/. Migrations 090–092 (server/migrations/workspace/forms.ts),
 * decisions D840–D869, threats T515–T529. The module stays hidden in the app until its client module is ready.
 */
registerWorkspaceModule({ id: "forms" });
