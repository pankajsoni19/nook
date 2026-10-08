/**
 * Knowledge bases (agent chat plan §9, D367–D369; Wave 44 "AC-E"): the vocabulary the server, the
 * client, and the tests share. Pure: no imports.
 */

/** Bounds (plan §9). */
export const KNOWLEDGE_BOUNDS = {
  name: 60,
  description: 280,
  /** Sources per base, and chunks per base. */
  sources: 500,
  chunks: 10_000,
  /** A Files document source: these types only, at most 1 MiB. */
  documentBytes: 1024 * 1024,
  /** A pasted text source, in UTF-8 bytes (and the stored column's character bound). */
  textBytes: 256 * 1024,
  textTitle: 120,
  /** `search_knowledge`: the query, the default and largest `k`, and the text of one hit. */
  queryChars: 500,
  k: { default: 5, max: 8 },
  hitTextChars: 2000,
  /** Per-source chunk previews (2026-10-08): the first characters of each chunk, and a page's default and largest size. */
  previewChars: 300,
  previewPage: { default: 20, max: 50 },
  /** Change embedding model (2026-10-08): the model id's length. */
  modelName: 100
} as const;

/** The Files types a document source may have (plan §9). */
export const KNOWLEDGE_DOCUMENT_TYPES = ["text/plain", "text/markdown", "text/csv"] as const;

/** Chunking (plan §9, D369): about 800 tokens, 15% overlap inside long sections, 20 CSV rows per chunk. */
export const CHUNKING = { targetChars: 3200, overlap: 0.15, csvRows: 20, version: 1 } as const;

/** Embedding requests (plan §9): 64 inputs per call. */
export const EMBEDDING_BATCH = 64;

/** Reciprocal rank fusion's constant (plan §9). */
export const RRF_K = 60;

export type KnowledgeLevel = "owner" | "manage" | "view";
export type KnowledgeStatus = "empty" | "indexing" | "ready" | "error";
export type SourceKind = "note" | "document" | "text";
/** `pending` waits in the queue; `indexing` is being read and embedded now. */
export type SourceStatus = "pending" | "indexing" | "ready" | "error" | "unavailable";

export type KnowledgeSummary = {
  id: string; name: string; description: string; ownerId: string; ownerName: string; yourLevel: KnowledgeLevel;
  embeddingModel: string; dims: number; status: KnowledgeStatus; chunkCount: number; sourceCount: number;
  /** Sources by state, for the list's line; `paused` (Wave 44 fixes) counts the `pending` ones waiting on the daily budget. */
  counts: { pending: number; indexing: number; ready: number; error: number; unavailable: number; paused?: number };
  audience: "private" | "selected" | "all_users" | null; revision: number; createdAt: string; updatedAt: string;
  /**
   * Why the base is not working normally (Wave 44 fixes), shown on its page: its embedding provider
   * was removed (M3: keyword search only, nothing new indexed), or its owner is blocked (M2: paused).
   */
  notice: string | null;
  /** The embedding provider's name, or null when it was removed (2026-10-08). */
  providerName: string | null;
  /**
   * The base is moving to another embedding model (2026-10-08): its old vectors are gone and its
   * sources are being embedded again. Search uses keywords only until that finishes (never two
   * embedding spaces in one search).
   */
  changingModel: boolean;
};

/**
 * One source as the base's page lists it. A viewer is never told the title (or id) of a note or file
 * they cannot read themselves (`titleHidden`); managers and the owner see every title.
 */
export type KnowledgeSource = {
  id: string; kind: SourceKind; title: string | null; titleHidden: boolean; refId: string | null;
  status: SourceStatus; error: string | null; chunkCount: number; indexedAt: string | null; createdAt: string | null; bytes: number | null;
  /** Whether the reader may preview this source's chunks (2026-10-08): the owner or a manager who can read the source now. */
  previewable: boolean;
};

/** One chunk as a source's preview shows it (2026-10-08): its place, heading path, and first `previewChars` characters. */
export type KnowledgeChunkPreview = { ord: number; heading: string | null; preview: string; chars: number };
export type KnowledgeChunkPage = { chunks: KnowledgeChunkPreview[]; total: number; offset: number; limit: number };

/** Change embedding model's provider list (2026-10-08): names and the embedding defaults, never an address or key. */
export type KnowledgeEmbeddingChoice = { id: string; name: string; isDefault: boolean; embeddingModel: string; embeddingDims: number; models: string[] | null };

/** Whether a model takes a `dimensions` parameter (OpenAI's text-embedding-3 family); other models answer in their own size. */
export const takesDimensions = (model: string) => /text-embedding-3/i.test(model);

/** What Change embedding model's confirm says (D91: the app's own dialog). */
export const MODEL_CHANGE_EFFECT = "Every source is embedded again with the new model, at your token cost. Search uses keywords only until that finishes, and the old vectors are deleted now. This counts as this hour's Re-index.";

export type KnowledgeDetail = KnowledgeSummary & { sources: KnowledgeSource[] };

/** A hit (Try it, `search_knowledge`): `source.id` and `source.title` only when the reader can open that note or file. */
export type KnowledgeHit = {
  kb: { id: string; name: string };
  heading: string | null;
  source: { kind: SourceKind; id?: string; title?: string };
  text: string;
  score: number;
  /** Try it shows why a hit ranked: its place in each list (null when absent from it). */
  ranks: { vector: number | null; keyword: number | null };
};

/** What Add source's pickers offer: notes and files both the caller and the base's owner can read. */
export type KnowledgeCandidate = { id: string; title: string; detail: string; added: boolean };

/** `search_knowledge` (plan §9): the tool's name on the model's side, and its server label. */
export const KNOWLEDGE_TOOL = { server: "knowledge", tool: "search_knowledge", modelName: "knowledge__search_knowledge" } as const;

/** The Access sheet's note (D367): who reads a base's text. */
export const KNOWLEDGE_SHARE_NOTE = "Anyone who can use an agent with this knowledge base can read its text. View: search it. Manage: also add sources and attach it to agents.";

/** A source waits on the daily token budget (`pending` with the pause reason, QA LOW-3). */
export const isPausedSource = (source: { status: SourceStatus; error: string | null }) => source.status === "pending" && source.error !== null;
