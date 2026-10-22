import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_MODEL, type LocalModelFile } from "../../../shared/localEmbedding";

/**
 * The local model's files on disk (D545): present with the pinned sizes (cheap, for Settings → AI),
 * and their sha256 (checked by the worker every time it loads the model, before ONNX Runtime or the
 * tokenizer reads a byte). Pure: no config, no database, so the worker can import it.
 */

export class LocalModelError extends Error {
  constructor(readonly code: "LOCAL_EMBEDDINGS_OFF" | "MODEL_MISSING" | "MODEL_CHANGED" | "LOCAL_BUSY" | "LOCAL_FAILED" | "LOCAL_TIMEOUT", message: string) {
    super(message);
    this.name = "LocalModelError";
  }
}

/** The first file missing or of another size, or null when all are in place. */
export function missingFile(dir: string): LocalModelFile | null {
  for (const file of LOCAL_MODEL.files) {
    const path = join(dir, file.path);
    if (!existsSync(path) || statSync(path).size !== file.bytes) return file;
  }
  return null;
}

/** Why the model cannot load from `dir`, in an admin's words, or null. */
export function filesProblem(dir: string): string | null {
  const missing = missingFile(dir);
  return missing ? `The local model's files are not in place: ${missing.path} is missing or has another size in ${dir}. An image built with LOCAL_EMBEDDINGS_MODEL=skip has none: put them in LOCAL_EMBEDDINGS_DIR with scripts/fetchLocalModel.ts, or build with LOCAL_EMBEDDINGS_MODEL=include.` : null;
}

async function sha256Of(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/** The sha256 checks already made, by path, size, and modification time (Settings → AI asks often; a file changed since is checked again). */
const verified = new Map<string, { size: number; mtimeMs: number; ok: boolean }>();

/**
 * Why the model in `dir` would not load, or null when every file is in place with its pinned size
 * and sha256 (Settings → AI offers the Local kind only then). Each file is hashed once per change.
 */
export async function verifiedProblem(dir: string): Promise<string | null> {
  const problem = filesProblem(dir);
  if (problem) return problem;
  for (const file of LOCAL_MODEL.files) {
    const path = join(dir, file.path);
    const { size, mtimeMs } = statSync(path);
    let entry = verified.get(path);
    if (!entry || entry.size !== size || entry.mtimeMs !== mtimeMs) {
      entry = { size, mtimeMs, ok: await sha256Of(path) === file.sha256 };
      verified.set(path, entry);
    }
    if (!entry.ok) return `The local model's file ${file.path} in ${dir} does not match its pinned sha256. Fetch it again with scripts/fetchLocalModel.ts.`;
  }
  return null;
}

/** Every file's size and sha256 against the pinned manifest; throws `MODEL_MISSING` or `MODEL_CHANGED`. */
export async function verifyModelFiles(dir: string): Promise<void> {
  const problem = filesProblem(dir);
  if (problem) throw new LocalModelError("MODEL_MISSING", problem);
  for (const file of LOCAL_MODEL.files) {
    const actual = await sha256Of(join(dir, file.path));
    if (actual !== file.sha256) throw new LocalModelError("MODEL_CHANGED", `The local model's file ${file.path} does not match its pinned sha256, so it was not loaded. Fetch it again with scripts/fetchLocalModel.ts.`);
  }
}
