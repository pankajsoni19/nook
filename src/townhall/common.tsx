import { HealthChip } from "../ui/progress/Progress";
import type { TownhallState } from "../../shared/townhall";

/** A session's state as the shared tone chip (§E.1.7): icon and words, never color alone. */
export function StateChip({ state }: { state: TownhallState }) {
  return state === "live" ? <span className="th-live-chip"><span className="ui-live-dot" aria-hidden="true" />Live</span>
    : <HealthChip tone={state === "upcoming" ? "info" : "neutral"} label={state === "upcoming" ? "Upcoming" : "Ended"} />;
}

/** "Thu 14 Nov, 16:00" in the viewer's zone (the year when it is not this one). */
export function formatWhen(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), hour: "2-digit", minute: "2-digit" });
}
