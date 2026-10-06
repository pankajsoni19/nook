import { endianness } from "node:os";
import { EMBEDDING_BATCH } from "../../shared/knowledge";
import { EgressError, egressFetch, readEgressText } from "../agents/egress";
import { excerpt, ProviderError, type ProviderConnection } from "../agents/loop";

/**
 * Embeddings (plan §9, D368; Wave 44 "AC-E"): `POST {baseUrl}/embeddings` on the configured
 * provider, through the same egress guard as every other outbound call (D347: https or an allowed
 * private host, DNS checked and pinned on every request, no redirects, byte and time caps, only the
 * provider's Authorization header). Inputs go in batches of 64 (fewer for wide vectors); `dimensions` is sent to models that
 * take it (OpenAI's text-embedding-3 family); every vector is L2-normalized and stored as
 * little-endian float32.
 *
 * Errors carry no response body beyond `excerpt`'s redacted message, never the API key (T309).
 */

/** The response cap per call (plan §3.2 item 5) and the timeouts, on an object so tests can shorten them. */
export const embeddingLimits = { maxBytes: 4 * 1024 * 1024, firstByteMs: 30_000, idleMs: 30_000, totalMs: 120_000 };

/**
 * Inputs per request (Wave 44 fixes, L2): 64 at 512 dimensions, fewer for wider vectors, so an answer
 * stays well under the 4 MiB cap (a float is about 20 bytes of JSON: 10 × 3072 is about 0.6 MiB).
 * With no size asked for (a model that answers in its own), the widest supported size is assumed.
 */
export const batchSizeFor = (dims: number | null) => Math.max(1, Math.min(EMBEDDING_BATCH, Math.floor((EMBEDDING_BATCH * 512) / (dims ?? 3072))));

/** Whether a model takes the `dimensions` parameter (text-embedding-3 models do; ada-002 and most others do not). */
export const takesDimensions = (model: string) => /text-embedding-3/i.test(model);

export type EmbeddingResult = { vectors: Float32Array[]; tokens: number; estimated: boolean };

/** Characters ÷ 4 when the provider reports no usage (plan §2.1). */
const estimate = (inputs: readonly string[]) => inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);

/** Scales a vector to unit length (a zero vector stays zero). */
export function normalizeVector(values: ArrayLike<number>): Float32Array {
  const vector = Float32Array.from(values);
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) sum += vector[index]! * vector[index]!;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let index = 0; index < vector.length; index += 1) vector[index] = vector[index]! / norm;
  return vector;
}

const LITTLE = endianness() === "LE";

/** A vector as the stored BLOB: float32, little-endian (2 KiB at 512 dimensions). */
export function vectorToBlob(vector: Float32Array): Uint8Array {
  if (LITTLE) return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
  const out = new Uint8Array(vector.length * 4);
  const view = new DataView(out.buffer);
  for (let index = 0; index < vector.length; index += 1) view.setFloat32(index * 4, vector[index]!, true);
  return out;
}

/** A stored BLOB read into `target` at `offset` (the search matrix), or a new vector. */
export function blobToVector(blob: Uint8Array, target?: Float32Array, offset = 0): Float32Array {
  const length = Math.floor(blob.byteLength / 4);
  const out = target ?? new Float32Array(length);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let index = 0; index < length; index += 1) out[offset + index] = view.getFloat32(index * 4, true);
  return out;
}

function rethrow(error: unknown): never {
  if (error instanceof ProviderError) throw error;
  if (error instanceof EgressError) {
    if (error.code === "TIMEOUT") throw new ProviderError("MODEL_TIMEOUT", error.message);
    if (error.code === "TOO_LARGE") throw new ProviderError("TOO_LARGE", error.message);
    if (error.code === "NETWORK") throw new ProviderError("PROVIDER_ERROR", error.message);
    throw new ProviderError("EGRESS_REFUSED", error.message);
  }
  throw error;
}

/**
 * One request of at most `batchSizeFor(dims)` inputs. The vectors come back in input order (by `index`), each of
 * `dims` numbers when `dims` is given.
 */
async function embedBatch(connection: ProviderConnection, model: string, dims: number | null, inputs: readonly string[], signal?: AbortSignal): Promise<EmbeddingResult> {
  const body = JSON.stringify({ model, input: inputs, encoding_format: "float", ...(dims !== null && takesDimensions(model) ? { dimensions: dims } : {}) });
  let response: Awaited<ReturnType<typeof egressFetch>>;
  try {
    response = await egressFetch(`${connection.baseUrl}/embeddings`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}) },
      body,
      signal
    }, embeddingLimits);
  } catch (error) {
    rethrow(error);
  }
  let text: string;
  try {
    text = await readEgressText(response, embeddingLimits.maxBytes);
  } catch (error) {
    rethrow(error);
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = excerpt(text);
    const status = response.status;
    const base = status === 401 || status === 403 ? "The provider refused the API key" : status === 404 ? "The provider has no such embedding model or endpoint" : status === 429 ? "The provider is rate limiting this key" : status >= 500 ? "The provider is unavailable" : "The provider refused the request";
    throw new ProviderError("PROVIDER_ERROR", `${base} (HTTP ${status})${detail ? `: ${detail.redacted}` : ""}`, status, `${base} (HTTP ${status})${detail ? `: ${detail.admin}` : ""}`);
  }
  let parsed: { data?: Array<{ index?: unknown; embedding?: unknown }>; usage?: { prompt_tokens?: unknown; total_tokens?: unknown } };
  try { parsed = JSON.parse(text) as typeof parsed; } catch { throw new ProviderError("PROVIDER_ERROR", "The provider's embeddings answer was not JSON"); }
  const data = Array.isArray(parsed.data) ? parsed.data : [];
  if (data.length !== inputs.length) throw new ProviderError("PROVIDER_ERROR", "The provider returned a different number of embeddings than inputs");
  const vectors: Float32Array[] = new Array(inputs.length);
  for (const [position, item] of data.entries()) {
    const index = typeof item.index === "number" && Number.isInteger(item.index) ? item.index : position;
    if (index < 0 || index >= inputs.length || vectors[index]) throw new ProviderError("PROVIDER_ERROR", "The provider's embeddings answer was not valid");
    const values = item.embedding;
    if (!Array.isArray(values) || values.length < 1 || values.length > 3072 || !values.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new ProviderError("PROVIDER_ERROR", "The provider's embeddings answer was not valid");
    }
    if (dims !== null && values.length !== dims) throw new ProviderError("PROVIDER_ERROR", `The model returned ${values.length} dimensions; this knowledge base uses ${dims}`);
    vectors[index] = normalizeVector(values as number[]);
  }
  const reported = typeof parsed.usage?.prompt_tokens === "number" ? parsed.usage.prompt_tokens : typeof parsed.usage?.total_tokens === "number" ? parsed.usage.total_tokens : null;
  return { vectors, tokens: reported ?? estimate(inputs), estimated: reported === null };
}

/**
 * Embeds `inputs` in batches (`batchSizeFor`: 64 at 512 dimensions, 10 at 3072). `beforeBatch` runs before each request (the budget check: a
 * refused batch costs nothing) and `afterBatch` after it (charging its tokens).
 */
export async function embedTexts(connection: ProviderConnection, model: string, dims: number | null, inputs: readonly string[], hooks: { beforeBatch?: (count: number) => void; afterBatch?: (tokens: number) => void; signal?: AbortSignal } = {}): Promise<EmbeddingResult> {
  const vectors: Float32Array[] = [];
  let tokens = 0;
  let estimated = false;
  const size = batchSizeFor(dims);
  for (let start = 0; start < inputs.length; start += size) {
    const batch = inputs.slice(start, start + size);
    hooks.beforeBatch?.(batch.length);
    const result = await embedBatch(connection, model, dims, batch, hooks.signal);
    hooks.afterBatch?.(result.tokens);
    vectors.push(...result.vectors);
    tokens += result.tokens;
    estimated ||= result.estimated;
  }
  return { vectors, tokens, estimated };
}
