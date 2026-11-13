import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { checkEstimate, estimateBadge, estimateSettingsOf, estimateTotal, estimateWords, FIBONACCI_POINTS } from "../shared/estimates";
import { matchesQuery, parse } from "../shared/taskQuery";
import { estimateProgressLabel, sprintEstimates } from "../src/tasks/sprintModel";
import { SprintBar } from "../src/tasks/SprintBar";
import { CardFace, cardFaceLabel } from "../src/tasks/CardFace";
import { BoardColumnView } from "../src/tasks/BoardColumnView";
import { CardEstimateField, columnEstimate } from "../src/tasks/EstimateField";
import { EstimateSettingsSection, estimateChangeNotes, estimateSummary } from "../src/tasks/EstimateSettingsSection";
import { boardData, sortBoardCards } from "../src/tasks/boardQuery";
import { parseBoardSearch } from "../src/tasks/boardUrl";
import { mergeCardDetail } from "../src/tasks/cardTags";
import type { BoardColumn, BoardSummary, CardDetail, CardSummary, SprintSummary } from "../src/tasks/tasksApi";

/** Lane ESTIMATES (docs/plan/TASK_ESTIMATES.md, D750–D757): the shared rules and the client's badges, totals, field, and settings. */

const noop = () => undefined;
const S1 = "11111111-1111-4111-8111-111111111111";
const columns: BoardColumn[] = [
  { id: "todo", board_id: "b", name: "To do", position: 1, is_done: 0, created_at: "", updated_at: "" },
  { id: "done", board_id: "b", name: "Done", position: 2, is_done: 1, created_at: "", updated_at: "" }
];
const card = (id: string, column: string, extra: Partial<CardSummary> = {}): CardSummary => ({
  id, board_id: "b", column_id: column, position: 1, title: id, has_description: 0, revision: 1, created_by: null, creator_name: null, due_on: null,
  assignees: [], tag_ids: [], flags: [], description_excerpt: "", comment_count: 0, attachment_count: 0, created_at: "", updated_at: "", level: 0, parent_card_id: null, sprint_id: null, ...extra
});
const sprint: SprintSummary = {
  id: S1, board_id: "b", name: "Sprint 4", goal: "", start_on: null, end_on: null, state: "active", is_active: true, position: 1024, completed_at: null,
  card_count: 3, done_count: 1, created_at: "", updated_at: ""
};

describe("shared/estimates (D751, D753, D754)", () => {
  test("checkEstimate: off refuses values but clears; Fibonacci needs the scale; free and hours take 0–999 with two decimals", () => {
    const off = { kind: "none", scale: "fibonacci" } as const;
    const fib = { kind: "points", scale: "fibonacci" } as const;
    const free = { kind: "points", scale: "free" } as const;
    const hours = { kind: "hours", scale: "fibonacci" } as const;
    expect(checkEstimate(off, 3)).toMatchObject({ ok: false, code: "ESTIMATES_OFF" });
    expect(checkEstimate(off, null)).toEqual({ ok: true, value: null });
    for (const point of FIBONACCI_POINTS) expect(checkEstimate(fib, point)).toEqual({ ok: true, value: point });
    expect(checkEstimate(fib, 4)).toMatchObject({ ok: false, code: "ESTIMATE_INVALID" });
    expect(checkEstimate(free, 4)).toEqual({ ok: true, value: 4 });
    expect(checkEstimate(hours, 1.5)).toEqual({ ok: true, value: 1.5 });
    // Float input that is two decimals within error reads back rounded.
    expect(checkEstimate(hours, 0.1 + 0.2)).toEqual({ ok: true, value: 0.3 });
    expect(checkEstimate(hours, 1.125)).toMatchObject({ ok: false, code: "ESTIMATE_INVALID" });
    expect(checkEstimate(hours, -0.5)).toMatchObject({ ok: false, code: "ESTIMATE_INVALID" });
    expect(checkEstimate(hours, 1000)).toMatchObject({ ok: false, code: "ESTIMATE_INVALID" });
    expect(checkEstimate(hours, Number.NaN)).toMatchObject({ ok: false, code: "ESTIMATE_INVALID" });
  });

  test("badges, words, totals, and settings from a summary", () => {
    expect(estimateBadge("points", 5)).toBe("5 pts");
    expect(estimateBadge("points", 1)).toBe("1 pt");
    expect(estimateBadge("hours", 1.5)).toBe("1.5h");
    expect(estimateBadge("none", 5)).toBe("");
    expect(estimateBadge("hours", null)).toBe("");
    expect(estimateWords("hours", 1)).toBe("1 hour");
    expect(estimateWords("points", 13)).toBe("13 points");
    expect(estimateTotal([1, null, 2.25, undefined, 0])).toEqual({ sum: 3.25, counted: 3 });
    expect(estimateSettingsOf(undefined)).toEqual({ kind: "none", scale: "fibonacci" });
    expect(estimateSettingsOf({ estimate_kind: "hours", estimate_scale: "free" })).toEqual({ kind: "hours", scale: "free" });
    expect(estimateSettingsOf({ estimate_kind: "days" })).toEqual({ kind: "none", scale: "fibonacci" });
  });
});

describe("sprint totals (D755)", () => {
  const cards = [
    card("a", "todo", { sprint_id: S1, estimate: 5 }),
    card("b", "done", { sprint_id: S1, estimate: 3 }),
    card("c", "todo", { sprint_id: S1, estimate: null }),
    // A subtask's estimate never adds to its task's sprint total.
    card("sub", "todo", { level: 1, parent_card_id: "a", sprint_id: S1, estimate: 8 }),
    card("backlog", "todo", { estimate: 2 })
  ];

  test("work-level cards of the sprint, by done and not", () => {
    expect(sprintEstimates(cards, columns, S1, 0)).toEqual({ total: 8, done: 3, remaining: 5, counted: 2 });
    expect(sprintEstimates(cards, columns, null, 0)).toEqual({ total: 2, done: 0, remaining: 2, counted: 1 });
    expect(estimateProgressLabel("points", sprintEstimates(cards, columns, S1, 0), true)).toEqual({ text: "3 of 8 pts done · 5 pts left", label: "3 points of 8 points done, 5 points left" });
    expect(estimateProgressLabel("hours", sprintEstimates(cards, columns, null, 0), false)).toEqual({ text: "2h", label: "2 hours estimated" });
    expect(estimateProgressLabel("none", sprintEstimates(cards, columns, S1, 0), true)).toBeNull();
    expect(estimateProgressLabel("points", sprintEstimates([card("x", "todo", { sprint_id: S1 })], columns, S1, 0), true)).toBeNull();
  });

  test("the sprint bar adds the totals beside the counts only with estimates on", () => {
    const render = (estimateKind?: "points" | "hours") => renderToStaticMarkup(<SprintBar sprints={[sprint]} selection={{ kind: "sprint", sprint }} cards={cards} columns={columns} workLevel={0}
      name="Task" plural="Tasks" today="2026-09-27" owner={false} onSelect={noop} onStart={noop} onComplete={noop} estimateKind={estimateKind} />);
    const on = render("points");
    expect(on).toContain("1 of 3 done");
    expect(on).toContain("3 of 8 pts done · 5 pts left");
    expect(on).toContain('aria-label="3 points of 8 points done, 5 points left"');
    expect(render()).not.toContain("task-sprint-estimate");
  });
});

describe("faces, columns, table, and query (D754, D756)", () => {
  test("the face shows the estimate chip and reads it; off shows nothing", () => {
    const sized = card("k1", "todo", { title: "Fix login", estimate: 5 });
    const html = renderToStaticMarkup(<CardFace card={sized} tags={[]} done={false} today="2026-09-27" excerptId="x" estimateKind="points" />);
    expect(html).toContain("5 pts");
    expect(html).toContain('title="Estimate: 5 points"');
    expect(cardFaceLabel({ card: sized, tags: [], done: false, today: "2026-09-27", estimateKind: "hours" })).toBe("Fix login, estimate 5 hours");
    expect(renderToStaticMarkup(<CardFace card={sized} tags={[]} done={false} today="2026-09-27" excerptId="x" />)).not.toContain("task-estimate-chip");
  });

  test("a column header sums the listed cards' estimates", () => {
    const cards = [card("a", "todo", { estimate: 5 }), card("b", "todo", { estimate: 8 }), card("c", "todo")];
    expect(columnEstimate("points", cards)).toEqual({ text: "13 pts", label: "13 points estimated on 2 cards" });
    expect(columnEstimate("points", [card("c", "todo")])).toBeNull();
    expect(columnEstimate("none", cards)).toBeNull();
    const html = renderToStaticMarkup(<BoardColumnView column={columns[0]!} cards={cards} owner={false} isFirst isLast draggingId={null} dropIndex={null} estimateKind="hours"
      onDragStart={noop} onDragEnd={noop} onDragOverIndex={noop} onDropAt={noop} onKeyMove={noop} onCardMenu={noop} onOpenCard={noop} onColumnMenu={noop} onMoveColumn={noop} onAddCard={noop} />);
    expect(html).toContain('class="task-column-estimate" title="13 hours estimated on 2 cards"><span aria-hidden="true">13h</span><span class="sr-only">13 hours estimated on 2 cards</span>');

  });

  test("the table sorts by estimate (empty last both ways) and the URL keeps the sort", () => {
    const data = boardData({ columns, cards: [card("a", "todo", { estimate: 5 }), card("b", "todo"), card("c", "todo", { estimate: 1 })], board: { structure: undefined, estimate_kind: "points", estimate_scale: "free" } });
    expect(data.estimates).toEqual({ kind: "points", scale: "free" });
    expect(sortBoardCards(data.cards, data, { field: "estimate", direction: "asc" }).map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(sortBoardCards(data.cards, data, { field: "estimate", direction: "desc" }).map((item) => item.id)).toEqual(["a", "c", "b"]);
    expect(parseBoardSearch("?view=table&sort=estimate:desc").sort).toEqual({ field: "estimate", direction: "desc" });
  });

  test("has:estimate in the board's own matcher", () => {
    const parsed = parse("has:estimate");
    if (!parsed.ok) throw new Error("parse failed");
    const context = { userId: "u", today: "2026-09-27" };
    const base = { id: "k", column_id: "todo", position: 1, title: "t", description_excerpt: "", due_on: null, assignees: [], tag_ids: [], flags: [], created_at: "", updated_at: "" };
    expect(matchesQuery({ ...base, estimate: 0 }, parsed.query, context)).toBe(true);
    expect(matchesQuery({ ...base, estimate: null }, parsed.query, context)).toBe(false);
  });

  test("a saved card's estimate reaches the board's copy", () => {
    const item = card("k", "todo", { estimate: null });
    expect(mergeCardDetail(item, { ...item, description: "", estimate: 3 } as CardDetail).estimate).toBe(3);
  });
});

describe("the card field and Board settings (D752, D754)", () => {
  const detail = { estimate: 5 } as Pick<CardDetail, "estimate">;

  test("Fibonacci chips, a number with its unit, text when read-only, and nothing with estimates off", () => {
    const fib = renderToStaticMarkup(<CardEstimateField card={detail} settings={{ kind: "points", scale: "fibonacci" }} idPrefix="d" saving={false} onSave={async () => true} />);
    expect(fib).toContain('role="radiogroup"');
    expect((fib.match(/role="radio"/g) ?? []).length).toBe(FIBONACCI_POINTS.length);
    expect(fib).toContain('aria-checked="true" class="task-estimate-option active" aria-label="5 points, click to clear"');
    const kept = renderToStaticMarkup(<CardEstimateField card={{ estimate: 4 }} settings={{ kind: "points", scale: "fibonacci" }} idPrefix="d" saving={false} onSave={async () => true} />);
    expect(kept).toContain("from before the board used the Fibonacci scale");
    const hours = renderToStaticMarkup(<CardEstimateField card={{ estimate: 1.5 }} settings={{ kind: "hours", scale: "fibonacci" }} idPrefix="d" saving={false} onSave={async () => true} />);
    expect(hours).toContain('value="1.5"');
    expect(hours).toContain(">h</span>");
    const free = renderToStaticMarkup(<CardEstimateField card={{ estimate: null }} settings={{ kind: "points", scale: "free" }} idPrefix="d" saving={false} onSave={async () => true} />);
    expect(free).toContain(">pts</span>");
    expect(renderToStaticMarkup(<CardEstimateField card={detail} settings={{ kind: "hours", scale: "free" }} idPrefix="d" saving={false} onSave={async () => true} readOnly />)).toContain("5 hours");
    expect(renderToStaticMarkup(<CardEstimateField card={detail} settings={{ kind: "none", scale: "fibonacci" }} idPrefix="d" saving={false} onSave={async () => true} />)).toBe("");
  });

  test("the settings warn what a change does to stored values; readers see a summary", () => {
    expect(estimateChangeNotes({ kind: "points", scale: "free" }, { kind: "hours", scale: "free" })).toEqual(["Values are not converted: a card estimated at 5 points will show 5 hours."]);
    expect(estimateChangeNotes({ kind: "hours", scale: "free" }, { kind: "none", scale: "free" })[0]).toContain("hidden, not deleted");
    expect(estimateChangeNotes({ kind: "points", scale: "free" }, { kind: "points", scale: "fibonacci" })[0]).toContain("off the Fibonacci scale");
    expect(estimateChangeNotes({ kind: "none", scale: "fibonacci" }, { kind: "hours", scale: "fibonacci" })).toEqual([]);
    expect(estimateSummary({ kind: "hours", scale: "fibonacci" })).toContain("hours");
    const board = { id: "b", name: "B", owner_id: "o", owner_name: "Olu", is_owner: 0, visibility: "private", card_count: 0, created_at: "", updated_at: "", estimate_kind: "points", estimate_scale: "fibonacci" } as BoardSummary;
    const notify = Object.assign(noop, { success: noop, error: noop, warning: noop, info: noop }) as never;
    const reader = renderToStaticMarkup(<EstimateSettingsSection board={board} owner={false} notify={notify} />);
    expect(reader).toContain("Estimates");
    expect(reader).toContain("Only the owner or a manager changes this.");
    const owner = renderToStaticMarkup(<EstimateSettingsSection board={board} owner notify={notify} />);
    expect(owner).toContain("Estimate cards in");
    expect(owner).toContain("Points scale");
    // An older server without the fields: no section.
    expect(renderToStaticMarkup(<EstimateSettingsSection board={{ ...board, estimate_kind: undefined }} owner notify={notify} />)).toBe("");
  });
});
