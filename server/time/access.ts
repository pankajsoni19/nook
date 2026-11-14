import { db } from "../db";
import { itemLevel, readableContainerSql } from "../access/workspaceItems";
import { LEVEL_RANK, type ItemLevel } from "../access/levels";
import { readableBoardPredicate } from "../tasks/access";
import type { Role } from "../team/roles";

/**
 * Who sees and changes time (lane TIME, docs/plan/WORKSPACE_MODULES.md §D.2):
 *
 * - **Entries (D872):** your own always; every entry of a project to its `edit`-and-up members; an
 *   entry that tracks a card to everyone who can read the card (Jira worklogs, §G.1 Q5), unless its
 *   project keeps entries private (`settings.privateEntries`), when card readers see totals only.
 * - **Money (D873):** rates and amounts to the entry's author and the project's managers (`manage`
 *   and the owner) only; everyone else sees hours (T530).
 * - **Changing entries (T532):** the author, while the entry is not locked (D874); a project manager
 *   on that project's entries (never moving them to another project).
 * - **Logging on a project:** `edit` and up; a guest who is a member of the project at any level
 *   (§G.1 Q8: contractors log time on projects they belong to; guests are capped at `view`).
 *
 * Every predicate is SQL with named parameters (`$userId`), applied before LIMIT, so pages and counts
 * hold only what the viewer may see. The entry alias is `e`, its project `p` (LEFT JOIN).
 */

export const PROJECT_JOIN = "time_entries e LEFT JOIN time_projects p ON p.id = e.project_id";

const privateProject = "(p.id IS NOT NULL AND json_extract(p.settings_json, '$.privateEntries') = 1)";

/** A card the viewer can read, for an entry's target. */
export const readableCardTargetSql = `EXISTS (SELECT 1 FROM cards tk JOIN boards b ON b.id = tk.board_id WHERE tk.id = e.target_id AND tk.deleted_at IS NULL AND ${readableBoardPredicate})`;

/** Entries `$userId` may see in full (D872). */
export const visibleEntrySql = () => `(e.user_id = $userId
  OR (p.id IS NOT NULL AND ${readableContainerSql("time_project", "p", { minLevel: "edit" })})
  OR (e.target_kind = 'card' AND NOT ${privateProject} AND ${readableCardTargetSql}))`;

/**
 * The entry's live project is one `$userId` cannot open (TG4, D1143): a card reader, or an author who
 * lost access, sees the entry's time but not the project's name, color, or client.
 */
export const hiddenProjectSql = () => `(p.id IS NOT NULL AND p.deleted_at IS NULL AND NOT ${readableContainerSql("time_project", "p")})`;

/** What a project the viewer cannot open is called, wherever an entry shows its project. */
export const HIDDEN_PROJECT_LABEL = "A project you can't open";

/** Entries whose money `$userId` may see (D873). */
export const moneyVisibleSql = () => `(e.user_id = $userId OR (p.id IS NOT NULL AND ${readableContainerSql("time_project", "p", { minLevel: "manage" })}))`;

export type ProjectRow = {
  id: string; short_id: string; owner_id: string; name: string; code: string | null; color: string; company_id: string | null; board_id: string | null;
  billable_default: number; rate_minor: number | null; currency: string; budget_kind: "none" | "hours" | "money"; budget_value: number | null;
  budget_period: "total" | "monthly"; budget_alerted?: string | null; settings_json: string; archived_at: string | null; visibility: "private" | "selected" | "all_users"; share_role: string;
  revision: number; created_at: string; updated_at: string; deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null;
};

const roleQuery = () => db.query("SELECT role FROM users WHERE id = ? AND disabled_at IS NULL");
export const roleOf = (userId: string) => (roleQuery().get(userId) as { role: Role } | null)?.role ?? null;

export function projectRow(ref: string): ProjectRow | null {
  const lower = ref.toLowerCase();
  return db.query("SELECT * FROM time_projects WHERE id = ? OR short_id = ?").get(lower, lower) as ProjectRow | null;
}

/** The viewer's level on a live project (`none` when missing, binned, or unreadable). */
export const projectLevel = (projectId: string, userId: string): ItemLevel => itemLevel("time_project", projectId, userId);

export const atLeast = (level: ItemLevel, needed: Exclude<ItemLevel, "none">) => LEVEL_RANK[level] >= LEVEL_RANK[needed];

/** Whether the person may log time on the project (edit and up; a guest member at any level). */
export function canLogOn(projectId: string, userId: string): boolean {
  const level = projectLevel(projectId, userId);
  if (level === "none") return false;
  if (atLeast(level, "edit")) return true;
  return roleOf(userId) === "guest";
}

export const canManageProject = (projectId: string, userId: string) => atLeast(projectLevel(projectId, userId), "manage");

export function projectSettings(row: Pick<ProjectRow, "settings_json">): { privateEntries: boolean; requireDescription: boolean } {
  try {
    const parsed = JSON.parse(row.settings_json) as Record<string, unknown>;
    return { privateEntries: parsed.privateEntries === true, requireDescription: parsed.requireDescription === true };
  } catch {
    return { privateEntries: false, requireDescription: false };
  }
}
