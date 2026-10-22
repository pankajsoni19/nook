import { db } from "../db";
import { AUDIENCE_ALL_USERS } from "../team/roles";
import type { ReportListLevel, ReportListVisibility } from "../../shared/reports";
import { ReportError } from "./errors";

/**
 * Who reaches a report list (phase 3, migration 068, D550–D551). The owner reads, curates, renames, shares,
 * and deletes it. `selected` lets the people and groups in `report_list_members` /
 * `report_list_group_shares` see it at `view`, or curate it at `edit` (add, remove, reorder); `all_users`
 * lets every person see it (never guests or integrations, AUDIENCE_ALL_USERS), at view. A Team viewer is
 * capped at view (D266: a role is a ceiling). Missing, binned, and forbidden are the same 404 (T168).
 * A list never grants access to its reports (D487): their reads go through readableReportSql.
 */

export type ListRow = {
  id: string; owner_id: string; name: string; visibility: ReportListVisibility; created_at: string; updated_at: string;
  deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null;
};

export const listNotFound = () => new ReportError(404, "NOT_FOUND", "List not found");

/** SQL: `$userId` is a person (not a guest, not blocked). */
const PERSON_SQL = "(SELECT u_rl.role <> 'guest' FROM users u_rl WHERE u_rl.id = $userId AND u_rl.disabled_at IS NULL) = 1";

/** SQL: the live list `alias` is visible to `$userId`. */
export const readableListSql = (alias = "l") => `(${alias}.deleted_at IS NULL AND (${alias}.owner_id = $userId
  OR (${alias}.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})
  OR (${alias}.visibility = 'selected' AND ${PERSON_SQL} AND (
    EXISTS (SELECT 1 FROM report_list_members lm WHERE lm.list_id = ${alias}.id AND lm.user_id = $userId)
    OR EXISTS (SELECT 1 FROM report_list_group_shares lg JOIN group_members gm_l ON gm_l.group_id = lg.group_id WHERE lg.list_id = ${alias}.id AND gm_l.user_id = $userId)))))`;

/** SQL: the caller's level on the readable list `alias` (owner, edit, or view; viewers and guests at most view). */
export const listLevelSql = (alias = "l") => `CASE WHEN ${alias}.owner_id = $userId THEN 'owner'
  WHEN ${alias}.visibility = 'selected' AND (SELECT u_ll.role IN ('admin', 'member') FROM users u_ll WHERE u_ll.id = $userId AND u_ll.disabled_at IS NULL) = 1 AND (
    EXISTS (SELECT 1 FROM report_list_members lm_l WHERE lm_l.list_id = ${alias}.id AND lm_l.user_id = $userId AND lm_l.level = 'edit')
    OR EXISTS (SELECT 1 FROM report_list_group_shares lg_l JOIN group_members gm_ll ON gm_ll.group_id = lg_l.group_id WHERE lg_l.list_id = ${alias}.id AND gm_ll.user_id = $userId AND lg_l.level = 'edit')) THEN 'edit'
  ELSE 'view' END`;

/** A live list the caller can see, with their level on it; anything else is a 404. */
export function readableList(id: string, userId: string): ListRow & { level: ReportListLevel } {
  const row = db.query(`SELECT l.*, ${listLevelSql("l")} AS level FROM report_lists l WHERE l.id = $id AND ${readableListSql("l")}`).get({ id, userId }) as (ListRow & { level: ReportListLevel }) | null;
  if (!row) throw listNotFound();
  return row;
}

/** A list the caller curates (its owner, or `edit`): add, remove, reorder. A reader gets 403; anyone else 404. */
export function curatedList(id: string, userId: string) {
  const row = readableList(id, userId);
  if (row.level === "view") throw new ReportError(403, "ROLE_READ_ONLY", "You can view this list; ask its owner for the edit level to change it");
  return row;
}

/** A list the caller owns: rename, share, delete. A curator or reader gets 403; anyone else 404. */
export function ownedList(id: string, userId: string) {
  const row = readableList(id, userId);
  if (row.level !== "owner") throw new ReportError(403, "OWNER_ONLY", "Only the list's owner can rename, share, or delete it");
  return row;
}
