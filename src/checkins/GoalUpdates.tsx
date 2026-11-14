import { useEffect, useState } from "react";
import { Target } from "lucide-react";
import { api } from "../api";
import type { StandupGoalTarget } from "../../shared/checkins";

/**
 * Goal updates beside a `goal_update` question (§C C5, D1043): the person's open goals with their key
 * results; a number typed for a manual key result becomes a goal check-in when the answer is posted
 * (as them, with the question's text as its note). Automatic key results are shown for context. With
 * no goals, or Goals unavailable, it renders nothing and the question stays plain text.
 */
export type GoalValues = Record<string, Record<string, string>>;

export const loadGoalTargets = () => api<{ goals: StandupGoalTarget[] }>("/goals/checkin-targets").then((result) => result.goals).catch(() => [] as StandupGoalTarget[]);

/** The typed values as the answer's `goalUpdates` (numbers only; empty fields are left out). */
export function goalUpdatesOf(values: GoalValues) {
  return Object.entries(values).map(([goalId, krs]) => ({
    goalId,
    values: Object.fromEntries(Object.entries(krs).filter(([, text]) => text.trim() !== "" && Number.isFinite(Number(text))).map(([krId, text]) => [krId, Number(text)]))
  })).filter((update) => Object.keys(update.values).length > 0);
}

const amount = (value: number, unit: string | null, metric: string) => metric === "percent" ? `${value}%` : `${value}${unit ? ` ${unit}` : ""}`;

export function GoalUpdates({ targets, values, onChange, onOpenPath }: { targets: StandupGoalTarget[]; values: GoalValues; onChange: (values: GoalValues) => void; onOpenPath?: (path: string) => void }) {
  if (!targets.length) return <p className="standup-muted standup-goal-empty"><Target aria-hidden="true" />You have no open goals to update. Write your update instead.</p>;
  return <div className="standup-goals" role="group" aria-label="Your goals">
    {targets.map((goal) => <fieldset key={goal.id} className="standup-goal">
      <legend><a href={goal.href} onClick={(event) => { if (onOpenPath) { event.preventDefault(); onOpenPath(goal.href); } }}>{goal.title}</a><span className="standup-muted">{Math.round(goal.progress * 100)}%</span></legend>
      {goal.keyResults.map((kr) => {
        const id = `standup-kr-${kr.id}`;
        return <div key={kr.id} className="standup-goal-kr">
          <label htmlFor={id}>{kr.title}</label>
          {kr.manual
            ? <span className="standup-goal-input"><input id={id} type="number" inputMode="decimal" step="any" placeholder={String(kr.currentValue)} value={values[goal.id]?.[kr.id] ?? ""}
                onChange={(event) => onChange({ ...values, [goal.id]: { ...(values[goal.id] ?? {}), [kr.id]: event.target.value } })} aria-describedby={`${id}-of`} />
              <span id={`${id}-of`} className="standup-muted">of {amount(kr.targetValue, kr.unit, kr.metric)}</span></span>
            : <span className="standup-muted">{amount(kr.currentValue, kr.unit, kr.metric)} of {amount(kr.targetValue, kr.unit, kr.metric)} · updates itself</span>}
        </div>;
      })}
    </fieldset>)}
    <p className="standup-muted">Values you type check in on those goals when you post, with your update as the note.</p>
  </div>;
}

/** Loads the person's goals once, when the set has a goal update question. */
export function useGoalTargets(enabled: boolean) {
  const [targets, setTargets] = useState<StandupGoalTarget[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadGoalTargets().then((goals) => { if (live) setTargets(goals); });
    return () => { live = false; };
  }, [enabled]);
  return targets;
}
