import { expect, test } from "bun:test";
import type { BoardColumn, CardDetail, CardView } from "../src/tasks/tasksApi";
import { installDom, mockApi, render } from "./support/dom";

/**
 * Review fix: the board passes CardDialog inline callbacks (onElsewhere, onMissing), so each board
 * re-render hands it new functions. Those must not re-run the card's load: a refetch overwrote the
 * title being typed with the saved one.
 */
installDom("http://nook.test/tasks");
const { CardDialog } = await import("../src/tasks/CardDialog");

const stamp = "2026-01-01T00:00:00Z";
const columns: BoardColumn[] = [{ id: "c1", board_id: "b1", name: "To do", position: 1024, is_done: 0, created_at: stamp, updated_at: stamp }];
const card = { id: "k1", board_id: "b1", column_id: "c1", position: 1024, title: "Saved title", has_description: 0, revision: 1, created_by: "u1", creator_name: "Ann",
  due_on: null, comment_count: 0, attachment_count: 0, created_at: stamp, updated_at: stamp, description: "", assignees: [], tag_ids: [], flags: [] } as unknown as CardDetail;
const view: CardView = { card, comments: [], hasMoreComments: false, attachments: [], relations: [] };

test("new inline callbacks on a parent re-render do not refetch the card or reset the title being typed", async () => {
  const api = mockApi({ "GET /tasks/cards/k1": () => view });
  const dialog = (n: number) => <CardDialog userId="u1" cardId="k1" boardId="b1" columns={columns} boardOwner
    onClose={() => n} onMissing={() => n} onElsewhere={() => n} onChanged={() => n} onMove={() => n} onDelete={async () => undefined}
    notify={() => n} tags={[]} />;
  const rendered = await render(dialog(1));
  const field = await rendered.waitFor(() => rendered.container.ownerDocument.querySelector<HTMLTextAreaElement>('textarea[aria-label="Card title"]'));
  await rendered.waitFor(() => field.value === "Saved title");
  const loads = () => api.calls.filter((call) => call.method === "GET" && call.path === "/tasks/cards/k1").length;
  expect(loads()).toBe(1);
  // Type into the title (React's controlled input: set the native value, then fire input).
  const { act } = await import("react");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Unsaved edit");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (let n = 2; n < 5; n += 1) await rendered.rerender(dialog(n));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(loads()).toBe(1);
  expect(field.value).toBe("Unsaved edit");
});
