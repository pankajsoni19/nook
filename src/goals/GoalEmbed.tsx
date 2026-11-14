import { useEffect, useState } from "react";
import { Target } from "lucide-react";
import { EmbedCard } from "../ui/embeds/EmbedCard";
import { GoalHealthChip, ProgressBar } from "../ui/progress/Progress";
import type { EmbedCardProps } from "../editor/moduleEmbedRegistry";
import { shortIdOfSegment } from "../../shared/friendlyUrls";
import { getGoal, type GoalDetail } from "./goalsApi";

/**
 * A goal's live card in a note or a card description (§B.4.4, W3-WIRE D1059): title, health, progress
 * (as the reader may see it, fetched as the reader), the first key results, and Open. The Markdown
 * says "Goal" only; a reader who cannot open the goal sees "Goal unavailable" (T513).
 */
const pct = (value: number) => `${Math.round(value * 100)}%`;

export default function GoalEmbed({ path }: EmbedCardProps) {
  const segment = path.split(/[?#]/)[0]!.split("/").filter(Boolean)[1] ?? "";
  const ref = shortIdOfSegment(segment) ?? segment;
  const [goal, setGoal] = useState<GoalDetail | null | "gone">(null);
  useEffect(() => {
    let live = true;
    getGoal(ref).then((body) => { if (live) setGoal(body.goal); }, () => { if (live) setGoal("gone"); });
    return () => { live = false; };
  }, [ref]);
  if (goal === null) return <EmbedCard icon={Target} word="Goal" loading />;
  if (goal === "gone") return <EmbedCard icon={Target} word="Goal" unavailable />;
  const open = () => window.dispatchEvent(new CustomEvent("nook:open-path", { detail: { path: goal.href } }));
  const subtitle = [goal.period?.name ?? null, goal.owner.name, goal.state !== "active" ? goal.state.replace(/_/g, " ") : null].filter(Boolean).join(" · ");
  return <EmbedCard icon={Target} word="Goal" title={goal.title} subtitle={subtitle} action={{ label: "Open", onClick: open }}>
    <div className="ui-embed-goal">
      <ProgressBar value={goal.progress} label="Progress" meter valueText={pct(goal.progress)} tone={goal.health === "off_track" ? "danger" : goal.health === "at_risk" ? "warning" : "accent"} />
      {goal.health !== "none" && <GoalHealthChip health={goal.health} />}
      {goal.keyResults.length > 0 && <ul className="ui-embed-krs">{goal.keyResults.slice(0, 3).map((kr) => <li key={kr.id}><span>{kr.title}</span><span className="ui-tabular">{pct(kr.progress)}</span></li>)}
        {goal.keyResults.length > 3 && <li className="ui-embed-more">+ {goal.keyResults.length - 3} more</li>}</ul>}
    </div>
  </EmbedCard>;
}
