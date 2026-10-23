import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LOCAL_MODELS, LOCAL_VARIANTS, localModelUrl, type LocalVariant } from "../shared/localEmbedding";

/**
 * Fetches a local embedding model's files (D545) from its pinned commit and checks each file's size
 * and sha256 before it is kept. The Docker build runs it (the image carries the files); a host without
 * Docker runs it once into LOCAL_EMBEDDINGS_DIR. Nook itself never downloads them.
 *
 *   bun --no-env-file scripts/fetchLocalModel.ts [dir] [--variant multilingual|english]
 *
 * `--variant` (D686) picks the model: multilingual-e5-small (the default) or bge-small-en-v1.5 (the
 * English-only one, for LOCAL_EMBEDDINGS_VARIANT=english). The default folder is ./models/<model id>.
 * A file already in place with the right size and sha256 is kept. Exits 1 on any mismatch, 2 on usage.
 */

const args = process.argv.slice(2);
const flagAt = args.indexOf("--variant");
const variant = (flagAt >= 0 ? args[flagAt + 1] : "multilingual") as LocalVariant;
if (!(LOCAL_VARIANTS as readonly string[]).includes(variant)) {
  console.error("Usage: bun scripts/fetchLocalModel.ts [dir] [--variant multilingual|english]");
  process.exit(2);
}
const model = LOCAL_MODELS[variant];
const positional = args.filter((_, index) => flagAt < 0 || (index !== flagAt && index !== flagAt + 1));
const target = resolve(positional[0] ?? join(import.meta.dir, "..", "models", model.id));

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

for (const file of model.files) {
  const path = join(target, file.path);
  if (existsSync(path) && statSync(path).size === file.bytes && await sha256Of(path) === file.sha256) {
    console.log(`ok      ${file.path}`);
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  const response = await fetch(localModelUrl(file, model), { redirect: "follow" });
  if (!response.ok || !response.body) {
    console.error(`failed  ${file.path}: HTTP ${response.status}`);
    process.exit(1);
  }
  await Bun.write(partial, response);
  const bytes = statSync(partial).size;
  const sha256 = await sha256Of(partial);
  if (bytes !== file.bytes || sha256 !== file.sha256) {
    rmSync(partial, { force: true });
    console.error(`failed  ${file.path}: expected ${file.bytes} bytes, sha256 ${file.sha256}; got ${bytes} bytes, sha256 ${sha256}`);
    process.exit(1);
  }
  renameSync(partial, path);
  console.log(`fetched ${file.path} (${bytes} bytes, sha256 ${sha256})`);
}
console.log(`${model.label} is in ${target}`);
