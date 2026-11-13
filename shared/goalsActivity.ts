import { registerActivityKinds } from "./itemActivity";

/**
 * Goal activity kinds (lane GOALS, §B.5): what a goal's timeline shows besides comments. Loaded by the
 * server (recording) and the client (renderers typed by the same object). Payloads carry ids and
 * snapshot labels only (T505); a check-in's note is never copied into activity.
 */
export const GOAL_ACTIVITY = registerActivityKinds("goals", {
  goal_title: { shape: "change", coalesce: true },
  goal_state: { shape: "change", coalesce: false },
  goal_health: { shape: "change", coalesce: false },
  goal_owner: { shape: "change", coalesce: false },
  goal_period: { shape: "change", coalesce: true },
  goal_parent: { shape: "change", coalesce: true },
  goal_details: { shape: "event", coalesce: true },
  checked_in: { shape: "event", coalesce: false },
  kr_added: { shape: "item", coalesce: false },
  kr_removed: { shape: "item", coalesce: false },
  kr_changed: { shape: "item", coalesce: true },
  goal_closed: { shape: "change", coalesce: false },
  goal_reopened: { shape: "event", coalesce: false },
  goal_carried: { shape: "item", coalesce: false }
});
export type GoalActivityKind = keyof typeof GOAL_ACTIVITY;
