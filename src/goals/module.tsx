import { Target } from "lucide-react";
import type { WorkspaceClientModule } from "../workspaceModules/types";

/**
 * Goals (lane GOALS, docs/plan/WORKSPACE_MODULES.md). A Wave 1 stub (W1-UI, D832): hidden everywhere
 * until the lane fills it in and sets `ready: true`. The lane owns this file; `WorkspaceClientModule`
 * lists what it can register (routes, launcher, Today sections, quick actions, card slots, embeds,
 * slash items, search, settings rows).
 */
export const module: WorkspaceClientModule = {
  id: "goals",
  segment: "goals",
  label: "Goals",
  icon: Target,
  description: "Goals and key results with check-ins and progress from tasks, time, contacts, and forms.",
  ready: false,
  app: null
};
