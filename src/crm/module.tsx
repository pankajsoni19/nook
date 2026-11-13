import { Contact } from "lucide-react";
import type { WorkspaceClientModule } from "../workspaceModules/types";

/**
 * Contacts (lane CRM, docs/plan/WORKSPACE_MODULES.md). A Wave 1 stub (W1-UI, D832): hidden everywhere
 * until the lane fills it in and sets `ready: true`. The lane owns this file; `WorkspaceClientModule`
 * lists what it can register (routes, launcher, Today sections, quick actions, card slots, embeds,
 * slash items, search, settings rows).
 */
export const module: WorkspaceClientModule = {
  id: "crm",
  segment: "contacts",
  label: "Contacts",
  icon: Contact,
  description: "Contacts, companies, and deals, with a timeline of calls, meetings, and bookings.",
  ready: false,
  app: null
};
