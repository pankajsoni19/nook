import { db } from "../db";
import { registerStandupGoalUpdater } from "../checkins/goalUpdates";
import { CheckinError } from "../checkins/store";
import { checkIn, GoalError } from "../goals/service";
import { goalRow } from "../goals/access";
import { GOAL_LIMITS, type GoalHealth } from "../../shared/goals";

/**
 * Standups → Goals (docs/plan/WORKSPACE_MODULES.md §C C5, D1043): an answer's `goalUpdates` become
 * goal check-ins written as the participant, inside the answer's transaction, through Goals' own
 * `checkIn` (edit on the goal, which owners and contributors hold, T542), so a refused update fails the
 * answer with Goals' reason instead of half-saving it. Each check-in's note is the text of the
 * answer's goal update question(s) and names the standup; its health stays the goal's unless the
 * person chose one. A goal they cannot edit, or a key result of another goal, is refused (T596).
 */

const answerText = (answers: Record<string, unknown>, ids: readonly string[]) =>
  ids.map((id) => answers[id]).filter((value): value is string => typeof value === "string" && value.trim() !== "").join("\n\n").trim();

export const standupGoalUpdaterUnregister = registerStandupGoalUpdater((context) => {
  if (!context.goalUpdates.length) return;
  const seen = new Set<string>();
  const text = answerText(context.answers as Record<string, unknown>, context.questionIds);
  const note = `${text ? `${text}\n\n` : ""}From the standup “${context.checkinName}”`.slice(0, GOAL_LIMITS.note);
  for (const update of context.goalUpdates) {
    const goal = goalRow(update.goalId);
    if (!goal || goal.deleted_at !== null) throw new CheckinError(404, "NOT_FOUND", "Goal not found");
    if (seen.has(goal.id)) throw new CheckinError(400, "INVALID", "Each goal once per answer");
    seen.add(goal.id);
    try {
      // Keyed by the answer (D1059b): editing or retrying it updates this check-in, never adds one.
      checkIn(context.userId, goal.id, { health: (update.health ?? goal.health) as GoalHealth, confidence: update.confidence ?? null, note, values: update.values ?? {}, sourceRef: context.responseId });
    } catch (error) {
      if (error instanceof GoalError) throw new CheckinError(error.status, error.code, error.message);
      throw error;
    }
    db.query("INSERT OR IGNORE INTO work_links (id, a_kind, a_id, b_kind, b_id, relation, created_by, created_via, created_at) VALUES (?, 'checkin_round', ?, 'goal', ?, 'relates', ?, 'system', ?)")
      .run(Bun.randomUUIDv7(), context.responseId, goal.id, context.userId, new Date().toISOString());
  }
});
