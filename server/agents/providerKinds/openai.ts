import { takesDimensions } from "../../../shared/knowledge";
import { bearerHeaders, outputDimensionBody, trimBaseUrl, type ProviderAdapter } from "./types";

/**
 * The default kind (D543): any OpenAI-compatible endpoint (OpenAI itself, Z.ai, a vLLM or LiteLLM
 * proxy). Its wire is v0.43.0's, pinned by tests/openaiProviderGolden.test.ts: Bearer auth, one
 * page of `GET /models`, `dimensions` and `encoding_format: "float"` on text-embedding-3 models, and
 * a one-token Test completion. Only an admin's own compat flags change what it sends.
 */
export const openaiAdapter: ProviderAdapter = {
  kind: "openai",
  newProvider: { compat: {} },
  capabilities: { chat: true, embeddings: true },
  impliedCompat: () => ({}),
  normalizeBaseUrl: trimBaseUrl,
  headers: bearerHeaders,
  modelsList: { pages: 1, query: () => "" },
  takesDimensions: (model, compat) => takesDimensions(model, { dimensionsParam: compat.dimensionsParam }),
  embeddingBody(model, dims, inputs, inputType, compat) {
    const sized = dims !== null && this.takesDimensions(model, compat);
    // D542: an endpoint an admin marked as sized by `output_dimension` gets that wire shape.
    if (compat.dimensionsParam === "output_dimension") return outputDimensionBody(model, dims, inputs, inputType, sized);
    return { model, input: inputs, encoding_format: "float", ...(sized ? { dimensions: dims } : {}) };
  },
  test: { listModels: true, completionTokens: 1 }
};
