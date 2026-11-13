import { CalendarClock } from "lucide-react";
import { WORKSPACE_MODULE_LABELS } from "../../shared/workspaceModules";
import type { WorkspaceClientModule } from "../workspaceModules/types";

/**
 * Bookings (lane BOOK, docs/plan/WORKSPACE_MODULES.md). A Wave 1 stub (W1-UI, D832): hidden everywhere
 * until the lane fills it in and sets `ready: true`. The lane owns this file; `WorkspaceClientModule`
 * lists what it can register (routes, launcher, Today sections, quick actions, card slots, embeds,
 * slash items, search, settings rows).
 */
export const module: WorkspaceClientModule = {
  id: "bookings",
  segment: WORKSPACE_MODULE_LABELS.bookings.path.slice(1),
  label: WORKSPACE_MODULE_LABELS.bookings.label,
  icon: CalendarClock,
  description: WORKSPACE_MODULE_LABELS.bookings.description,
  ready: false,
  app: null
};
