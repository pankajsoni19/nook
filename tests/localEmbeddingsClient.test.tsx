import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { breakable, capabilitiesHint, endpointLabel, isLocal, localOptionText, localProviderText, LOCAL_PROVIDER_TEXT, testText } from "../src/chat/AiSettings";
import { claudeTemperatureWarning } from "../src/chat/AgentsSettings";
import { changeEffect } from "../src/chat/KnowledgeModel";
import { KNOWLEDGE_INTRO } from "../src/chat/KnowledgeSettings";
import { MODEL_CHANGE_EFFECT } from "../shared/knowledge";
import { knowledgeLine } from "../src/chat/knowledgeApi";
import { DEFAULT_COMPAT } from "../shared/agents";
import { LOCAL_BASE_URL, LOCAL_MODEL, type LocalEmbeddingStatus } from "../shared/localEmbedding";
import type { KnowledgeSummary } from "../shared/knowledge";

/**
 * Local embeddings and lane CLAUDE's leftovers, client side (2026-10-22, lane LOCALEMB; D544–D547):
 * the provider card and Add provider's Kind choice for the model built into Nook, code values that
 * wrap between words on a 1280 px card, a knowledge base's short row line on a phone, and the agent
 * editor's warning about Claude 4.7+ and a temperature below 1.
 */

const status = (patch: Partial<LocalEmbeddingStatus>): LocalEmbeddingStatus => ({ allowed: true, available: true, reason: null, model: LOCAL_MODEL.id, dims: 384, bytes: 135_391_358, variant: "multilingual", languages: "multilingual", memoryGb: 0.8, added: false, ...patch });

describe("the local provider in Settings → AI", () => {
  test("its card names it and its address is never shown as a URL", () => {
    expect(endpointLabel({ baseUrl: LOCAL_BASE_URL, compat: { ...DEFAULT_COMPAT, chat: false } })).toBe("Local (built into Nook)");
    expect(isLocal({ baseUrl: LOCAL_BASE_URL })).toBe(true);
    expect(isLocal({ baseUrl: "https://api.openai.com/v1" })).toBe(false);
  });

  test("the Kind choice says why it cannot be added, when it cannot", () => {
    expect(localOptionText(status({}))).toBe("Built into Nook: knowledge bases only, nothing leaves the server");
    expect(localOptionText(status({ allowed: false, available: false }))).toBe("Turned off on this server (LOCAL_EMBEDDINGS=off)");
    expect(localOptionText(status({ added: true }))).toBe("Already added");
    expect(localOptionText(status({ available: false, reason: "missing" }))).toBe("Its model files are not in place on this server (see below)");
    expect(LOCAL_PROVIDER_TEXT).toContain("nothing leaves the server");
    expect(LOCAL_PROVIDER_TEXT).toContain("384 dimensions, about 135 MB, multilingual");
    expect(LOCAL_PROVIDER_TEXT).toContain("about 0.8 GB of memory");
    // D686: the English variant's line names its model, size, language, and memory.
    const english = localProviderText(status({ model: "bge-small-en-v1.5", bytes: 34_726_188, variant: "english", languages: "English only", memoryGb: 0.3 }));
    expect(english).toContain("Runs bge-small-en-v1.5 (384 dimensions, about 35 MB, English only)");
    expect(english).toContain("about 0.3 GB of memory");
  });

  test("Test reads as one embedded sentence; Anthropic's hint names the local model", () => {
    expect(testText({ ok: true, models: { ok: true, count: null, latencyMs: null, error: null, skipped: true }, completion: { ok: false, model: null, latencyMs: null, error: null, skipped: true }, embeddings: { ok: true, model: LOCAL_MODEL.id, dims: 384, latencyMs: 2140, error: null } }))
      .toBe("Models: not listed by this provider. Embeddings: ok (multilingual-e5-small, 384 dimensions) in 2140 ms.");
    expect(capabilitiesHint(true, false)).toContain("Local embeddings (built into Nook)");
  });

  test("Change embedding model says the local model costs no tokens", () => {
    expect(changeEffect({ flavor: "local" })).toBe("Every source is embedded again on this server (no token cost; about a second or two a passage). Search uses keywords only until that finishes, and the old vectors are deleted now. This counts as this hour's Re-index.");
    expect(changeEffect({})).toBe(MODEL_CHANGE_EFFECT);
    // D548: no Re-index hour for a keyword-only base or one whose provider was removed.
    expect(changeEffect({ flavor: "local" }, { keywordOnly: true, providerName: null })).toBe("Every source is embedded again on this server (no token cost; about a second or two a passage). Search uses keywords only until that finishes, and the old vectors are deleted now. No Re-index hour applies to this knowledge base.");
    expect(changeEffect({}, { keywordOnly: false, providerName: null })).toContain("No Re-index hour applies");
    expect(changeEffect({}, { keywordOnly: false, providerName: "OpenAI" })).toBe(MODEL_CHANGE_EFFECT);
  });

  test("Settings → Knowledge says where a base's text goes, by how it searches", () => {
    expect(KNOWLEDGE_INTRO).toContain("except with Local embeddings (run on this server) or keyword search, which send it nowhere");
    expect(KNOWLEDGE_INTRO).not.toContain("is sent to the model provider to be indexed");
  });

  test("code values wrap after _ - . / rather than mid-word", () => {
    expect(renderToStaticMarkup(<code>{breakable("max_completion_tokens")}</code>)).toBe("<code>max_<wbr/>completion_<wbr/>tokens</code>");
    expect(renderToStaticMarkup(<code>{breakable("text-embedding-3-small")}</code>)).toBe("<code>text-<wbr/>embedding-<wbr/>3-<wbr/>small</code>");
    expect(renderToStaticMarkup(<code>{breakable("gpt")}</code>)).toBe("<code>gpt</code>");
  });
});

describe("a knowledge base's row on a phone", () => {
  const kb = (patch: Partial<KnowledgeSummary>) => ({ sourceCount: 1, chunkCount: 0, status: "error" as const, counts: { pending: 0, indexing: 0, ready: 0, error: 1, unavailable: 0 }, ...patch });
  test("the short line keeps the problem in a few words; the page keeps the long one", () => {
    expect(knowledgeLine(kb({}), true)).toBe("1 source · 0 chunks · 1 error");
    expect(knowledgeLine(kb({}))).toBe("1 source · 0 chunks · 1 source has an error");
    expect(knowledgeLine(kb({ sourceCount: 4, counts: { pending: 0, indexing: 0, ready: 1, error: 2, unavailable: 1 } }), true)).toBe("4 sources · 0 chunks · 2 errors · 1 unavailable");
  });
});

describe("the agent editor and Claude's temperature (D539)", () => {
  const claude = { flavor: "anthropic" as const, defaultModel: "claude-opus-5-5" };
  test("warns below 1 on Claude 4.7 and later, or a Claude model it cannot read", () => {
    expect(claudeTemperatureWarning(claude, "", "0.2")).toContain("Claude 4.7 and later refuse a temperature below 1");
    expect(claudeTemperatureWarning(claude, "claude-sonnet-4-7", "0")).not.toBeNull();
    expect(claudeTemperatureWarning(claude, "claude-fable-5-1", "0.5")).not.toBeNull();
    expect(claudeTemperatureWarning(claude, "my-proxy-alias", "0.5")).not.toBeNull();
  });
  test("quiet at 1 or more, empty, older Claude models, and other providers", () => {
    expect(claudeTemperatureWarning(claude, "", "1")).toBeNull();
    expect(claudeTemperatureWarning(claude, "", "")).toBeNull();
    expect(claudeTemperatureWarning(claude, "claude-sonnet-4-5-20250929", "0.2")).toBeNull();
    expect(claudeTemperatureWarning(claude, "claude-3-7-sonnet", "0.2")).toBeNull();
    expect(claudeTemperatureWarning({ defaultModel: "gpt-6-luna" }, "", "0.2")).toBeNull();
    expect(claudeTemperatureWarning(null, "", "0.2")).toBeNull();
  });
});
