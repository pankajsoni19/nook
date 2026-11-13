import type { Answers, QuestionSet } from "../../shared/questions";

/**
 * Goal updates in standup answers (docs/plan/WORKSPACE_MODULES.md §C5, D945). Standups do not depend on
 * Goals: a `goal_update` question is stored as the person's text (goal links in it become `mentions`),
 * and when a module registers an updater here (Goals, in Wave 3) it is called inside the answer's
 * transaction, as the person, to write their goal check-ins. With nothing registered, nothing else
 * happens. An updater that throws fails the answer, so it must refuse only what the person typed wrong.
 */
export type GoalUpdateContext = { userId: string; checkinId: string; roundId: string; responseId: string; set: QuestionSet; answers: Answers };
export type GoalUpdater = (context: GoalUpdateContext & { questionIds: string[] }) => void;

const updaters: GoalUpdater[] = [];

export function registerStandupGoalUpdater(updater: GoalUpdater) {
  updaters.push(updater);
  return () => { const index = updaters.indexOf(updater); if (index >= 0) updaters.splice(index, 1); };
}

export const hasGoalUpdater = () => updaters.length > 0;

export function runGoalUpdaters(context: GoalUpdateContext) {
  const questionIds = context.set.questions.filter((question) => question.role === "goal_update" && context.answers[question.id] !== undefined).map((question) => question.id);
  if (!questionIds.length) return;
  for (const updater of updaters) updater({ ...context, questionIds });
}
