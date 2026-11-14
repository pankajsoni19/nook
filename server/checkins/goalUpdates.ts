import * as z from "zod/v4";
import type { Answers, QuestionSet } from "../../shared/questions";
import { STANDUP_GOAL_UPDATES_MAX } from "../../shared/checkins";
import { CheckinError } from "./store";

/**
 * Goal updates in standup answers (docs/plan/WORKSPACE_MODULES.md §C5, D945, D1043). Standups do not
 * depend on Goals: a `goal_update` question is stored as the person's text (goal links in it become
 * `mentions`), and the answer may carry structured `goalUpdates` (new values for the person's key
 * results, typed in the answer sheet beside that question). When a module registers an updater here
 * (Goals, through server/wiring) it is called inside the answer's transaction, as the person, to write
 * their goal check-ins. With nothing registered, structured updates are refused (nothing could apply
 * them) and the text is kept as before. An updater that throws fails the answer, so it must refuse only
 * what the person typed wrong.
 */
export const goalUpdateSchema = z.object({
  goalId: z.string().min(6).max(64),
  values: z.record(z.string().max(64), z.union([z.number(), z.boolean()])).optional(),
  health: z.enum(["on_track", "at_risk", "off_track", "none"]).optional(),
  confidence: z.number().int().min(1).max(10).nullable().optional()
}).strict();
export const goalUpdatesSchema = z.array(goalUpdateSchema).max(STANDUP_GOAL_UPDATES_MAX);
export type StandupGoalUpdate = z.infer<typeof goalUpdateSchema>;

export type GoalUpdateContext = { userId: string; checkinId: string; checkinName: string; roundId: string; responseId: string; set: QuestionSet; answers: Answers; goalUpdates: readonly StandupGoalUpdate[] };
export type GoalUpdater = (context: GoalUpdateContext & { questionIds: string[] }) => void;

const updaters: GoalUpdater[] = [];

export function registerStandupGoalUpdater(updater: GoalUpdater) {
  updaters.push(updater);
  return () => { const index = updaters.indexOf(updater); if (index >= 0) updaters.splice(index, 1); };
}

export const hasGoalUpdater = () => updaters.length > 0;

export function runGoalUpdaters(context: GoalUpdateContext) {
  const roleIds = context.set.questions.filter((question) => question.role === "goal_update").map((question) => question.id);
  if (context.goalUpdates.length) {
    if (!roleIds.length) throw new CheckinError(400, "NO_GOAL_QUESTION", "This standup has no goal update question");
    if (!updaters.length) throw new CheckinError(400, "NOT_AVAILABLE", "Goal updates need the Goals module");
  }
  const questionIds = roleIds.filter((id) => context.answers[id] !== undefined);
  if (!questionIds.length && !context.goalUpdates.length) return;
  for (const updater of updaters) updater({ ...context, questionIds });
}
