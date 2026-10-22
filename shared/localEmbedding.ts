/**
 * The embedding model built into Nook (D544, D545): what the server, the client, the fetch script,
 * and the tests share. Pure: no imports.
 *
 * multilingual-e5-small (intfloat, MIT), the int8 ONNX export in Xenova/multilingual-e5-small, pinned
 * to one commit of that repository. Every file has its size and sha256 (Hugging Face's LFS oid is the
 * sha256 of the file), checked when the files are fetched and again whenever the model is loaded.
 */

/** A local provider's base URL: never a network address (D544). Its scheme marks the kind. */
export const LOCAL_BASE_URL = "local://nook";

export type LocalModelFile = { path: string; bytes: number; sha256: string };

export const LOCAL_MODEL = {
  id: "multilingual-e5-small",
  label: "multilingual-e5-small (int8)",
  dims: 384,
  /** The model's position limit, special tokens included. */
  maxTokens: 512,
  /** E5 models are trained with these prefixes on queries and passages. */
  prefixes: { query: "query: ", document: "passage: " },
  repo: "Xenova/multilingual-e5-small",
  revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
  license: "MIT",
  files: [
    { path: "onnx/model_quantized.onnx", bytes: 118_308_185, sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193" },
    { path: "tokenizer.json", bytes: 17_082_730, sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39" },
    { path: "tokenizer_config.json", bytes: 443, sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b" }
  ] as readonly LocalModelFile[]
} as const;

/** Where a model file is fetched from: the pinned commit, never a branch. */
export const localModelUrl = (file: Pick<LocalModelFile, "path">) => `https://huggingface.co/${LOCAL_MODEL.repo}/resolve/${LOCAL_MODEL.revision}/${file.path}`;

/** The model's total size on disk, in bytes. */
export const LOCAL_MODEL_BYTES = LOCAL_MODEL.files.reduce((sum, file) => sum + file.bytes, 0);

/**
 * What Settings → AI knows about the local model (`GET /api/agents/admin/providers`, `local`):
 * whether this server allows it (`LOCAL_EMBEDDINGS`), whether its files are in place, and why not.
 */
export type LocalEmbeddingStatus = {
  allowed: boolean; available: boolean; reason: string | null;
  model: string; dims: number; bytes: number;
  /** Whether a local provider has been added (at most one). */
  added: boolean;
};
