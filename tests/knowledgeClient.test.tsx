import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute } from "../src/router";
import { hubEntries, hubEntryOf, isNestedHubRoute } from "../src/settings/hubModel";
import { accessPath } from "../src/access/accessApi";
import { levelDescription } from "../src/access/accessLevels";
import { hitSource, knowledgeLine, pollInterval, sourceLabel, sourceStatusLabel, stillIndexing } from "../src/chat/knowledgeApi";
import { knowledgePickerBases } from "../src/chat/toolPicker";
import { restoreResultMessage } from "../src/bin/binFormat";
import { AddSourceSheet, KNOWLEDGE_WARNING } from "../src/chat/KnowledgeSettings";
import { KnowledgeToolGroup } from "../src/chat/AgentsSettings";
import { orphanRefs, pickCounts, refKey, refName, toggleRef } from "../src/chat/toolPicker";
import { callLabel } from "../src/chat/ToolDisclosure";
import { binItemLabel, filterBinItems } from "../src/bin/binFormat";
import { grantChips, rowsToGrants, selectorFor } from "../src/keys/keyGrants";
import type { AgentToolRef, KnowledgeCatalogBase, ToolCallView, ToolCatalog } from "../shared/agents";
import type { KnowledgeDetail } from "../shared/knowledge";

/**
 * Wave 44 "AC-E" client: Settings → Knowledge's routes and hub entry, the 390 px history model
 * (every sheet on the history guard, a nested page with its own back link), the Add source sheet's
 * warning, the agent tool picker's Knowledge group, the "Searched knowledge" disclosure, the Bin's
 * label, and the key builder's "Chat → Read" on chosen knowledge bases.
 */

const src = join(import.meta.dir, "..", "src");
const read = (path: string) => readFileSync(join(src, path), "utf8");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const detail = (patch: Partial<KnowledgeDetail> = {}): KnowledgeDetail => ({
  id: id(1), name: "Support FAQ", description: "Billing", ownerId: id(2), ownerName: "Ana", yourLevel: "manage", embeddingModel: "text-embedding-3-small", dims: 512,
  status: "ready", chunkCount: 12, sourceCount: 2, counts: { pending: 0, indexing: 0, ready: 2, error: 0, unavailable: 0 }, audience: null, revision: 3,
  createdAt: "2026-10-06T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z", notice: null, sources: [], ...patch
});

describe("routes and the Settings hub", () => {
  test("/settings/knowledge and /settings/knowledge/:id parse, format, and nest", () => {
    expect(parseRoute("/settings/knowledge", "")).toEqual({ app: "settings", section: "knowledge" });
    const page = parseRoute(`/settings/knowledge/${id(7).toUpperCase()}`, "");
    expect(page).toEqual({ app: "settings", section: "knowledge", kbId: id(7) });
    expect(formatRoute(page)).toBe(`/settings/knowledge/${id(7)}`);
    expect(formatRoute({ app: "settings", section: "knowledge" })).toBe("/settings/knowledge");
    // A malformed id opens the list, not a broken page.
    expect(parseRoute("/settings/knowledge/not-an-id", "")).toEqual({ app: "settings", section: null });
    expect(isNestedHubRoute(page)).toBe(true);
    expect(isNestedHubRoute({ app: "settings", section: "knowledge" })).toBe(false);
    expect(hubEntryOf(page)).toBe("knowledge");
  });

  test("Knowledge is listed for every role that chats, after Agents; never for guests", () => {
    for (const role of ["admin", "member", "viewer"] as const) {
      const ids = hubEntries(role, { teamModuleEnabled: true }).map((entry) => entry.id);
      expect(ids.indexOf("knowledge")).toBe(ids.indexOf("agents") + 1);
    }
    expect(hubEntries("guest", { teamModuleEnabled: true }).map((entry) => entry.id)).not.toContain("knowledge");
  });
});

describe("the base's page (§13.4)", () => {
  test("lines, labels, and the polling rule", () => {
    expect(knowledgeLine(detail())).toBe("2 sources · 12 chunks · Ready");
    expect(knowledgeLine(detail({ status: "indexing", counts: { pending: 2, indexing: 1, ready: 0, error: 0, unavailable: 0 }, sourceCount: 3, chunkCount: 1 }))).toBe("3 sources · 1 chunk · Indexing 3");
    expect(sourceLabel({ kind: "note", title: null, titleHidden: true })).toEqual({ kind: "Note", title: "A note you can't open" });
    expect(sourceLabel({ kind: "text", title: "FAQ", titleHidden: false })).toEqual({ kind: "Pasted text", title: "FAQ" });
    expect(hitSource({ source: { kind: "note" } })).toBe("A note you can't open");
    expect(hitSource({ source: { kind: "document", id: id(3), title: "prices.csv" } })).toBe("File · prices.csv");
    expect(stillIndexing([{ status: "ready" }, { status: "pending" }])).toBe(true);
    expect(stillIndexing([{ status: "ready" }, { status: "unavailable" }])).toBe(false);
    expect(accessPath("knowledge_base", id(1))).toBe(`/knowledge/${id(1)}/access`);
    expect(levelDescription("knowledge_base", "view")).toContain("Search it");
    expect(levelDescription("knowledge_base", "view")).toContain("attaching it to agents needs Manage");
    expect(levelDescription("knowledge_base", "manage")).toContain("attach it to agents");
    expect(levelDescription("knowledge_base", "manage")).toContain("never delete");
  });

  test("Wave 44 fixes: errors in the status line (LOW-4), the budget pause and slow polling (LOW-3)", () => {
    expect(knowledgeLine(detail({ counts: { pending: 0, indexing: 0, ready: 1, error: 1, unavailable: 0 } }))).toBe("2 sources · 12 chunks · 1 source has an error");
    expect(knowledgeLine(detail({ status: "error", counts: { pending: 0, indexing: 0, ready: 0, error: 2, unavailable: 0 } }))).toBe("2 sources · 12 chunks · 2 sources have errors");
    expect(knowledgeLine(detail({ sourceCount: 9, counts: { pending: 0, indexing: 0, ready: 2, error: 0, unavailable: 7 } }))).toBe("9 sources · 12 chunks · 7 sources unavailable");
    expect(knowledgeLine(detail({ sourceCount: 3, counts: { pending: 0, indexing: 0, ready: 1, error: 1, unavailable: 1 } }))).toBe("3 sources · 12 chunks · 1 source has an error · 1 source unavailable");
    expect(knowledgeLine(detail({ status: "indexing", counts: { pending: 1, indexing: 0, ready: 0, error: 1, unavailable: 0 } }))).toBe("2 sources · 12 chunks · Indexing 1 · 1 source has an error");
    const paused = { status: "pending" as const, error: "Paused: the daily token budget is used up; indexing resumes after midnight UTC" };
    expect(sourceStatusLabel(paused)).toBe("Paused");
    expect(knowledgeLine(detail({ status: "indexing", sourceCount: 3, counts: { pending: 2, indexing: 0, ready: 1, error: 0, unavailable: 0, paused: 2 } }))).toBe("3 sources · 12 chunks · Paused 2");
    expect(knowledgeLine(detail({ status: "indexing", sourceCount: 3, counts: { pending: 2, indexing: 0, ready: 1, error: 0, unavailable: 0, paused: 1 } }))).toBe("3 sources · 12 chunks · Indexing 2");
    expect(sourceStatusLabel({ status: "pending", error: null })).toBe("Waiting");
    expect(pollInterval([paused, paused, { status: "ready", error: null }])).toBe(60_000);
    expect(pollInterval([paused, { status: "pending", error: null }])).toBe(1_500);
    expect(pollInterval([paused, { status: "indexing", error: null }])).toBe(1_500);
    expect(pollInterval([{ status: "ready", error: null }])).toBeNull();
    // The page shows the base's notice (a removed provider, a blocked owner).
    expect(read("chat/KnowledgeSettings.tsx")).toContain("kb.notice &&");
  });

  test("Wave 44 fixes: the Bin's restore toast names the knowledge base (LOW-6)", () => {
    expect(restoreResultMessage({ type: "knowledge_base" }, { ok: true, knowledgeBaseId: id(1), knowledgeBaseName: "Support FAQ" })).toBe("Restored the knowledge base “Support FAQ”");
    expect(restoreResultMessage({ type: "knowledge_base" }, { ok: true, alreadyRestored: true, knowledgeBaseId: id(1), knowledgeBaseName: "Support FAQ" })).toBe("The knowledge base “Support FAQ” is already restored");
  });

  test("Add source warns who reads the text and offers notes, files, and pasted text", () => {
    const html = renderToStaticMarkup(<AddSourceSheet kb={detail()} onClose={() => undefined} onAdded={() => undefined} />);
    expect(html).toContain(KNOWLEDGE_WARNING);
    expect(html).toContain("read as Ana when indexed");
    for (const label of ["Note", "File", "Paste text"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain("aria-pressed=\"true\"");
  });

  test("390 px: every sheet closes on Back first; no native select; the page has its own back link", () => {
    const page = read("chat/KnowledgeSettings.tsx");
    const sheets = page.match(/<ModalDialog /g)?.length ?? 0;
    expect(sheets).toBe(3);
    expect(page.match(/useHistoryDialogGuard\(true,/g)?.length).toBe(sheets);
    expect(page).toContain("<AccessSheet kind=\"knowledge_base\"");
    expect(page).toContain("guardHistory");
    expect(page).not.toMatch(/<select[\s>]/);
    expect(page).toContain("team-back team-back-visible");
    const css = read("chat/knowledge.css");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("overflow-wrap: anywhere");
  });
});

describe("the agent tool picker and the chat", () => {
  const bases: KnowledgeCatalogBase[] = [
    { id: id(1), name: "Support FAQ", description: "Billing", ownerName: "Ana", yours: true, status: "ready", chunkCount: 12 },
    { id: id(2), name: "Handbook", description: "", ownerName: "Ben", yours: false, status: "indexing", chunkCount: 0 }
  ];
  const catalog: ToolCatalog = { servers: [], nook: { linked: false, linkState: "none", tools: [] }, knowledge: bases };

  test("the Knowledge group: one checkbox per base, counts, and orphans", () => {
    const picked: AgentToolRef[] = [{ source: "knowledge", kbId: id(1) }];
    const html = renderToStaticMarkup(<KnowledgeToolGroup bases={bases} tools={picked} onChange={() => undefined} />);
    expect(html).toContain("aria-label=\"Knowledge\"");
    expect(html).toContain("1 attached");
    expect(html).toContain("Support FAQ");
    expect(html).toContain("Ben&#x27;s · 0 chunks");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(refKey(picked[0]!)).toBe(`knowledge:${id(1)}`);
    expect(refName(picked[0]!)).toBe("A knowledge base");
    expect(pickCounts(picked, catalog)).toMatchObject({ knowledge: 1, nook: 0, total: 1 });
    expect(toggleRef(picked, { source: "knowledge", kbId: id(1) })).toEqual([]);
    // A base that left the catalog (binned, unshared) is an orphan to clear; an older server's catalog leaves picks alone.
    const gone: AgentToolRef = { source: "knowledge", kbId: id(9) };
    expect(orphanRefs([...picked, gone], catalog)).toEqual([gone]);
    expect(orphanRefs([gone], { ...catalog, knowledge: undefined })).toEqual([]);
    expect(renderToStaticMarkup(<KnowledgeToolGroup bases={[]} tools={[]} onChange={() => undefined} />)).toContain("Settings → Knowledge");
  });

  test("Wave 44 fixes (M4): only bases you own or manage can be attached; one you now only view says so", () => {
    const viewOnly: KnowledgeCatalogBase = { id: id(3), name: "Viewed", description: "", ownerName: "Cy", yours: false, manageable: false, status: "ready", chunkCount: 4 };
    const managed: KnowledgeCatalogBase = { ...bases[1]!, manageable: true };
    expect(knowledgePickerBases([managed, viewOnly], []).map((kb) => kb.id)).toEqual([id(2)]);
    const picked: AgentToolRef[] = [{ source: "knowledge", kbId: id(3) }];
    expect(knowledgePickerBases([managed, viewOnly], picked).map((kb) => kb.id)).toEqual([id(2), id(3)]);
    const html = renderToStaticMarkup(<KnowledgeToolGroup bases={[managed, viewOnly]} tools={picked} onChange={() => undefined} />);
    expect(html).toContain("You no longer manage this knowledge base");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<KnowledgeToolGroup bases={[viewOnly]} tools={[]} onChange={() => undefined} />)).toContain("No knowledge bases you own or manage yet");
    // Not an orphan: it is still in the catalog.
    expect(orphanRefs(picked, { ...catalog, knowledge: [viewOnly] })).toEqual([]);
  });

  test("a search_knowledge call reads “Searched knowledge” in the disclosure", () => {
    const call: ToolCallView = { id: "c1", tool: "search_knowledge", server: "knowledge", serverId: null, argsPreview: "{}", resultPreview: null, ok: true, truncated: false, durationMs: 4, decision: null, proposalId: null };
    expect(callLabel(call)).toBe("Searched knowledge");
    expect(callLabel({ ...call, tool: "echo", server: "srv" })).toBe("Called srv/echo");
  });

  test("the Bin labels and filters knowledge bases", () => {
    const item = { type: "knowledge_base" as const, title: "", id: id(1) };
    expect(binItemLabel(item)).toBe("Untitled knowledge base");
    expect(filterBinItems([item as never, { type: "agent", id: id(2) } as never], "knowledge_base")).toHaveLength(1);
  });
});

describe("keys: Chat → Read on chosen knowledge bases", () => {
  test("each Chat permission names its own kind; chips and payloads say so", () => {
    expect(selectorFor("agents", "read")?.kinds).toEqual(["knowledge_base"]);
    expect(selectorFor("agents", "run")?.kinds).toEqual(["agent"]);
    const rows = [{ key: "a", module: "agents" as const, permission: "read" as const, applies: "chosen" as const, resourceIds: [`knowledge_base:${id(1)}`] }];
    expect(rowsToGrants(rows)).toEqual({ grants: [{ module: "agents", permission: "read", resources: [{ kind: "knowledge_base", id: id(1) }] }], error: null });
    expect(rowsToGrants([{ ...rows[0]!, resourceIds: [] }]).error).toContain("knowledge base");
    expect(grantChips([{ module: "agents", permission: "read", resource: { kind: "knowledge_base", id: id(1), name: "Support FAQ" }, active: true, inactiveReason: null }])[0]!.label).toBe("Chat: read agents, chats, and knowledge · Support FAQ");
  });
});
