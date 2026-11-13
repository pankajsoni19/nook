import { ClipboardList } from "lucide-react";
import type { WorkspaceClientModule } from "../workspaceModules/types";

/**
 * Forms (lane FORMS, docs/plan/WORKSPACE_MODULES.md). A Wave 1 stub (W1-UI, D832): hidden everywhere
 * until the lane fills it in and sets `ready: true`. The lane owns this file; `WorkspaceClientModule`
 * lists what it can register (routes, launcher, Today sections, quick actions, card slots, embeds,
 * slash items, search, settings rows).
 */
export const module: WorkspaceClientModule = {
  id: "forms",
  segment: "forms",
  label: "Forms",
  icon: ClipboardList,
  description: "Forms, surveys, and polls: share them inside the workspace or on a public page, and see the answers.",
  ready: false,
  app: null
};
