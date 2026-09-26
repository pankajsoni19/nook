import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardColumnView } from "../src/tasks/BoardColumnView";
import { MoveCardSheet } from "../src/tasks/MoveCardSheet";
import { WipLimitDialog } from "../src/tasks/WipLimitDialog";
import { addCardRefusal, canEnterColumn, columnBadge, columnFullMessage, validateWipLimit, wipCountLabel, wipState } from "../src/tasks/taskActions";
import type { BoardColumn, CardSummary } from "../src/tasks/tasksApi";

const noop = () => undefined;
const column = (id: string, wip_limit: number | null, name = id): BoardColumn => ({ id, board_id: "b1", name, position: 1024, is_done: 0, wip_limit, created_at: "", updated_at: "" });
const card = (id: string, column_id: string): CardSummary => ({
  id, board_id: "b1", column_id, position: 1024, title: `Card ${id}`, has_description: 0, revision: 1, created_by: null, creator_name: null,
  due_on: null, assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0, created_at: "", updated_at: ""
});

test("WIP state and count labels: under, at, and over the limit", () => {
  expect(wipState(2, null)).toBeNull();
  expect(wipState(2, 3)).toBe("under");
  expect(wipState(3, 3)).toBe("full");
  expect(wipState(4, 3)).toBe("over");
  expect(wipCountLabel(2, null)).toBe("2 cards");
  expect(wipCountLabel(2, 3)).toBe("2 of 3 cards");
  expect(wipCountLabel(1, 1)).toBe("1 of 1 card, at the limit");
  expect(wipCountLabel(4, 3)).toBe("4 of 3 cards, over the limit");
});

test("a full column refuses cards from other columns but not its own", () => {
  const cards = [card("a", "todo"), card("b", "doing")];
  const doing = column("doing", 1);
  expect(canEnterColumn(cards, doing, "a")).toBe(false);
  expect(canEnterColumn(cards, doing, "b")).toBe(true);
  expect(canEnterColumn(cards, column("doing", 2), "a")).toBe(true);
  expect(canEnterColumn(cards, column("doing", null), "a")).toBe(true);
  // A new card (no id yet) counts as coming in.
  expect(canEnterColumn(cards, doing, null)).toBe(false);
  expect(columnFullMessage("Doing", 1)).toBe("“Doing” is full (limit 1). Move a card out of it first.");
});

test("the limit field: empty for none, whole numbers from 1 to 1000", () => {
  expect(validateWipLimit("  ")).toEqual({ ok: true, value: null });
  expect(validateWipLimit("3")).toEqual({ ok: true, value: 3 });
  expect(validateWipLimit("1000")).toEqual({ ok: true, value: 1000 });
  for (const bad of ["0", "1001", "2.5", "-1", "abc", "1e3"]) expect(validateWipLimit(bad).ok).toBe(false);
});

const renderColumn = (limit: number | null, count: number, refuseDrop = false) => renderToStaticMarkup(<BoardColumnView
  column={column("doing", limit, "Doing")} cards={Array.from({ length: count }, (_, index) => card(`k${index}`, "doing"))}
  owner={false} isFirst isLast draggingId={null} dropIndex={null} refuseDrop={refuseDrop}
  onDragStart={noop} onDragEnd={noop} onDragOverIndex={noop} onDropAt={noop} onKeyMove={noop} onCardMenu={noop} onOpenCard={noop} onColumnMenu={noop} onMoveColumn={noop} onAddCard={async () => undefined} />);

test("the column header shows n / limit with the full and over styles", () => {
  expect(renderColumn(null, 2)).toContain('<b aria-label="2 cards">2</b>');
  expect(renderColumn(3, 2)).toContain('class="task-wip under" aria-label="2 of 3 cards" title="WIP limit 3">2 / 3</b>');
  expect(renderColumn(2, 2)).toContain('class="task-wip full" aria-label="2 of 2 cards, at the limit"');
  expect(renderColumn(1, 2)).toContain('class="task-wip over" aria-label="2 of 1 card, over the limit"');
  const refused = renderColumn(1, 1, true);
  expect(refused).toContain("task-column drop-refused");
  expect(refused).toContain("Full: it takes at most 1 card.");
  expect(renderColumn(1, 1)).not.toContain("drop-refused");
});

test("column badges count the cards shown, with the total in the label; WIP counts every live card (QA FAIL-2)", () => {
  expect(columnBadge(3, 3, null)).toEqual({ text: "3", label: "3 cards", wip: null });
  expect(columnBadge(3, 8, null)).toEqual({ text: "3", label: "3 shown of 8 cards", wip: null });
  expect(columnBadge(8, 8, 10)).toEqual({ text: "8 / 10", label: "8 of 10 cards", wip: "under" });
  expect(columnBadge(3, 8, 8)).toEqual({ text: "3 · 8 / 8", label: "3 shown; 8 of 8 cards, at the limit", wip: "full" });
  const markup = renderToStaticMarkup(<BoardColumnView
    column={column("doing", null, "Doing")} cards={[]} totalCount={1} hiddenNote={{ text: "1 epic not shown", onShowAll: noop }} emptyText="1 epic is shown in Table and List views"
    owner={false} isFirst isLast draggingId={null} dropIndex={null}
    onDragStart={noop} onDragEnd={noop} onDragOverIndex={noop} onDropAt={noop} onKeyMove={noop} onCardMenu={noop} onOpenCard={noop} onColumnMenu={noop} onMoveColumn={noop} onAddCard={async () => undefined} />);
  expect(markup).toContain('<b aria-label="0 shown of 1 card">0</b>');
  expect(markup).toContain('<p class="task-column-hidden"><span>1 epic not shown</span><button type="button" class="task-column-show-all">Show all levels</button></p>');
  expect(markup).toContain(">1 epic is shown in Table and List views</li>");
});

test("Move to… disables a full column and keeps the card's own column", () => {
  const columns = [column("todo", null, "To do"), column("doing", 1, "Doing"), column("done", 5, "Done")];
  const cards = [card("a", "todo"), card("b", "doing")];
  const markup = renderToStaticMarkup(<MoveCardSheet card={cards[0]!} columns={columns} cards={cards} onMove={async () => undefined} onCancel={noop} />);
  const option = (name: string) => markup.split("<button").find((part) => part.includes(`<span>${name}`)) ?? "";
  expect(option("Doing")).toContain('disabled=""');
  expect(option("Doing")).toContain("Doing<small>Full (limit 1)</small>");
  expect(option("To do")).toContain("To do<small>Current column</small>");
  expect(option("To do")).toContain('autofocus=""');
  expect(option("Done")).not.toContain("disabled");
});

test("the WIP limit dialog offers Remove limit only when one is set, and warns below the count", () => {
  const set = renderToStaticMarkup(<WipLimitDialog columnName="Doing" limit={3} count={5} onSubmit={async () => undefined} onCancel={noop} />);
  expect(set).toContain(">Remove limit</button>");
  expect(set).toContain('inputMode="numeric"');
  expect(set).toContain("It holds 5 now.");
  const none = renderToStaticMarkup(<WipLimitDialog columnName="Doing" limit={null} count={0} onSubmit={async () => undefined} onCancel={noop} />);
  expect(none).not.toContain("Remove limit");
  expect(none).toContain("Leave it empty for no limit.");
});

test("Add a card on a full column refuses with the drag's COLUMN_FULL copy instead of opening elsewhere", () => {
  const full = { id: "todo", name: "To do", wip_limit: 2 };
  const cards = [{ id: "a", column_id: "todo" }, { id: "b", column_id: "todo" }, { id: "c", column_id: "doing" }];
  expect(addCardRefusal(cards, full)).toBe(columnFullMessage("To do", 2));
  expect(addCardRefusal(cards, full)).toBe("“To do” is full (limit 2). Move a card out of it first.");
  expect(addCardRefusal(cards, { ...full, wip_limit: 3 })).toBeNull();
  expect(addCardRefusal(cards, { id: "doing", name: "Doing", wip_limit: null })).toBeNull();
});
