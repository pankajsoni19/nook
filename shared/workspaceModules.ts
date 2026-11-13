/**
 * The workspace modules' vocabulary (docs/plan/WORKSPACE_MODULES.md §B.1, D800): every word the seven
 * modules need in the shared registries, declared once by Wave 1 so the module lanes only add files.
 * Pure: no imports, so the server, the client, and tests share it.
 *
 * Product owner answers (§G.1): the `crm` module is called **Contacts** everywhere a person reads it
 * (labels, nav, URLs `/contacts/...`), and `checkins` is called **Standups** (`/standups/...`). The ids
 * stay `crm` and `checkins` internally (scopes, grants, tables). Townhall is the seventh module.
 */

/** Module ids, in Settings order (after `reports`). Server MODULE_IDS and the client's spread these. */
export const WORKSPACE_MODULE_IDS = ["forms", "time", "goals", "checkins", "crm", "bookings", "townhall"] as const;
export type WorkspaceModuleId = typeof WORKSPACE_MODULE_IDS[number];
export const isWorkspaceModuleId = (value: unknown): value is WorkspaceModuleId =>
  typeof value === "string" && (WORKSPACE_MODULE_IDS as readonly string[]).includes(value);

/** What a person reads for each module (§G.1 Q7), and the first URL segment of its app. */
export const WORKSPACE_MODULE_LABELS: Record<WorkspaceModuleId, { label: string; path: string; description: string }> = {
  forms: { label: "Forms", path: "/forms", description: "Forms, surveys, polls, and find-a-time polls." },
  time: { label: "Time", path: "/time", description: "Timers, timesheets, projects, and time reports." },
  goals: { label: "Goals", path: "/goals", description: "Goals with key results, check-ins, and progress from your work." },
  checkins: { label: "Standups", path: "/standups", description: "Scheduled standups, retros, and pulse surveys." },
  crm: { label: "Contacts", path: "/contacts", description: "Contacts, companies, deals, and follow-ups." },
  bookings: { label: "Bookings", path: "/bookings", description: "Booking pages, availability, and meetings people book with you." },
  townhall: { label: "Townhall", path: "/townhall", description: "All-hands and AMA sessions: questions, upvotes, live polls, and recaps." }
};

/** The MCP scopes of the seven modules (§0): a read and a write scope each; write implies read. */
export const WORKSPACE_SCOPES = [
  "forms:read", "forms:write", "time:read", "time:write", "goals:read", "goals:write",
  "checkins:read", "checkins:write", "crm:read", "crm:write", "bookings:read", "bookings:write",
  "townhall:read", "townhall:write"
] as const;
export type WorkspaceScope = typeof WORKSPACE_SCOPES[number];

/**
 * Sharing containers (§B.9): the resource kinds key grants may name, and the access kinds of the
 * generic `item_members` / `item_group_grants` tables (D803). One per module.
 */
export const WORKSPACE_CONTAINER_KINDS = ["form", "time_project", "goal", "checkin", "contact_book", "booking_type", "townhall_session"] as const;
export type WorkspaceContainerKind = typeof WORKSPACE_CONTAINER_KINDS[number];

/** The container kind each module shares by, and back. */
export const MODULE_CONTAINER: Record<WorkspaceModuleId, WorkspaceContainerKind> = {
  forms: "form", time: "time_project", goals: "goal", checkins: "checkin", crm: "contact_book", bookings: "booking_type", townhall: "townhall_session"
};
export const CONTAINER_MODULE: Record<WorkspaceContainerKind, WorkspaceModuleId> = {
  form: "forms", time_project: "time", goal: "goals", checkin: "checkins", contact_book: "crm", booking_type: "bookings", townhall_session: "townhall"
};

/** Bin types the lanes register providers for (§B.13). Bookings are never binned. */
export const WORKSPACE_BIN_TYPES = ["form", "goal", "checkin", "contact_book", "contact", "company", "deal", "time_project", "booking_type", "townhall_session"] as const;
export type WorkspaceBinType = typeof WORKSPACE_BIN_TYPES[number];

/** Inbox proposal kinds pre-allowed by migration 085 (§B.7). */
export const WORKSPACE_PROPOSAL_KINDS = [
  "time_log", "goal_checkin", "contact_create", "contact_update", "deal_create", "deal_update", "interaction_log", "checkin_answer", "form_create", "townhall_question"
] as const;
export type WorkspaceProposalKind = typeof WORKSPACE_PROPOSAL_KINDS[number];

/** Inbox proposal target types pre-allowed by migration 085. */
export const WORKSPACE_PROPOSAL_TARGETS = [
  "form", "time_project", "time_entry", "goal", "key_result", "checkin", "checkin_round", "contact_book", "contact", "company", "deal", "townhall_session"
] as const;

/** Email categories (Settings → Notifications), one per module; keys of `email_prefs.categories`. */
export const WORKSPACE_MAIL_CATEGORIES = WORKSPACE_MODULE_IDS;

/** Access levels of the generic member tables (§B.9): owner sits above manage and is not stored. */
export const ITEM_LEVELS = ["view", "comment", "edit", "manage"] as const;
export type ItemLevel = typeof ITEM_LEVELS[number];
/** A viewer's effective level on an item: a stored level, `owner`, or null (no access). */
export type EffectiveItemLevel = ItemLevel | "owner" | null;
export const ITEM_LEVEL_RANK: Record<ItemLevel | "owner", number> = { view: 1, comment: 2, edit: 3, manage: 4, owner: 5 };
/** Whether `held` is at least `needed`. */
export const levelAtLeast = (held: EffectiveItemLevel, needed: ItemLevel | "owner") => held !== null && ITEM_LEVEL_RANK[held] >= ITEM_LEVEL_RANK[needed];

/** A container's audience (calendars and collections have the same shape). */
export const VISIBILITIES = ["private", "selected", "all_users"] as const;
export type Visibility = typeof VISIBILITIES[number];
