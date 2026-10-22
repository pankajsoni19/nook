import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom, render } from "./support/dom";
import { BoardColumnView } from "../src/tasks/BoardColumnView";
import { CardFace, cardFaceLabel } from "../src/tasks/CardFace";
import { FilterBar } from "../src/tasks/FilterBar";
import { HomeFilterBar } from "../src/tasks/home/HomeFilterBar";
import { boardData, type BoardContext } from "../src/tasks/boardQuery";
import { CARD_DRAG_TYPE } from "../src/tasks/boardOrder";
import { canEnterColumn } from "../src/tasks/taskActions";
import type { BoardColumn, CardSummary } from "../src/tasks/tasksApi";

// Lane TASKS (D602, D605, D608): collapsed columns, the filter bar's fixed order, and archived cards.

installDom("http://nook.test/tasks");

const noop = () => undefined;
const column = (id: string, name: string, is_done: 0 | 1 = 0): BoardColumn => ({ id, board_id: "b1", name, position: 1024, is_done, wip_limit: null, created_at: "", updated_at: "" });
const card = (id: string, column_id: string, extra: Partial<CardSummary> = {}): CardSummary => ({
  id, board_id: "b1", column_id, position: 1024, title: `Card ${id}`, has_description: 0, revision: 1, created_by: null, creator_name: null,
  due_on: null, due_time: null, due_tz: null, due_at: null, assignees: [], assignee_id: null, assignee_name: null, description_excerpt: "", tag_ids: [], flags: [],
  comment_count: 0, attachment_count: 0, created_at: "", updated_at: "", ...extra
});
const done = column("c-done", "Done", 1);
const cards = [card("k1", "c-done"), card("k2", "c-done"), card("k3", "c-done")];

function columnView(props: Partial<Parameters<typeof BoardColumnView>[0]> = {}) {
  return <BoardColumnView column={done} cards={cards} owner={false} isFirst={false} isLast draggingId={null} dropIndex={null}
    onDragStart={noop} onDragEnd={noop} onDragOverIndex={noop} onDropAt={noop} onKeyMove={noop} onCardMenu={noop} onOpenCard={noop}
    onColumnMenu={noop} onMoveColumn={noop} onAddCard={noop} onToggleCollapsed={noop} {...props} />;
}

describe("collapsing a column (D602)", () => {
  test("open, every reader gets Collapse (not only the owner); collapsed on desktop it is a strip with Expand, the count, and the name, and no cards", () => {
    const open = renderToStaticMarkup(columnView());
    expect(open).toContain('aria-label="Collapse Done"');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("Card k1");
    // The owner's move arrows and ⋯ stay owner-only.
    expect(open).not.toContain("Column actions for Done");

    const strip = renderToStaticMarkup(columnView({ collapsed: true }));
    expect(strip).toContain('class="task-column collapsed"');
    expect(strip).toContain('aria-expanded="false"');
    expect(strip).toContain('aria-label="Expand Done, 3 cards"');
    expect(strip).toMatch(/<span id="column-c-done" class="task-column-strip-name">Done<\/span>/);
    expect(strip).toContain('aria-labelledby="column-c-done"');
    expect(strip).not.toContain("Card k1");
    expect(strip).not.toContain("Add a card");
  });

  test("on phones a collapsed column keeps its page and header and says its cards are hidden", () => {
    const page = renderToStaticMarkup(columnView({ collapsed: true, phone: true, owner: true }));
    expect(page).toContain("Collapsed, 3 cards hidden");
    expect(page).toContain(">Expand</button>");
    expect(page).toContain('aria-label="Expand Done"');
    expect(page).toContain("Column actions for Done");
    expect(page).not.toContain("Card k1");
    expect(renderToStaticMarkup(columnView({ collapsed: true, phone: true, cards: [] }))).toContain("Collapsed</span>");
  });

  test("a card dropped on the strip is filed at the column's top (index 0), and Expand calls the toggle", async () => {
    const drops: Array<[string | null, number]> = [];
    let toggled = 0;
    let over: number | null = null;
    const view = await render(columnView({ collapsed: true, draggingId: "k9", onDropAt: (payload, index) => drops.push([payload, index]), onToggleCollapsed: () => { toggled += 1; }, onDragOverIndex: (index) => { over = index; } }));
    const strip = view.container.querySelector("section.task-column.collapsed")!;
    const fire = async (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: [CARD_DRAG_TYPE], getData: (kind: string) => kind === CARD_DRAG_TYPE ? "k9" : "", dropEffect: "none" } });
      const { act } = await import("react");
      await act(async () => { strip.dispatchEvent(event); });
      return event;
    };
    expect((await fire("dragover")).defaultPrevented).toBe(true);
    expect(over).toBe(0);
    await fire("drop");
    expect(drops).toEqual([["k9", 0]]);
    await view.click(view.container.querySelector(".task-column-strip")!);
    expect(toggled).toBe(1);
  });

  test("a full collapsed column refuses the drop like an open one", async () => {
    const drops: number[] = [];
    const view = await render(columnView({ collapsed: true, refuseDrop: true, draggingId: "k9", onDropAt: (_payload, index) => drops.push(index) }));
    const strip = view.container.querySelector("section.task-column.collapsed")!;
    const event = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: [CARD_DRAG_TYPE], getData: () => "k9", dropEffect: "move" } });
    strip.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(drops).toEqual([]);
  });
});

describe("the filter bar keeps + Filter and the text box first (D608)", () => {
  const context: BoardContext = { userId: "u1", today: "2026-10-22", now: Date.parse("2026-10-22T12:00:00Z"), timeZone: "UTC" };
  const order = (markup: string, classes: string[]) => classes.map((name) => markup.indexOf(name));

  test("board: + Filter, the text box, the applied chips, Clear, then the count, with or without chips", () => {
    const board = boardData({ columns: [column("c1", "To do")], cards: [card("k1", "c1")], tags: [] });
    const filtered = renderToStaticMarkup(<FilterBar board={board} context={context} filter={{ terms: [{ key: "tag", values: ["none"], negate: false }, { key: "flag", values: ["urgent"], negate: false }] }} shown={0} total={1} onChange={noop} />);
    const positions = order(filtered, ["task-filter-add", "task-filter-text", "task-filter-chip", "task-filter-clear", "task-filter-count"]);
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Without filters the selector and the text box are still the first two.
    const bare = renderToStaticMarkup(<FilterBar board={board} context={context} filter={{ terms: [] }} shown={1} total={1} onChange={noop} />);
    expect(bare.indexOf("task-filter-add")).toBeLessThan(bare.indexOf("task-filter-text"));
    expect(bare).not.toContain("task-filter-chip");
  });

  test("Tasks home: the same order", () => {
    const markup = renderToStaticMarkup(<HomeFilterBar filter={{ terms: [{ key: "tag", values: ["none"], negate: false }] }} onChange={noop} names={{ board: (id) => id, column: (id) => id, tag: (value) => value, user: (id) => id }}
      options={{ boards: [], users: [], tagNames: [] }} shown="1 card" />);
    const positions = order(markup, ["task-filter-add", "task-filter-text", "task-filter-chip", "task-filter-clear"]);
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("archiving by hand and the Archived mark (D610)", () => {
  test("the card's ⋯ menu offers Archive, or Unarchive on an archived card, and runs it after closing; never for read-only", async () => {
    const { MoveCardSheet } = await import("../src/tasks/MoveCardSheet");
    const events: string[] = [];
    const view = await render(<MoveCardSheet card={card("k1", "c-done")} columns={[done]} onMove={async () => undefined} onCancel={() => events.push("close")} onArchive={() => events.push("archive")} />);
    const archive = [...view.container.ownerDocument.querySelectorAll("button.move-option")].find((button) => button.textContent?.startsWith("Archive"))!;
    expect(archive.textContent).toContain("Hide it from the board");
    await view.click(archive);
    expect(events).toEqual(["close", "archive"]);
    const archived = renderToStaticMarkup(<MoveCardSheet card={card("k1", "c-done", { archived_at: "2026-10-01T00:00:00.000Z" })} columns={[done]} onMove={async () => undefined} onCancel={noop} onArchive={noop} />);
    expect(archived).toContain("Unarchive");
    expect(renderToStaticMarkup(<MoveCardSheet card={card("k1", "c-done")} columns={[done]} onMove={async () => undefined} onCancel={noop} readOnly />)).not.toContain("Archive");
  });

  test("Tasks home rows and table mark archived cards", async () => {
    const { QueryResults } = await import("../src/tasks/home/QueryResults");
    const result = (archived_at: string | null) => ({
      id: "k1", board_id: "b1", board_name: "Board", column_id: "c1", column_name: "Done", column_state: "done", is_done: 1, archived_at, position: 1, title: "Old card",
      description_excerpt: "", revision: 1, created_by: null, creator_name: null, due_on: null, due_time: null, due_tz: null, due_at: null, assignees: [], tags: [], flags: [],
      created_at: "", updated_at: "", parent_card_id: null, level: 0, parent_title: null, sprint_id: null, sprint_name: null, level_on_board: "owner"
    });
    for (const layout of ["list", "table"] as const) {
      const markup = renderToStaticMarkup(<QueryResults {...{ cards: [result("2026-10-01T00:00:00.000Z")], layout, group: "none", today: "2026-10-22", userId: "u1", onLoadMore: noop, onOpenCard: noop, onMoveCard: noop, emptyText: "", hasMore: false, loadingMore: false } as never} />);
      expect(markup).toContain('class="task-archived-chip"');
      expect(renderToStaticMarkup(<QueryResults {...{ cards: [result(null)], layout, group: "none", today: "2026-10-22", userId: "u1", onLoadMore: noop, onOpenCard: noop, onMoveCard: noop, emptyText: "", hasMore: false, loadingMore: false } as never} />)).not.toContain("task-archived-chip");
    }
  });
});

describe("archived cards when shown (D605)", () => {
  test("the lane card is marked Archived and says so to screen readers; WIP never counts archived cards", () => {
    const archived = card("k1", "c-done", { archived_at: "2026-10-01T00:00:00.000Z" });
    const face = renderToStaticMarkup(<CardFace card={archived} tags={[]} done today="2026-10-22" excerptId="ex" />);
    expect(face).toContain('class="task-archived-chip"');
    expect(face).toContain("Archived");
    expect(cardFaceLabel({ card: archived, tags: [], done: true, today: "2026-10-22" })).toBe("Card k1, archived");
    const lane = renderToStaticMarkup(columnView({ cards: [archived] }));
    expect(lane).toContain('class="task-card archived"');

    const full = { ...column("c-done", "Done", 1), wip_limit: 1 };
    expect(canEnterColumn([archived], full, "k5")).toBe(true);
    expect(canEnterColumn([archived, card("k2", "c-done")], full, "k5")).toBe(false);
  });
});
