import { registerWorkspaceModule } from "../workspaceModules";
import { checkinRoutes, CHECKIN_READ_ONLY_WRITES } from "./routes";
import { checkinTools, CHECKIN_READ_TOOLS, CHECKIN_WRITE_TOOLS, roundResource } from "./mcp";
import { DRIVE_PURPOSE, driveCheckin } from "./rounds";
import { binProvider, datasets, digestSection, itemKinds, mailTemplates, progressSources, proposalKind, searchScope, todayProvider, workKinds } from "./registrations";
import "../../shared/checkins";

export { registerStandupGoalUpdater } from "./goalUpdates";

/**
 * Standups (module id `checkins`): the module entry (docs/plan/WORKSPACE_MODULES.md §D.4, D930–D959).
 * Everything else lives in server/checkins/: rows and access (store.ts), writes (service.ts), rounds,
 * answers, and blockers (rounds.ts), reads (views.ts), HTTP (routes.ts), MCP (mcp.ts), and the
 * foundation registrations (registrations.ts). Migrations 099–100 (server/migrations/workspace/checkins.ts),
 * threats T550–T559.
 */
registerWorkspaceModule({
  id: "checkins",
  routes: checkinRoutes,
  readOnlyWrites: CHECKIN_READ_ONLY_WRITES,
  accessContainer: { kind: "checkin", table: "checkins", nameColumn: "name" },
  itemKinds,
  workKinds,
  mcpTools: checkinTools,
  mcpResources: [roundResource],
  agentTools: { allowed: CHECKIN_READ_TOOLS, never: CHECKIN_WRITE_TOOLS },
  binProviders: [{ type: "checkin", provider: binProvider }],
  todayProviders: [{ name: "checkinsDue", provider: todayProvider }],
  searchScopes: [searchScope],
  datasets,
  // The dispatcher passes the occurrence; events up to it run, then the schedule re-arms (D939).
  scheduleHandlers: { [DRIVE_PURPOSE]: { run: (schedule, fireAt) => { driveCheckin(schedule.owner.id, Math.max(Date.parse(fireAt), Date.now())); } } },
  progressSources,
  mailTemplates: mailTemplates as never,
  proposalKinds: [{ kind: "checkin_answer", def: proposalKind }],
  digestSections: [digestSection]
});
