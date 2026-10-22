import { describe, expect, test } from "bun:test";
import { capabilitiesHint, capabilitiesSummary, endpointLabel, probeSummary, testText } from "../src/chat/AiSettings";
import { searchLine } from "../src/chat/KnowledgeSettings";
import { KEYWORD_CHANGE_EFFECT } from "../src/chat/KnowledgeModel";
import { DEFAULT_COMPAT } from "../shared/agents";
import type { ToolCallingProbe } from "../shared/reportsModel";

/**
 * Claude, Voyage AI, and keyword-only knowledge bases, client side (2026-10-22, lane CLAUDE;
 * D539–D542): the provider card's endpoint and capabilities lines, Test and Test tool calling read
 * as findings (forced choice refused is fine), and a keyword-only base's line.
 */

const probe = (patch: Partial<ToolCallingProbe>): ToolCallingProbe => ({
  required: { ok: false, outcome: "unsupported", status: 400, error: "PROVIDER_ERROR: toolchoice: type tool and any are not supported for this model.", forcedRefused: true },
  named: { ok: false, outcome: "unsupported", status: 400, error: "PROVIDER_ERROR: toolchoice: type tool and any are not supported for this model.", forcedRefused: true },
  auto: { ok: true, outcome: "supported", status: 200, error: null },
  toolCalling: "auto", compat: { requiredToolChoice: false, namedToolChoice: false }, reasoning: null, inconclusive: false, model: "claude-opus-5-5", ms: 900, ...patch
});

describe("the provider card", () => {
  test("names the endpoint: Anthropic by host or flavor, Voyage AI, else OpenAI-compatible", () => {
    expect(endpointLabel({ baseUrl: "https://api.anthropic.com/v1", compat: DEFAULT_COMPAT })).toBe("Anthropic (OpenAI-compatible endpoint)");
    expect(endpointLabel({ baseUrl: "https://llm.internal/v1", compat: { ...DEFAULT_COMPAT, flavor: "anthropic" } })).toBe("Anthropic (OpenAI-compatible endpoint)");
    expect(endpointLabel({ baseUrl: "https://api.voyageai.com/v1", compat: DEFAULT_COMPAT })).toBe("Voyage AI (embeddings only)");
    expect(endpointLabel({ baseUrl: "https://api.openai.com/v1", compat: DEFAULT_COMPAT })).toBe("OpenAI-compatible");
  });

  test("says what it can do: Embeddings: none for Anthropic, Chat: none for Voyage AI", () => {
    expect(capabilitiesSummary({})).toBe("Chat and embeddings");
    expect(capabilitiesSummary({ embeddings: false })).toBe("Chat · Embeddings: none");
    expect(capabilitiesSummary({ chat: false })).toBe("Embeddings only · Chat: none");
    expect(capabilitiesHint(true, false)).toContain("Voyage AI");
    expect(capabilitiesHint(false, true)).toContain("never the default");
  });

  test("Test reads an embeddings-only provider's embedding, and Anthropic's models and completion", () => {
    expect(testText({ ok: true, models: { ok: true, count: null, latencyMs: null, error: null, skipped: true }, completion: { ok: false, model: null, latencyMs: null, error: null, skipped: true }, embeddings: { ok: true, model: "voyage-3.5", dims: 512, latencyMs: 80, error: null } }))
      .toBe("Models: not listed by this provider. Embeddings: ok (voyage-3.5, 512 dimensions) in 80 ms.");
    expect(testText({ ok: true, models: { ok: true, count: 7, latencyMs: 120, error: null }, completion: { ok: true, model: "claude-opus-5-5", latencyMs: 700, error: null } }))
      .toBe("Models: 7 in 120 ms. Completion: ok (claude-opus-5-5) in 700 ms.");
  });

  test("Test tool calling: forced choice refused is the finding, and auto works", () => {
    expect(probeSummary(probe({}))).toBe("Tool calling works (auto) with claude-opus-5-5. Forced tool choice: not supported, so Nook uses auto (fine). Saved to the provider.");
    expect(probeSummary(probe({ toolCalling: "none", auto: { ok: false, outcome: "unsupported", status: 200, error: "The provider answered without calling the tool" } }))).toContain("Tool calling does not work with claude-opus-5-5");
    // A provider whose forced choice works reads as before.
    expect(probeSummary(probe({ toolCalling: "forced", auto: null, required: { ok: true, outcome: "supported", status: 200, error: null }, named: { ok: true, outcome: "supported", status: 200, error: null }, compat: { requiredToolChoice: true, namedToolChoice: true } })))
      .toBe("Tool calling (claude-opus-5-5): required works; a named tool works. Saved to the provider; Nook names the tool it needs.");
  });
});

describe("keyword-only knowledge bases (D541)", () => {
  test("the page's line names keyword search instead of a model", () => {
    expect(searchLine({ keywordOnly: true, providerName: null, embeddingModel: "", dims: 512 })).toBe("Keyword search (no embeddings)");
    expect(searchLine({ keywordOnly: false, providerName: "Voyage", embeddingModel: "voyage-3.5", dims: 1024 })).toBe("Voyage · voyage-3.5, 1024 dimensions");
    expect(KEYWORD_CHANGE_EFFECT).toContain("Nothing is sent for embeddings");
  });
});
