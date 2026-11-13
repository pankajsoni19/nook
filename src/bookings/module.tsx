import { CalendarClock } from "lucide-react";
import type { WorkspaceClientModule } from "../workspaceModules/types";

/**
 * Bookings (lane BOOK, docs/plan/WORKSPACE_MODULES.md). A Wave 1 stub (W1-UI, D832): hidden everywhere
 * until the lane fills it in and sets `ready: true`. The lane owns this file; `WorkspaceClientModule`
 * lists what it can register (routes, launcher, Today sections, quick actions, card slots, embeds,
 * slash items, search, settings rows).
 */
export const module: WorkspaceClientModule = {
  id: "bookings",
  segment: "bookings",
  label: "Bookings",
  icon: CalendarClock,
  description: "Booking pages people outside the workspace use to book time with you.",
  ready: false,
  app: null
};
