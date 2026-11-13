// The card's comments and activity as one timeline (lane ACTIVITY, D746): pure helpers, the API call,
// and the per-person "Activity" and order choices. The drawing is in cardActivity.tsx.
import { api } from "../api";
import type { CardActivityEntry } from "../../shared/cardActivity";
import type { CardComment } from "./tasksApi";

export type TimelineOrder = "asc" | "desc";
export type TimelinePrefs = { showActivity: boolean; order: TimelineOrder };
export const DEFAULT_TIMELINE_PREFS: TimelinePrefs = { showActivity: true, order: "asc" };

/**
 * Saved per person in this browser (localStorage, like the Today sections and the Files view). The
 * server's user_preferences row holds only the modules a person turned off, under a compare-and-swap
 * revision and a 512-byte CHECK; two display choices of the card view do not justify a migration there.
 */
const timelineKey = (userId: string) => `nook:card-timeline:${userId}`;

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export function readTimelinePrefs(userId: string): TimelinePrefs {
  try {
    const parsed = JSON.parse(storage()?.getItem(timelineKey(userId)) ?? "{}") as Partial<TimelinePrefs>;
    return {
      showActivity: typeof parsed.showActivity === "boolean" ? parsed.showActivity : DEFAULT_TIMELINE_PREFS.showActivity,
      order: parsed.order === "desc" || parsed.order === "asc" ? parsed.order : DEFAULT_TIMELINE_PREFS.order
    };
  } catch {
    return DEFAULT_TIMELINE_PREFS;
  }
}

export function writeTimelinePrefs(userId: string, prefs: TimelinePrefs) {
  try { storage()?.setItem(timelineKey(userId), JSON.stringify(prefs)); } catch { /* blocked storage: this visit only */ }
}

export type ActivityPage = { activity: CardActivityEntry[]; next: string | null };

/** GET /api/tasks/cards/:k/activity, newest first (the timeline orders it itself). */
export function listCardActivity(cardId: string, cursor?: string | null, limit = 50) {
  const query = new URLSearchParams({ order: "desc", limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  return api<ActivityPage>(`/tasks/cards/${cardId}/activity?${query}`);
}

/**
 * Merges a refreshed first page into what is loaded: the page replaces every loaded entry at or after
 * its oldest one (an entry folded or dropped since is gone), and older loaded pages stay.
 */
export function mergeActivityPage(loaded: ActivityPage, first: ActivityPage): ActivityPage {
  const oldest = first.activity[first.activity.length - 1];
  if (!first.next || !oldest) return first;
  const seen = new Set(first.activity.map((entry) => entry.id));
  const older = loaded.activity.filter((entry) => !seen.has(entry.id) && entry.created_at < oldest.created_at);
  // Older pages already loaded stay, with the cursor that continues after them.
  return older.length ? { activity: [...first.activity, ...older], next: loaded.next } : first;
}

export type TimelineItem =
  | { type: "comment"; id: string; at: string; comment: CardComment }
  | { type: "activity"; id: string; at: string; entry: CardActivityEntry };

/**
 * Comments (oldest first, as the dialog keeps them) and activity entries (any order) in one list, in
 * `order`. Each list may still have older items on the server; nothing older than the newer of the two
 * "floors" is shown, so the two never interleave with a gap. `loadComments` / `loadActivity` say which
 * list "Load earlier" must page to move that floor back.
 */
export function buildTimeline(input: {
  comments: readonly CardComment[];
  hasMoreComments: boolean;
  activity: readonly CardActivityEntry[];
  /** More activity on the server (ignored when activity is hidden). */
  hasMoreActivity: boolean;
  showActivity: boolean;
  order: TimelineOrder;
}) {
  const commentFloor = input.hasMoreComments ? input.comments[0]?.created_at ?? null : null;
  const entries = input.showActivity ? input.activity : [];
  const oldestEntry = entries.reduce<string | null>((oldest, entry) => oldest === null || entry.created_at < oldest ? entry.created_at : oldest, null);
  const activityFloor = input.showActivity && input.hasMoreActivity ? oldestEntry : null;
  const floor = commentFloor && activityFloor ? (commentFloor > activityFloor ? commentFloor : activityFloor) : commentFloor ?? activityFloor;
  const items: TimelineItem[] = [
    ...input.comments.map((comment): TimelineItem => ({ type: "comment", id: comment.id, at: comment.created_at, comment })),
    ...entries.map((entry): TimelineItem => ({ type: "activity", id: entry.id, at: entry.created_at, entry }))
  ].filter((item) => floor === null || item.at >= floor);
  // Same instant: activity before the comment (a change, then the note about it), ids as the tie-break.
  items.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.type !== b.type ? (a.type === "activity" ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (input.order === "desc") items.reverse();
  return {
    items,
    loadComments: commentFloor !== null && commentFloor === floor,
    loadActivity: activityFloor !== null && activityFloor === floor
  };
}

/** Changes that may have added history: the dialog re-reads the newest page when this key changes. */
export function activityRefreshKey(card: { updated_at: string; revision: number; column_id: string; archived_at?: string | null } | null, extra: { columnId?: string; relations: number; attachments: number }) {
  return card ? [card.updated_at, card.revision, extra.columnId ?? card.column_id, card.archived_at ?? "", extra.relations, extra.attachments].join("|") : "";
}
