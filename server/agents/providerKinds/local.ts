import { config } from "../../config";
import { LOCAL_BASE_URL, LOCAL_MODEL } from "../../../shared/localEmbedding";
import { LOCAL_EMBED_BOUNDS, localEmbed, localEmbeddingStatus, localFilesProblem } from "../../knowledge/local/embedder";
import { db } from "../../db";
import { ProviderError } from "../loop";
import { AgentError } from "../status";
import { bearerHeaders, type ProviderAdapter } from "./types";

/**
 * The embedding model built into Nook (D544): "Local (built into Nook)". Embeddings only (Chat:
 * none), no API key, no network: its base URL is `local://nook`, never fetched, so no egress check
 * applies and nothing leaves the server. multilingual-e5-small, 384 dimensions (no size choice),
 * run on a worker thread one text at a time (knowledge/local/embedder.ts). Off by default: an admin
 * adds it; `LOCAL_EMBEDDINGS=off` forbids it. It costs no provider tokens, so it is not metered
 * against the daily token budgets (its CPU is bounded by the worker instead).
 */
export const localAdapter: ProviderAdapter = {
  kind: "local",
  newProvider: { compat: { chat: false, supportsTools: false }, defaultModel: LOCAL_MODEL.id, embeddingModel: LOCAL_MODEL.id, embeddingDims: LOCAL_MODEL.dims },
  capabilities: { chat: false, embeddings: true },
  impliedCompat: () => ({}),
  normalizeBaseUrl: () => LOCAL_BASE_URL,
  headers: bearerHeaders,
  modelsList: null,
  takesDimensions: () => false,
  embeddingBody: (model, _dims, inputs) => ({ model, input: inputs }),
  test: { listModels: false, completionTokens: 1, embedInput: "Nook embeds this sentence on this server; nothing is sent out." },
  network: false,
  fixedBaseUrl: LOCAL_BASE_URL,
  takesApiKey: false,
  fixedCapabilities: true,
  metered: false,
  embeddingModels: [LOCAL_MODEL.id],
  // A getter: the embedder may still be loading when this module is (an import cycle through loop.ts).
  get batchSize() { return LOCAL_EMBED_BOUNDS.batch; },
  async embed(model, _dims, inputs, options) {
    if (model !== LOCAL_MODEL.id) throw new ProviderError("PROVIDER_ERROR", `The local provider has only ${LOCAL_MODEL.id}`);
    const result = await localEmbed(inputs, options.inputType ?? "document", options.signal);
    // No provider tokens are spent, so none are charged (D544).
    return { vectors: result.vectors, tokens: 0, estimated: false };
  },
  assertCreatable() {
    if (!config.localEmbeddings.enabled) throw new AgentError(409, "LOCAL_EMBEDDINGS_OFF", "Local embeddings are turned off on this server (LOCAL_EMBEDDINGS=off)", { field: "baseUrl" });
    // An image built with LOCAL_EMBEDDINGS_MODEL=skip, or a LOCAL_EMBEDDINGS_DIR without the files: nothing to run.
    const missing = localFilesProblem();
    if (missing) throw new AgentError(409, "LOCAL_MODEL_MISSING", missing, { field: "baseUrl" });
  }
};

/** What Settings → AI shows about the local model (`GET /api/agents/admin/providers`, `local`). */
export const localStatus = () => localEmbeddingStatus(db.query("SELECT 1 FROM agent_providers WHERE base_url = ?").get(LOCAL_BASE_URL) !== null);
