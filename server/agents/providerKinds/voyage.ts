import { flavorDefaults, normalizeKnownBaseUrl, VOYAGE_DEFAULT_MODEL, VOYAGE_SIZES } from "../../../shared/agents";
import { takesDimensions } from "../../../shared/knowledge";
import { bearerHeaders, outputDimensionBody, type ProviderAdapter } from "./types";

/**
 * Voyage AI (D542): embeddings only, by host (`api.voyageai.com`) or `compat.flavor: "voyage"`. No
 * chat, no models list (Test makes one embedding instead), sized by `output_dimension` in four sizes
 * on its sized models, `input_type` document or query, no `encoding_format`; new providers start
 * with voyage-3.5 as both models.
 */
export const voyageAdapter: ProviderAdapter = {
  kind: "voyage",
  newProvider: { compat: flavorDefaults("voyage"), defaultModel: VOYAGE_DEFAULT_MODEL, embeddingModel: VOYAGE_DEFAULT_MODEL },
  capabilities: { chat: false, embeddings: true },
  impliedCompat: (compat) => ({
    ...(compat.dimensionsParam ? {} : { dimensionsParam: "output_dimension" as const }),
    ...(compat.embeddingSizes ? {} : { embeddingSizes: [...VOYAGE_SIZES] })
  }),
  normalizeBaseUrl: normalizeKnownBaseUrl,
  headers: bearerHeaders,
  modelsList: null,
  takesDimensions: (model) => takesDimensions(model, { flavor: "voyage" }),
  embeddingBody(model, dims, inputs, inputType) {
    return outputDimensionBody(model, dims, inputs, inputType, dims !== null && this.takesDimensions(model, {}));
  },
  test: { listModels: false, completionTokens: 1 }
};
