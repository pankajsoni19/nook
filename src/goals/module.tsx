import { lazy } from "react";
import { Target, TrendingUp } from "lucide-react";
import { WORKSPACE_MODULE_LABELS } from "../../shared/workspaceModules";
import { shortIdOfSegment } from "../../shared/friendlyUrls";
import { GoalCardSection } from "./GoalCardSection";
import { goalActivityRenderers } from "./activity";
import type { WorkspaceClientModule, WorkspaceRoute } from "../workspaceModules/types";
import type { Route } from "../router";

/**
 * Goals (lane GOALS, docs/plan/WORKSPACE_MODULES.md §D.3, D900–D929). The client module: the lazy app
 * (`/goals`, `/goals/<slug>-<shortid>`), Today sections, a quick action, the card dialog's Goals field,
 * activity renderers, the search section, notification topics, and shortcuts.
 */

const VIEWS = new Set(["tree", "list", "timeline", "mine", "insights"]);
const goalRoute = (href: string): Route => ({ app: "goals", path: href.split("/").filter(Boolean).slice(1), search: "" }) as Route;
const pct = (value: unknown) => `${Math.round(Number(value ?? 0) * 100)}%`;
const healthWord: Record<string, string> = { on_track: "On track", at_risk: "At risk", off_track: "Off track", none: "" };

export const module: WorkspaceClientModule = {
  id: "goals",
  segment: WORKSPACE_MODULE_LABELS.goals.path.slice(1),
  label: WORKSPACE_MODULE_LABELS.goals.label,
  icon: Target,
  description: WORKSPACE_MODULE_LABELS.goals.description,
  ready: true,
  app: lazy(() => import("./GoalsApp")),
  launcher: true,
  parseRoute: (segments, search) => {
    const [first] = segments;
    if (first && shortIdOfSegment(first.toLowerCase())) return { path: [first.toLowerCase()] };
    const params = new URLSearchParams(search);
    const kept = new URLSearchParams();
    const view = params.get("view");
    if (view && VIEWS.has(view)) kept.set("view", view);
    const period = params.get("period");
    if (period && /^[0-9a-f-]{36}$|^none$/i.test(period)) kept.set("period", period.toLowerCase());
    const query = kept.toString();
    return { path: [], search: query ? `?${query}` : "" };
  },
  formatRoute: (route: WorkspaceRoute) => `/goals${route.path[0] ? `/${encodeURIComponent(route.path[0])}` : ""}${route.path[0] ? "" : route.search}`,
  todaySections: {
    goalsCheckin: {
      title: "Goals to check in on", group: "housekeeping", empty: "every goal is checked in", app: "Goals", module: "goals",
      row: (item) => ({ key: String(item.id), label: String(item.title), meta: `${pct(item.progress)}${item.lastCheckinAt ? "" : " · no check-in yet"}`, route: goalRoute(String(item.href)), tone: "today" })
    },
    goalsAtRisk: {
      title: "Goals at risk", group: "housekeeping", empty: "nothing at risk", app: "Goals", module: "goals",
      row: (item) => ({ key: String(item.id), label: String(item.title), meta: `${healthWord[String(item.health)] ?? ""} · ${pct(item.progress)}`, route: goalRoute(String(item.href)), tone: item.health === "off_track" ? "overdue" : "soon" })
    }
  },
  quickActions: [{ id: "goals.checkin", label: "Check in on a goal", icon: TrendingUp, href: "/goals?view=mine", hiddenFor: ["viewer", "guest"] }],
  cardSections: [{ id: "goals.card", area: "side", order: 20, component: GoalCardSection }],
  activityRenderers: goalActivityRenderers,
  searchRenderer: {
    scope: "goals", label: "Goals", icon: Target,
    row: (result) => ({ key: String(result.id), title: String(result.title), meta: typeof result.snippet === "string" ? result.snippet : undefined, href: String(result.href) })
  },
  notificationTopics: [
    { id: "goals.checkin_due", label: "Check-in reminders", description: "When a goal you own or contribute to is due a check-in" },
    { id: "goals.health_changed", label: "Goals at risk", description: "When a goal you follow goes at risk or off track" },
    { id: "goals.source_failing", label: "Automatic progress stopped", description: "When a key result's source can no longer update it" },
    { id: "goals.period_ending", label: "Period ending", description: "A week before a period with your open goals ends" }
  ],
  shortcuts: [
    { keys: "n", label: "New goal" }, { keys: "/", label: "Search goals" }, { keys: "j / k", label: "Move between goals" }, { keys: "Enter", label: "Open the goal" },
    { keys: "← / →", label: "Fold or unfold in the tree" }, { keys: "c", label: "Check in (goal page)" }, { keys: "e", label: "Edit (goal page)" }, { keys: "k", label: "Add a key result (goal page)" }
  ]
};
