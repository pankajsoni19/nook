import { Sunrise } from "lucide-react";
import type { WorkspaceClientModule } from "../workspaceModules/types";

/**
 * Standups (lane CHECKINS, docs/plan/WORKSPACE_MODULES.md). A Wave 1 stub (W1-UI, D832): hidden everywhere
 * until the lane fills it in and sets `ready: true`. The lane owns this file; `WorkspaceClientModule`
 * lists what it can register (routes, launcher, Today sections, quick actions, card slots, embeds,
 * slash items, search, settings rows).
 */
export const module: WorkspaceClientModule = {
  id: "checkins",
  segment: "standups",
  label: "Standups",
  icon: Sunrise,
  description: "Standups, retros, and pulse surveys on a schedule, with blockers linked to cards.",
  ready: false,
  app: null
};
