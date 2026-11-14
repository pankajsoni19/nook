import { useEffect, useState } from "react";
import { Target } from "lucide-react";
import { goalsForItem, type GoalSummary } from "./goalsApi";
import "./goals.css";

/**
 * The board header's goal chip (§C C22, D1048): the goal(s) the board contributes to (a `contributes`
 * link from the board, made on the goal page's "Link work"), with progress. One goal shows its title
 * and percentage; more show the first and "+N". Readers see only goals they can open (the server's
 * `goalsOfItem`); with none it renders nothing, so boards without goals look as before.
 */
export function BoardGoalChip({ board }: { board: { id: string; name: string } }) {
  const [goals, setGoals] = useState<GoalSummary[] | null>(null);
  useEffect(() => {
    let live = true;
    goalsForItem("board", board.id).then((body) => { if (live) setGoals(body.goals); }, () => { if (live) setGoals([]); });
    return () => { live = false; };
  }, [board.id]);
  if (!goals?.length) return null;
  const [first] = goals;
  const percent = Math.round(first!.progress * 100);
  const label = `${board.name} contributes to ${goals.map((goal) => `${goal.title} (${Math.round(goal.progress * 100)}%)`).join(", ")}`;
  return <a className={`goals-board-chip health-${first!.health}`} href={first!.href} title={label} aria-label={label}
    onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); window.history.pushState(null, "", first!.href); window.dispatchEvent(new PopStateEvent("popstate")); }}>
    <Target aria-hidden="true" /><span className="goals-board-chip-title">{first!.title}</span><span className="goals-board-chip-progress">{percent}%</span>
    {goals.length > 1 && <span className="goals-board-chip-more">+{goals.length - 1}</span>}
  </a>;
}
