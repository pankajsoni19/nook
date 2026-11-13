import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CARD_ACTIVITY_KIND_NAMES, type CardActivityEntry, type CardActivityKind, type CardActivityPayload } from "../shared/cardActivity";
import { ACTIVITY_RENDERERS, ActivityRow, dueValueLabel, TimelineControls } from "../src/tasks/cardActivity";
import { activityRefreshKey, buildTimeline, DEFAULT_TIMELINE_PREFS, mergeActivityPage, readTimelinePrefs, writeTimelinePrefs } from "../src/tasks/cardActivityModel";
import { CardDialog } from "../src/tasks/CardDialog";
import type { CardComment, CardDetail, CardView } from "../src/tasks/tasksApi";

/** The card's history in the comments timeline (lane ACTIVITY, D746): drawing, merging, ordering, and the saved choices. */

const entry = (id: string, at: string, kind: CardActivityKind = "title", payload: CardActivityPayload = { from: { label: "Old" }, to: { label: "New" } }, extra: Partial<CardActivityEntry> = {}): CardActivityEntry => ({
  id, card_id: "k1", kind, actor_id: "u1", actor_name: "Shubhangi", via: null, payload, created_at: at, ...extra
});
const comment = (id: string, at: string): CardComment => ({ id, card_id: "k1", author_id: "u2", author_name: "Bo", is_author: 0, body: `Comment ${id}`, created_at: at, edited_at: null });
const at = (minute: number) => `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`;

afterEach(() => { try { localStorage.clear(); } catch { /* no storage in this run */ } });

test("every kind has a renderer, and each reads as a sentence with its values in bold", () => {
  expect(Object.keys(ACTIVITY_RENDERERS).sort()).toEqual([...CARD_ACTIVITY_KIND_NAMES].sort());
  const samples: Partial<Record<CardActivityKind, [CardActivityPayload, string]>> = {
    created: [{ from: null, to: { id: "c1", label: "To do" } }, "created this card in <strong class=\"task-activity-value\">To do</strong>"],
    column: [{ from: { id: "c1", label: "To do" }, to: { id: "c3", label: "Done" } }, "moved this from <strong class=\"task-activity-value\">To do</strong> to <strong class=\"task-activity-value\">Done</strong>"],
    description: [{}, "updated the description"],
    assignee_added: [{ item: { id: "u3", label: "Cy" } }, "assigned <strong class=\"task-activity-value\">Cy</strong>"],
    due: [{ from: null, to: { id: "2026-12-02", label: "2026-12-02" } }, "set the due date to"],
    sprint: [{ from: { id: "s1", label: "Sprint A" }, to: null }, "cleared the sprint (was <strong class=\"task-activity-value\">Sprint A</strong>)"],
    flag_set: [{ item: { id: "needs_review", label: "needs_review" } }, "flagged this <strong class=\"task-activity-value\">Needs review</strong>"],
    relation_added: [{ item: { id: "k2", label: "Login", detail: "depends_on" } }, "linked <strong class=\"task-activity-value\">Login</strong> (depends on)"],
    binned: [{ count: 2 }, "moved this card to the Bin with 2 subtasks"],
    attachment_removed: [{ item: { id: "d1", label: "plan.txt" } }, "removed the file <strong class=\"task-activity-value\">plan.txt</strong>"]
  };
  for (const kind of CARD_ACTIVITY_KIND_NAMES) {
    const [payload, text] = samples[kind] ?? [{ from: { id: "a", label: "A" }, to: { id: "b", label: "B" }, item: { id: "x", label: "X" } }, ""];
    const html = renderToStaticMarkup(<ActivityRow entry={entry("e1", at(1), kind, payload)} />);
    expect(html).toContain("<strong class=\"task-activity-actor\">Shubhangi</strong>");
    expect(html).toContain(`data-kind="${kind}"`);
    expect(html).toContain(text);
    // The absolute time on hover, the relative one shown.
    expect(html).toMatch(/<time dateTime="2026-11-10T10:01:00.000Z" title="[^"]+">/);
  }
});

test("start, estimate, and a move to another board read as sentences (integration: D720, D750, D716)", () => {
  const text = (kind: CardActivityKind, payload: CardActivityPayload) => renderToStaticMarkup(<ActivityRow entry={entry("e1", at(1), kind, payload)} />);
  const bold = (value: string) => `<strong class="task-activity-value">${value}</strong>`;
  expect(text("start", { from: null, to: { id: "2026-11-12T09:00", label: "2026-11-12 09:00", detail: "Europe/Berlin" } }))
    .toMatch(/set the start date to <strong class="task-activity-value">[^<]*09:00 \(Europe\/Berlin\)<\/strong>/);
  expect(text("start", { from: { id: "2026-11-12", label: "2026-11-12" }, to: null })).toContain("cleared the start date (was");
  expect(text("estimate", { from: null, to: { id: "5", label: "5 pts", detail: "points" } })).toContain(`set the estimate to ${bold("5 pts")}`);
  expect(text("estimate", { from: { id: "5", label: "5 pts", detail: "points" }, to: { id: "3", label: "3h", detail: "hours" } }))
    .toContain(`changed the estimate from ${bold("5 pts")} to ${bold("3h")}`);
  expect(text("estimate", { from: { id: "3", label: "3h", detail: "hours" }, to: null })).toContain(`cleared the estimate (was ${bold("3h")})`);
  expect(text("board_move", { from: { id: "b1", label: "My tasks", detail: "MYT-2" }, to: { id: "b2", label: "Roadmap", detail: "ROA-2" } }))
    .toContain(`moved this card from ${bold("My tasks (MYT-2)")} to ${bold("Roadmap (ROA-2)")}`);
  // A board the reader cannot open comes without its name or key (server side).
  expect(text("board_move", { from: { label: "a board you can't open" }, to: { id: "b2", label: "Roadmap", detail: "ROA-2" } }))
    .toContain(`moved this card from ${bold("a board you can&#x27;t open")} to`);
});

test("surfaces and Nook itself are named", () => {
  expect(renderToStaticMarkup(<ActivityRow entry={entry("e1", at(1), "title", undefined, { via: "mcp" })} />)).toContain("via MCP");
  const system = renderToStaticMarkup(<ActivityRow entry={entry("e2", at(1), "archived", {}, { via: "system", actor_id: null, actor_name: "" })} />);
  expect(system).toContain("<strong class=\"task-activity-actor\">Nook</strong> archived this card");
  expect(renderToStaticMarkup(<ActivityRow entry={entry("e3", at(1), "title", undefined, { actor_id: null, actor_name: "" })} />)).toContain("Former member");
  // A kind this build does not know (a newer server) is skipped, not drawn wrong.
  expect(renderToStaticMarkup(<ActivityRow entry={entry("e4", at(1), "some_future_kind" as CardActivityKind)} />)).toBe("");
  expect(dueValueLabel({ id: "2026-12-02T14:30", label: "2026-12-02 14:30", detail: "Europe/Paris" })).toMatch(/14:30 \(Europe\/Paris\)$/);
});

test("comments and activity interleave by time, in either order", () => {
  const comments = [comment("m1", at(2)), comment("m2", at(5))];
  const activity = [entry("a3", at(4)), entry("a1", at(1)), entry("a2", at(2))];
  const ids = (order: "asc" | "desc", showActivity = true) =>
    buildTimeline({ comments, hasMoreComments: false, activity, hasMoreActivity: false, showActivity, order }).items.map((item) => item.id);
  // Same instant: the change before the comment about it.
  expect(ids("asc")).toEqual(["a1", "a2", "m1", "a3", "m2"]);
  expect(ids("desc")).toEqual(["m2", "a3", "m1", "a2", "a1"]);
  expect(ids("asc", false)).toEqual(["m1", "m2"]);
  expect(ids("desc", false)).toEqual(["m2", "m1"]);
});

test("nothing older than the newer floor shows, and Load earlier pages the list that is behind", () => {
  const comments = [comment("m1", at(10)), comment("m2", at(20))];
  const activity = [entry("a1", at(5)), entry("a2", at(15)), entry("a3", at(25))];
  // More comments on the server: the activity at 10:05 could sit next to a comment not loaded yet.
  let timeline = buildTimeline({ comments, hasMoreComments: true, activity, hasMoreActivity: false, showActivity: true, order: "asc" });
  expect(timeline.items.map((item) => item.id)).toEqual(["m1", "a2", "m2", "a3"]);
  expect(timeline).toMatchObject({ loadComments: true, loadActivity: false });
  // More activity: its floor (10:15) is newer, so the comment at 10:10 waits too.
  timeline = buildTimeline({ comments, hasMoreComments: false, activity: activity.slice(1), hasMoreActivity: true, showActivity: true, order: "asc" });
  expect(timeline.items.map((item) => item.id)).toEqual(["a2", "m2", "a3"]);
  expect(timeline).toMatchObject({ loadComments: false, loadActivity: true });
  // Activity hidden: comments page as before.
  timeline = buildTimeline({ comments, hasMoreComments: true, activity, hasMoreActivity: true, showActivity: false, order: "asc" });
  expect(timeline).toMatchObject({ loadComments: true, loadActivity: false });
  expect(timeline.items).toHaveLength(2);
});

test("a refreshed first page replaces what it covers and keeps older pages", () => {
  const loaded = { activity: [entry("a5", at(50)), entry("a4", at(40)), entry("a3", at(30)), entry("a2", at(20))], next: "after-a2" };
  // a4 was folded away (coalesced); a6 is new.
  const first = { activity: [entry("a6", at(55)), entry("a5", at(52)), entry("a3", at(30))], next: "after-a3" };
  expect(mergeActivityPage(loaded, first)).toEqual({ activity: [first.activity[0]!, first.activity[1]!, first.activity[2]!, loaded.activity[3]!], next: "after-a2" });
  expect(mergeActivityPage(loaded, { activity: [entry("a6", at(55))], next: null })).toEqual({ activity: [entry("a6", at(55))], next: null });
  expect(activityRefreshKey(null, { relations: 0, attachments: 0 })).toBe("");
});

test("the switch and order button say what they do, and the choice is saved per person", () => {
  const html = renderToStaticMarkup(<TimelineControls prefs={{ showActivity: true, order: "desc" }} onChange={() => undefined} idPrefix="x" />);
  expect(html).toContain("role=\"switch\"");
  expect(html).toContain("aria-checked=\"true\"");
  expect(html).toContain(">Activity<");
  expect(html).toContain("aria-label=\"Newest first. Show oldest first\"");
  expect(renderToStaticMarkup(<TimelineControls prefs={{ showActivity: false, order: "asc" }} onChange={() => undefined} idPrefix="x" />))
    .toContain("aria-label=\"Oldest first. Show newest first\"");

  expect(readTimelinePrefs("u1")).toEqual(DEFAULT_TIMELINE_PREFS);
  writeTimelinePrefs("u1", { showActivity: false, order: "desc" });
  if (typeof localStorage !== "undefined") {
    expect(readTimelinePrefs("u1")).toEqual({ showActivity: false, order: "desc" });
    expect(readTimelinePrefs("u2")).toEqual(DEFAULT_TIMELINE_PREFS);
    localStorage.setItem("nook:card-timeline:u3", "{\"order\":\"sideways\",\"showActivity\":\"yes\"}");
    expect(readTimelinePrefs("u3")).toEqual(DEFAULT_TIMELINE_PREFS);
  }
});

test("the card dialog's Comments header carries the switch and the order button; the composer stays below", () => {
  const stamp = "2026-01-01T00:00:00Z";
  const card = {
    id: "k1", board_id: "b1", column_id: "c1", position: 1024, title: "Refund flow", has_description: 0, revision: 1, created_by: "u1", creator_name: "Ann",
    due_on: null, comment_count: 1, attachment_count: 0, created_at: stamp, updated_at: stamp, level: 0, parent_card_id: null, description: "", assignees: [], tag_ids: [], flags: []
  } as unknown as CardDetail;
  const view: CardView = { card, comments: [comment("m1", stamp)], hasMoreComments: false, attachments: [], relations: [] };
  const html = renderToStaticMarkup(<CardDialog userId="u1" cardId="k1" columns={[]} boardOwner onClose={() => undefined} onMissing={() => undefined} onChanged={() => undefined}
    onMove={() => undefined} onDelete={async () => undefined} notify={{ success: () => undefined, error: () => undefined, warning: () => undefined } as never} initialView={view} boardLevel="edit" />);
  const header = html.slice(html.indexOf("Comments</h3>"), html.indexOf("task-comments"));
  expect(header).toContain("task-timeline-controls");
  expect(header).toContain("role=\"switch\"");
  expect(html.indexOf("task-comment-composer")).toBeGreaterThan(html.indexOf("task-comments"));
  expect(html).toContain("Comment m1");
});
