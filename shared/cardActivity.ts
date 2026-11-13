/**
 * Card activity history (lane ACTIVITY, D740–D746): the kinds of event a card's history records, and
 * the payload each one stores. Shared by the server (server/tasks/activity.ts writes and lists them)
 * and the client (src/tasks/cardActivity.tsx draws them).
 *
 * Every payload uses one of two shapes, so the history stays readable after a rename or a deletion:
 *
 * - `change`: `{ from, to }`, each an `ActivityValue` or null (unset). "set the due date to …",
 *   "changed the sprint from A to B", "cleared the parent".
 * - `item`: `{ item }`, one thing added to or removed from a set (an assignee, a tag, a file).
 * - `event`: `{}` or a small fixed payload (created, moved to the Bin, restored, archived).
 *
 * An `ActivityValue` keeps the id (to compare, and to link while the thing exists) and a display
 * snapshot taken when the event happened (`label`), so a deleted tag or a renamed column still reads
 * as it was.
 *
 * ## Adding a kind (the extension point)
 *
 * 1. Add one row to `CARD_ACTIVITY_KINDS` below, e.g. `start: { shape: "change", coalesce: true }`.
 *    The database stores the kind as text (no CHECK list), so no migration is needed.
 * 2. Record it from the service that makes the change, inside the same transaction:
 *    `recordCardChange(cardId, boardId, userId, "start", fromValue, toValue)` (server/tasks/activity.ts).
 * 3. Add one row to `ACTIVITY_RENDERERS` in src/tasks/cardActivity.tsx, e.g.
 *    `start: change("start date", CalendarClock, dueLabel)`.
 *
 * TypeScript then refuses a kind that is listed here and not drawn there, or drawn and not listed.
 * Expected next kinds: `start` (start date and time), `estimate`, and `board` (moved from board X).
 */
export type ActivityShape = "change" | "item" | "event";

export const CARD_ACTIVITY_KINDS = {
  /** The card was created; `to` is its first column. */
  created: { shape: "change", coalesce: false },
  title: { shape: "change", coalesce: true },
  /** No diff is kept: "updated the description". */
  description: { shape: "event", coalesce: true },
  /** Another column of the board (its status). */
  column: { shape: "change", coalesce: true },
  assignee_added: { shape: "item", coalesce: false },
  assignee_removed: { shape: "item", coalesce: false },
  /** `id` is `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` with `tz` in the label's `detail`. */
  due: { shape: "change", coalesce: true },
  tag_added: { shape: "item", coalesce: false },
  tag_removed: { shape: "item", coalesce: false },
  flag_set: { shape: "item", coalesce: false },
  flag_cleared: { shape: "item", coalesce: false },
  /** The parent card (same board). */
  parent: { shape: "change", coalesce: true },
  /** The card's level (Epic, Story, Subtask); `id` is the level number. */
  level: { shape: "change", coalesce: true },
  /** `item` is the other card; `detail` is the relation type as seen from this card. */
  relation_added: { shape: "item", coalesce: false },
  relation_removed: { shape: "item", coalesce: false },
  sprint: { shape: "change", coalesce: true },
  binned: { shape: "event", coalesce: false },
  restored: { shape: "event", coalesce: false },
  archived: { shape: "event", coalesce: false },
  unarchived: { shape: "event", coalesce: false },
  attachment_added: { shape: "item", coalesce: false },
  attachment_removed: { shape: "item", coalesce: false }
} as const satisfies Record<string, { shape: ActivityShape; coalesce: boolean }>;

export type CardActivityKind = keyof typeof CARD_ACTIVITY_KINDS;
export const CARD_ACTIVITY_KIND_NAMES = Object.keys(CARD_ACTIVITY_KINDS) as CardActivityKind[];
export const isCardActivityKind = (value: string): value is CardActivityKind => Object.hasOwn(CARD_ACTIVITY_KINDS, value);

/** A thing as it was when the event happened. `detail` is a short extra (a relation type, a time zone). */
export type ActivityValue = { id?: string; label: string; detail?: string };

export type CardActivityPayload = {
  from?: ActivityValue | null;
  to?: ActivityValue | null;
  item?: ActivityValue;
  /** `binned`: how many subtasks went to the Bin with it. `restored`: how many came back. */
  count?: number;
};

/** Where a change came from, besides the web app: an MCP key, the REST API, an agent, an approved proposal, or Nook itself. */
export type ActivityVia = "mcp" | "rest" | "agent" | "proposal" | "system";

/** One history entry as GET /api/tasks/cards/:k/activity returns it. */
export type CardActivityEntry = {
  id: string;
  card_id: string;
  kind: CardActivityKind;
  /** null for Nook itself (the auto-archive sweep) or a deleted account. */
  actor_id: string | null;
  /** The actor's current display name, else the name kept with the entry. */
  actor_name: string;
  actor_is_integration?: 0 | 1;
  /** Web payloads only. */
  actor_avatar_url?: string | null;
  via: ActivityVia | null;
  payload: CardActivityPayload;
  created_at: string;
};

/** Repeat edits of the same field by the same person within this window are one entry. */
export const ACTIVITY_COALESCE_MS = 2 * 60_000;
export const ACTIVITY_PAGE_MAX = 100;
export const ACTIVITY_PAGE_DEFAULT = 50;
/** Labels are clipped to this many characters (titles are at most 200). */
export const ACTIVITY_LABEL_MAX = 200;

/** Two values name the same thing: by id when both have one, else by label. */
export function sameActivityValue(a: ActivityValue | null | undefined, b: ActivityValue | null | undefined) {
  if (!a || !b) return !a && !b;
  return a.id !== undefined && b.id !== undefined ? a.id === b.id && (a.detail ?? "") === (b.detail ?? "") : a.label === b.label;
}
