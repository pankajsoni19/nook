import { db } from "../db";
import { capByRole, LEVEL_RANK, maxLevel, type ItemLevel } from "../access/levels";
import { itemLevel, readableContainerSql } from "../access/workspaceItems";
import { userRole } from "../team/userRole";
import { isShortId } from "../../shared/friendlyUrls";

/**
 * Who can open and change a goal (lane GOALS, §B.9, D900, D907). A goal is a sharing container of kind
 * `goal` (server/access/workspaceItems.ts: owner, visibility, share_role, item members, group grants),
 * and its **contributors** (`goal_contributors`) also hold `edit`, capped by their Team role, so they
 * can check in on a private goal they work on. No access is inherited from a parent goal (D900).
 */

export type GoalRow = {
  id: string; short_id: string; owner_id: string; parent_id: string | null; period_id: string | null; title: string; description_md: string;
  kind: "objective" | "kpi"; group_id: string | null; start_on: string | null; due_on: string | null;
  state: "draft" | "active" | "achieved" | "missed" | "dropped" | "carried_over"; health: "none" | "on_track" | "at_risk" | "off_track";
  progress: number; progress_mode: "key_results" | "children" | "manual"; checkin_cadence: "none" | "weekly" | "biweekly" | "monthly";
  last_checkin_at: string | null; closed_at: string | null; final_progress: number | null; position: number; color: string | null;
  visibility: "private" | "selected" | "all_users"; share_role: string; deleted_at: string | null; deleted_by: string | null; purge_after: string | null;
  purge_started_at: string | null; revision: number; created_at: string; updated_at: string;
};

/** A goal row by id or short id (live or binned), or null. */
export function goalRow(ref: string): GoalRow | null {
  const value = ref.toLowerCase();
  const column = isShortId(value) ? "short_id" : "id";
  return db.query(`SELECT * FROM goals WHERE ${column} = ?`).get(value) as GoalRow | null;
}

const isContributor = (goalId: string, userId: string) => db.query("SELECT 1 FROM goal_contributors WHERE goal_id = ? AND user_id = ?").get(goalId, userId) !== null;

/** The viewer's live level on a goal; `none` when it is binned, missing, or unreadable. */
export function goalLevel(goalId: string, userId: string): ItemLevel {
  const base = itemLevel("goal", goalId, userId);
  if (base === "owner") return base;
  const row = db.query("SELECT deleted_at FROM goals WHERE id = ?").get(goalId) as { deleted_at: string | null } | null;
  if (!row || row.deleted_at !== null) return "none";
  if (!isContributor(goalId, userId)) return base;
  const role = userRole(userId);
  return maxLevel(base, capByRole("edit", role));
}

export const atLeast = (level: ItemLevel, needed: ItemLevel) => LEVEL_RANK[level] >= LEVEL_RANK[needed];

/**
 * SQL: goal `alias` is readable by `$userId` (sharing, or a contributor whose account is live). Live
 * goals only; used before LIMIT so pages hold only readable goals.
 */
export function readableGoalSql(alias = "g", userParam = "$userId") {
  return `(${readableContainerSql("goal", alias, { userParam })} OR (${alias}.deleted_at IS NULL AND EXISTS (SELECT 1 FROM goal_contributors gc JOIN users gcu ON gcu.id = gc.user_id
    WHERE gc.goal_id = ${alias}.id AND gc.user_id = ${userParam} AND gcu.disabled_at IS NULL)))`;
}

/** The ids among `ids` the user can read (one query). */
export function readableGoalIds(ids: readonly string[], userId: string): Set<string> {
  if (!ids.length) return new Set();
  const rows = db.query(`SELECT g.id FROM goals g WHERE g.id IN (SELECT value FROM json_each($ids)) AND ${readableGoalSql("g")}`).all({ ids: JSON.stringify([...new Set(ids)]), userId }) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}
