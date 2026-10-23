import { Database } from "bun:sqlite";
import { closeSync, constants, createReadStream, openSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import type { S3StorageConfig } from "../config";
import { s3Client } from "./stores";

/**
 * BACKUP_S3_OBJECTS=copy (D687): with S3 storage, each archive can also carry the bucket's objects, so it
 * restores alone. The objects are the ones the database snapshot names (documents and their whiteboard
 * scenes and snapshots, not purged; uploaded profile pictures), listed from the snapshot (one consistent
 * point in time) into a side file (D688: never a list in memory), then streamed one at a time from the
 * bucket into the archive under the local storage layout (`documents/objects/<id>`, `avatars/<id>`), so
 * a restored folder is a complete local-storage data directory. Read only: nothing in the bucket changes.
 */

export type ObjectNamespace = "documents" | "avatars";
/** One object the snapshot names: where it goes in the archive, and the size and SHA-256 the database records (none for pictures). */
export type BucketObject = { namespace: ObjectNamespace; id: string; path: string; size: number | null; sha256: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** server/avatars.ts AVATAR_REMOVED: a marker, never a file. */
const AVATAR_REMOVED = "00000000-0000-8000-8000-000000000000";
/** The archive path of an object, as the local backend lays it out (server/objectStore.ts LOCAL_LAYOUT). */
export const archivePathOf = (namespace: ObjectNamespace, id: string) => namespace === "documents" ? `documents/objects/${id}` : `avatars/${id}`;
/** The folders of DATA_DIR that hold local objects: left out of the walk when the bucket's objects are copied (no name twice). */
export const LOCAL_OBJECT_DIRS = ["documents/objects", "avatars"] as const;

/**
 * Writes every object the snapshot names to `listPath` (one JSON record a line) and returns the count
 * and the bytes the database records (profile pictures have no recorded size: `unsized` counts them).
 * Tables a database of an older version lacks are skipped.
 */
export async function listSnapshotObjects(snapshotPath: string, listPath: string) {
  const db = new Database(snapshotPath, { readonly: true });
  // A plain descriptor written synchronously in batches (no FileHandle left to the garbage collector).
  const fd = openSync(listPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const flush = () => { const bytes = Buffer.from(buffer); buffer = ""; for (let at = 0; at < bytes.byteLength;) at += writeSync(fd, bytes, at); };
  let count = 0;
  let bytes = 0;
  let unsized = 0;
  let buffer = "";
  const add = async (object: BucketObject) => {
    if (!UUID.test(object.id)) return;
    buffer += `${JSON.stringify(object)}\n`;
    count += 1;
    if (object.size === null) unsized += 1;
    else bytes += object.size;
    if (buffer.length >= 65_536) flush();
  };
  try {
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    if (tables.has("documents")) {
      const whiteboards = tables.has("whiteboards");
      const purge = (db.query("PRAGMA table_info(documents)").all() as Array<{ name: string }>).some((row) => row.name === "purge_started_at");
      const live = purge ? "d.purge_started_at IS NULL" : "1";
      const sql = [
        `SELECT d.id AS id, d.size_bytes AS size, d.sha256 AS sha256 FROM documents d WHERE ${live}${whiteboards ? " AND NOT EXISTS (SELECT 1 FROM whiteboards w WHERE w.document_id = d.id)" : ""}`,
        ...(whiteboards ? [`SELECT w.object_id, d.size_bytes, d.sha256 FROM whiteboards w JOIN documents d ON d.id = w.document_id WHERE ${live}`] : []),
        ...(tables.has("whiteboard_snapshots") ? [`SELECT s.object_id, s.size_bytes, s.sha256 FROM whiteboard_snapshots s JOIN documents d ON d.id = s.document_id WHERE ${live}`] : [])
      ].join(" UNION ALL ");
      for (const row of db.query(sql).iterate() as IterableIterator<{ id: string; size: number | null; sha256: string | null }>) {
        await add({ namespace: "documents", id: row.id, path: archivePathOf("documents", row.id), size: typeof row.size === "number" ? row.size : null, sha256: row.sha256 ?? null });
      }
    }
    const userColumns = new Set((db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((row) => row.name));
    if (userColumns.has("avatar_id")) {
      for (const row of db.query("SELECT avatar_id AS id FROM users WHERE avatar_id IS NOT NULL AND avatar_id <> ?").iterate(AVATAR_REMOVED) as IterableIterator<{ id: string }>) {
        // An uploaded picture's id is a version-8 UUID (server/avatars.ts); Google's are fetched again.
        if (row.id[14] === "8") await add({ namespace: "avatars", id: row.id, path: archivePathOf("avatars", row.id), size: null, sha256: null });
      }
    }
    if (buffer) flush();
  } finally {
    closeSync(fd);
    db.close();
  }
  return { count, bytes, unsized };
}

/** The records of a `listSnapshotObjects` file, streamed. */
export async function* objectsFrom(listPath: string): AsyncIterable<BucketObject> {
  for await (const line of createInterface({ input: createReadStream(listPath, { encoding: "utf8" }), crlfDelay: Infinity })) {
    if (line) yield JSON.parse(line) as BucketObject;
  }
}

export type OpenedObject = { size: number; mtime: Date; chunks: AsyncIterable<Uint8Array> };

const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : error instanceof Error ? error.name : "Unknown";
};
const missing = (error: unknown) => ["NoSuchKey", "NotFound", "ENOENT"].includes(codeOf(error));

const deadline = <T>(work: Promise<T>, ms: number, what: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`S3 ${what} timed out`)), ms); })]).finally(() => clearTimeout(timer));
};

/**
 * Reads objects from the storage bucket (read only): a HEAD for the size (retried up to three times),
 * then one GET streamed, each read of the body under the storage timeout (a stalled body fails the run
 * rather than hanging it). Null when the object is not there (purged after the snapshot, or lost).
 */
export function bucketObjectReader(storage: Pick<S3StorageConfig, "bucket" | "endpoint" | "region" | "accessKeyId" | "secretAccessKey" | "prefix" | "timeoutMs">) {
  const client = s3Client(storage);
  const timeoutMs = storage.timeoutMs;
  return async function openObject(object: BucketObject): Promise<OpenedObject | null> {
    if (!UUID.test(object.id)) return null;
    const key = `${storage.prefix}${object.namespace}/${object.id}`;
    let info: { size: number; lastModified: Date } | null = null;
    for (let attempt = 1; !info; attempt += 1) {
      try {
        info = await deadline(client.stat(key), timeoutMs, "HEAD");
      } catch (error) {
        if (missing(error)) return null;
        if (attempt >= 3) throw Object.assign(new Error(`S3 error ${codeOf(error)} reading an object`), { code: codeOf(error) });
        await Bun.sleep(500 * attempt);
      }
    }
    const size = info.size;
    const file = client.file(key);
    async function* chunks() {
      if (size === 0) return;
      const reader = (file.stream() as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { done, value } = await deadline(reader.read(), timeoutMs, "read");
          if (done) return;
          yield value;
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
    }
    return { size, mtime: info.lastModified ?? new Date(), chunks: chunks() };
  };
}
