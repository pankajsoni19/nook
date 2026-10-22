import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, stat, utimes } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import * as tar from "tar-stream";

/**
 * The archive format of online backups (lane BACKUP, D611). A gzip'd tar whose root is a data
 * directory: drop it into an empty DATA_DIR and Nook starts on it.
 *
 *   mynotes.sqlite         a VACUUM INTO snapshot (one consistent point in time; no -wal or -shm)
 *   notes/…, documents/objects/…, avatars/…, push/vapid.json, storage-instance, …
 *   nook-backup.json       the manifest, always the last entry: every file's size and SHA-256
 *
 * Packing and reading stream (one file and one gzip window in memory at a time). Reading checks every
 * entry against the manifest; extraction writes only regular files under the target, never a link.
 */

export const DATABASE_NAME = "mynotes.sqlite";
export const MANIFEST_NAME = "nook-backup.json";
/** Archive names (D619): only names like this, directly under a backup prefix or folder, are ever listed or deleted. */
export const ARCHIVE_PATTERN = /^nook-backup-(\d{8}T\d{6}Z)-([0-9a-f]{6})\.tar\.gz$/;
/** The offline archives scripts/backup.sh writes (`--force`): readable by the drill and restore, never pruned here. */
export const LEGACY_ARCHIVE_PATTERN = /^mynotes-(\d{8}T\d{6}Z)\.tar\.gz$/;

export const archiveName = (at: Date, suffix = createHash("sha256").update(crypto.randomUUID()).digest("hex").slice(0, 6)) =>
  `nook-backup-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${suffix}.tar.gz`;

/** The time in an archive name (new or legacy), or null. */
export function archiveTime(name: string) {
  const stamp = ARCHIVE_PATTERN.exec(name)?.[1] ?? LEGACY_ARCHIVE_PATTERN.exec(name)?.[1];
  if (!stamp) return null;
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export type ManifestFile = { path: string; size: number; sha256: string };
export type Manifest = {
  format: "nook-backup";
  version: 1;
  createdAt: string;
  appVersion: string;
  gitSha: string;
  /** Where file bytes lived (D612): with s3 the archive holds the database and DATA_DIR only, not the bucket's objects. */
  storage: { backend: "local" } | { backend: "s3"; bucket: string; prefix: string; endpointHost: string };
  database: { path: string; bytes: number; sha256: string; integrity: "ok"; migrations: number[] };
  /** Every entry but the manifest, in archive order (the database first). */
  files: ManifestFile[];
  /** Files under DATA_DIR left out on purpose (links, sockets) or gone before they were read. */
  skipped: Array<{ path: string; reason: "symlink" | "special" | "vanished" }>;
  counts: Record<string, number>;
};

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

const COUNTED_TABLES = ["users", "notes", "folders", "documents", "tasks", "collections", "events", "vaults", "reports", "agents", "chats"] as const;

/** Row counts of the tables a restore is checked by (a table this version lacks is left out). */
export function tableCounts(db: Database) {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
    counts[table] = (db.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  }
  return counts;
}

/** Applied migration ids, ascending (empty for a database without schema_migrations). */
export function appliedMigrations(db: Database) {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()) return [];
  return (db.query("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
}

/** `PRAGMA integrity_check` (full): "ok", or the first problems it reports. */
export function integrityCheck(db: Database) {
  const rows = db.query("PRAGMA integrity_check(20)").all() as Array<{ integrity_check: string }>;
  const lines = rows.map((row) => row.integrity_check);
  return lines.length === 1 && lines[0] === "ok" ? "ok" : lines.join("; ").slice(0, 500) || "no answer";
}

/**
 * A consistent copy of the live database (D611): `VACUUM INTO` on a read-only connection is one read
 * transaction, so writers carry on (WAL) and the copy is the database as of its start, compact, with
 * no free pages (secure_delete leftovers never travel). Then `integrity_check` on the copy; anything
 * but "ok" throws. The copy is set to journal_mode DELETE so it is a single file.
 */
export function snapshotDatabase(databasePath: string, outPath: string) {
  const live = new Database(databasePath, { readonly: true });
  try {
    live.exec("PRAGMA busy_timeout = 30000");
    live.query("VACUUM INTO ?").run(outPath);
  } finally {
    live.close();
  }
  const copy = new Database(outPath, { readwrite: true });
  try {
    const integrity = integrityCheck(copy);
    if (integrity !== "ok") throw new ArchiveError(`The database snapshot failed its integrity check: ${integrity}`);
    copy.exec("PRAGMA journal_mode = DELETE");
    return { migrations: appliedMigrations(copy), counts: tableCounts(copy) };
  } finally {
    copy.close();
  }
}

/** Top-level names never archived: the live database and its sidecars (the snapshot replaces them), Litestream's state, the heartbeat. */
const EXCLUDED_TOP = new Set([DATABASE_NAME, `${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`, `${DATABASE_NAME}-journal`, `.${DATABASE_NAME}-litestream`, `${DATABASE_NAME}-litestream`, "server.heartbeat", "lost+found", MANIFEST_NAME]);
/** Paths (relative, "/"-separated) never archived: uploads in flight. */
const EXCLUDED_PATHS = new Set(["documents/.staging"]);

export type DataFile = { path: string; abs: string };

/**
 * Every regular file under DATA_DIR that belongs in an archive, sorted. Leaves out the live database,
 * staging, `*.tmp` (atomic writes in flight), the backup folder when it is inside DATA_DIR, and links
 * (never followed; listed in `skipped`).
 */
export async function collectDataFiles(dataDir: string, excludeDirs: string[] = []) {
  const root = await realpath(dataDir);
  const excluded = new Set(await Promise.all(excludeDirs.map(async (dir) => { try { return await realpath(dir); } catch { return resolve(dir); } })));
  const files: DataFile[] = [];
  const skipped: Manifest["skipped"] = [];
  let bytes = 0;
  async function walk(dir: string) {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (dir === root && EXCLUDED_TOP.has(entry.name)) continue;
      if (EXCLUDED_PATHS.has(rel) || excluded.has(abs) || entry.name.endsWith(".tmp")) continue;
      if (entry.isSymbolicLink()) {
        skipped.push({ path: rel, reason: "symlink" });
      } else if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        files.push({ path: rel, abs });
        try { bytes += (await stat(abs)).size; } catch { /* gone; packing records it */ }
      } else {
        skipped.push({ path: rel, reason: "special" });
      }
    }
  }
  await walk(root);
  return { files, skipped, bytes };
}

type PackInput = { manifest: Omit<Manifest, "files" | "skipped" | "database"> & { database: Omit<Manifest["database"], "sha256" | "bytes"> }; database: string; files: DataFile[]; skipped: Manifest["skipped"] };

/**
 * Writes the archive: the snapshot first, then the files, then the manifest. Each file is opened once
 * and read from that descriptor up to the size it had when opened (notes and objects are replaced by
 * rename, never rewritten in place, so the bytes are one version). A file gone before it was opened is
 * recorded in `skipped` as vanished (a purge raced the backup). Returns the manifest, the archive's
 * size, and its SHA-256.
 */
export async function writeArchive(outPath: string, input: PackInput) {
  const pack = tar.pack();
  const archiveHash = createHash("sha256");
  let archiveBytes = 0;
  const output = createWriteStream(outPath, { mode: 0o600, flags: "wx" });
  const done = pipeline(pack, createGzip({ level: 6 }), async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      archiveHash.update(chunk);
      archiveBytes += chunk.byteLength;
      yield chunk;
    }
  }, output);
  // A failure inside the pipeline must not leave addEntry waiting on a callback that never comes.
  let failed: unknown = null;
  done.catch((error) => { failed = error; });
  const files: ManifestFile[] = [];
  const skipped = [...input.skipped];

  async function addEntry(name: string, abs: string) {
    let handle;
    try {
      handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new ArchiveError(`${name} is not a regular file`);
      const hash = createHash("sha256");
      let finished!: (error?: Error | null) => void;
      const written = new Promise<void>((resolveEntry, reject) => { finished = (error) => error ? reject(error) : resolveEntry(); });
      const entry = pack.entry({ name, size: info.size, mode: 0o600, mtime: info.mtime, type: "file" }, (error) => finished(error));
      if (info.size > 0) {
        const source = createReadStream("", { fd: handle.fd, start: 0, end: info.size - 1, autoClose: false, highWaterMark: 256 * 1024 });
        for await (const chunk of source as AsyncIterable<Buffer>) {
          if (failed) throw failed;
          hash.update(chunk);
          if (!entry.write(chunk)) await new Promise<void>((resolveDrain) => entry.once("drain", () => resolveDrain()));
        }
      }
      (entry as unknown as { end(): void }).end();
      await written;
      return { path: name, size: info.size, sha256: hash.digest("hex") };
    } finally {
      await handle.close();
    }
  }

  try {
    const database = await addEntry(DATABASE_NAME, input.database);
    if (!database) throw new ArchiveError("The database snapshot is missing");
    files.push(database);
    for (const file of input.files) {
      const added = await addEntry(file.path, file.abs);
      if (added) files.push(added);
      else skipped.push({ path: file.path, reason: "vanished" });
    }
    const manifest: Manifest = { ...input.manifest, database: { ...input.manifest.database, bytes: database.size, sha256: database.sha256 }, files, skipped } as Manifest;
    pack.entry({ name: MANIFEST_NAME, mode: 0o600, mtime: new Date(manifest.createdAt) }, Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`));
    pack.finalize();
    await done;
    return { manifest, size: archiveBytes, sha256: archiveHash.digest("hex") };
  } catch (error) {
    pack.destroy(error as Error);
    await done.catch(() => undefined);
    await rm(outPath, { force: true });
    throw failed ?? error;
  }
}

/** A tar entry name as a safe relative path ("./a/b" → "a/b"), or null for the root entry; throws on anything that could escape. */
export function safeEntryName(raw: string) {
  const name = raw.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (name === "" || name === ".") return null;
  if (name.startsWith("/") || name.includes("\0") || name.includes("\\") || name.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new ArchiveError(`Unsafe path in the archive: ${JSON.stringify(raw.slice(0, 120))}`);
  }
  return name;
}

export type ReadResult = {
  manifest: Manifest | null;
  /** Every regular file read, with its size and SHA-256. */
  files: ManifestFile[];
  archiveBytes: number;
  archiveSha256: string;
};

/**
 * Reads an archive end to end: every entry is hashed, and (when the archive has a manifest) checked
 * against it, both ways: a file the manifest names that is missing, or one it does not name, fails.
 * Archives without a manifest are the offline `mynotes-*.tar.gz` (`legacy: true` accepts them).
 * With `extractTo` (an empty or new directory), files are written there as they are read: regular files
 * only (0600, directories 0700), each opened with O_EXCL and O_NOFOLLOW under the target, with the
 * archive's modification times. Links and devices fail the read.
 */
export async function readArchive(archivePath: string, options: { extractTo?: string; legacy?: boolean } = {}): Promise<ReadResult> {
  const target = options.extractTo ? resolve(options.extractTo) : null;
  if (target) await mkdir(target, { recursive: true, mode: 0o700 });
  const targetReal = target ? await realpath(target) : null;
  const archiveHash = createHash("sha256");
  let archiveBytes = 0;
  const raw = createReadStream(archivePath, { highWaterMark: 256 * 1024 });
  raw.on("data", (chunk) => { archiveHash.update(chunk as Buffer); archiveBytes += (chunk as Buffer).byteLength; });
  const gunzip = createGunzip();
  const extract = tar.extract();
  raw.on("error", (error) => extract.destroy(error));
  gunzip.on("error", (error) => extract.destroy(new ArchiveError(`The archive is not a valid gzip file: ${error.message}`)));
  raw.pipe(gunzip).pipe(extract as unknown as NodeJS.WritableStream);

  const files: ManifestFile[] = [];
  let manifestText: string | null = null;
  const seen = new Set<string>();
  try {
    for await (const entry of extract) {
      const header = entry.header;
      const name = safeEntryName(header.name);
      const type = header.type ?? "file";
      if (type === "directory" || name === null) {
        if (name && target) await mkdir(join(target, name), { recursive: true, mode: 0o700 });
        entry.resume();
        continue;
      }
      if (type !== "file" && type !== "contiguous-file") throw new ArchiveError(`The archive holds a ${type} (${name}); only regular files are restored`);
      if (seen.has(name)) throw new ArchiveError(`The archive names ${name} twice`);
      seen.add(name);
      if (name === MANIFEST_NAME) {
        const chunks: Buffer[] = [];
        for await (const chunk of entry) chunks.push(chunk as Buffer);
        manifestText = Buffer.concat(chunks).toString("utf8");
        continue;
      }
      if (manifestText !== null) throw new ArchiveError("The archive has entries after its manifest");
      const hash = createHash("sha256");
      let size = 0;
      let handle = null;
      if (target && targetReal) {
        const path = join(target, name);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const parent = await realpath(dirname(path));
        if (parent !== targetReal && !parent.startsWith(targetReal + sep)) throw new ArchiveError(`Unsafe path in the archive: ${name}`);
        handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      }
      try {
        for await (const chunk of entry) {
          hash.update(chunk as Buffer);
          size += (chunk as Buffer).byteLength;
          if (handle) await handle.write(chunk as Buffer);
        }
      } finally {
        await handle?.close();
      }
      if (target && header.mtime) await utimes(join(target, name), header.mtime, header.mtime).catch(() => undefined);
      files.push({ path: name, size, sha256: hash.digest("hex") });
    }
  } catch (error) {
    raw.destroy();
    throw error instanceof ArchiveError ? error : new ArchiveError(`The archive could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  let manifest: Manifest | null = null;
  if (manifestText !== null) {
    try {
      manifest = JSON.parse(manifestText) as Manifest;
    } catch {
      throw new ArchiveError("The archive's manifest is not valid JSON");
    }
    if (manifest.format !== "nook-backup" || manifest.version !== 1 || !Array.isArray(manifest.files)) throw new ArchiveError("The archive's manifest is not a Nook backup manifest (version 1)");
    const read = new Map(files.map((file) => [file.path, file]));
    for (const expected of manifest.files) {
      const actual = read.get(expected.path);
      if (!actual) throw new ArchiveError(`The archive is missing ${expected.path}, which its manifest lists`);
      if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new ArchiveError(`${expected.path} does not match its manifest (size or SHA-256)`);
      read.delete(expected.path);
    }
    if (read.size) throw new ArchiveError(`The archive holds ${read.size} file(s) its manifest does not list, such as ${[...read.keys()][0]}`);
  } else if (!options.legacy) {
    throw new ArchiveError("The archive has no manifest (nook-backup.json); it is not an online backup");
  }
  if (!files.some((file) => file.path === DATABASE_NAME)) throw new ArchiveError("The archive holds no mynotes.sqlite");
  return { manifest, files, archiveBytes, archiveSha256: archiveHash.digest("hex") };
}

/** True when `dir` does not exist or holds nothing (a restore never writes into a used data directory). */
export async function isEmptyDirectory(dir: string) {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  return (await readdir(dir)).length === 0;
}
