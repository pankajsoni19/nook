import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { cancelSchedules } from "../schedules/service";
import { recordItemActivity } from "../activity/service";
import { currentSet, draftSet, publishSet, saveDraftSet, QuestionError } from "../questions/service";
import { canWriteContent } from "../team/userRole";
import { readPolicies } from "../team/policies";
import { LEVEL_RANK, type ItemLevel } from "../access/levels";
import { scheduleRuleProblem } from "../../shared/schedules";
import { isValidTimeZone } from "../../shared/calendarRecurrence";
import { CHECKIN_DESCRIPTION_MAX, CHECKIN_MAX_GROUPS, CHECKIN_MAX_PARTICIPANTS, CHECKIN_NAME_MAX, CHECKIN_TEMPLATE_DEFS, DATE_PATTERN, type CheckinSchedule, type CheckinTemplate } from "../../shared/checkins";
import type { QuestionSet } from "../../shared/questions";
import { CheckinError, checkinLevel, checkinRow, notFound, scheduleOf, type CheckinRow } from "./store";
import { DRIVE_PURPOSE, joinOpenRounds, leaveOpenRounds, rearm, syncGroupParticipants } from "./rounds";

/**
 * Standups' writes (docs/plan/WORKSPACE_MODULES.md §D.4): creating one from a template, its settings
 * and schedule, participants (people and groups), questions (draft and publish through the question
 * engine), the Bin, and each person's own zone, pause, and summary choice. Every write is one
 * transaction with its audit row and item activity (the D742 pattern), so the web app, MCP, REST v1,
 * and approved proposals behave the same.
 */

export type ParticipantsInput = { people: string[]; groups: string[] };
export type CheckinInput = {
  name?: string;
  template: CheckinTemplate;
  description?: string;
  schedule?: Partial<CheckinSchedule>;
  deadlineMinutes?: number;
  reminderMinutesBefore?: number | null;
  participants?: ParticipantsInput;
  privateAnswers?: boolean;
  summary?: { notifyParticipants?: boolean; email?: boolean };
};
export type CheckinPatch = Partial<Omit<CheckinInput, "template" | "participants">> & { status?: "active" | "paused"; expectedRevision?: number };

const requireLevel = (row: CheckinRow | null, userId: string, needed: ItemLevel, what = "change this standup") => {
  const level = checkinLevel(row, userId);
  if (level === "none") throw notFound();
  if (LEVEL_RANK[level] < LEVEL_RANK[needed] || !canWriteContent(userId)) throw new CheckinError(403, "READ_ONLY", `You can't ${what}`);
  return { row: row!, level };
};

function checkSchedule(schedule: CheckinSchedule): CheckinSchedule {
  const clean: CheckinSchedule = {
    weekdays: [...new Set(schedule.weekdays)].sort(), at: schedule.at, everyNWeeks: schedule.everyNWeeks ?? 1,
    zoneMode: schedule.zoneMode === "fixed" ? "fixed" : "each", tz: schedule.tz
  };
  if (!isValidTimeZone(clean.tz)) throw new CheckinError(400, "INVALID", "Choose a valid time zone");
  const problem = scheduleRuleProblem({ cadence: { weekdays: clean.weekdays, at: clean.at, ...(clean.everyNWeeks > 1 ? { everyNWeeks: clean.everyNWeeks } : {}) } }, clean.tz);
  if (problem) throw new CheckinError(400, "INVALID", problem);
  return clean;
}

function checkName(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > CHECKIN_NAME_MAX) throw new CheckinError(400, "INVALID", `A name is 1 to ${CHECKIN_NAME_MAX} characters`);
  return trimmed;
}

function checkTimes(deadline: number, reminder: number | null) {
  if (!Number.isInteger(deadline) || deadline < 30 || deadline > 10_080) throw new CheckinError(400, "INVALID", "The deadline is 30 minutes to 7 days after it opens");
  if (reminder !== null && (!Number.isInteger(reminder) || reminder < 5 || reminder >= deadline)) throw new CheckinError(400, "INVALID", "Remind at least 5 minutes before, and before the deadline");
}

/** Validates people and groups: live team members (guests only when sharing with guests is on). */
function checkParticipants(input: ParticipantsInput) {
  const people = [...new Set(input.people.map((id) => id.toLowerCase()))];
  const groups = [...new Set(input.groups.map((id) => id.toLowerCase()))];
  if (people.length > CHECKIN_MAX_PARTICIPANTS) throw new CheckinError(400, "INVALID", `At most ${CHECKIN_MAX_PARTICIPANTS} people`);
  if (groups.length > CHECKIN_MAX_GROUPS) throw new CheckinError(400, "INVALID", `At most ${CHECKIN_MAX_GROUPS} groups`);
  if (people.length) {
    const found = db.query("SELECT id, role FROM users WHERE disabled_at IS NULL AND kind = 'person' AND id IN (SELECT value FROM json_each(?))").all(JSON.stringify(people)) as Array<{ id: string; role: string }>;
    if (found.length !== people.length) throw new CheckinError(400, "INVALID", "One or more people were not found");
    if (!readPolicies().shareWithGuests && found.some((user) => user.role === "guest")) throw new CheckinError(400, "GUEST_SHARE_DISABLED", "Sharing with guests is turned off for this Nook");
  }
  if (groups.length) {
    const found = db.query("SELECT id FROM user_groups WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(groups)) as Array<{ id: string }>;
    if (found.length !== groups.length) throw new CheckinError(400, "INVALID", "One or more groups were not found");
  }
  return { people, groups };
}

function writeParticipants(checkinId: string, input: { people: string[]; groups: string[] }, timestamp: string) {
  const before = new Set((db.query("SELECT user_id FROM checkin_participants WHERE checkin_id = ?").all(checkinId) as Array<{ user_id: string }>).map((row) => row.user_id));
  db.query("DELETE FROM checkin_participant_groups WHERE checkin_id = ?").run(checkinId);
  const insertGroup = db.query("INSERT INTO checkin_participant_groups (checkin_id, group_id, created_at) VALUES (?, ?, ?)");
  for (const groupId of input.groups) insertGroup.run(checkinId, groupId, timestamp);
  // Direct rows: the chosen people (a group row for the same person becomes direct).
  db.query("DELETE FROM checkin_participants WHERE checkin_id = ? AND via_group_id IS NULL AND user_id NOT IN (SELECT value FROM json_each(?))").run(checkinId, JSON.stringify(input.people));
  for (const userId of input.people) {
    db.query(`INSERT INTO checkin_participants (checkin_id, user_id, joined_at) VALUES (?, ?, ?)
      ON CONFLICT (checkin_id, user_id) DO UPDATE SET via_group_id = NULL`).run(checkinId, userId, timestamp);
  }
  syncGroupParticipants(checkinId, timestamp);
  const after = new Set((db.query("SELECT user_id FROM checkin_participants WHERE checkin_id = ?").all(checkinId) as Array<{ user_id: string }>).map((row) => row.user_id));
  return { added: [...after].filter((id) => !before.has(id)), removed: [...before].filter((id) => !after.has(id)), count: after.size };
}

export function createCheckin(userId: string, input: CheckinInput, nowMs = Date.now()): CheckinRow {
  if (!canWriteContent(userId)) throw new CheckinError(403, "READ_ONLY", "Your team role can't create standups");
  const template = CHECKIN_TEMPLATE_DEFS[input.template];
  if (!template) throw new CheckinError(400, "INVALID", "Unknown template");
  const name = checkName(input.name ?? template.name);
  const description = (input.description ?? "").trim();
  if (description.length > CHECKIN_DESCRIPTION_MAX) throw new CheckinError(400, "INVALID", `A description is at most ${CHECKIN_DESCRIPTION_MAX} characters`);
  const schedule = checkSchedule({ ...template.schedule, tz: "UTC", ...input.schedule } as CheckinSchedule);
  const deadline = input.deadlineMinutes ?? template.deadlineMinutes;
  const reminder = input.reminderMinutesBefore === undefined ? template.reminderMinutesBefore : input.reminderMinutesBefore;
  checkTimes(deadline, reminder);
  const participants = checkParticipants(input.participants ?? { people: [userId], groups: [] });
  const id = crypto.randomUUID();
  const timestamp = new Date(nowMs).toISOString();
  return db.transaction(() => {
    const { tz, ...stored } = schedule;
    db.query(`INSERT INTO checkins (id, owner_id, name, template, description_md, anonymous, private_answers, status, schedule_json, tz, deadline_minutes, reminder_minutes_before, summary_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, name, input.template, description, template.anonymous ? 1 : 0, input.privateAnswers ? 1 : 0,
      JSON.stringify(stored), tz, deadline, reminder, JSON.stringify({ notifyParticipants: input.summary?.notifyParticipants !== false, email: input.summary?.email === true }), timestamp, timestamp);
    const host = { kind: "checkin" as const, id };
    saveDraftSet(host, template.questions(), userId);
    publishSet(host, userId);
    writeParticipants(id, participants, timestamp);
    recordItemActivity({ itemKind: "checkin", itemId: id, actorId: userId, kind: "created", payload: { to: { label: name } }, at: timestamp });
    audit(userId, null, "checkins.create", { checkinId: id, template: input.template, participants: participants.people.length, groups: participants.groups.length });
    const row = checkinRow(id)!;
    rearm(row, nowMs);
    return row;
  })();
}

export function updateCheckin(userId: string, ref: string, patch: CheckinPatch, nowMs = Date.now()): CheckinRow {
  return db.transaction(() => {
    const { row } = requireLevel(checkinRow(ref), userId, "edit");
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== row.revision) throw new CheckinError(409, "CHECKIN_CHANGED", "This standup changed since you opened it", { revision: row.revision });
    const name = patch.name !== undefined ? checkName(patch.name) : row.name;
    const description = patch.description !== undefined ? patch.description.trim() : row.description_md;
    if (description.length > CHECKIN_DESCRIPTION_MAX) throw new CheckinError(400, "INVALID", `A description is at most ${CHECKIN_DESCRIPTION_MAX} characters`);
    const schedule = patch.schedule ? checkSchedule({ ...scheduleOf(row), ...patch.schedule } as CheckinSchedule) : scheduleOf(row);
    const deadline = patch.deadlineMinutes ?? row.deadline_minutes;
    const reminder = patch.reminderMinutesBefore === undefined ? row.reminder_minutes_before : patch.reminderMinutesBefore;
    checkTimes(deadline, reminder);
    const summary = { ...JSON.parse(row.summary_json) as Record<string, unknown>, ...(patch.summary ?? {}) };
    const { tz, ...stored } = schedule;
    db.query(`UPDATE checkins SET name = ?, description_md = ?, schedule_json = ?, tz = ?, deadline_minutes = ?, reminder_minutes_before = ?, status = ?, private_answers = ?,
        summary_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?`).run(name, description, JSON.stringify(stored), tz, deadline, reminder, patch.status ?? row.status,
      patch.privateAnswers === undefined ? row.private_answers : patch.privateAnswers ? 1 : 0, JSON.stringify(summary), new Date(nowMs).toISOString(), row.id);
    recordItemActivity({ itemKind: "checkin", itemId: row.id, actorId: userId, kind: "settings_changed" });
    audit(userId, null, "checkins.update", { checkinId: row.id, fields: Object.keys(patch).filter((key) => key !== "expectedRevision") });
    const updated = checkinRow(row.id)!;
    rearm(updated, nowMs);
    return updated;
  })();
}

/** To the Bin (owner or a manager), with its rounds and answers; the schedule stops. */
export function deleteCheckin(userId: string, ref: string, nowMs = Date.now()) {
  return db.transaction(() => {
    const { row } = requireLevel(checkinRow(ref), userId, "manage", "delete this standup");
    const at = new Date(nowMs);
    db.query("UPDATE checkins SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(at.toISOString(), userId, purgeAfterFrom(at), at.toISOString(), row.id);
    cancelSchedules({ kind: "checkin", id: row.id }, DRIVE_PURPOSE);
    recordItemActivity({ itemKind: "checkin", itemId: row.id, actorId: userId, kind: "binned" });
    audit(userId, null, "checkins.delete", { checkinId: row.id });
    return { binned: true, id: row.id };
  })();
}

export function setParticipants(userId: string, ref: string, input: ParticipantsInput, nowMs = Date.now()) {
  return db.transaction(() => {
    const { row } = requireLevel(checkinRow(ref), userId, "edit", "change who takes part");
    const checked = checkParticipants(input);
    const timestamp = new Date(nowMs).toISOString();
    const changed = writeParticipants(row.id, checked, timestamp);
    joinOpenRounds(row, changed.added, nowMs);
    leaveOpenRounds(row.id, changed.removed);
    db.query("UPDATE checkins SET revision = revision + 1, updated_at = ? WHERE id = ?").run(timestamp, row.id);
    recordItemActivity({ itemKind: "checkin", itemId: row.id, actorId: userId, kind: "participants_changed" });
    audit(userId, null, "checkins.participants", { checkinId: row.id, added: changed.added.length, removed: changed.removed.length, groups: checked.groups.length });
    rearm(checkinRow(row.id)!, nowMs);
    return { participants: changed.count, added: changed.added.length, removed: changed.removed.length };
  })();
}

/** A participant's own settings: their zone (stops following the browser) and a pause until a date (out of office). */
export function setMyParticipation(userId: string, ref: string, input: { tz?: string | null; pausedUntil?: string | null }, nowMs = Date.now()) {
  return db.transaction(() => {
    const row = checkinRow(ref);
    if (checkinLevel(row, userId) === "none") throw notFound();
    const participant = db.query("SELECT * FROM checkin_participants WHERE checkin_id = ? AND user_id = ?").get(row!.id, userId);
    if (!participant) throw new CheckinError(403, "NOT_PARTICIPANT", "You're not taking part in this standup");
    if (input.tz !== undefined && input.tz !== null && !isValidTimeZone(input.tz)) throw new CheckinError(400, "INVALID", "Choose a valid time zone");
    if (input.pausedUntil !== undefined && input.pausedUntil !== null && !DATE_PATTERN.test(input.pausedUntil)) throw new CheckinError(400, "INVALID", "Pause until a date (YYYY-MM-DD)");
    if (input.tz !== undefined) db.query("UPDATE checkin_participants SET tz = ?, tz_auto = ? WHERE checkin_id = ? AND user_id = ?").run(input.tz, input.tz === null ? 1 : 0, row!.id, userId);
    if (input.pausedUntil !== undefined) {
      db.query("UPDATE checkin_participants SET paused_until = ? WHERE checkin_id = ? AND user_id = ?").run(input.pausedUntil, row!.id, userId);
      // Open rounds on or before the pause's end count as out (not missed) while still pending.
      if (input.pausedUntil) {
        for (const round of db.query("SELECT id FROM checkin_rounds WHERE checkin_id = ? AND status = 'open' AND round_date <= ?").all(row!.id, input.pausedUntil) as Array<{ id: string }>) {
          db.query("UPDATE checkin_round_participants SET status = 'out' WHERE round_id = ? AND user_id = ? AND status = 'pending'").run(round.id, userId);
        }
      }
    }
    audit(userId, null, "checkins.participation", { checkinId: row!.id, tz: input.tz !== undefined, paused: input.pausedUntil ?? undefined });
    rearm(checkinRow(row!.id)!, nowMs);
    return db.query("SELECT tz, paused_until FROM checkin_participants WHERE checkin_id = ? AND user_id = ?").get(row!.id, userId) as { tz: string | null; paused_until: string | null };
  })();
}

/** The browser's zone for every standup where the person has not chosen one (the app sends it on open). */
export function setAutoTimeZone(userId: string, tz: string, nowMs = Date.now()) {
  if (!isValidTimeZone(tz)) throw new CheckinError(400, "INVALID", "Choose a valid time zone");
  return db.transaction(() => {
    const changed = db.query("SELECT checkin_id FROM checkin_participants WHERE user_id = ? AND tz_auto = 1 AND (tz IS NULL OR tz <> ?)").all(userId, tz) as Array<{ checkin_id: string }>;
    db.query("UPDATE checkin_participants SET tz = ? WHERE user_id = ? AND tz_auto = 1 AND (tz IS NULL OR tz <> ?)").run(tz, userId, tz);
    for (const { checkin_id } of changed) {
      const row = checkinRow(checkin_id);
      if (row && row.deleted_at === null) rearm(row, nowMs);
    }
    return { updated: changed.length };
  })();
}

export function setSubscription(userId: string, ref: string, summaries: boolean) {
  const row = checkinRow(ref);
  if (checkinLevel(row, userId) === "none") throw notFound();
  db.query(`INSERT INTO checkin_subscriptions (checkin_id, user_id, summaries) VALUES (?, ?, ?) ON CONFLICT (checkin_id, user_id) DO UPDATE SET summaries = excluded.summaries`)
    .run(row!.id, userId, summaries ? 1 : 0);
  return { summaries };
}

// ---------------------------------------------------------------- questions

export function readQuestions(userId: string, ref: string) {
  const row = checkinRow(ref);
  const level = checkinLevel(row, userId);
  if (level === "none") throw notFound();
  const host = { kind: "checkin" as const, id: row!.id };
  const current = currentSet(host);
  const draft = LEVEL_RANK[level] >= LEVEL_RANK.edit ? draftSet(host) : null;
  return { current: current?.set ?? null, version: current?.version ?? 0, draft: draft?.set ?? null, draftUpdatedAt: draft?.updatedAt ?? null };
}

function questionCall<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof QuestionError) throw new CheckinError(error.status, error.code, error.message, error.details);
    throw error;
  }
}

export function saveQuestions(userId: string, ref: string, set: unknown) {
  return db.transaction(() => {
    const { row } = requireLevel(checkinRow(ref), userId, "edit", "edit the questions");
    return { draft: questionCall(() => saveDraftSet({ kind: "checkin", id: row.id }, set, userId)) };
  })();
}

export function publishQuestions(userId: string, ref: string) {
  return db.transaction(() => {
    const { row } = requireLevel(checkinRow(ref), userId, "edit", "publish the questions");
    const published = questionCall(() => publishSet({ kind: "checkin", id: row.id }, userId));
    recordItemActivity({ itemKind: "checkin", itemId: row.id, actorId: userId, kind: "questions_published", payload: { extra: { version: published.version } } });
    audit(userId, null, "checkins.questions_publish", { checkinId: row.id, version: published.version, questions: published.set.questions.length });
    return published;
  })();
}

/** Restore from the Bin (the provider checks who may) and wake the schedule again. */
export function restoredCheckin(id: string) {
  const row = checkinRow(id);
  if (row) rearm(row);
}

export type { QuestionSet };
