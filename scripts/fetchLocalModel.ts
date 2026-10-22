import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LOCAL_MODEL, localModelUrl } from "../shared/localEmbedding";

/**
 * Fetches the local embedding model's files (D545) from the pinned commit and checks each file's
 * size and sha256 before it is kept. The Docker build runs it once (the image carries the files);
 * a host without Docker runs it once into LOCAL_EMBEDDINGS_DIR. Nook itself never downloads them.
 *
 *   bun --no-env-file scripts/fetchLocalModel.ts [dir]   (default: ./models/multilingual-e5-small)
 *
 * A file already in place with the right size and sha256 is kept. Exits 1 on any mismatch.
 */

const target = resolve(process.argv[2] ?? join(import.meta.dir, "..", "models", LOCAL_MODEL.id));

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

for (const file of LOCAL_MODEL.files) {
  const path = join(target, file.path);
  if (existsSync(path) && statSync(path).size === file.bytes && await sha256Of(path) === file.sha256) {
    console.log(`ok      ${file.path}`);
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  const response = await fetch(localModelUrl(file), { redirect: "follow" });
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
console.log(`${LOCAL_MODEL.label} is in ${target}`);
