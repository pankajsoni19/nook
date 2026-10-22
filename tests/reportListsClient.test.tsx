/**
 * Report lists (phase 3, D550–D559) on the Reports home, rendered with happy-dom: the URL of a list
 * (/reports/lists/:id), Lists in the nav with per-viewer counts, a list's page in its order with "N reports
 * you can't open" for curators only, Move up / Remove from list, the add-to-list picker as a history layer,
 * Back and Forward between a list and All reports, and the phone row's short last-change label.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ReportFolderTree, ReportListSummary, ReportSummary } from "../shared/reports";
import { captureToasts, installDom, mockApi, render, type ApiCall, type Rendered } from "./support/dom";

installDom("http://nook.test/reports");

const { ReportsHome, shortAge, hiddenLabel } = await import("../src/reports/ReportsHome");
const { ReportsApp } = await import("../src/reports/ReportsApp");
const { RoleContext } = await import("../src/team/roleAccess");
const { formatRoute, locationUrl, parseRoute, reportsListId, reportsListView } = await import("../src/router");
const { reportListSearch } = await import("../src/reports/reportsApi");
const { popStateClosedDialog, takeDialogSentinelEntry, whenHistorySettled } = await import("../src/historyDialogs");
const { act } = await import("react");

const at = "2026-10-22T00:00:00.000Z";
const ME = "0b8f7c2e-2222-4222-8222-000000000001";
const DS = "0b8f7c2e-3333-4333-8333-000000000001";
const LIST = "0b8f7c2e-4444-4444-8444-000000000001";
const OTHER_LIST = "0b8f7c2e-4444-4444-8444-000000000002";
const A = "0b8f7c2e-1111-4111-8111-000000000001";
const B = "0b8f7c2e-1111-4111-8111-000000000002";
const C = "0b8f7c2e-1111-4111-8111-000000000003";
const summary = (id: string, title: string): ReportSummary => ({
  id, title, datasourceId: DS, datasourceName: "Warehouse", status: "ready", isOwner: true, ownerName: "Me", blockCount: 1, lastRunAt: null,
  createdAt: at, updatedAt: at, revision: 1, folderId: null, scheduleCadence: null, ownerId: ME, favorite: false, level: "owner", ownerCount: 1
});
const tree: ReportFolderTree = { folders: [], counts: { all: 3, unfiled: 3, shared: 0, favorites: 0 }, owners: [{ id: ME, name: "Me", count: 3, isMe: true }], canCreateFolders: true, canManageFolders: false };
const list = (extra: Partial<ReportListSummary> = {}): ReportListSummary => ({ id: LIST, name: "Board pack", ownerId: ME, ownerName: "Me", level: "owner", visibility: "private", count: 3, hidden: 1, createdAt: at, updatedAt: at, ...extra });
const shared = list({ id: OTHER_LIST, name: "Mira's picks", ownerId: "x", ownerName: "Mira", level: "view", count: 1, hidden: null });
const base = (extra: Record<string, (call: ApiCall) => unknown> = {}, lists: ReportListSummary[] = [list(), shared]) => mockApi({
  "GET /reports": () => ({ reports: [summary(A, "Alpha"), summary(B, "Beta"), summary(C, "Gamma")], nextCursor: null }),
  [`GET /reports?list=${LIST}`]: () => ({ reports: [summary(C, "Gamma"), summary(A, "Alpha"), summary(B, "Beta")], nextCursor: null }),
  [`GET /reports?list=${OTHER_LIST}`]: () => ({ reports: [summary(A, "Alpha")], nextCursor: null }),
  "GET /reports/folders": () => tree,
  "GET /reports/lists": () => ({ lists }),
  "GET /reports/datasources": () => ({ datasources: [{ id: DS, name: "Warehouse", database: "analytics" }] }),
  ...extra
});
const noop = () => undefined;
let cleanups: Array<() => void> = [];
const afterThis = (cleanup: () => void) => { cleanups.push(cleanup); };
afterEach(() => { for (const cleanup of cleanups) cleanup(); cleanups = []; });
const home = (props: Partial<Parameters<typeof ReportsHome>[0]> = {}) => <RoleContext.Provider value="member">
  <ReportsHome displayName="Me" role="member" onHome={noop} onSettings={noop} onSignOut={noop} onOpen={noop} onOpenDatasources={noop} {...props} />
</RoleContext.Provider>;
const rowTitles = () => [...document.querySelectorAll(".reports-row-title > span")].map((item) => item.textContent);
const navLink = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".reports-sidebar .reports-nav-link")].find((item) => item.querySelector(".reports-nav-name")?.textContent?.startsWith(name))!;
const settle = () => new Promise<void>((resolve) => whenHistorySettled(resolve));
async function menuItem(view: Rendered, title: string, label: string) {
  await view.click(document.querySelector<HTMLButtonElement>(`button[aria-label="${title} actions"]`)!);
  await view.click(await view.waitFor(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === label) ?? null));
}
async function browser(view: Rendered, move: "back" | "forward") {
  await act(async () => { if (move === "back") window.history.back(); else window.history.forward(); await Bun.sleep(40); });
  await act(async () => { await Bun.sleep(20); });
  await view.waitFor(() => true);
}

describe("routes", () => {
  test("/reports/lists/:id is a list view; its filters ride in the query; the list query asks for list=", () => {
    expect(parseRoute(`/reports/lists/${LIST.toUpperCase()}`)).toEqual({ app: "reports", reportId: null, folder: `list:${LIST}` });
    expect(formatRoute({ app: "reports", reportId: null, folder: reportsListView(LIST), filter: { status: ["ready"] } })).toBe(`/reports/lists/${LIST}?status=ready`);
    expect(parseRoute("/reports/lists/not-an-id")).toEqual({ app: "reports", reportId: null });
    expect(locationUrl({ pathname: `/reports/lists/${LIST}`, search: "?status=ready" })).toBe(`/reports/lists/${LIST}?status=ready`);
    expect(reportsListId(reportsListView(LIST))).toBe(LIST);
    expect(reportsListId(LIST)).toBeNull();
    const { listQueryFor } = require("../src/reports/ReportsHome") as typeof import("../src/reports/ReportsHome");
    expect(reportListSearch(listQueryFor(reportsListView(LIST), undefined, "", false))).toBe(`?list=${LIST}`);
  });

  test("a phone row's last change is short (D559); the hidden label counts", () => {
    const now = Date.parse(at);
    expect([shortAge(at, now), shortAge(at, now + 9 * 60_000), shortAge(at, now + 3 * 3_600_000), shortAge(at, now + 2 * 86_400_000)]).toEqual(["now", "9m", "3h", "2d"]);
    expect(hiddenLabel(1)).toBe("1 report in this list you can’t open");
    expect(hiddenLabel(2)).toBe("2 reports in this list you can’t open");
  });
});

describe("a list", () => {
  test("Lists in the nav (someone else's names its owner); a list's page in its order; curators see how many they can't open", async () => {
    base();
    const view = await render(home({ folder: reportsListView(LIST) }));
    await view.waitFor(() => rowTitles().join() === "Gamma,Alpha,Beta");
    expect(document.querySelector("#reports-title")?.textContent).toBe("Board pack · 3");
    expect(navLink("Board pack").getAttribute("aria-current")).toBe("page");
    expect(navLink("Mira's picks").textContent).toContain("Mira");
    expect(document.querySelector(".reports-list-hidden")?.textContent).toBe("1 report in this list you can’t open");
    expect(document.querySelector(".reports-folder-chip svg")?.getAttribute("class")).toContain("lucide-list-ordered");
    expect(document.querySelector<HTMLInputElement>(".reports-search input")?.placeholder).toBe("Filter this list");
  });

  test("a reader's view of a shared list has no hidden count and no curating actions", async () => {
    base();
    const view = await render(home({ folder: reportsListView(OTHER_LIST) }));
    await view.waitFor(() => rowTitles().join() === "Alpha");
    expect(document.querySelector(".reports-list-hidden")).toBeNull();
    await view.click(document.querySelector<HTMLButtonElement>('button[aria-label="Alpha actions"]')!);
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim());
    expect(labels).toContain("Add to list…");
    expect(labels).not.toContain("Remove from list");
    expect(labels).not.toContain("Move up in list");
  });

  test("Move down in list reorders at once (PATCH afterId); Remove from list drops the row, with Undo", async () => {
    const toasts = captureToasts();
    const api = base({
      [`PATCH /reports/lists/${LIST}/items/${C}`]: () => ({ ok: true }),
      [`DELETE /reports/lists/${LIST}/items/${A}`]: () => ({ removed: true, list: list({ count: 2 }) })
    });
    const view = await render(home({ folder: reportsListView(LIST) }));
    await view.waitFor(() => rowTitles().join() === "Gamma,Alpha,Beta");
    await menuItem(view, "Gamma", "Move down in list");
    expect(rowTitles().join()).toBe("Alpha,Gamma,Beta");
    await view.waitFor(() => api.calls.some((call) => call.method === "PATCH"));
    expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({ afterId: A });
    await menuItem(view, "Alpha", "Remove from list");
    await view.waitFor(() => rowTitles().join() === "Gamma,Beta");
    expect(toasts.some((toast) => toast.message.includes("Took “Alpha” out of Board pack"))).toBe(true);
  });

  test("Add to list… opens the picker of the lists you curate; a toggle adds at once; Back closes it, Forward reopens it", async () => {
    const api = base({
      [`GET /reports/${B}/lists`]: () => ({ lists: [{ id: LIST, name: "Board pack", contains: false, ownerName: "Me", isOwner: true }] }),
      [`PUT /reports/lists/${LIST}/items/${B}`]: () => ({ added: true, list: list({ count: 4 }) })
    });
    await settle();
    window.history.replaceState({ "mynotes.depth": 0 }, "", "/reports");
    // The app's popstate handler (ReportsApp) hands Back and Forward to the open layer first.
    const onPop = (event: PopStateEvent) => { popStateClosedDialog(event); };
    window.addEventListener("popstate", onPop);
    afterThis(() => window.removeEventListener("popstate", onPop));
    const view = await render(home());
    await view.waitFor(() => rowTitles().length === 3);
    await settle();
    await menuItem(view, "Beta", "Add to list…");
    const option = await view.waitFor(() => document.querySelector<HTMLButtonElement>('.report-list-sheet [role="checkbox"]'));
    await settle();
    expect(option.getAttribute("aria-checked")).toBe("false");
    await view.click(option);
    await view.waitFor(() => api.calls.some((call) => call.method === "PUT" && call.path === `/reports/lists/${LIST}/items/${B}`));
    expect(document.querySelector('.report-list-sheet [role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
    await settle();
    await act(async () => { window.history.back(); await Bun.sleep(60); });
    await view.waitFor(() => document.querySelector(".report-list-sheet") === null);
    await settle();
    await act(async () => { window.history.forward(); await Bun.sleep(60); });
    await view.waitFor(() => document.querySelector(".report-list-sheet") !== null);
    await act(async () => { window.history.back(); await Bun.sleep(60); });
    await view.waitFor(() => document.querySelector(".report-list-sheet") === null);
    await settle();
  });

  test("New report from a list you curate adds it to that list before opening it", async () => {
    const NEW = "0b8f7c2e-1111-4111-8111-000000000009";
    const toasts = captureToasts();
    const api = base({
      "POST /reports": () => ({ report: { ...summary(NEW, "Margins"), spec: { version: 2, sections: [], blocks: [], queries: [] }, doc: null, lastError: null } }),
      [`PUT /reports/lists/${LIST}/items/${NEW}`]: () => ({ added: true, list: list({ count: 4 }) })
    });
    const create = async (folder: string) => {
      let opened = "";
      const view = await render(home({ folder, onOpen: (id) => { opened = id; } }));
      await view.waitFor(() => rowTitles().length > 0);
      await view.click(view.button("New report")!);
      const sheet = await view.waitFor(() => document.querySelector(".new-report-sheet"));
      await view.click([...sheet.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => item.textContent === "Blank")!);
      const input = sheet.querySelector<HTMLInputElement>("input[placeholder='Weekly revenue']")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Margins");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await view.click(view.button("Create report", sheet)!);
      await view.waitFor(() => opened);
      return opened;
    };
    expect(await create(reportsListView(LIST))).toBe(NEW);
    const adds = () => api.calls.filter((call) => call.method === "PUT" && call.path.startsWith("/reports/lists/"));
    expect(adds().map((call) => call.path)).toEqual([`/reports/lists/${LIST}/items/${NEW}`]);
    expect(toasts.some((toast) => toast.message === "Added the new report to Board pack")).toBe(true);
  });

  test("New report from a list you only view creates it normally, outside the list", async () => {
    const NEW = "0b8f7c2e-1111-4111-8111-000000000009";
    const api = base({ "POST /reports": () => ({ report: { ...summary(NEW, "Margins"), spec: { version: 2, sections: [], blocks: [], queries: [] }, doc: null, lastError: null } }) });
    let opened = "";
    const view = await render(home({ folder: reportsListView(OTHER_LIST), onOpen: (id) => { opened = id; } }));
    await view.waitFor(() => rowTitles().length > 0);
    await view.click(view.button("New report")!);
    const sheet = await view.waitFor(() => document.querySelector(".new-report-sheet"));
    await view.click([...sheet.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => item.textContent === "Blank")!);
    const input = sheet.querySelector<HTMLInputElement>("input[placeholder='Weekly revenue']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Margins");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await view.click(view.button("Create report", sheet)!);
    await view.waitFor(() => opened);
    expect(opened).toBe(NEW);
    expect(api.calls.some((call) => call.method === "PUT" && call.path.startsWith("/reports/lists/"))).toBe(false);
  });

  test("Back and Forward step between All reports and a list", async () => {
    base();
    await settle();
    window.history.replaceState({ "mynotes.depth": 0 }, "", "/reports");
    const navigate = (route: Parameters<typeof formatRoute>[0], options?: { replace?: boolean }) => {
      const depth = Number((window.history.state as Record<string, unknown> | null)?.["mynotes.depth"] ?? 0);
      if (options?.replace || takeDialogSentinelEntry(window.history.state)) window.history.replaceState({ "mynotes.depth": depth }, "", formatRoute(route));
      else window.history.pushState({ "mynotes.depth": depth + 1 }, "", formatRoute(route));
    };
    const view = await render(<RoleContext.Provider value="member">
      <ReportsApp displayName="Me" role="member" navigate={navigate} flash={noop} onHome={noop} onSettings={noop} onSignOut={noop} onOpenDatasources={noop} />
    </RoleContext.Provider>);
    await view.waitFor(() => rowTitles().join() === "Alpha,Beta,Gamma");
    await view.click(navLink("Board pack"));
    expect(window.location.pathname).toBe(`/reports/lists/${LIST}`);
    await view.waitFor(() => rowTitles().join() === "Gamma,Alpha,Beta");
    await browser(view, "back");
    await view.waitFor(() => rowTitles().join() === "Alpha,Beta,Gamma");
    expect(window.location.pathname).toBe("/reports");
    await browser(view, "forward");
    await view.waitFor(() => rowTitles().join() === "Gamma,Alpha,Beta");
  });
});
