import { config } from "../../config";
import { LOCAL_BASE_URL, LOCAL_MODELS, localVariantOf } from "../../../shared/localEmbedding";
import { LOCAL_EMBED_BOUNDS, localEmbed, localEmbeddingStatus, localFilesProblem, localModel } from "../../knowledge/local/embedder";
import { db } from "../../db";
import { ProviderError } from "../loop";
import { AgentError } from "../status";
import { bearerHeaders, type ProviderAdapter } from "./types";

/**
 * The embedding model built into Nook (D544): "Local (built into Nook)". Embeddings only (Chat:
 * none), no API key, no network: its base URL is `local://nook`, never fetched, so no egress check
 * applies and nothing leaves the server. multilingual-e5-small, 384 dimensions (no size choice), or
 * bge-small-en-v1.5 with LOCAL_EMBEDDINGS_VARIANT=english (D686: the provider offers only the model the
 * server runs; a base still on the other one is moved with Change embedding model), run on a worker thread one text at a time (knowledge/local/embedder.ts). Off by default: an admin
 * adds it; `LOCAL_EMBEDDINGS=off` forbids it. It costs no provider tokens, so it is not metered
 * against the daily token budgets (its CPU is bounded by the worker instead).
 */
export const localAdapter: ProviderAdapter = {
  kind: "local",
  // Getters (D686): the model is the server's variant, read when a provider is added.
  get newProvider() { const model = localModel(); return { compat: { chat: false, supportsTools: false }, defaultModel: model.id, embeddingModel: model.id, embeddingDims: model.dims }; },
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
  get embeddingModels() { return [localModel().id]; },
  // A getter: the embedder may still be loading when this module is (an import cycle through loop.ts).
  get batchSize() { return LOCAL_EMBED_BOUNDS.batch; },
  async embed(model, _dims, inputs, options) {
    const running = localModel();
    if (model !== running.id) {
      // D686: a base embedded with the other variant's model: its vectors cannot be compared with this model's.
      const other = localVariantOf(model);
      throw new ProviderError("PROVIDER_ERROR", other
        ? `This knowledge base uses ${model}, but this server runs ${running.id} (LOCAL_EMBEDDINGS_VARIANT=${running.variant}). Its owner moves it with Change embedding model (every source is embedded again), or an admin sets LOCAL_EMBEDDINGS_VARIANT=${LOCAL_MODELS[other].variant} again.`
        : `The local provider has only ${running.id}`);
    }
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
