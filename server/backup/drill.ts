import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { mkdir, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { StorageConfig } from "../config";
import { verifyMigrations } from "../migrations";
import { litestreamRestore } from "../litestream";
import { ArchiveError, DATABASE_NAME, integrityCheck, isEmptyDirectory, readArchive, tableCounts, type ManifestSummary } from "./archive";
import { sweepWorkDirs } from "./job";
import type { BackupSettings, LitestreamSettings } from "./settings";
import { acquireLock, ensureBackupDir, recordDrill, type DrillCheck, type DrillReport, type Trigger } from "./state";
import { createLocalStore, createS3Store, newestFirst, s3Client, s3ErrorText, type ArchiveStore, type StoredArchive } from "./stores";

/**
 * The restore drill and the real restore (D617).
 *
 * The drill restores a backup into a scratch folder under BACKUP_DIR and checks it the way a restore
 * would be checked: the archive against its manifest, `PRAGMA integrity_check`, the migration runner in
 * read-only verify mode (no id this build does not know; ids it would still apply are reported), the
 * main tables' row counts, and (local storage) that every document, profile picture, and published
 * note version the database names is in the archive. With S3 storage the objects are not in the
 * archive (D612): when the bucket is reachable the drill lists it, read only, and reports objects the
 * database names that are not there. The scratch copy is removed afterwards; nothing is ever started on it.
 */

export type DrillSource = { kind: "archive"; name: string | null; path: string | null } | { kind: "litestream"; timestamp: string | null };

/** `latest`, an archive name, a path to an archive file, `litestream`, or `litestream@<RFC 3339 time>`. */
export function parseSource(from: string): DrillSource {
  const value = from.trim();
  if (value === "latest" || value === "") return { kind: "archive", name: null, path: null };
  if (value === "litestream") return { kind: "litestream", timestamp: null };
  if (value.startsWith("litestream@")) {
    const timestamp = value.slice("litestream@".length);
    if (!Number.isFinite(Date.parse(timestamp)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(timestamp)) throw new Error("litestream@<time> needs an RFC 3339 time, such as litestream@2026-10-22T09:30:00Z");
    return { kind: "litestream", timestamp: new Date(timestamp).toISOString().replace(/\.000Z$/, "Z") };
  }
  if (value.includes("/") || isAbsolute(value)) return { kind: "archive", name: null, path: resolve(value) };
  return { kind: "archive", name: value, path: null };
}

export type DrillOptions = {
  from: string;
  settings: BackupSettings;
  litestream: LitestreamSettings;
  /** The live database path (Litestream knows its replica by it). */
  databasePath: string;
  storage: StorageConfig;
  trigger: Trigger;
  /** Ids this build would still apply fail the drill too. */
  strict?: boolean;
  /** Keep the scratch copy (its path is in the report). */
  keepScratch?: boolean;
  /** D689: look for the archive in this folder only. */
  fromDir?: string | null;
  stores?: ArchiveStore[];
  litestreamBin?: string | null;
  log?: (line: string) => void;
};

/**
 * D689: `--from-dir <folder>`: archives are looked up in that folder only (online and offline names;
 * no bucket), for a fresh container whose BACKUP_DIR is the empty folder being restored. The folder
 * must exist and be a directory; it is only read.
 */
export function folderStores(dir: string): ArchiveStore[] {
  const folder = resolve(dir);
  let info;
  try { info = statSync(folder); } catch { throw new Error(`--from-dir ${folder} does not exist (mount the backup folder into the container, such as -v /srv/mynotes/backup:/backups:ro)`); }
  if (!info.isDirectory()) throw new Error(`--from-dir ${folder} is not a folder`);
  return [createLocalStore(folder)];
}

/** Every store an archive may be read from: the local folder (with offline archives) and the bucket, when configured. */
export function readableStores(settings: BackupSettings): ArchiveStore[] {
  const stores: ArchiveStore[] = [createLocalStore(settings.localDir)];
  if (settings.s3) stores.push(createS3Store(settings.s3));
  return stores;
}

type Located = { store: ArchiveStore; archive: StoredArchive };

/** The archive `name` (or the newest, for null) across the stores; local first when both hold it. */
export async function locateArchive(stores: ArchiveStore[], name: string | null): Promise<Located> {
  const found: Located[] = [];
  const errors: string[] = [];
  for (const store of stores) {
    try {
      for (const archive of await store.list({ legacy: true })) if (name === null || archive.name === name) found.push({ store, archive });
    } catch (error) {
      errors.push(`${store.kind}: ${store.kind === "s3" ? s3ErrorText(error) : error instanceof Error ? error.message : "unreadable"}`);
    }
  }
  // Newest first; the same archive in both places is read from the local folder (no download).
  found.sort((a, b) => a.archive.name === b.archive.name ? (a.store.kind === "local" ? -1 : 1) : newestFirst(a.archive, b.archive));
  if (!found.length) throw new Error(name ? `No archive named ${name}${errors.length ? ` (${errors.join("; ")})` : ""}` : `No backup archive found${errors.length ? ` (${errors.join("; ")})` : ""}`);
  return found[0]!;
}

/** Copies the archive somewhere readable: a local store's file is read in place (in its own folder); an S3 one is downloaded into `scratch`. */
async function archiveFile(located: Located, scratch: string) {
  if (located.store.kind === "local") return join(located.store.location, located.archive.name);
  const path = join(scratch, located.archive.name);
  await located.store.fetch(located.archive.name, path);
  return path;
}

const check = (checks: DrillCheck[], name: string, ok: boolean, detail: string, warning = false) => {
  checks.push({ name, ok, detail, ...(warning ? { warning: true } : {}) });
  return ok;
};

/** Files the database names that the restored folder lacks (local storage only). */
function missingLocalFiles(db: Database, dataDir: string) {
  const missing: string[] = [];
  let checked = 0;
  const has = (path: string, size?: number) => {
    checked += 1;
    try {
      const info = statSync(join(dataDir, path));
      if (!info.isFile() || (size !== undefined && info.size !== size)) missing.push(path);
    } catch {
      missing.push(path);
    }
  };
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  if (tables.has("documents")) {
    const whiteboards = tables.has("whiteboards");
    const rows = db.query(`SELECT ${whiteboards ? "COALESCE(w.object_id, d.id)" : "d.id"} AS object_id, d.size_bytes AS size FROM documents d
      ${whiteboards ? "LEFT JOIN whiteboards w ON w.document_id = d.id" : ""} WHERE d.purge_started_at IS NULL`).all() as Array<{ object_id: string; size: number }>;
    for (const row of rows) has(`documents/objects/${row.object_id}`, row.size);
    if (tables.has("whiteboard_snapshots")) {
      for (const row of db.query("SELECT s.object_id AS object_id, s.size_bytes AS size FROM whiteboard_snapshots s JOIN documents d ON d.id = s.document_id WHERE d.purge_started_at IS NULL").all() as Array<{ object_id: string; size: number }>) {
        has(`documents/objects/${row.object_id}`, row.size);
      }
    }
  }
  const userColumns = new Set((db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((row) => row.name));
  if (userColumns.has("avatar_id")) {
    // An uploaded picture's id is a version-8 UUID (server/avatars.ts); Google's are fetched again, and the removed marker is no file.
    for (const row of db.query("SELECT avatar_id AS id FROM users WHERE avatar_id IS NOT NULL AND avatar_id <> '00000000-0000-8000-8000-000000000000'").all() as Array<{ id: string }>) {
      if (row.id[14] === "8") has(`avatars/${row.id}`);
    }
  }
  if (tables.has("notes")) {
    const purge = (db.query("PRAGMA table_info(notes)").all() as Array<{ name: string }>).some((row) => row.name === "purge_started_at");
    for (const row of db.query(`SELECT id, current_version AS version FROM notes WHERE current_version > 0${purge ? " AND purge_started_at IS NULL" : ""}`).all() as Array<{ id: string; version: number }>) {
      has(`notes/${row.id}/versions/${String(row.version).padStart(6, "0")}.md`);
    }
  }
  return { missing, checked };
}

/** Object ids the database names that the bucket lacks (S3 storage; read only: one LIST per 1,000 objects). */
async function missingBucketObjects(db: Database, storage: Extract<StorageConfig, { backend: "s3" }>) {
  const client = s3Client(storage);
  const sizes = new Map<string, number>();
  let continuationToken: string | undefined;
  const prefix = `${storage.prefix}documents/`;
  do {
    const page = await client.list({ prefix, ...(continuationToken ? { continuationToken } : {}) });
    for (const entry of page.contents ?? []) sizes.set(entry.key.slice(prefix.length), entry.size ?? 0);
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken);
  const rows = db.query(`SELECT COALESCE(w.object_id, d.id) AS object_id, d.size_bytes AS size FROM documents d LEFT JOIN whiteboards w ON w.document_id = d.id WHERE d.purge_started_at IS NULL`).all() as Array<{ object_id: string; size: number }>;
  return { missing: rows.filter((row) => sizes.get(row.object_id) !== row.size).length, checked: rows.length };
}

/**
 * Checks a restored data folder (shared by the drill and `restore`): integrity, schema, counts, and
 * the files the database names. Appends to `checks`; returns the counts.
 */
export async function checkRestored(dataDir: string, options: { manifest: ManifestSummary | null; storage: StorageConfig; databaseOnly: boolean; strict?: boolean }, checks: DrillCheck[]) {
  const path = join(dataDir, DATABASE_NAME);
  if (!check(checks, "Database present", existsSync(path), existsSync(path) ? `${statSync(path).size} bytes` : "mynotes.sqlite is missing")) return {};
  // Read-write on the scratch copy only: a legacy archive's -wal needs a writable connection to be read.
  const db = new Database(path, { readwrite: true });
  try {
    const integrity = integrityCheck(db);
    if (!check(checks, "Integrity check", integrity === "ok", integrity === "ok" ? "PRAGMA integrity_check: ok" : integrity)) return {};
    const schema = verifyMigrations(db);
    if (schema.unknown.length) {
      check(checks, "Schema", false, `The database has migration(s) ${schema.unknown.join(", ")} that this Nook does not know: it is from a newer version`);
    } else if (schema.missing.length) {
      check(checks, "Schema", !options.strict, `${schema.applied.length} migrations applied; this Nook would apply ${schema.missing.length} more on its first start (${schema.missing.slice(0, 5).join(", ")}${schema.missing.length > 5 ? ", …" : ""})`, !options.strict);
    } else {
      check(checks, "Schema", true, `All ${schema.applied.length} migrations of this Nook applied (latest ${schema.applied.at(-1) ?? "none"})`);
    }
    const counts = tableCounts(db);
    // A database without accounts is a fresh install's: reported, not a failure.
    const empty = (counts.users ?? 0) === 0;
    check(checks, "Row counts", true, `${Object.entries(counts).map(([table, n]) => `${table} ${n}`).join(", ") || "no tables"}${empty ? " (no accounts yet)" : ""}`, empty);
    if (options.manifest?.counts) {
      const differ = Object.entries(options.manifest.counts).filter(([table, n]) => counts[table] !== n);
      check(checks, "Counts match the manifest", differ.length === 0, differ.length ? differ.map(([table, n]) => `${table}: ${counts[table]} restored, ${n} recorded`).join("; ") : "Every counted table matches");
    }
    if (options.databaseOnly) {
      check(checks, "Files", true, "Database only (Litestream): note Markdown and files come from an archive", true);
    } else if ((options.manifest?.storage.backend ?? options.storage.backend) === "local" || options.manifest?.objects?.mode === "copy") {
      // Local storage, or (D687) an S3 archive that copied the bucket's objects in: every file is in the archive.
      const { missing, checked } = missingLocalFiles(db, dataDir);
      const skipped = options.manifest?.skipped ?? [];
      const vanished = new Set(skipped.filter((entry) => entry.reason === "vanished").map((entry) => entry.path));
      const notInBucket = new Set(skipped.filter((entry) => entry.reason === "missing").map((entry) => entry.path));
      const unexplained = missing.filter((entry) => !vanished.has(entry) && !notInBucket.has(entry));
      const lost = missing.filter((entry) => notInBucket.has(entry)).length;
      const purged = missing.length - unexplained.length - lost;
      check(checks, "Files the database names", unexplained.length === 0,
        unexplained.length ? `${unexplained.length} of ${checked} missing or the wrong size, such as ${unexplained.slice(0, 3).join(", ")}` : `All ${checked} present${purged ? ` (${purged} purged while the backup ran)` : ""}${lost ? `; ${lost} were not in the bucket when the backup ran` : ""}`, lost > 0);
      const copied = options.manifest?.objects;
      if (copied?.mode === "copy") {
        check(checks, "Objects copied from the bucket", true, `${copied.count} object(s), ${copied.bytes} bytes, in the archive and checked against the manifest (SHA-256)${copied.mismatched ? `; ${copied.mismatched} differed from the database's SHA-256 when copied` : ""}${copied.missing ? `; ${copied.missing} named but not in the bucket` : ""}`, copied.mismatched > 0 || copied.missing > 0);
      }
    } else if (options.storage.backend === "s3" && (!options.manifest || options.manifest.storage.backend !== "s3" || (options.manifest.storage.bucket === options.storage.bucket && options.manifest.storage.prefix === options.storage.prefix))) {
      try {
        const { missing, checked } = await missingBucketObjects(db, options.storage);
        check(checks, "Objects in the bucket", true, missing ? `${missing} of ${checked} documents the backup names are not in the bucket now (purged since, or lost)` : `All ${checked} documents the backup names are in the bucket`, missing > 0);
      } catch (error) {
        check(checks, "Objects in the bucket", true, `The bucket could not be listed (${s3ErrorText(error)}); objects not checked`, true);
      }
    } else {
      check(checks, "Objects in the bucket", true, "The backup's files are in an S3 bucket this server is not configured for; not checked", true);
    }
    return counts;
  } finally {
    db.close();
  }
}

const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 400) : "Unknown error";
const filesWord = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

/** Runs one drill. Returns null when a backup or another drill holds the lock. */
export async function runDrill(options: DrillOptions): Promise<DrillReport | null> {
  const dir = options.settings.localDir;
  const log = options.log ?? (() => undefined);
  ensureBackupDir(dir);
  const lock = acquireLock(dir, { op: "drill", trigger: options.trigger });
  if (!lock) return null;
  const started = new Date();
  const id = crypto.randomUUID();
  const scratch = join(dir, `.drill-${id}`);
  const data = join(scratch, "data");
  const checks: DrillCheck[] = [];
  let counts: Record<string, number> = {};
  let source = options.from;
  let error: string | undefined;
  try {
    sweepWorkDirs(dir);
    await mkdir(data, { recursive: true, mode: 0o700 });
    const parsed = parseSource(options.from);
    let manifest: ManifestSummary | null = null;
    if (parsed.kind === "litestream") {
      source = `litestream${parsed.timestamp ? ` as of ${parsed.timestamp}` : " (latest)"}`;
      if (!options.litestream.s3) throw new Error("Litestream is not configured (LITESTREAM_ENABLED=true and an S3 bucket)");
      log(`Restoring ${source}`);
      await litestreamRestore(options.litestream, { databasePath: options.databasePath, outPath: join(data, DATABASE_NAME), timestamp: parsed.timestamp ?? undefined, bin: options.litestreamBin });
      check(checks, "Litestream restore", true, `Restored from ${options.litestream.s3.bucket}/${options.litestream.s3.path}`);
    } else {
      let path: string;
      if (parsed.path) {
        path = parsed.path;
        source = `file ${path}`;
      } else {
        const located = await locateArchive(options.stores ?? (options.fromDir ? folderStores(options.fromDir) : readableStores(options.settings)), parsed.name);
        source = `archive ${located.archive.name} (${located.store.kind})`;
        log(`Reading ${source}`);
        path = await archiveFile(located, scratch);
      }
      const read = await readArchive(path, { extractTo: data, legacy: true, scratchDir: scratch });
      manifest = read.manifest;
      check(checks, "Archive", true, read.manifest
        ? `${filesWord(read.fileCount)} checked against the manifest (SHA-256); made ${read.manifest.createdAt} by Nook ${read.manifest.appVersion}`
        : `${filesWord(read.fileCount)}; an offline archive without a manifest (sizes and hashes not recorded)`, !read.manifest);
    }
    counts = await checkRestored(data, { manifest, storage: options.storage, databaseOnly: parsed.kind === "litestream", strict: options.strict }, checks);
  } catch (failure) {
    error = failure instanceof ArchiveError ? failure.message : errorText(failure);
    check(checks, "Restore", false, error);
  } finally {
    if (!options.keepScratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  const finished = new Date();
  const ok = !error && checks.every((entry) => entry.ok);
  const report: DrillReport = {
    id, trigger: options.trigger, startedAt: started.toISOString(), finishedAt: finished.toISOString(), ok, ms: finished.getTime() - started.getTime(),
    source: options.keepScratch ? `${source}; scratch copy kept in ${data}` : source, checks, counts, ...(error ? { error } : {})
  };
  try {
    recordDrill(dir, report);
  } finally {
    lock.release();
  }
  return report;
}

export type RestoreOptions = {
  from: string;
  /** An empty or new folder: the data directory to start the restored Nook on. */
  to: string;
  /** For a Litestream restore: the archive the files come from (latest, a name, or a path). */
  filesFrom?: string | null;
  /** For a Litestream restore: the database alone, without files. */
  databaseOnly?: boolean;
  /** D689: look for archives (`--from` and `--files-from`) in this folder only, not BACKUP_DIR or the bucket. */
  fromDir?: string | null;
  settings: BackupSettings;
  litestream: LitestreamSettings;
  databasePath: string;
  storage: StorageConfig;
  stores?: ArchiveStore[];
  litestreamBin?: string | null;
  log?: (line: string) => void;
};

/**
 * A real restore (D617) into an empty folder, never over a used one. An archive is extracted (and
 * checked against its manifest as it is read); a Litestream restore extracts the files of `filesFrom`,
 * then replaces the database with the replica's (as of the time asked for). The result is checked like
 * a drill, and the checks are returned; the folder is left in place either way.
 */
export async function restoreInto(options: RestoreOptions) {
  const target = resolve(options.to);
  if (!await isEmptyDirectory(target)) throw new Error(`${target} is not empty; restore only into an empty or new folder (move the old data directory aside first)`);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const log = options.log ?? (() => undefined);
  const checks: DrillCheck[] = [];
  const parsed = parseSource(options.from);
  const stores = options.stores ?? (options.fromDir ? folderStores(options.fromDir) : readableStores(options.settings));
  let manifest: ManifestSummary | null = null;

  /** Extracts an archive (by source) into the target; a download is staged in the target and removed after. */
  async function extract(from: string) {
    const source = parseSource(from);
    if (source.kind !== "archive") throw new Error("--files-from must name an archive (latest, a name, or a path)");
    let path = source.path;
    let download: string | null = null;
    if (!path) {
      const located = await locateArchive(stores, source.name);
      log(`Using archive ${located.archive.name} (${located.store.kind})`);
      if (located.store.kind === "local") path = join(located.store.location, located.archive.name);
      else {
        download = join(target, `.restore-download-${crypto.randomUUID().slice(0, 8)}.tar.gz`);
        await located.store.fetch(located.archive.name, download);
        path = download;
      }
    }
    try {
      const read = await readArchive(path, { extractTo: target, legacy: true });
      check(checks, "Archive", true, read.manifest ? `${filesWord(read.fileCount)} checked against the manifest; made ${read.manifest.createdAt}` : `${filesWord(read.fileCount)} (offline archive, no manifest)`, !read.manifest);
      return read.manifest;
    } finally {
      if (download) await unlink(download).catch(() => undefined);
    }
  }

  if (parsed.kind === "archive") {
    manifest = await extract(options.from);
  } else {
    if (!options.litestream.s3) throw new Error("Litestream is not configured (LITESTREAM_ENABLED=true and an S3 bucket)");
    if (!options.databaseOnly && !options.filesFrom) throw new Error("A Litestream restore holds only the database: add --files-from latest (or an archive) for note Markdown and files, or --db-only");
    if (options.filesFrom) {
      manifest = await extract(options.filesFrom);
      for (const suffix of ["", "-wal", "-shm"]) await rm(join(target, `${DATABASE_NAME}${suffix}`), { force: true });
    }
    log(`Restoring the database from Litestream${parsed.timestamp ? ` as of ${parsed.timestamp}` : ""}`);
    await litestreamRestore(options.litestream, { databasePath: options.databasePath, outPath: join(target, DATABASE_NAME), timestamp: parsed.timestamp ?? undefined, bin: options.litestreamBin });
    // Fold anything Litestream's check left in a WAL into the file, so the folder holds one database file.
    const restored = new Database(join(target, DATABASE_NAME), { readwrite: true });
    try { restored.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { restored.close(); }
    check(checks, "Litestream restore", true, `Database restored${parsed.timestamp ? ` as of ${parsed.timestamp}` : ""}`);
  }
  const counts = await checkRestored(target, { manifest: parsed.kind === "litestream" ? null : manifest, storage: options.storage, databaseOnly: parsed.kind === "litestream" && !options.filesFrom }, checks);
  // Litestream-ahead-of-archive: files of notes published after the archive are reported, not fatal.
  if (parsed.kind === "litestream" && options.filesFrom) {
    for (const entry of checks) if (entry.name === "Files the database names" && !entry.ok) { entry.ok = true; entry.warning = true; entry.detail += " (changed after the archive the files came from)"; }
  }
  return { target, checks, counts, ok: checks.every((entry) => entry.ok), manifest };
}
