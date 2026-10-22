import { ANTHROPIC_VERSION, flavorDefaults, normalizeKnownBaseUrl } from "../../../shared/agents";
import { openaiAdapter } from "./openai";
import { bearerHeaders, type ProviderAdapter } from "./types";

/** Pages of Anthropic's native model list Nook reads at most (D539: 1,000 a page, so 5,000 ids; more than any account has). */
export const MODEL_LIST_PAGES = 5;

/**
 * Anthropic (D539, D540): its OpenAI-compatible endpoint, by host (`api.anthropic.com`) or a proxy's
 * `compat.flavor: "anthropic"`. What differs from the OpenAI kind: `x-api-key` and
 * `anthropic-version` beside the Bearer key on every request (its native `/v1/models` requires them),
 * that models list read page by page (`limit=1000`, `after_id`), `/v1` added to a bare host, new
 * providers starting with `max_tokens`, auto-only tool choice, a 200,000-token window and no
 * embeddings, and a 16-token Test (current Claude models think before they answer, so one token can
 * come back empty). Embeddings, when an admin turns them on for a proxy, are sent as the OpenAI kind's.
 */
export const anthropicAdapter: ProviderAdapter = {
  kind: "anthropic",
  newProvider: { compat: flavorDefaults("anthropic") },
  capabilities: { chat: true, embeddings: false },
  impliedCompat: () => ({}),
  normalizeBaseUrl: normalizeKnownBaseUrl,
  headers: (apiKey, accept) => ({ ...bearerHeaders(apiKey, accept), "anthropic-version": ANTHROPIC_VERSION, ...(apiKey ? { "x-api-key": apiKey } : {}) }),
  modelsList: { pages: MODEL_LIST_PAGES, query: (after) => `?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}` },
  takesDimensions: openaiAdapter.takesDimensions,
  embeddingBody: (...args) => openaiAdapter.embeddingBody(...args),
  test: { listModels: true, completionTokens: 16 }
};
