import { Timer } from "lucide-react";
import type { WorkspaceClientModule } from "../workspaceModules/types";

/**
 * Time (lane TIME, docs/plan/WORKSPACE_MODULES.md). A Wave 1 stub (W1-UI, D832): hidden everywhere
 * until the lane fills it in and sets `ready: true`. The lane owns this file; `WorkspaceClientModule`
 * lists what it can register (routes, launcher, Today sections, quick actions, card slots, embeds,
 * slash items, search, settings rows).
 */
export const module: WorkspaceClientModule = {
  id: "time",
  segment: "time",
  label: "Time",
  icon: Timer,
  description: "Timers and timesheets on cards, projects, and clients, with budgets and billable reports.",
  ready: false,
  app: null
};
