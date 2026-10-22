import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReportDetail, ReportSpec } from "../shared/reports";
import type { InstructionsView, ProposalView, ReportInstruction } from "../shared/reportsEdit";
import type { DocServerChoice, ReportDocView } from "../shared/reportsGenerate";
import { installDom, mockApi, render, type Rendered } from "./support/dom";

installDom("http://nook.test/reports/11111111-1111-4111-8111-111111111111");
mock.module("../src/reports/charts", () => ({ default: () => <div className="mock-echart" /> }));

const { ChangesPanel, addTargetLabel, instructionDocItem } = await import("../src/reports/ChangesPanel");
const { DocList, shortLink } = await import("../src/reports/DocList");
const { docRowItem } = await import("../src/reports/DocSettingsSheet");
const { docChangedText, docSourceLine } = await import("../src/reports/ReportGeneration");
const { NewSectionInPlace } = await import("../src/reports/ProposalSheet");
const { reportCssVariables } = await import("../shared/reportTheme");

/**
 * Lane DOCS (D515–D518) in the app: the docs list (title, source, state, ↑ ↓ remove), Doc settings'
 * rows, the "Doc changed" banner and source line naming docs, the Changes composer's "Add a new
 * section" with its place and attached docs (the request it sends), the thread's docs, and a proposed
 * section shown in its place.
 */

const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const spec = { version: 1, specVersion: 3, parameters: [], sections: [{ id: "trend", title: "Over time" }], queries: [{ key: "daily", sql: "SELECT 1", purpose: "", createdBy: "agent" }],
  blocks: [
    { id: "intro", type: "markdown", markdown: "Hello" },
    { id: "daily-line", type: "chart", title: "Revenue per day", queryKey: "daily", kind: "line", x: "day", y: ["revenue"], section: "trend" }
  ] } as unknown as ReportSpec;
const REPORT = { id: REPORT_ID, title: "Revenue", revision: 3, isOwner: true, spec, doc: { serverId: "s-outline", tool: "fetch", ref: "https://docs.example.test/doc/a", hash: null } } as unknown as ReportDetail;
const OUTLINE: DocServerChoice = { id: "s-outline", name: "Outline", status: "ok", synced: true, tools: [{ name: "fetch", title: null, args: ["id"] }], pick: { tool: "fetch", arg: "id", outline: true }, candidates: [], toolNames: ["fetch"], host: "docs.example.test" };
const NOOK: DocServerChoice = { id: "nook", name: "Nook (this workspace)", status: "ok", synced: true, builtin: true, origins: ["http://nook.test"], host: null, tools: [], pick: { tool: "read", arg: "id", outline: false }, candidates: [], toolNames: [] };

const doc = (patch: Partial<ReportDocView>): ReportDocView => ({
  id: "d1", position: 0, serverId: "nook", serverName: "Nook (this workspace)", tool: "read_note", arg: null, ref: "http://nook.test/notes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Revenue metrics", hash: "a".repeat(64),
  latest: null, changed: false, added: false, addedVia: "create", addedByName: "Pat", createdAt: "2026-10-20T00:00:00.000Z", ...patch
});

describe("the docs list (D515)", () => {
  test("each row: its title (or a short link), its source, its state, and ↑ ↓ ✕ with names; the ends cannot move further", () => {
    const html = renderToStaticMarkup(<DocList items={[
      docRowItem(doc({})),
      docRowItem(doc({ id: "d2", serverId: "s-outline", serverName: "Outline", tool: "fetch", ref: "https://docs.example.test/doc/refunds-XyZ", title: null, changed: true })),
      docRowItem(doc({ id: "d3", title: "Country rules", added: true, changed: true, addedVia: "settings" }))
    ]} onMove={() => undefined} onRemove={() => undefined} />);
    expect(html).toContain("<strong title=\"http://nook.test/notes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\">Revenue metrics</strong>");
    expect(html).toContain("docs.example.test/…/refunds-XyZ</strong>");
    expect(html).toContain("<span class=\"report-doc-row-flag\">Changed</span> · via Outline (fetch)");
    expect(html).toContain("<span class=\"report-doc-row-flag\">New</span> · Nook");
    expect(html).toContain("added in Doc settings by Pat");
    expect(html).toContain("disabled=\"\" aria-label=\"Move “Revenue metrics” up\"");
    expect(html).toContain("disabled=\"\" aria-label=\"Move “Country rules” down\"");
    expect(html).toContain("aria-label=\"Remove “Country rules”\"");
    // Read-only (the thread): no buttons.
    expect(renderToStaticMarkup(<DocList items={[docRowItem(doc({}))]} />)).not.toContain("<button");
    expect(shortLink("not a url but a long id that goes on and on and on and on and on")).toHaveLength(46);
  });

  test("the banner names the docs that changed and the ones added since; the source line names the docs", () => {
    const docs = [doc({}), doc({ id: "d2", title: "Order handbook", changed: true }), doc({ id: "d3", title: "Country rules", changed: true, added: true })];
    const state = { mainChanged: true, pages: [], latest: null, docs };
    expect(docChangedText(state)).toBe("The doc “Order handbook” changed since this report was generated. “Country rules” was added to its docs since.");
    expect(docChangedText({ ...state, docs: [doc({ changed: true }), doc({ id: "d2", title: "B", changed: true }), doc({ id: "d3", title: "C", changed: true })], metricsChanged: ["Net revenue"] }))
      .toBe("The docs “Revenue metrics”, “B” and 1 more changed since this report was generated. The definition of “Net revenue” changed.");
    expect(docSourceLine({ doc: null, latest: null, docs })).toBe("From 3 docs: “Revenue metrics”, “Order handbook” and 1 more");
    // One doc reads as before.
    expect(docSourceLine({ doc: { serverId: "nook", serverName: "Nook (this workspace)", tool: null, arg: null, ref: null, hash: null, browseTools: [] }, latest: { id: "s", sha256: "a", title: "Revenue metrics", bytes: 1, fetchedAt: "" }, docs: [doc({})] })).toBe("From Revenue metrics via Nook (this workspace)");
    expect(docChangedText({ mainChanged: true, pages: [], latest: { id: "s", sha256: "a", title: "Revenue metrics", bytes: 1, fetchedAt: "" }, docs: [doc({ changed: true })] })).toBe("The doc (Revenue metrics) changed since this report was generated.");
  });

  test("the thread: a new section's place; an attached doc's state", () => {
    expect(addTargetLabel(REPORT, "daily-line")).toBe("New section after “Revenue per day”");
    expect(addTargetLabel(REPORT, null)).toBe("New section at the end");
    expect(instructionDocItem({ id: "x", title: "Refund rules", source: "nook", serverName: "Nook (this workspace)", ref: "http://nook.test/notes/b", bytes: 10, joined: true, joinNote: null })).toMatchObject({ tag: "Added to the report's docs", source: "Nook (this workspace)" });
    expect(instructionDocItem({ id: "x", title: "Mine", source: "nook", serverName: null, ref: null, bytes: 10, joined: false, joinNote: "Not added: the report's owner cannot read it" })).toMatchObject({ tag: "Not added", meta: "the report's owner cannot read it" });
  });
});

describe("a proposed section in its place (D516)", () => {
  test("after the chosen block: the block, the new section with its blocks, then the section that follows", () => {
    const proposed = { ...spec, sections: [{ id: "trend", title: "Over time" }, { id: "refunds", title: "Refunds", summary: "Where money went back" }, { id: "later", title: "Later" }],
      blocks: [...spec.blocks, { id: "refund-note", type: "markdown", markdown: "Refunds are **net**.", section: "refunds" }] } as unknown as ReportSpec;
    const report = { ...REPORT, spec: { ...spec, sections: [...spec.sections, { id: "later", title: "Later" }] } } as ReportDetail;
    const proposal = { instructionId: "i", spec: proposed, blocks: [{ blockId: "refund-note", change: "added", before: null, after: proposed.blocks.at(-1)! }], queries: [], results: [], currentResults: [], summary: null, outOfDate: false } as ProposalView;
    const html = renderToStaticMarkup(<div style={reportCssVariables("dark") as React.CSSProperties}><NewSectionInPlace report={report} proposal={proposal} afterBlockId="daily-line" results={new Map()} palette={{ mode: "dark" } as never} lookup={() => null} /></div>);
    expect(html).toContain("After “Revenue per day”");
    expect(html).toContain("<span class=\"report-diff-label\">New section</span><h2 class=\"report-section-title\">Refunds</h2><p class=\"report-section-summary\">Where money went back</p>");
    expect(html).toContain("<strong>net</strong>");
    expect(html).toContain("Then “Later”");
    const end = renderToStaticMarkup(<NewSectionInPlace report={report} proposal={proposal} afterBlockId={null} results={new Map()} palette={{ mode: "dark" } as never} lookup={() => null} />);
    expect(end).toContain("At the end of the report, after “Revenue per day”");
  });
});

describe("the Changes composer (D516, D517)", () => {
  const instruction = (patch: Partial<ReportInstruction>): ReportInstruction => ({
    id: "22222222-2222-4222-8222-222222222222", reportId: REPORT_ID, blockId: null, text: "Add refunds", status: "queued", position: 1, kind: "change", afterBlockId: null, docs: [], docCount: 0,
    authorName: "Pat", isMine: true, via: "web", runId: null, agentRunId: null, summary: null, error: null, appliedVersion: null, autoApplied: false,
    createdAt: "2026-10-20T08:00:00.000Z", startedAt: null, finishedAt: null, decidedAt: null, ...patch
  });
  async function pick(view: Rendered, index: number, option: string) {
    const combos = [...document.querySelectorAll<HTMLButtonElement>(".report-changes-compose button[role=\"combobox\"]")];
    await view.click(combos[index]!);
    await view.click(await view.waitFor(() => [...document.querySelectorAll<HTMLElement>("[role=\"option\"]")].find((item) => item.textContent?.trim().startsWith(option)) ?? null));
  }
  async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const { act } = await import("react");
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  test("Add a new section after a block, with a doc link attached (its source picked from the link): the request carries kind, place, and docs; the thread shows them", async () => {
    let view: InstructionsView = { instructions: [], level: "owner", canComment: true, canApply: true, autoApply: false };
    const api = mockApi({
      [`GET /reports/${REPORT_ID}/instructions`]: () => view,
      "GET /reports/doc-servers": () => ({ servers: [NOOK, OUTLINE] }),
      [`POST /reports/${REPORT_ID}/instructions`]: (call) => {
        const body = call.body as Record<string, unknown>;
        const sent = instruction({ text: String(body.text), kind: "add", afterBlockId: String(body.afterBlockId), docs: [{ id: "x", title: "Refund rules", source: "server", serverName: "Outline", ref: "https://docs.example.test/doc/refunds-XyZ", bytes: 20, joined: false, joinNote: null }], docCount: 1 });
        view = { ...view, instructions: [sent] };
        return { instruction: sent };
      }
    });
    const rendered = await render(<ChangesPanel report={REPORT} initialBlockId={null} onClose={() => undefined} onReportChanged={() => undefined} />);
    await rendered.waitFor(() => document.querySelector(".report-changes-compose"));
    await pick(rendered, 0, "Add a new section");
    await rendered.waitFor(() => document.querySelectorAll(".report-changes-compose button[role=\"combobox\"]").length === 2);
    await pick(rendered, 1, "After “Revenue per day”");
    await type(document.querySelector<HTMLTextAreaElement>(".report-changes-compose textarea")!, "A section on refunds");
    await rendered.click(rendered.button("Attach a doc")!);
    await rendered.waitFor(() => api.calls.some((call) => call.path === "/reports/doc-servers"));
    const link = await rendered.waitFor(() => document.querySelector<HTMLInputElement>(".report-doc-adder-row input"));
    await type(link, "https://docs.example.test/doc/refunds-XyZ");
    await rendered.click(rendered.button("Attach")!);
    await rendered.waitFor(() => document.querySelector(".report-changes-compose .report-doc-list"));
    expect(document.querySelector(".report-changes-compose .report-doc-row small")?.textContent).toBe("via Outline");
    await rendered.click(rendered.button("Send")!);
    const post = await rendered.waitFor(() => api.calls.find((call) => call.method === "POST"));
    expect(post.body).toEqual({ text: "A section on refunds", blockId: null, kind: "add", afterBlockId: "daily-line", docs: [{ docRef: "https://docs.example.test/doc/refunds-XyZ", serverId: "s-outline", tool: null, arg: null }] });
    // The composer is ready for the next one; the thread shows where the section goes and the attached doc.
    await rendered.waitFor(() => document.querySelector(".report-instruction .report-doc-list"));
    expect(document.querySelector(".report-changes-compose .report-doc-list")).toBeNull();
    expect(document.querySelector(".report-instruction-target")?.textContent).toBe("New section after “Revenue per day”");
    expect(document.querySelector(".report-instruction .report-doc-row strong")?.textContent).toBe("Refund rules");
  });

  test("a change about a block sends no kind and no docs; another reader sees how many docs, not which", async () => {
    let view: InstructionsView = { instructions: [instruction({ isMine: false, docs: [], docCount: 2 })], level: "comment", canComment: true, canApply: false, autoApply: false };
    const api = mockApi({
      [`GET /reports/${REPORT_ID}/instructions`]: () => view,
      [`POST /reports/${REPORT_ID}/instructions`]: (call) => { view = { ...view }; return { instruction: instruction({ text: String((call.body as Record<string, unknown>).text) }) }; }
    });
    const rendered = await render(<ChangesPanel report={REPORT} initialBlockId="daily-line" onClose={() => undefined} onReportChanged={() => undefined} />);
    await rendered.waitFor(() => document.querySelector(".report-instruction-docs-count"));
    expect(document.querySelector(".report-instruction-docs-count")?.textContent).toBe("2 docs attached");
    await type(document.querySelector<HTMLTextAreaElement>(".report-changes-compose textarea")!, "Make it a stacked bar");
    await rendered.click(rendered.button("Send")!);
    const post = await rendered.waitFor(() => api.calls.find((call) => call.method === "POST"));
    expect(post.body).toEqual({ text: "Make it a stacked bar", blockId: "daily-line" });
  });
});
