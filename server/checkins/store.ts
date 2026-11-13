import { db } from "../db";
import { avatarUrlFor } from "../avatars";
import { capByRole, LEVEL_RANK, type ItemLevel } from "../access/levels";
import { containerRow, itemLevel, readableContainerSql } from "../access/workspaceItems";
import { userRole } from "../team/userRole";
import { slugSegment, isShortId } from "../../shared/friendlyUrls";
import type { CheckinPerson, CheckinSchedule, CheckinTemplate, ParticipationState } from "../../shared/checkins";

/**
 * Standups' rows and access (docs/plan/WORKSPACE_MODULES.md §D.4, §B.9, T550).
 *
 * A standup is a workspace container (kind `checkin`): its owner, people and groups with a level, or
 * everyone signed in. Participants read it too (D938): taking part gives `comment` (so they can
 * comment on and react to answers), capped by their Team role, so a guest participant reads and
 * answers but never comments. `private_answers` narrows answers to their author and to managers.
 */

export type CheckinRow = {
  id: string; short_id: string; owner_id: string; name: string; template: CheckinTemplate; description_md: string; anonymous: number; private_answers: number;
  status: "active" | "paused"; schedule_json: string; tz: string; deadline_minutes: number; reminder_minutes_before: number | null; summary_json: string;
  visibility: "private" | "selected" | "all_users"; share_role: string; revision: number; created_at: string; updated_at: string;
  deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null;
};

export type RoundRow = {
  id: string; checkin_id: string; round_date: string; opens_at: string; closes_at: string; closed_at: string | null; status: "scheduled" | "open" | "closed";
  manual: number; answered_count: number; participant_count: number; summary_md: string | null; created_at: string;
};

export type RoundParticipantRow = {
  round_id: string; user_id: string; status: ParticipationState; opens_at: string; deadline_at: string; notified_at: string | null; reminded_at: string | null;
  nudged_at: string | null; answered_at: string | null; response_id: string | null;
};

export type ParticipantRow = { checkin_id: string; user_id: string; tz: string | null; tz_auto: number; paused_until: string | null; joined_at: string; via_group_id: string | null };

export class CheckinError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export const notFound = (what = "Standup") => new CheckinError(404, "NOT_FOUND", `${what} not found`);

export const scheduleOf = (row: Pick<CheckinRow, "schedule_json" | "tz">): CheckinSchedule => ({ ...(JSON.parse(row.schedule_json) as Omit<CheckinSchedule, "tz">), tz: row.tz });
export const summaryOptions = (row: Pick<CheckinRow, "summary_json">) => {
  const parsed = JSON.parse(row.summary_json) as { notifyParticipants?: boolean; email?: boolean };
  return { notifyParticipants: parsed.notifyParticipants !== false, email: parsed.email === true };
};

export const checkinHref = (row: Pick<CheckinRow, "name" | "short_id">) => `/standups/${slugSegment(row.name, row.short_id)}`;

/** A standup by id or short id, live or binned. */
export function checkinRow(ref: string): CheckinRow | null {
  const value = ref.toLowerCase();
  if (value.length > 64) return null;
  return db.query(`SELECT * FROM checkins WHERE ${isShortId(value) ? "short_id" : "id"} = ?`).get(value) as CheckinRow | null;
}

export const roundRow = (id: string) => (id.length <= 64 ? db.query("SELECT * FROM checkin_rounds WHERE id = ?").get(id.toLowerCase()) as RoundRow | null : null);

export const isParticipant = (checkinId: string, userId: string) => db.query("SELECT 1 FROM checkin_participants WHERE checkin_id = ? AND user_id = ?").get(checkinId, userId) !== null;

/** The viewer's level on a live standup: the container's, raised to `comment` for participants (role-capped). */
export function checkinLevel(row: CheckinRow | null, userId: string): ItemLevel {
  if (!row || row.deleted_at !== null) return "none";
  const level = itemLevel("checkin", row.id, userId);
  if (LEVEL_RANK[level] >= LEVEL_RANK.comment || !isParticipant(row.id, userId)) return level;
  const raised = capByRole("comment", userRole(userId));
  return LEVEL_RANK[raised] > LEVEL_RANK[level] ? raised : level;
}

export const levelFor = (ref: string, userId: string) => checkinLevel(checkinRow(ref), userId);

/** SQL: the standup aliased `alias` is readable by `$userId` (container access or participation). Live rows only. */
export const readableCheckinSql = (alias: string, userParam = "$userId") =>
  `(${readableContainerSql("checkin", alias, { userParam })} OR (${alias}.deleted_at IS NULL AND EXISTS (SELECT 1 FROM checkin_participants cp_r WHERE cp_r.checkin_id = ${alias}.id AND cp_r.user_id = ${userParam})))`;

/** Whether the viewer reads every answer of the standup, or only their own (`private_answers`, T550). */
export const readsAllAnswers = (row: CheckinRow, level: ItemLevel) => row.private_answers === 0 || LEVEL_RANK[level] >= LEVEL_RANK.manage;

/** People by id, as the API shows them. Missing ones read "Former member". */
export function people(ids: readonly string[]): Map<string, CheckinPerson> {
  const unique = [...new Set(ids)];
  const out = new Map<string, CheckinPerson>();
  if (!unique.length) return out;
  const rows = db.query("SELECT id, display_name, avatar_id FROM users WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(unique)) as Array<{ id: string; display_name: string; avatar_id: string | null }>;
  for (const row of rows) out.set(row.id, { id: row.id, name: row.display_name, avatarUrl: avatarUrlFor(row.id, row.avatar_id) });
  for (const id of unique) if (!out.has(id)) out.set(id, { id, name: "Former member", avatarUrl: null });
  return out;
}

export const personOf = (id: string) => people([id]).get(id)!;

export { containerRow };
