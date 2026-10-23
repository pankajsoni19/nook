import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installDom } from "./support/dom";
import { BoardColumnView } from "../src/tasks/BoardColumnView";
import { columnStatuses } from "../src/tasks/ColumnStatusIcon";
import { MoveCardSheet } from "../src/tasks/MoveCardSheet";
import type { TaskState } from "../shared/taskQuery";
import type { BoardColumn, CardSummary } from "../src/tasks/tasksApi";

// Lane COLICON (D629–D631): a status icon left of each column's name, from its state and place.

installDom("http://nook.test/tasks");

const noop = () => undefined;
type Col = BoardColumn & { state?: TaskState };
const column = (id: string, name: string, state?: TaskState, is_done: 0 | 1 = state === "done" ? 1 : 0): Col =>
  ({ id, board_id: "b1", name, position: 1024, is_done, wip_limit: null, created_at: "", updated_at: "", ...(state ? { state } : {}) });
const card = (id: string, column_id: string): CardSummary => ({
  id, board_id: "b1", column_id, position: 1024, title: `Card ${id}`, has_description: 0, revision: 1, created_by: null, creator_name: null,
  due_on: null, due_time: null, due_tz: null, due_at: null, assignees: [], assignee_id: null, assignee_name: null, description_excerpt: "", tag_ids: [], flags: [],
  comment_count: 0, attachment_count: 0, created_at: "", updated_at: ""
});

const scrum = [column("c1", "Backlog", "todo"), column("c2", "To do", "todo"), column("c3", "Build", "doing"), column("c4", "Review", "doing"), column("c5", "QA", "doing"), column("c6", "Done", "done")];

describe("column statuses (D629)", () => {
  test("left to right: the first of several To do columns is Backlog, In progress steps by place, Done is done", () => {
    const statuses = columnStatuses(scrum);
    expect(scrum.map((col) => statuses.get(col.id)!.kind)).toEqual(["backlog", "todo", "doing", "doing", "doing", "done"]);
    expect(scrum.map((col) => statuses.get(col.id)!.label)).toEqual(["Backlog", "To do", "In progress, step 1 of 3", "In progress, step 2 of 3", "In progress, step 3 of 3", "Done"]);
  });

  test("a single To do column is To do, not Backlog; a single In progress column has no step; older payloads use is_done", () => {
    const statuses = columnStatuses([column("a", "To do", "todo"), column("b", "Doing", "doing"), column("c", "Done", "done")]);
    expect([...statuses.values()].map((status) => status.label)).toEqual(["To do", "In progress", "Done"]);
    const legacy = columnStatuses([column("x", "Open"), column("y", "Closed", undefined, 1)]);
    expect(legacy.get("x")!.kind).toBe("doing");
    expect(legacy.get("y")!.kind).toBe("done");
  });

  test("the In progress pie grows with the column's place", () => {
    const statuses = columnStatuses(scrum);
    const html = (id: string) => renderToStaticMarkup(columnView(scrum.find((col) => col.id === id)!, { status: statuses.get(id) }));
    const wedges = ["c3", "c4", "c5"].map((id) => html(id).match(/<path d="([^"]+)"/)![1]);
    expect(new Set(wedges).size).toBe(3);
    // ¾ takes the large arc; ¼ and ½ do not.
    expect(wedges[0]).toContain(" 0 0 1 ");
    expect(wedges[2]).toContain(" 0 1 1 ");
  });
});

function columnView(col: Col, props: Partial<Parameters<typeof BoardColumnView>[0]> = {}) {
  return <BoardColumnView column={col} cards={[card("k1", col.id)]} owner={false} isFirst={false} isLast={false} draggingId={null} dropIndex={null}
    onDragStart={noop} onDragEnd={noop} onDragOverIndex={noop} onDropAt={noop} onKeyMove={noop} onCardMenu={noop} onOpenCard={noop}
    onColumnMenu={noop} onMoveColumn={noop} onAddCard={noop} onToggleCollapsed={noop} {...props} />;
}

describe("where the icon shows", () => {
  const statuses = columnStatuses(scrum);
  const review = scrum[3];

  test("the column header: a decorative icon before the name; the state describes the column", () => {
    const html = renderToStaticMarkup(columnView(review, { status: statuses.get("c4") }));
    expect(html).toMatch(/<header class="task-column-header"><svg class="task-column-status doing"[^>]*aria-hidden="true"/);
    expect(html).toContain('aria-describedby="column-status-c4"');
    expect(html).toContain('<span id="column-status-c4" hidden="">In progress, step 2 of 3</span>');
    // The name and the section's label stay as they were.
    expect(html).toContain('<h2 id="column-c4" title="Review">Review</h2>');
  });

  test("the collapsed strip shows it above the name, and the strip button is described by it", () => {
    const html = renderToStaticMarkup(columnView(scrum[5], { status: statuses.get("c6"), collapsed: true }));
    expect(html).toMatch(/<\/b><svg class="task-column-status done"[^>]*>.*<\/svg><span id="column-c6" class="task-column-strip-name">Done<\/span>/);
    expect(html).toContain('aria-label="Expand Done, 1 card"');
    expect(html).toContain('aria-describedby="column-status-c6"');
  });

  test("without a status nothing changes", () => {
    const html = renderToStaticMarkup(columnView(review));
    expect(html).not.toContain("task-column-status");
    expect(html).not.toContain("column-status-");
  });

  test("Move to… lists each column with its status icon", () => {
    const html = renderToStaticMarkup(<MoveCardSheet card={card("k1", "c1")} columns={scrum} onMove={async () => undefined} onCancel={noop} />);
    expect((html.match(/class="task-column-status /g) ?? []).length).toBe(6);
    expect(html).toContain('<span id="move-status-c1" hidden="">Backlog</span>');
  });
});
