import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ARCHIVE_PATTERN, LEGACY_ARCHIVE_PATTERN } from "./archive";
import type { BackupS3Settings } from "./settings";

/**
 * Where archives are kept (D613): a local folder and an S3 prefix behind one interface. Both list and
 * delete only names matching ARCHIVE_PATTERN directly in their folder or under their prefix (D619), so
 * retention can never touch anything else in the bucket (files, Litestream, other tools' objects).
 */

export type StoredArchive = { name: string; size: number; modifiedMs: number };

export interface ArchiveStore {
  kind: "local" | "s3";
  /** For people: the folder, or s3://bucket/prefix at host. Never a credential. */
  location: string;
  /** Copies a finished archive in (multipart on S3, streamed from the file; a local copy is staged and renamed). */
  put(localPath: string, name: string): Promise<{ size: number }>;
  /** Online archives, newest first; with `legacy`, the offline mynotes-*.tar.gz too (local folder only). */
  list(options?: { legacy?: boolean }): Promise<StoredArchive[]>;
  /** Deletes one archive; refuses any name that is not an online archive's. */
  remove(name: string): Promise<void>;
  /** Copies an archive out to a local file (streamed). */
  fetch(name: string, toPath: string): Promise<void>;
}

const assertArchiveName = (name: string, legacy = false) => {
  if (!ARCHIVE_PATTERN.test(name) && !(legacy && LEGACY_ARCHIVE_PATTERN.test(name))) throw new Error("Not a backup archive name");
};

export function createLocalStore(dir: string): ArchiveStore {
  return {
    kind: "local",
    location: dir,
    async put(localPath, name) {
      assertArchiveName(name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const target = join(dir, name);
      const staged = `${target}.partial`;
      // Same filesystem (the work folder is inside this one): a rename; otherwise a copy, then a rename.
      try {
        await rename(localPath, staged);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await copyFile(localPath, staged, constants.COPYFILE_EXCL);
      }
      await rename(staged, target);
      return { size: (await stat(target)).size };
    },
    async list(options = {}) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const out: StoredArchive[] = [];
      for (const name of names) {
        if (!ARCHIVE_PATTERN.test(name) && !(options.legacy && LEGACY_ARCHIVE_PATTERN.test(name))) continue;
        try {
          const info = await stat(join(dir, name));
          if (info.isFile()) out.push({ name, size: info.size, modifiedMs: info.mtimeMs });
        } catch {
          // Removed meanwhile.
        }
      }
      return out.sort(newestFirst);
    },
    async remove(name) {
      assertArchiveName(name);
      await rm(join(dir, name), { force: true });
    },
    async fetch(name, toPath) {
      assertArchiveName(name, true);
      await copyFile(join(dir, name), toPath, constants.COPYFILE_EXCL);
    }
  };
}

/** Newest first by the time in the name (names sort by time), then by modification time. */
export function newestFirst(a: StoredArchive, b: StoredArchive) {
  // Online and offline names compare by their time (nook-backup-<time>-… and mynotes-<time>.tar.gz).
  const key = (archive: StoredArchive) => archive.name.replace(/^mynotes-/, "nook-backup-");
  const [ka, kb] = [key(a), key(b)];
  return ka === kb ? b.modifiedMs - a.modifiedMs : kb > ka ? 1 : -1;
}

/** Multipart part size for archive uploads; the upload holds one part in memory at a time. */
export const ARCHIVE_PART_BYTES = 8 * 1024 * 1024;

export function s3Client(settings: Pick<BackupS3Settings, "bucket" | "endpoint" | "region" | "accessKeyId" | "secretAccessKey">) {
  return new Bun.S3Client({
    bucket: settings.bucket,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    // Always explicit, like the storage backend (never AWS_ENDPOINT or S3_ENDPOINT from the environment).
    endpoint: settings.endpoint,
    ...(settings.region ? { region: settings.region } : {})
  });
}

const deadline = <T>(work: Promise<T>, ms: number, what: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`S3 ${what} timed out`)), ms); })]).finally(() => clearTimeout(timer));
};

/** An S3 error as its service code only (never a URL or key). */
export function s3ErrorText(error: unknown) {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code)) return `S3 error ${code}`;
  if (error instanceof Error && /^S3 .* timed out$|^The bucket|^Archive/.test(error.message)) return error.message;
  return `S3 error ${error instanceof Error ? error.name : "Unknown"}`;
}

export function createS3Store(settings: BackupS3Settings): ArchiveStore {
  const client = s3Client(settings);
  const prefix = settings.prefix;
  const timeoutMs = settings.timeoutMs;
  const location = `s3://${settings.bucket}/${prefix} at ${new URL(settings.endpoint).host}`;
  const keyOf = (name: string) => `${prefix}${name}`;

  /** HEAD through a presigned URL: Bun's stat() does not return x-amz-server-side-encryption. */
  async function encryptedAtRest(key: string) {
    const url = client.presign(key, { method: "HEAD", expiresIn: 300 });
    const response = await deadline(fetch(url, { method: "HEAD" }), timeoutMs, "HEAD");
    if (!response.ok) throw new Error(`The bucket answered ${response.status} to a HEAD of the archive`);
    return Boolean(response.headers.get("x-amz-server-side-encryption"));
  }

  return {
    kind: "s3",
    location,
    async put(localPath, name) {
      assertArchiveName(name);
      const key = keyOf(name);
      const size = (await stat(localPath)).size;
      const sink = client.file(key).writer({ partSize: ARCHIVE_PART_BYTES, queueSize: 1, retry: 3, type: "application/gzip" });
      // Bun's writer keeps every view passed to write() until the upload ends (review N2 of the storage
      // slice), so chunks go into one part-sized buffer owned here, and only whole parts are handed over,
      // each flushed before the next is read: memory stays at about one part whatever the archive's size.
      let part = new Uint8Array(ARCHIVE_PART_BYTES);
      let filled = 0;
      try {
        for await (const chunk of createReadStream(localPath, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) {
          let offset = 0;
          while (offset < chunk.byteLength) {
            const take = Math.min(ARCHIVE_PART_BYTES - filled, chunk.byteLength - offset);
            part.set(chunk.subarray(offset, offset + take), filled);
            filled += take;
            offset += take;
            if (filled === ARCHIVE_PART_BYTES) {
              await deadline(Promise.resolve(sink.write(part)), timeoutMs * 4, "part upload");
              await deadline(Promise.resolve(sink.flush()), timeoutMs * 4, "part upload");
              part = new Uint8Array(ARCHIVE_PART_BYTES);
              filled = 0;
            }
          }
        }
        if (filled > 0) await deadline(Promise.resolve(sink.write(part.subarray(0, filled))), timeoutMs * 4, "part upload");
        await deadline(Promise.resolve(sink.end()), timeoutMs * 4, "upload");
      } catch (error) {
        await deadline(client.delete(key), timeoutMs, "DELETE").catch(() => undefined);
        throw error;
      }
      const stored = await deadline(client.stat(key), timeoutMs, "HEAD");
      if (stored.size !== size) {
        await deadline(client.delete(key), timeoutMs, "DELETE").catch(() => undefined);
        throw new Error(`Archive upload came back with ${stored.size} bytes instead of ${size}`);
      }
      if (settings.sse === "required" && !(await encryptedAtRest(key))) {
        await deadline(client.delete(key), timeoutMs, "DELETE").catch(() => undefined);
        throw new Error("The bucket did not encrypt the archive at rest (BACKUP_S3_SSE=required): turn on default encryption for the bucket (SSE-S3 or SSE-KMS); the uploaded copy was removed");
      }
      return { size };
    },
    async list() {
      const out: StoredArchive[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await deadline(client.list({ prefix, ...(continuationToken ? { continuationToken } : {}) }), timeoutMs, "LIST");
        for (const entry of page.contents ?? []) {
          const name = entry.key.slice(prefix.length);
          // Directly under the prefix and named like an archive; anything else is not ours.
          if (!entry.key.startsWith(prefix) || !ARCHIVE_PATTERN.test(name)) continue;
          out.push({ name, size: entry.size ?? 0, modifiedMs: entry.lastModified ? Date.parse(entry.lastModified) : 0 });
        }
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken);
      return out.sort(newestFirst);
    },
    async remove(name) {
      assertArchiveName(name);
      await deadline(client.delete(keyOf(name)), timeoutMs, "DELETE");
    },
    async fetch(name, toPath) {
      assertArchiveName(name);
      const handle = await open(toPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        const stream = client.file(keyOf(name)).stream() as unknown as AsyncIterable<Uint8Array>;
        for await (const chunk of stream) await handle.write(chunk);
      } finally {
        await handle.close();
      }
    }
  };
}

/**
 * Keeps the newest `keep` archives in a store (D613, D619): only online archive names, never `keepName`
 * (the one just written), oldest deleted first. Returns the names removed.
 */
export async function pruneArchives(store: ArchiveStore, keep: number, keepName: string) {
  const archives = await store.list();
  const removed: string[] = [];
  let kept = archives.some((archive) => archive.name === keepName) ? 1 : 0;
  for (const archive of archives) {
    if (archive.name === keepName) continue;
    if (kept < keep) {
      kept += 1;
      continue;
    }
    await store.remove(archive.name);
    removed.push(archive.name);
  }
  return removed;
}
