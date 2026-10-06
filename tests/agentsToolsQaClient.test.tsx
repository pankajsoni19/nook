import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentDetail, PendingConfirmation, ToolCallView, ToolCatalog } from "../shared/agents";
import { editorDiffers } from "../src/chat/AgentsSettings";
import { callLabel, callOutcome, ConfirmationCard } from "../src/chat/ToolDisclosure";
import { wholeIn } from "../src/chat/ToolServers";
import { orphanRefs } from "../src/chat/toolPicker";

/** Wave 41 end-user QA (AC-B): the client halves of Q2, Q3, Q4, M1, L2, and L7. */

const read = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();

const agent: AgentDetail = {
  id: "a1", ownerId: "u1", name: "Helper", description: "", icon: null, color: null, providerId: null, model: null, maxSteps: 8, temperature: null, maxOutputTokens: null,
  starters: [], revision: 1, createdAt: "", updatedAt: "", isOwner: true, tools: [], nookDirectWrites: false, linked: false, linkState: "none", trifecta: false, systemPrompt: "Be brief."
};
const form = { name: "Helper", description: "", icon: "", systemPrompt: "Be brief.", model: "", maxSteps: 8, temperature: "", starters: "", directWrites: false, tools: [] };

describe("Q2: the agent editor keeps what is being typed", () => {
  test("a form equal to the loaded agent is clean; any edit makes it dirty", () => {
    expect(editorDiffers(agent, form)).toBe(false);
    expect(editorDiffers(agent, { ...form, systemPrompt: "Be brief. And kind." })).toBe(true);
    expect(editorDiffers(agent, { ...form, tools: [{ source: "nook", toolName: "list_notes" }] })).toBe(true);
    expect(editorDiffers(agent, { ...form, temperature: "0.2" })).toBe(true);
  });

  test("the editor's load never depends on flash or navigate, and a background load skips a dirty form", async () => {
    const source = await read("chat/AgentsSettings.tsx");
    expect(source).toContain("}, [agentId, creating, fill, loadCatalog]);");
    expect(source).not.toMatch(/\[agentId, creating, fill, flash/);
    expect(source).toContain("if (!force && dirtyRef.current === detail.id) return;");
    // Only the explicit Reload refills over edits.
    expect(source).toContain("void load(true);");
  });
});

describe("Q3, M1, L7: the disclosure and the card", () => {
  const call = (patch: Partial<ToolCallView>): ToolCallView => ({ id: "call_1_0", tool: "write_thing", server: "fx", serverId: "s1", argsPreview: "{}", resultPreview: null, ok: false, truncated: false, durationMs: null, decision: null, proposalId: null, ...patch });

  test("a call stopped while its card waited says so; an unanswered card says it was not answered", () => {
    expect(callOutcome(call({ decision: "cancelled" }))).toBe("Stopped before an answer");
    expect(callOutcome(call({ decision: "expired" }))).toBe("Not answered in time");
    expect(callOutcome(call({ resultPreview: JSON.stringify({ error: "x", code: "TOOL_UNAVAILABLE" }) }))).toBe("No longer available; not run");
  });

  test("an unknown tool reads as such, never as ?/<name>", () => {
    expect(callLabel(call({ server: "", tool: "nook__made_up" }))).toBe("Unknown tool nook__made_up");
    expect(callLabel(call({}))).toBe("Called fx/write_thing");
  });

  test("the card answers with the card it rendered (its nonce and hash)", () => {
    const card: PendingConfirmation = { confirmationId: "a".repeat(32), argsHash: "b".repeat(64), callId: "call_1_0", tool: "write_thing", server: "fx", args: { what: "x" }, expiresAt: new Date(Date.now() + 60_000).toISOString(), proposal: false };
    const html = renderToStaticMarkup(<ConfirmationCard confirmation={card} busy={false} onDecide={() => undefined} />);
    expect(html).toContain(`confirm-${card.confirmationId}`);
    expect(cardPassesItself()).toBe(true);
  });
});

/** The card's buttons pass the rendered card to `onDecide` (a source check: static markup runs no clicks). */
function cardPassesItself() {
  const source = readFileSync(new URL("../src/chat/ToolDisclosure.tsx", import.meta.url), "utf8");
  return source.includes(`onDecide("once", confirmation)`) && source.includes(`onDecide("deny", confirmation)`);
}

describe("Q4 and L2: the picker and the server form", () => {
  test("without a live key, picked Nook tools are inactive, not orphans", () => {
    const unlinked: ToolCatalog = { servers: [], nook: { linked: false, linkState: "revoked", tools: [] } };
    expect(orphanRefs([{ source: "nook", toolName: "list_notes" }], unlinked)).toEqual([]);
    const linked: ToolCatalog = { servers: [], nook: { linked: true, linkState: "live", tools: [] } };
    expect(orphanRefs([{ source: "nook", toolName: "list_notes" }], linked)).toEqual([{ source: "nook", toolName: "list_notes" }]);
  });

  test("timeout and result-cap fields take whole numbers in bounds only, checked on save", () => {
    expect(wholeIn("20", 5, 120)).toBe(20);
    expect(wholeIn("", 5, 120)).toBeNull();
    expect(wholeIn("2", 5, 120)).toBeNull();
    expect(wholeIn("200", 5, 120)).toBeNull();
    expect(wholeIn("7.5", 5, 120)).toBeNull();
  });

  test("the server form validates itself (no silent native block), and Auto on a not-read-only tool asks first", async () => {
    const source = await read("chat/ToolServers.tsx");
    expect(source).toContain("onSubmit={submit} noValidate>");
    expect(source).toContain("Enter a tool timeout of");
    expect(source).toContain(`if (policy === "auto" && !tool.readOnly && !await confirm.ask({`);
    expect(source).not.toMatch(/window\.confirm\(|<select/);
  });
});
