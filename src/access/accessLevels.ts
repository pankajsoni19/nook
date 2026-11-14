import type { WorkspaceContainerKind } from "../../shared/workspaceModules";

/**
 * The item level ladder on the client (access plan D266, §C.2, §D.3), mirroring
 * server/access/levels.ts. Chrome only: the server decides every write.
 */
export type Level = "view" | "comment" | "edit" | "manage";
export type ItemLevel = "none" | Level | "owner";
/** Wave 43 (AC-D): agents (view, manage) and chats (view) use the same sheet. */
/** Every workspace container uses the same sheet over the generic `/api/access/:kind/:id` (D803, D1085, D1050). */
export type AccessKind = "note" | "folder" | "document" | "board" | "task_view" | "collection" | "calendar" | "agent" | "chat" | "knowledge_base" | WorkspaceContainerKind;

/**
 * The workspace containers' words in the Access sheet (D1050): one row per kind, so a module joins by
 * a row here, never a branch in the sheet. `noun` names it in the audience hints, `levels` is the line
 * under each level, and `privateHint` replaces "Nobody else can open this …" where the module itself
 * adds people (a standup's participants, a goal's contributors); `defaultLevel` is where a new person starts.
 */
export const WORKSPACE_ACCESS: Record<WorkspaceContainerKind, { noun: string; levels: Record<Level, string>; privateHint?: string; defaultLevel?: Level }> = {
  form: { noun: "form", levels: { view: "See results and responses", comment: "Also comment on responses", edit: "Also edit the questions, settings, and actions", manage: "Also sharing, the public link, and the Bin" } },
  time_project: { noun: "project", levels: { view: "See the project; guests log their own time", comment: "See the project and comment", edit: "Log time and see everyone's entries", manage: "Also rates, approvals, budgets, and sharing" }, defaultLevel: "edit" },
  goal: { noun: "goal", levels: { view: "See the goal, its key results, and check-ins", comment: "Also comment and link work", edit: "Also check in, edit, and add key results", manage: "Also sharing and the Bin" }, privateHint: "Only you and its contributors can open this goal" },
  checkin: { noun: "standup", levels: { view: "Read the answers (as the standup allows)", comment: "Also comment and react", edit: "Also change the questions, schedule, and people", manage: "Also sharing and the Bin" }, privateHint: "Only you and the people taking part can open this standup" },
  contact_book: { noun: "contact book", levels: { view: "See contacts, companies, and deals", comment: "Also comment on them", edit: "Also add and change records and log interactions", manage: "Also fields, pipelines, settings, and sharing" } },
  booking_type: { noun: "booking type", levels: { view: "See the type and its bookings", comment: "Also comment on bookings", edit: "Also change the type's details and questions", manage: "Also hosts, calendars, links, and sharing" } },
  townhall_session: { noun: "townhall", levels: { view: "Ask, upvote, and vote in polls", comment: "Also reply under questions", edit: "Host: moderate, run polls, change the session", manage: "Also sharing and delete" } }
};

export const isWorkspaceAccessKind = (kind: AccessKind): kind is WorkspaceContainerKind => Object.prototype.hasOwnProperty.call(WORKSPACE_ACCESS, kind);

const RANK: Record<ItemLevel, number> = { none: 0, view: 1, comment: 2, edit: 3, manage: 4, owner: 5 };

/** Whether `level` reaches `needed`; an older server that sends no level keeps today's behaviour (`fallback`). */
export function levelAtLeast(level: ItemLevel | undefined | null, needed: ItemLevel, fallback: ItemLevel = "edit") {
  return RANK[level ?? fallback] >= RANK[needed];
}

export const LEVEL_LABELS: Record<Level, string> = { view: "Can view", comment: "Can comment", edit: "Can edit", manage: "Manager" };

/** One line per level and kind, under each option of the level Select (§E). */
export function levelDescription(kind: AccessKind, level: Level): string {
  switch (kind) {
    case "board":
      return { view: "Read cards and comments", comment: "Read, comment, and react", edit: "Add, change, and move cards, not columns or sharing", manage: "Also columns, tags, sprints, and sharing up to Can edit" }[level];
    case "collection":
      return { view: "Read rows and export", comment: "Read rows", edit: "Add, change, and delete rows, not fields or sharing", manage: "Also fields, views, name, and sharing up to Can edit" }[level];
    case "calendar":
      return { view: "See events", comment: "See events", edit: "Add and change events, not the calendar or sharing", manage: "Also rename, colour, and sharing up to Can edit" }[level];
    case "note":
      return level === "edit" ? "Write the draft and publish; never share, move, or delete" : "Read the published note";
    case "folder":
      return level === "edit" ? "Also write and publish the notes that use its access; never share, move, or delete" : "Read the notes and files that use the folder's access";
    case "task_view":
      return "Run the saved view; cards show only from boards they can open";
    case "document":
      return "Open and download";
    case "agent":
      return level === "manage" ? "Also edit its prompt, model, tools, and starters, and share it at Can view; never delete it" : "Chat with it; never see its prompt or tools";
    case "chat":
      return "Read the conversation, tool calls and results included, and continue in their own copy";
    case "knowledge_base":
      return level === "manage" ? "Also add and remove sources, re-index, attach it to agents, and share it at Can view; never delete it" : "Search it (Try it); attaching it to agents needs Manage";
    default:
      return WORKSPACE_ACCESS[kind].levels[level];
  }
}

/** Compares levels on the ladder (view < comment < edit < manage). */
export const levelRank = (level: ItemLevel) => RANK[level];
