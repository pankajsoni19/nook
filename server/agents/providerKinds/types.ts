import type { ProviderCompat, ProviderFlavor } from "../../../shared/agents";

/**
 * A provider kind's adapter (D543). Every kind-specific choice Nook makes about a model provider
 * lives in one file per kind under `server/agents/providerKinds/`: `openai.ts` (the default, any
 * OpenAI-compatible endpoint), `anthropic.ts`, `voyage.ts`, and `local.ts` (the embedding model
 * built into Nook). `loop.ts`, `providers.ts`, and `knowledge/embed.ts` ask the adapter of the
 * connection's kind and contain no kind branches, so a change for one kind cannot alter another;
 * tests/openaiProviderGolden.test.ts pins the OpenAI kind's wire to v0.43.0.
 */
export type ProviderKind = "openai" | ProviderFlavor;
export type EmbeddingInputType = "document" | "query";

export type ProviderAdapter = {
  kind: ProviderKind;
  /** What a new provider of this kind starts with; the form's and the request's own values win (D539, D542). */
  newProvider: { compat: Partial<ProviderCompat>; defaultModel?: string; embeddingModel?: string; embeddingDims?: number };
  /** What the kind can do when an admin has not said otherwise (D541 Embeddings, D542 Chat). */
  capabilities: { chat: boolean; embeddings: boolean };
  /** Compat the kind implies when it is not stored (Voyage AI's size field and sizes). */
  impliedCompat(compat: ProviderCompat): Partial<ProviderCompat>;
  /** The base URL as saved (D539: a known host without its version path gets `/v1`). */
  normalizeBaseUrl(value: string): string;
  /** The headers of every request to the provider (models, chat, probes, embeddings). */
  headers(apiKey: string | null, accept: string): Record<string, string>;
  /** `GET {baseUrl}/models`: how many pages to read and each page's query; null: the kind lists no models over HTTP. */
  modelsList: { pages: number; query(after: string | null): string } | null;
  /** Whether a model takes a size (the request's `dimensions` or `output_dimension`). */
  takesDimensions(model: string, compat: Pick<ProviderCompat, "dimensionsParam">): boolean;
  /** The `POST {baseUrl}/embeddings` body. */
  embeddingBody(model: string, dims: number | null, inputs: readonly string[], inputType: EmbeddingInputType | undefined, compat: Pick<ProviderCompat, "dimensionsParam">): Record<string, unknown>;
  /** Test (Settings → AI): whether it reads the models list, the completion's output tokens, and an embeddings-only kind's input. */
  test: { listModels: boolean; completionTokens: number; embedInput?: string };
  /**
   * A kind that runs inside Nook (D544, the local model) sets these: no network address (`network`
   * false: no egress check, no HTTP), one fixed base URL (at most one such provider; its kind never
   * changes), no API key, capabilities an admin cannot change, no token budget (`metered` false: it
   * costs no provider tokens), its only embedding models, its batch size, and its own `embed`.
   */
  network?: false;
  fixedBaseUrl?: string;
  takesApiKey?: false;
  fixedCapabilities?: true;
  metered?: false;
  embeddingModels?: readonly string[];
  batchSize?: number;
  embed?: (model: string, dims: number | null, inputs: readonly string[], options: { inputType?: EmbeddingInputType; signal?: AbortSignal }) => Promise<{ vectors: Float32Array[]; tokens: number; estimated: boolean }>;
  /** Refuses a new provider of this kind when the server forbids it (an `AgentError`). */
  assertCreatable?: () => void;
};

/** Bearer auth, as every kind sends it (v0.43.0's headers). */
export const bearerHeaders = (apiKey: string | null, accept: string): Record<string, string> => ({
  Accept: accept,
  "Content-Type": "application/json",
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
});

/**
 * The embeddings body of an endpoint sized by `output_dimension` (D542: Voyage AI, or any endpoint an
 * admin marks with `compat.dimensionsParam`): that field instead of `dimensions`, no `encoding_format`
 * (Voyage takes only null or base64; its default is floats), and `input_type`.
 */
export const outputDimensionBody = (model: string, dims: number | null, inputs: readonly string[], inputType: EmbeddingInputType | undefined, sized: boolean): Record<string, unknown> =>
  ({ model, input: inputs, ...(sized && dims !== null ? { output_dimension: dims } : {}), ...(inputType ? { input_type: inputType } : {}) });

/** A base URL as v0.43.0 saved it: trimmed, without trailing slashes. */
export const trimBaseUrl = (value: string) => value.trim().replace(/\/+$/, "");
