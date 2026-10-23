/**
 * The embedding models built into Nook (D544, D545, D686): what the server, the client, the fetch
 * script, and the tests share. Pure: no imports.
 *
 * multilingual-e5-small (intfloat, MIT), the int8 ONNX export in Xenova/multilingual-e5-small, pinned
 * to one commit of that repository, is the default; bge-small-en-v1.5 (BAAI, MIT) is the lighter,
 * English-only choice (`LOCAL_EMBEDDINGS_VARIANT=english`, D686). Every file has its size and sha256
 * (Hugging Face's LFS oid is the sha256 of the file), checked when the files are fetched and again
 * whenever the model is loaded.
 */

/** A local provider's base URL: never a network address (D544). Its scheme marks the kind. */
export const LOCAL_BASE_URL = "local://nook";

export type LocalModelFile = { path: string; bytes: number; sha256: string };

/** D686: which local model a server runs (`LOCAL_EMBEDDINGS_VARIANT`); `multilingual` is the default. */
export const LOCAL_VARIANTS = ["multilingual", "english"] as const;
export type LocalVariant = typeof LOCAL_VARIANTS[number];

export type LocalModelSpec = {
  variant: LocalVariant;
  id: string;
  label: string;
  dims: number;
  /** The model's position limit, special tokens included. */
  maxTokens: number;
  /** What a query and a passage are prefixed with (E5's `query: ` and `passage: `; BGE's retrieval instruction on queries only). */
  prefixes: { query: string; document: string };
  /** How the token vectors become one: their mean (E5) or the first token's (BGE: CLS). */
  pooling: "mean" | "cls";
  /** The tokenizer's sequence start and end tokens (the windows of a long text are framed with them). */
  specialTokens: { start: string; end: string };
  /** Its languages, in words for Settings → AI. */
  languages: string;
  /** Resident memory while loaded, measured (D546, D686), in GB, for Settings → AI. */
  memoryGb: number;
  repo: string;
  revision: string;
  license: string;
  files: readonly LocalModelFile[];
};

export const LOCAL_MODELS: Record<LocalVariant, LocalModelSpec> = {
  multilingual: {
    variant: "multilingual",
    id: "multilingual-e5-small",
    label: "multilingual-e5-small (int8)",
    dims: 384,
    maxTokens: 512,
    // E5 models are trained with these prefixes on queries and passages.
    prefixes: { query: "query: ", document: "passage: " },
    pooling: "mean",
    specialTokens: { start: "<s>", end: "</s>" },
    languages: "multilingual",
    memoryGb: 0.8,
    repo: "Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    license: "MIT",
    files: [
      { path: "onnx/model_quantized.onnx", bytes: 118_308_185, sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193" },
      { path: "tokenizer.json", bytes: 17_082_730, sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39" },
      { path: "tokenizer_config.json", bytes: 443, sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b" }
    ]
  },
  // D686: the int8 ONNX export in Xenova/bge-small-en-v1.5: English only, the same 384 dimensions and
  // 512 tokens, CLS pooling, and BGE's retrieval instruction before queries (passages go as they are).
  // Its 30,522-piece WordPiece vocabulary and small embedding table keep it at about a third of
  // e5-small's memory while loaded.
  english: {
    variant: "english",
    id: "bge-small-en-v1.5",
    label: "bge-small-en-v1.5 (int8)",
    dims: 384,
    maxTokens: 512,
    prefixes: { query: "Represent this sentence for searching relevant passages: ", document: "" },
    pooling: "cls",
    specialTokens: { start: "[CLS]", end: "[SEP]" },
    languages: "English only",
    memoryGb: 0.3,
    repo: "Xenova/bge-small-en-v1.5",
    revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
    license: "MIT",
    files: [
      { path: "onnx/model_quantized.onnx", bytes: 34_014_426, sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4" },
      { path: "tokenizer.json", bytes: 711_396, sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66" },
      { path: "tokenizer_config.json", bytes: 366, sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3" }
    ]
  }
};

/** The default model, multilingual-e5-small: what a server runs unless LOCAL_EMBEDDINGS_VARIANT=english. */
export const LOCAL_MODEL = LOCAL_MODELS.multilingual;

/** The variant whose model this id names, or null. */
export const localVariantOf = (modelId: string): LocalVariant | null => LOCAL_VARIANTS.find((variant) => LOCAL_MODELS[variant].id === modelId) ?? null;

/** Where a model file is fetched from: the pinned commit, never a branch. */
export const localModelUrl = (file: Pick<LocalModelFile, "path">, model: Pick<LocalModelSpec, "repo" | "revision"> = LOCAL_MODEL) =>
  `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`;

/** A model's total size on disk, in bytes. */
export const localModelBytes = (model: Pick<LocalModelSpec, "files">) => model.files.reduce((sum, file) => sum + file.bytes, 0);
/** The default model's size on disk. */
export const LOCAL_MODEL_BYTES = localModelBytes(LOCAL_MODEL);

/**
 * What Settings → AI knows about the local model (`GET /api/agents/admin/providers`, `local`):
 * whether this server allows it (`LOCAL_EMBEDDINGS`), whether its files are in place, and why not.
 */
export type LocalEmbeddingStatus = {
  allowed: boolean; available: boolean; reason: string | null;
  model: string; dims: number; bytes: number;
  /** D686: the variant this server runs (LOCAL_EMBEDDINGS_VARIANT), its languages, and its memory while loaded. */
  variant: LocalVariant; languages: string; memoryGb: number;
  /** Whether a local provider has been added (at most one). */
  added: boolean;
};
