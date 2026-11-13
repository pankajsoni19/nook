import { registerWorkspaceModule } from "../workspaceModules";
import { registerFormsRoutes, formsReadOnlyWrites } from "./routes";
import { registerFormsPublicRoutes } from "./public";
import { formsMcpTools, FORMS_AGENT_ALLOWED, FORMS_AGENT_NEVER } from "./mcp";
import { formItemKinds, formMetricSource, formsBinProvider, formsDatasets, formsSearchScope, formsTodayProviders, formWorkKinds } from "./registry";
import { formsMailTemplates, formsScheduleHandlers } from "./notifications";
import { recount } from "./service";
import "./actions";

/**
 * Forms & Polls: the module entry (docs/plan/WORKSPACE_MODULES.md §D.1, D840–D869, T515–T529).
 * Everything else lives in server/forms/: the service (service.ts), response actions (actions.ts),
 * notifications and schedules (notifications.ts), time-poll finalizing (finalize.ts), public pages
 * (public.ts), HTTP (routes.ts), MCP (mcp.ts), and the Bin, Today, search, datasets, work kinds, and
 * Goals progress source (registry.ts). Migrations 090–091 (server/migrations/workspace/forms.ts).
 */
registerWorkspaceModule({
  id: "forms",
  routes: registerFormsRoutes,
  publicRoutes: registerFormsPublicRoutes,
  mcpTools: formsMcpTools,
  agentTools: { allowed: FORMS_AGENT_ALLOWED, never: FORMS_AGENT_NEVER },
  accessContainer: { kind: "form", table: "forms", nameColumn: "title" },
  itemKinds: formItemKinds,
  workKinds: formWorkKinds,
  binProviders: [{ type: "form", provider: formsBinProvider }],
  todayProviders: formsTodayProviders,
  searchScopes: [formsSearchScope],
  datasets: formsDatasets,
  scheduleHandlers: formsScheduleHandlers,
  progressSources: [{ kind: "form_metric", source: formMetricSource as never }],
  mailTemplates: formsMailTemplates,
  readOnlyWrites: formsReadOnlyWrites.map((entry) => ({ ...entry, roles: [...entry.roles] })),
  // A restored response (Undo) counts again on its form.
  undoKinds: { response: { restored: (rows) => { for (const row of rows) if (row.table === "responses" && row.row.host_kind === "form") recount(String(row.row.host_id)); } } }
});
