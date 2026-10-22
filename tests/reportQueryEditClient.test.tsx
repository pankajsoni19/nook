/**
 * Lane EDIT (D525–D531), rendered with happy-dom: the owner's trash on block headers (confirm, a
 * `remove_block` version, Undo restoring the version before) and ⋯ → Remove; Inspect → Query → Edit
 * SQL with Run preview and Check and save; a commenter's Suggest an edit; a reader sees neither.
 */
import { describe, expect, mock, test } from "bun:test";
import type { ReportDetail } from "../shared/reports";
import { installDom, mockApi, render } from "./support/dom";
import { sampleSpec } from "./support/reportSeed";

installDom("http://nook.test/reports/0b8f7c2e-2222-4222-8222-222222222222");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { ReportPage } = await import("../src/reports/ReportPage");
const { RoleContext } = await import("../src/team/roleAccess");
const { whenHistorySettled } = await import("../src/historyDialogs");
const { notify } = await import("../src/ui/notify");
const { removalOps, leavesABlock } = await import("../src/reports/reportBlockEdit");

const REPORT_ID = "0b8f7c2e-2222-4222-8222-222222222222";
const spec = sampleSpec();
const base: ReportDetail = {
  id: REPORT_ID, title: "Revenue", datasourceId: "ds-1", datasourceName: "Analytics", status: "ready", isOwner: true, ownerName: "Me",
  blockCount: spec.blocks.length, lastRunAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", revision: 7,
  spec, doc: null, lastError: null
};
const noop = () => undefined;
const instructions = (level: "owner" | "comment" | "view") => ({ instructions: [], level, canComment: level !== "view", canApply: level === "owner", autoApply: false });
const outcome = (columns: string[]) => ({ class: "select", columns: columns.map((name) => ({ name, type: "String" })), rows: [columns.map((name) => `${name}-1`)], truncated: false, sentSql: "SELECT …", chQueryId: "nook-qedit-x", rowsRead: 1, bytesRead: 1, ms: 4 });

/** Records toasts with their action (captureToasts keeps only the text). */
function recordToasts() {
  const toasts: Array<{ kind: string; message: string; action?: { label: string; onClick: () => void } }> = [];
  const saved = { success: notify.success, warning: notify.warning, error: notify.error, info: notify.info };
  for (const kind of ["success", "warning", "error", "info"] as const) {
    (notify as Record<string, unknown>)[kind] = (message: string, options?: { action?: { label: string; onClick: () => void } }) => { toasts.push({ kind, message, action: options?.action }); };
  }
  return { toasts, restore: () => Object.assign(notify, saved) };
}

async function page(level: "owner" | "comment" | "view", extra: Record<string, (call: { body: unknown }) => unknown> = {}) {
  const report = { ...base, isOwner: level === "owner" };
  const api = mockApi({
    [`GET /reports/${REPORT_ID}`]: () => ({ report }),
    [`GET /reports/${REPORT_ID}/instructions`]: () => instructions(level),
    [`GET /reports/${REPORT_ID}/runs`]: () => ({ runs: [], schedule: null }),
    [`GET /reports/${REPORT_ID}/results`]: () => ({ results: [], running: null }),
    ...extra
  });
  const view = await render(<RoleContext.Provider value="member">
    <ReportPage reportId={REPORT_ID} displayName="Me" flash={noop} onBack={noop} onSettings={noop} onSignOut={noop} onGone={noop} />
  </RoleContext.Provider>);
  await view.waitFor(() => document.querySelector('[aria-label="How was Top countries built"]'));
  return { api, view };
}

async function settle(view: Awaited<ReturnType<typeof render>>) {
  for (const selector of [".report-query-edit", ".report-inspect"]) {
    const close = document.querySelector(`${selector} button[aria-label="Close"]`);
    if (close) { await view.click(close); await view.waitFor(() => !document.querySelector(selector)); }
  }
  let settled = false;
  whenHistorySettled(() => { settled = true; });
  await view.waitFor(() => settled);
}

describe("removal ops (pure)", () => {
  test("a block is one remove_block; a section removes its blocks, then itself; the last block stays", () => {
    expect(removalOps({ kind: "block", block: spec.blocks[3]! })).toEqual([{ op: "remove_block", id: "daily-line" }]);
    expect(removalOps({ kind: "section", section: { id: "s1", title: "S" }, blockIds: ["a", "b"] })).toEqual([{ op: "remove_block", id: "a" }, { op: "remove_block", id: "b" }, { op: "remove_section", id: "s1" }]);
    expect(leavesABlock({ spec }, { kind: "section", section: { id: "s", title: "S" }, blockIds: spec.blocks.map((block) => block.id) })).toBe(false);
    expect(leavesABlock({ spec: { ...spec, blocks: spec.blocks.slice(0, 1) } }, { kind: "block", block: spec.blocks[0]! })).toBe(false);
  });
});

describe("Remove from the header (the owner)", () => {
  test("the trash asks first, removes the block as a new version, and Undo restores the version before", async () => {
    const recorder = recordToasts();
    try {
      const { api, view } = await page("owner", {
        [`POST /reports/${REPORT_ID}/spec/edit`]: () => ({ version: 9, revision: 8 }),
        [`GET /reports/${REPORT_ID}/versions`]: () => ({ versions: [{ version: 9, current: true }, { version: 8, current: false }, { version: 5, current: false }] }),
        [`POST /reports/${REPORT_ID}/versions/8/restore`]: () => ({ version: 10, refreshRunId: null })
      });
      // Every chart, KPI, and table header, and the untitled intro text, has a trash.
      for (const label of ["Remove Revenue", "Remove Orders", "Remove Revenue and refunds per day", "Remove Top countries", "Remove Latest orders", "Remove this text"]) {
        expect(document.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
      }
      await view.click(document.querySelector('button[aria-label="Remove Top countries"]')!);
      const confirm = await view.waitFor(() => [...document.querySelectorAll(".file-dialog")].find((item) => item.textContent?.includes("Remove Top countries?")));
      expect(confirm.textContent).toContain("Undo, or restore the one before from Versions");
      expect(api.calls.some((call) => call.path.endsWith("/spec/edit"))).toBe(false);
      await view.click(view.button("Remove", confirm)!);
      const edit = await view.waitFor(() => api.calls.find((call) => call.method === "POST" && call.path.endsWith("/spec/edit")));
      expect(edit.body).toEqual({ ops: [{ op: "remove_block", id: "country-bar" }], expectedRevision: 7 });
      const toast = await view.waitFor(() => recorder.toasts.find((item) => item.message === "Removed Top countries (version 9)"));
      expect(toast.action?.label).toBe("Undo");
      toast.action!.onClick();
      await view.waitFor(() => api.calls.find((call) => call.method === "POST" && call.path.endsWith("/versions/8/restore")));
      await view.waitFor(() => recorder.toasts.find((item) => item.message === "Top countries is back"));
      await settle(view);
    } finally {
      recorder.restore();
    }
  });

  test("⋯ → Remove this block asks the same; a reader gets no trash, no Remove, no Edit SQL", async () => {
    const { view } = await page("owner");
    await view.click(document.querySelector('button[aria-label="More for Top countries"]')!);
    const menu = await view.waitFor(() => document.querySelector(".report-block-menu"));
    await view.click([...menu.querySelectorAll("button")].find((item) => item.textContent === "Remove this block")!);
    const confirm = await view.waitFor(() => [...document.querySelectorAll(".file-dialog")].find((item) => item.textContent?.includes("Remove Top countries?")));
    await view.click(view.button("Cancel", confirm)!);
    await settle(view);
  });

  test("a reader at view level sees no trash and only reads the SQL", async () => {
    const { view } = await page("view");
    expect(document.querySelector(".report-block-remove")).toBeNull();
    await view.click(document.querySelector('button[aria-label="How was Top countries built"]')!);
    const inspect = await view.waitFor(() => document.querySelector(".report-inspect"));
    await view.waitFor(() => view.button("Copy", inspect));
    expect(view.button("Edit SQL", inspect)).toBeNull();
    expect(view.button("Suggest an edit", inspect)).toBeNull();
    await settle(view);
  });
});

describe("Edit SQL and Suggest an edit", () => {
  const { act } = { act: async (work: () => void) => { const react = await import("react"); await react.act(async () => { work(); }); } };
  const type = async (textarea: HTMLTextAreaElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const NEW_SQL = "SELECT country, sum(revenue) AS total FROM analytics.orders GROUP BY country";

  test("the owner previews (the blocks' missing columns) and saves through spec/edit", async () => {
    const recorder = recordToasts();
    try {
      const { api, view } = await page("owner", {
        [`POST /reports/${REPORT_ID}/queries/by_country/preview`]: () => ({ preview: { queryKey: "by_country", outcome: outcome(["country", "total"]), blocks: [{ blockId: "country-bar", title: "Top countries", missing: ["revenue"] }], problems: ["block country-bar: y revenue is not a column of by_country"] } }),
        [`POST /reports/${REPORT_ID}/spec/edit`]: () => ({ version: 9, revision: 8 })
      });
      await view.click(document.querySelector('button[aria-label="How was Top countries built"]')!);
      const inspect = await view.waitFor(() => document.querySelector(".report-inspect"));
      await view.click(await view.waitFor(() => view.button("Edit SQL", inspect)));
      const sheet = await view.waitFor(() => document.querySelector(".report-query-edit"));
      expect(sheet.textContent).toContain("Edit SQL");
      const textarea = sheet.querySelector<HTMLTextAreaElement>("textarea.report-sql")!;
      expect(textarea.value).toBe(spec.queries.find((query) => query.key === "by_country")!.sql);
      expect(view.button("Check and save", sheet)!.disabled).toBe(true);
      await type(textarea, NEW_SQL);
      await view.click(view.button("Run preview", sheet)!);
      await view.waitFor(() => sheet.querySelector(".report-query-check-bad"));
      expect(sheet.querySelector(".report-query-checks")!.textContent).toContain("Top countries is missing revenue");
      expect(api.calls.find((call) => call.path.endsWith("/preview"))!.body).toEqual({ sql: NEW_SQL, values: null });
      await view.click(view.button("Check and save", sheet)!);
      const edit = await view.waitFor(() => api.calls.find((call) => call.method === "POST" && call.path.endsWith("/spec/edit")));
      expect(edit.body).toEqual({ ops: [{ op: "update_query", key: "by_country", sql: NEW_SQL }], expectedRevision: 7 });
      await view.waitFor(() => !document.querySelector(".report-query-edit"));
      expect(recorder.toasts.find((item) => item.message === "Saved by_country (version 9)")?.action?.label).toBe("Undo");
      await settle(view);
    } finally {
      recorder.restore();
    }
  });

  test("the typed SQL is kept per report and query in sessionStorage (Forward after Back left the page), and Cancel drops it", async () => {
    const key = `mynotes:reports-query-draft:${REPORT_ID}:by_country`;
    window.sessionStorage.setItem(key, "SELECT 'draft' AS country");
    const { view } = await page("owner");
    await view.click(document.querySelector('button[aria-label="How was Top countries built"]')!);
    const inspect = await view.waitFor(() => document.querySelector(".report-inspect"));
    await view.click(await view.waitFor(() => view.button("Edit SQL", inspect)));
    const sheet = await view.waitFor(() => document.querySelector(".report-query-edit"));
    const textarea = sheet.querySelector<HTMLTextAreaElement>("textarea.report-sql")!;
    expect(textarea.value).toBe("SELECT 'draft' AS country");
    await type(textarea, NEW_SQL);
    expect(window.sessionStorage.getItem(key)).toBe(NEW_SQL);
    await view.click(view.button("Cancel", sheet)!);
    await view.waitFor(() => !document.querySelector(".report-query-edit"));
    expect(window.sessionStorage.getItem(key)).toBeNull();
    await settle(view);
  });

  test("a commenter suggests an edit (with a note) instead; a refusal shows its reasons and keeps the sheet open", async () => {
    let refuse = true;
    const { api, view } = await page("comment", {
      [`POST /reports/${REPORT_ID}/queries/by_country/suggest`]: () => refuse
        ? { __reply: true, status: 400, body: { error: "block country-bar: y revenue is not a column of by_country", code: "INVALID", details: ["block country-bar: y revenue is not a column of by_country", "block country-bar: rule 3"] } }
        : { instruction: { id: "i-1", status: "proposed", suggestedQuery: "by_country" } }
    });
    expect(document.querySelector(".report-block-remove")).toBeNull();
    await view.click(document.querySelector('button[aria-label="How was Top countries built"]')!);
    const inspect = await view.waitFor(() => document.querySelector(".report-inspect"));
    expect(view.button("Edit SQL", inspect)).toBeNull();
    await view.click(await view.waitFor(() => view.button("Suggest an edit", inspect)));
    const sheet = await view.waitFor(() => document.querySelector(".report-query-edit"));
    await type(sheet.querySelector<HTMLTextAreaElement>("textarea.report-sql")!, NEW_SQL);
    await type(sheet.querySelector<HTMLTextAreaElement>(".report-query-edit-note textarea")!, "Totals read better");
    await view.click(view.button("Suggest to the owner", sheet)!);
    await view.waitFor(() => sheet.querySelector(".report-query-edit-error li"));
    expect(sheet.querySelector(".report-query-edit-error")!.textContent).toContain("rule 3");
    refuse = false;
    await view.click(view.button("Suggest to the owner", sheet)!);
    await view.waitFor(() => !document.querySelector(".report-query-edit"));
    const calls = api.calls.filter((call) => call.path.endsWith("/suggest"));
    expect(calls.at(-1)!.body).toEqual({ sql: NEW_SQL, note: "Totals read better", blockId: "country-bar", expectedRevision: 7 });
    expect(api.calls.some((call) => call.path.endsWith("/spec/edit"))).toBe(false);
    await settle(view);
  });
});
