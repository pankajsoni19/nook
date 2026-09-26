import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { popStateClosedDialog, registerHistoryDialogGuard } from "../src/historyDialogs";
import { createDialogGuard } from "../src/ui/useHistoryDialogGuard";

/**
 * Review L6b: "Complete…" in Board settings opens the Complete sprint dialog over the settings
 * sheet instead of replacing it, with its own history guard, so Back (or Cancel) closes only the
 * dialog and the settings are still there; the next Back closes the settings.
 */

test("Back with Complete sprint open over Board settings closes only the dialog; the next Back closes the settings", () => {
  const state = { settings: true, complete: true };
  const undos: number[] = [];
  const guard = (key: keyof typeof state) => createDialogGuard({
    isOpen: () => state[key], markClosed: () => { state[key] = false; }, close: () => { state[key] = false; },
    openDepth: () => 2, undo: (direction) => { undos.push(direction === "back" ? 1 : -1); }
  });
  // Registration order is opening order: the board's settings guard, then the nested one.
  const unregisterSettings = registerHistoryDialogGuard(guard("settings"));
  const unregisterComplete = registerHistoryDialogGuard(guard("complete"));
  try {
    expect(popStateClosedDialog({ state: { "mynotes.depth": 1 } })).toBe(true);
    expect(state).toEqual({ settings: true, complete: false });
    expect(popStateClosedDialog({ state: { "mynotes.depth": 1 } })).toBe(true);
    expect(state).toEqual({ settings: false, complete: false });
    expect(undos).toEqual([1, 1]);
  } finally {
    unregisterComplete();
    unregisterSettings();
  }
});

test("BoardView nests Complete sprint over the settings sheet, which leaves Escape to it", () => {
  const board = readFileSync(new URL("../src/tasks/BoardView.tsx", import.meta.url), "utf8");
  // The settings' Complete opens the nested dialog; it does not replace the board's dialog.
  expect(board).toContain("onComplete={(sprint) => setSettingsCompleteId(sprint.id)}");
  expect(board).not.toContain('onComplete={(sprint) => setDialog({ kind: "completeSprint"');
  expect(board).toContain("useHistoryDialogGuard(nestedCompleteId !== null, closeNestedComplete)");
  expect(board).toContain("suspended={nestedCompleteId !== null}");
  const sheet = readFileSync(new URL("../src/tasks/BoardSettingsSheet.tsx", import.meta.url), "utf8");
  expect(sheet).toMatch(/event\.key !== "Escape" \|\| event\.defaultPrevented \|\| suspended/);
});
