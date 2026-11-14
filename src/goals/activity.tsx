import type { ReactNode } from "react";
import { GOAL_ACTIVITY, type GoalActivityKind } from "../../shared/goalsActivity";
import { GOAL_STATE_LABEL, type GoalState } from "../../shared/goals";
import { HEALTH_LABEL, type Health } from "../ui/tone";
import type { ItemActivityEntry } from "../../shared/itemActivity";

/** How the goal timeline reads each goal activity kind, after the actor's name (§B.5). */

const state = (label?: string) => GOAL_STATE_LABEL[(label ?? "active") as GoalState] ?? label ?? "";
const health = (label?: string) => HEALTH_LABEL[(label ?? "none") as Health] ?? label ?? "";
const em = (text: string | undefined) => <em>{text ?? "—"}</em>;

export const goalActivityRenderers: Record<GoalActivityKind | "created", (entry: ItemActivityEntry) => ReactNode> = {
  created: () => "created this goal",
  goal_title: (entry) => <>renamed it to {em(entry.payload.to?.label)}</>,
  goal_state: (entry) => <>moved it from {state(entry.payload.from?.label)} to {state(entry.payload.to?.label)}</>,
  goal_health: (entry) => <>set health to {health(entry.payload.to?.label)}</>,
  goal_owner: (entry) => <>made {em(entry.payload.to?.label)} the owner</>,
  goal_period: (entry) => entry.payload.to ? <>moved it to {em(entry.payload.to.label)}</> : "took it out of its period",
  goal_parent: (entry) => entry.payload.to ? "aligned it to another goal" : "made it a top-level goal",
  goal_details: () => "edited the description",
  checked_in: (entry) => <>checked in: {health(String(entry.payload.extra?.health ?? "none"))}, {String(entry.payload.extra?.progress ?? 0)}%{entry.payload.extra?.confidence ? `, confidence ${entry.payload.extra.confidence}/10` : ""}</>,
  kr_added: (entry) => <>added key result {em(entry.payload.item?.label)}</>,
  kr_removed: (entry) => <>removed key result {em(entry.payload.item?.label)}</>,
  kr_changed: (entry) => <>changed key result {em(entry.payload.item?.label)}</>,
  goal_closed: (entry) => <>closed it as {state(entry.payload.to?.label)}</>,
  goal_reopened: () => "reopened it",
  goal_carried: (entry) => <>carried it over to {em(entry.payload.item?.label)}</>
};

// Every registered kind has a renderer (typed by GOAL_ACTIVITY).
void GOAL_ACTIVITY;
