import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, createWriteStream, openSync, writeSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
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
 *
 * D688: the manifest's file list never sits in memory. Packing appends each file's record to a side
 * file and writes the manifest as one JSON object whose `files` array comes last, one record a line
 * (`{…header…,"files":[` / `{record},` … / `]}`), streamed from that side file; reading streams the
 * manifest and the records it read to two side files and compares them line by line, in archive order.
 * Manifests written before (one `JSON.stringify(…, null, 1)` document) are still read, whole.
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

/** A manifest without its file list, as packing and reading return it (D688: the list stays on disk). */
export type ManifestSummary = Omit<Manifest, "files"> & { fileCount: number };

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
 * (never followed; listed in `skipped`). D688: with `listPath`, the list goes to that file (one path a
 * line, read back with `dataFilesFrom`) instead of memory, and `files` is empty.
 */
export async function collectDataFiles(dataDir: string, excludeDirs: string[] = [], options: { listPath?: string } = {}) {
  const root = await realpath(dataDir);
  const excluded = new Set(await Promise.all(excludeDirs.map(async (dir) => { try { return await realpath(dir); } catch { return resolve(dir); } })));
  const files: DataFile[] = [];
  const skipped: Manifest["skipped"] = [];
  let bytes = 0;
  let count = 0;
  const list = options.listPath ? await LineFile.create(options.listPath) : null;
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
        if (list) await list.write(`${JSON.stringify(rel)}\n`);
        else files.push({ path: rel, abs });
        count += 1;
        try { bytes += (await stat(abs)).size; } catch { /* gone; packing records it */ }
      } else {
        skipped.push({ path: rel, reason: "special" });
      }
    }
  }
  try {
    await walk(root);
  } finally {
    await list?.close();
  }
  return { files, skipped, bytes, count, root };
}

/** The files a `collectDataFiles` list names, streamed (D688). */
export async function* dataFilesFrom(listPath: string, root: string): AsyncIterable<DataFile> {
  for await (const line of linesOf(listPath)) {
    if (!line) continue;
    const path = JSON.parse(line) as string;
    yield { path, abs: join(root, ...path.split("/")) };
  }
}

type PackInput = { manifest: Omit<Manifest, "files" | "skipped" | "database"> & { database: Omit<Manifest["database"], "sha256" | "bytes"> }; database: string; files: Iterable<DataFile> | AsyncIterable<DataFile>; skipped: Manifest["skipped"] };

/** Appends lines to a file through one 64 KiB buffer (D688: lists that may hold a million records). */
class LineFile {
  private buffer = "";
  private fd: number | null;
  bytes = 0;
  // A plain descriptor, written synchronously in 64 KiB batches: no FileHandle for the garbage collector
  // to find open (Bun reports one collected open as an error), and closing twice is harmless.
  private constructor(fd: number) { this.fd = fd; }
  static async create(path: string) {
    return new LineFile(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
  }
  async write(text: string) {
    this.buffer += text;
    this.bytes += Buffer.byteLength(text);
    if (this.buffer.length >= 65_536) await this.flush();
  }
  /** Raw bytes (a manifest entry streamed to disk: chunks may split a character). */
  async writeBytes(bytes: Buffer) {
    await this.flush();
    if (this.fd === null) return;
    this.bytes += bytes.byteLength;
    for (let at = 0; at < bytes.byteLength;) at += writeSync(this.fd, bytes, at);
  }
  async flush() {
    if (!this.buffer || this.fd === null) return;
    const bytes = Buffer.from(this.buffer);
    this.buffer = "";
    for (let at = 0; at < bytes.byteLength;) at += writeSync(this.fd, bytes, at);
  }
  async close() {
    if (this.fd === null) return;
    try {
      await this.flush();
    } finally {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

/** The lines of a file, streamed. */
const linesOf = (path: string) => createInterface({ input: createReadStream(path, { encoding: "utf8", highWaterMark: 256 * 1024 }), crlfDelay: Infinity });

const FILES_OPEN = `,"files":[`;
const FILES_CLOSE = "\n]}\n";

/** Writes the streamed manifest entry (D688): the header, the side file of records, and the close. */
async function writeManifestEntry(pack: tar.Pack, header: Omit<Manifest, "files">, listPath: string, listBytes: number) {
  const head = `${JSON.stringify(header).slice(0, -1)}${FILES_OPEN}`;
  const size = Buffer.byteLength(head) + listBytes + Buffer.byteLength(FILES_CLOSE);
  let finished!: (error?: Error | null) => void;
  const written = new Promise<void>((resolveEntry, reject) => { finished = (error) => error ? reject(error) : resolveEntry(); });
  const entry = pack.entry({ name: MANIFEST_NAME, size, mode: 0o600, mtime: new Date(header.createdAt), type: "file" }, (error) => finished(error));
  const put = async (chunk: Buffer) => { if (!entry.write(chunk)) await new Promise<void>((resolveDrain) => entry.once("drain", () => resolveDrain())); };
  await put(Buffer.from(head));
  for await (const chunk of createReadStream(listPath, { highWaterMark: 256 * 1024 }) as AsyncIterable<Buffer>) await put(chunk);
  await put(Buffer.from(FILES_CLOSE));
  (entry as unknown as { end(): void }).end();
  await written;
}

/**
 * Writes the archive: the snapshot first, then the files, then the manifest. Each file is opened once
 * and read from that descriptor up to the size it had when opened (notes and objects are replaced by
 * rename, never rewritten in place, so the bytes are one version). A file gone before it was opened is
 * recorded in `skipped` as vanished (a purge raced the backup). Each file's record goes to a side file
 * beside the archive (`<archive>.files`, removed after), never to memory (D688). Returns the manifest
 * without its list, the archive's size, and its SHA-256.
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
  const skipped = [...input.skipped];
  const listPath = `${outPath}.files`;
  let list: LineFile | null = null;
  let fileCount = 0;
  const record = async (file: ManifestFile) => {
    await list!.write(`${fileCount === 0 ? "\n" : ",\n"}${JSON.stringify(file)}`);
    fileCount += 1;
  };

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
    list = await LineFile.create(listPath);
    const database = await addEntry(DATABASE_NAME, input.database);
    if (!database) throw new ArchiveError("The database snapshot is missing");
    await record(database);
    for await (const file of input.files) {
      const added = await addEntry(file.path, file.abs);
      if (added) await record(added);
      else skipped.push({ path: file.path, reason: "vanished" });
    }
    await list.close();
    const header = { ...input.manifest, database: { ...input.manifest.database, bytes: database.size, sha256: database.sha256 }, skipped } as Omit<Manifest, "files">;
    await writeManifestEntry(pack, header, listPath, list.bytes);
    pack.finalize();
    await done;
    const manifest: ManifestSummary = { ...header, fileCount };
    return { manifest, size: archiveBytes, sha256: archiveHash.digest("hex") };
  } catch (error) {
    pack.destroy(error as Error);
    await done.catch(() => undefined);
    await list?.close().catch(() => undefined);
    await rm(outPath, { force: true });
    throw failed ?? error;
  } finally {
    await rm(listPath, { force: true });
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
  /** The manifest without its file list (D688), or null for an offline archive. */
  manifest: ManifestSummary | null;
  /** How many regular files were read (the manifest not counted). */
  fileCount: number;
  /** Every regular file read, with its size and SHA-256: only with `collect` (tests, small archives). */
  files?: ManifestFile[];
  archiveBytes: number;
  archiveSha256: string;
};

const sameFile = (a: ManifestFile, b: ManifestFile) => a.path === b.path && a.size === b.size && a.sha256 === b.sha256;

/** The manifest's header and its records, in order, from the side file it was streamed to (D688; or a whole older manifest). */
async function openManifest(path: string): Promise<{ header: Omit<Manifest, "files">; records: AsyncIterable<ManifestFile> }> {
  const invalid = () => new ArchiveError("The archive's manifest is not valid JSON");
  const lines = linesOf(path);
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  const firstLine = first.done ? "" : first.value;
  if (firstLine.endsWith(FILES_OPEN)) {
    let header: Omit<Manifest, "files">;
    try { header = JSON.parse(`${firstLine.slice(0, -FILES_OPEN.length)}}`) as Omit<Manifest, "files">; } catch { lines.close(); throw invalid(); }
    async function* records() {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) throw invalid();
          const line = next.value;
          if (line === "]}") break;
          try { yield JSON.parse(line.endsWith(",") ? line.slice(0, -1) : line) as ManifestFile; } catch { throw invalid(); }
        }
      } finally {
        lines.close();
      }
    }
    return { header, records: records() };
  }
  // A manifest from before D688: one JSON document (its list was in memory when it was written, too).
  lines.close();
  let whole: Manifest;
  try { whole = JSON.parse(await readFile(path, "utf8")) as Manifest; } catch { throw invalid(); }
  if (!whole || !Array.isArray(whole.files)) throw new ArchiveError("The archive's manifest is not a Nook backup manifest (version 1)");
  const { files, ...header } = whole;
  return { header, records: (async function* () { yield* files; })() };
}

/**
 * Reads an archive end to end: every entry is hashed, and (when the archive has a manifest) checked
 * against it, both ways: a file the manifest names that is missing, or one it does not name, fails.
 * Archives without a manifest are the offline `mynotes-*.tar.gz` (`legacy: true` accepts them).
 * With `extractTo` (an empty or new directory), files are written there as they are read: regular files
 * only (0600, directories 0700), each opened with O_EXCL and O_NOFOLLOW under the target, with the
 * archive's modification times. Links and devices fail the read. D688: the records read and the manifest
 * go to two side files in a private folder under `scratchDir` (default the system's temporary folder),
 * removed afterwards, and are compared line by line; `collect` also returns the records (tests).
 */
export async function readArchive(archivePath: string, options: { extractTo?: string; legacy?: boolean; collect?: boolean; scratchDir?: string } = {}): Promise<ReadResult> {
  const target = options.extractTo ? resolve(options.extractTo) : null;
  if (target) await mkdir(target, { recursive: true, mode: 0o700 });
  const targetReal = target ? await realpath(target) : null;
  const scratch = await mkdtemp(join(options.scratchDir ?? tmpdir(), "nook-read-"));
  try {
    return await readInto(archivePath, options, target, targetReal, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function readInto(archivePath: string, options: { legacy?: boolean; collect?: boolean }, target: string | null, targetReal: string | null, scratch: string): Promise<ReadResult> {
  const archiveHash = createHash("sha256");
  let archiveBytes = 0;
  const raw = createReadStream(archivePath, { highWaterMark: 256 * 1024 });
  raw.on("data", (chunk) => { archiveHash.update(chunk as Buffer); archiveBytes += (chunk as Buffer).byteLength; });
  const gunzip = createGunzip();
  const extract = tar.extract();
  raw.on("error", (error) => extract.destroy(error));
  gunzip.on("error", (error) => extract.destroy(new ArchiveError(`The archive is not a valid gzip file: ${error.message}`)));
  raw.pipe(gunzip).pipe(extract as unknown as NodeJS.WritableStream);

  const readPath = join(scratch, "read.ndjson");
  const manifestPath = join(scratch, "manifest.json");
  const readList = await LineFile.create(readPath);
  const collected: ManifestFile[] | undefined = options.collect ? [] : undefined;
  let fileCount = 0;
  let sawManifest = false;
  let hasDatabase = false;
  try {
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
        if (name === MANIFEST_NAME) {
          if (sawManifest) throw new ArchiveError(`The archive names ${name} twice`);
          sawManifest = true;
          const manifestFile = await LineFile.create(manifestPath);
          try {
            for await (const chunk of entry) await manifestFile.writeBytes(chunk as Buffer);
          } finally {
            await manifestFile.close();
          }
          continue;
        }
        if (sawManifest) throw new ArchiveError("The archive has entries after its manifest");
        const hash = createHash("sha256");
        let size = 0;
        let handle = null;
        if (target && targetReal) {
          const path = join(target, name);
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const parent = await realpath(dirname(path));
          if (parent !== targetReal && !parent.startsWith(targetReal + sep)) throw new ArchiveError(`Unsafe path in the archive: ${name}`);
          // O_EXCL: an archive that names a file twice fails here.
          try {
            handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ArchiveError(`The archive names ${name} twice`);
            throw error;
          }
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
        const file = { path: name, size, sha256: hash.digest("hex") };
        await readList.write(`${JSON.stringify(file)}\n`);
        collected?.push(file);
        fileCount += 1;
        if (name === DATABASE_NAME) hasDatabase = true;
      }
    } finally {
      await readList.close();
    }
  } catch (error) {
    raw.destroy();
    throw error instanceof ArchiveError ? error : new ArchiveError(`The archive could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  let manifest: ManifestSummary | null = null;
  if (sawManifest) {
    const { header, records } = await openManifest(manifestPath);
    if (header.format !== "nook-backup" || header.version !== 1) throw new ArchiveError("The archive's manifest is not a Nook backup manifest (version 1)");
    // Both lists are in archive order (the database first): compare them record by record.
    const readLines = linesOf(readPath);
    const read = readLines[Symbol.asyncIterator]();
    let listed = 0;
    try {
      for await (const expected of records) {
        listed += 1;
        const next = await read.next();
        if (next.done) throw new ArchiveError(`The archive is missing ${expected.path}, which its manifest lists`);
        const actual = JSON.parse(next.value) as ManifestFile;
        if (actual.path !== expected.path) throw new ArchiveError(`The archive is missing ${expected.path}, which its manifest lists (found ${actual.path} in its place)`);
        if (!sameFile(actual, expected)) throw new ArchiveError(`${expected.path} does not match its manifest (size or SHA-256)`);
      }
      const extra = await read.next();
      if (!extra.done) throw new ArchiveError(`The archive holds ${fileCount - listed} file(s) its manifest does not list, such as ${(JSON.parse(extra.value) as ManifestFile).path}`);
    } finally {
      readLines.close();
    }
    manifest = { ...header, fileCount: listed };
  } else if (!options.legacy) {
    throw new ArchiveError("The archive has no manifest (nook-backup.json); it is not an online backup");
  }
  if (!hasDatabase) throw new ArchiveError("The archive holds no mynotes.sqlite");
  return { manifest, fileCount, ...(collected ? { files: collected } : {}), archiveBytes, archiveSha256: archiveHash.digest("hex") };
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
