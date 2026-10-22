/**
 * D575: Duplicate in the app (happy-dom): the ⋯ entry for every reader whose role writes (after Rename
 * for an owner), the dialog (title "Copy of …", Unfiled or a folder, what is copied), the request, the
 * toasts (and the docs left out), opening the copy, and the copy's first version label.
 */
import { describe, expect, mock, test } from "bun:test";
import type { ReportDetail, ReportDuplicate } from "../shared/reports";
import { versionSourceLabel } from "../shared/reportVersions";
import { captureToasts, installDom, mockApi, render } from "./support/dom";
import { historySpecs } from "./support/reportVersionsSeed";

installDom("http://nook.test/reports/0b8f7c2e-2222-4222-8222-222222222222");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { overflowItems, ReportPage } = await import("../src/reports/ReportPage");
const { copyTitle, duplicateHint, duplicateMessages } = await import("../src/reports/DuplicateSheet");
const { RoleContext } = await import("../src/team/roleAccess");
const { whenHistorySettled } = await import("../src/historyDialogs");

const REPORT_ID = "0b8f7c2e-2222-4222-8222-222222222222";
const COPY_ID = "0b8f7c2e-3333-4333-8333-333333333333";
const FOLDER_ID = "0b8f7c2e-4444-4444-8444-444444444444";
const spec = historySpecs()[5]!;
const report = (isOwner: boolean): ReportDetail => ({
  id: REPORT_ID, title: "Revenue", datasourceId: "ds-1", datasourceName: "Analytics", status: "ready", isOwner, ownerName: "Pankaj",
  blockCount: spec.blocks.length, lastRunAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", revision: 7,
  spec, doc: null, lastError: null, folderId: null, scheduleCadence: null, ownerId: "u-1", favorite: false, level: isOwner ? "owner" : "view", ownerCount: 1, canManageOwners: isOwner
} as ReportDetail);
const noop = () => undefined;

describe("Duplicate (D575)", () => {
  test("⋯ has Duplicate for readers (after Copy link and Versions) and owners (after Rename); not without the handler", () => {
    const reader = overflowItems({ ownerWrite: false, owner: false, commands: {}, versions: noop, copyLink: noop, share: noop, rename: noop, duplicate: noop, model: noop, remove: noop });
    expect(reader.map((item) => item.id)).toEqual(["copy-link", "versions", "duplicate"]);
    const owner = overflowItems({ ownerWrite: true, owner: true, commands: {}, share: noop, rename: noop, duplicate: noop, model: noop, remove: noop });
    expect(owner.map((item) => item.id)).toEqual(["share", "rename", "duplicate", "model", "bin"]);
    expect(overflowItems({ ownerWrite: false, owner: false, commands: {}, share: noop, rename: noop, model: noop, remove: noop }).map((item) => item.id)).toEqual([]);
    expect(copyTitle("Revenue")).toBe("Copy of Revenue");
    expect(copyTitle("x".repeat(200))).toHaveLength(200);
    expect(versionSourceLabel({ source: "initial", regenerated: false, restoredFrom: null, duplicatedFrom: "“Revenue” v3" })).toBe("Duplicated from “Revenue” v3");
  });

  test("a reader duplicates into a folder: the dialog, the request, the toasts, and the copy opens", async () => {
    const toasts = captureToasts();
    const opened: string[] = [];
    const result: ReportDuplicate = {
      report: { ...report(true), id: COPY_ID, title: "Copy of Revenue", folderId: FOLDER_ID },
      duplicate: { sourceId: REPORT_ID, sourceVersion: 6, results: 3, docs: 0, docsLeftOut: [], docsHidden: 2, model: "copied" }
    };
    const api = mockApi({
      [`GET /reports/${REPORT_ID}`]: () => ({ report: report(false) }),
      "GET /reports/folders": () => ({ folders: [{ id: FOLDER_ID, name: "Finance", parentId: null, position: 0, reportCount: 0 }], counts: { all: 1, unfiled: 1, shared: 1, favorites: 0 }, owners: [], canCreateFolders: true, canManageFolders: false }),
      [`POST /reports/${REPORT_ID}/duplicate`]: () => result
    });
    const view = await render(<RoleContext.Provider value="member">
      <ReportPage reportId={REPORT_ID} displayName="Ravi" flash={noop} onBack={noop} onSettings={noop} onSignOut={noop} onGone={noop} onOpenReport={(id) => opened.push(id)} />
    </RoleContext.Provider>);
    const more = await view.waitFor(() => document.querySelector<HTMLButtonElement>('button[aria-label="More report actions"]'));
    await view.click(more);
    const item = await view.waitFor(() => [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((button) => button.textContent?.trim() === "Duplicate"));
    await view.click(item);
    const dialog = await view.waitFor(() => document.querySelector(".report-duplicate-sheet"));
    expect(dialog.textContent).toContain("Duplicate “Revenue”");
    expect((dialog.querySelector("input") as HTMLInputElement).value).toBe("Copy of Revenue");
    expect(dialog.textContent).toContain(duplicateHint(false));
    const finance = await view.waitFor(() => [...dialog.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((button) => button.textContent?.includes("Finance")));
    expect([...dialog.querySelectorAll("[role=radio]")].map((button) => [button.textContent, button.getAttribute("aria-checked")])).toEqual([["Unfiled", "true"], ["Finance", "false"]]);
    await view.click(finance);
    await view.click(view.button("Duplicate", dialog)!);
    await view.waitFor(() => opened.length === 1);
    expect(opened).toEqual([COPY_ID]);
    expect(api.calls.find((call) => call.method === "POST")).toMatchObject({ path: `/reports/${REPORT_ID}/duplicate`, body: { title: "Copy of Revenue", folderId: FOLDER_ID } });
    expect(toasts).toEqual([{ kind: "success", message: "Duplicated as “Copy of Revenue”" }]);
    expect(document.querySelector(".report-duplicate-sheet")).toBeNull();
    await view.rerender(<></>);
    let settled = false;
    whenHistorySettled(() => { settled = true; });
    await view.waitFor(() => settled);
  });

  test("the toasts name the docs an owner's copy left out, and a model the copier may not choose", () => {
    const base = { report: { ...report(true), title: "Copy of Revenue" }, duplicate: { sourceId: REPORT_ID, sourceVersion: 2, results: 1, docs: 1, docsHidden: 0 } };
    expect(duplicateMessages({ ...base, duplicate: { ...base.duplicate, docsLeftOut: [{ title: "Private rules" }], model: "not_allowed" } })).toEqual({
      done: "Duplicated as “Copy of Revenue”",
      notes: ["Left out 1 doc you cannot read: “Private rules”", "The copy uses the default model: your role cannot choose the model that writes reports"]
    });
    const many = duplicateMessages({ ...base, duplicate: { ...base.duplicate, docsLeftOut: ["A", "B", "C", "D"].map((title) => ({ title })), model: "copied" } });
    expect(many.notes).toEqual(["Left out 4 docs you cannot read: “A”, “B”, “C” and 1 more"]);
    expect(duplicateHint(true)).toContain("the docs you can read");
  });
});
