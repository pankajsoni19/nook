import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { PRESETS } from "../shared/boardStructure";
import { focusIntoDialog } from "../src/files/Dialog";
import { addOnce, SubtasksSection } from "../src/tasks/CardHierarchySection";
import type { BoardColumn, CardDetail, CardSummary } from "../src/tasks/tasksApi";
import type { CardHierarchyContext } from "../src/tasks/useBoardHierarchy";

// The v0.9.0 delegated-QA polish findings, rendered with react-dom/server and pure helpers.
const epics = PRESETS.epic_story_subtask.structure;
const column = (id: string, position: number, isDone = false): BoardColumn => ({ id, board_id: "b", name: id, position, is_done: isDone ? 1 : 0, created_at: "", updated_at: "" });
const columns = [column("todo", 1024), column("done", 2048, true)];
function card(id: string, level: number, parent: string | null, title = id): CardSummary {
  return {
    id, board_id: "b", column_id: "todo", position: 1, title, has_description: 0, revision: 1, created_by: null, creator_name: null, due_on: null,
    assignee_id: null, assignee_name: null, comment_count: 0, attachment_count: 0, created_at: "", updated_at: "", level, parent_card_id: parent
  };
}
const cards = [card("e", 0, null, "Alpha"), card("s", 1, "e", "Login"), card("t", 2, "s", "Button")];
const context: CardHierarchyContext = {
  structure: epics, cards, columns, openCard: () => undefined, setChildDone: async () => undefined,
  addChild: async () => true, composeChild: () => undefined, detachChild: async () => undefined
};
const detail = (summary: CardSummary) => ({ ...summary, description: "" }) as unknown as CardDetail;

test("the inline add keeps its input enabled and refuses a second add while one is saving (QA FAIL-3)", async () => {
  const markup = renderToStaticMarkup(<SubtasksSection card={detail(cards[1]!)} context={context} idPrefix="c" />);
  const input = markup.slice(markup.indexOf('<input id="c-add-child"'), markup.indexOf("/>", markup.indexOf('<input id="c-add-child"')));
  expect(input).toContain('placeholder="Add subtask…"');
  expect(input).not.toContain("disabled");

  const flag = { current: false };
  let calls = 0;
  let release!: () => void;
  const first = addOnce(flag, () => new Promise<boolean>((resolve) => { calls += 1; release = () => resolve(true); }));
  expect(await addOnce(flag, async () => { calls += 1; return true; })).toBeNull();
  release();
  expect(await first).toBe(true);
  expect(calls).toBe(1);
  // Free again once the first add settles, even when it fails.
  await expect(addOnce(flag, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(await addOnce(flag, async () => false)).toBe(false);
});

test("a modal takes focus on open unless a child already has it; the board settings sheet uses it (QA FAIL-5)", () => {
  const focused: string[] = [];
  const element = (name: string, hidden = false) => ({ name, hasAttribute: (attribute: string) => attribute === "hidden" && hidden, focus: () => { focused.push(name); } });
  const close = element("close");
  const container = (children: ReturnType<typeof element>[], inside: unknown[] = []) => ({
    contains: (node: unknown) => inside.includes(node), querySelectorAll: () => children, focus: () => { focused.push("container"); }
  }) as unknown as Parameters<typeof focusIntoDialog>[0];
  const gear = { name: "gear" } as unknown as Element;
  focusIntoDialog(container([element("skip", true), close]), gear);
  expect(focused).toEqual(["close"]);
  // An autoFocus child already inside keeps focus.
  focusIntoDialog(container([close], [close]), close as unknown as Element);
  expect(focused).toEqual(["close"]);
  focusIntoDialog(container([]), gear);
  expect(focused).toEqual(["close", "container"]);
  const sheet = readFileSync(new URL("../src/tasks/BoardSettingsSheet.tsx", import.meta.url), "utf8");
  expect(sheet).toContain("useDialogFocus(panelRef);");
  expect(sheet).toMatch(/<aside ref=\{panelRef\} tabIndex=\{-1\}[^>]*role="dialog" aria-modal="true"[^>]*onKeyDown=\{trapTabKey\}/);
  const dialog = readFileSync(new URL("../src/files/Dialog.tsx", import.meta.url), "utf8");
  expect(dialog).toContain("useDialogFocus(sectionRef);");
});
