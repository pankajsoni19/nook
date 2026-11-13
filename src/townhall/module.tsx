import { Presentation } from "lucide-react";
import type { WorkspaceClientModule } from "../workspaceModules/types";

/**
 * Townhall (lane TOWNHALL, docs/plan/WORKSPACE_MODULES.md). A Wave 1 stub (W1-UI, D832): hidden everywhere
 * until the lane fills it in and sets `ready: true`. The lane owns this file; `WorkspaceClientModule`
 * lists what it can register (routes, launcher, Today sections, quick actions, card slots, embeds,
 * slash items, search, settings rows).
 */
export const module: WorkspaceClientModule = {
  id: "townhall",
  segment: "townhall",
  label: "Townhall",
  icon: Presentation,
  description: "All-hands and AMAs: questions with upvotes, live polls, and a presenter view.",
  ready: false,
  app: null
};
