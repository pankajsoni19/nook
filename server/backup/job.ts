import { readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { StorageConfig } from "../config";
import { archiveName, collectDataFiles, dataFilesFrom, readArchive, snapshotDatabase, writeArchive, type Manifest } from "./archive";
import type { BackupSettings } from "./settings";
import { acquireLock, ensureBackupDir, recordRun, type BackupRun, type TargetResult, type Trigger } from "./state";
import { createLocalStore, createS3Store, pruneArchives, s3ErrorText, type ArchiveStore } from "./stores";

/**
 * One online backup (D611–D614): snapshot, pack, verify, copy to each target, prune each target, record.
 * Runs in a low-priority child process (`bun server/backup-admin.ts backup`, started by the server or
 * by hand), never in the server's own event loop. It opens the live database read-only and never runs
 * a migration.
 */

export type JobOptions = {
  dataDir: string;
  databasePath: string;
  settings: BackupSettings;
  /** MIN_FREE_DISK_BYTES: the run refuses to start when it would leave less free on the backup folder's disk. */
  minFreeBytes: number;
  storage: StorageConfig;
  appVersion: string;
  gitSha: string;
  trigger: Trigger;
  /** Tests: other stores than the settings name. */
  stores?: ArchiveStore[];
  now?: () => Date;
  log?: (line: string) => void;
};

export function storesFor(settings: BackupSettings): ArchiveStore[] {
  const stores: ArchiveStore[] = [];
  // S3 first, then the local folder: the local copy is a rename of the verified file in the work folder.
  if (settings.target !== "local" && settings.s3) stores.push(createS3Store(settings.s3));
  if (settings.target !== "s3") stores.push(createLocalStore(settings.localDir));
  return stores;
}

const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 400) : "Unknown error";

/** Free bytes for an unprivileged writer on the disk holding `path`. */
export async function freeBytes(path: string) {
  const info = await statfs(path);
  return info.bavail * info.bsize;
}

/** Removes work and drill folders left by jobs that died (only called while holding the lock). */
export function sweepWorkDirs(dir: string, keep: string | null = null) {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!/^\.(work|drill|restore)-[0-9a-f-]{8,36}$/.test(name) || name === keep) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

/** Runs one backup. Returns null when another backup or drill holds the lock. */
export async function runBackup(options: JobOptions): Promise<BackupRun | null> {
  const { settings } = options;
  const dir = settings.localDir;
  const log = options.log ?? (() => undefined);
  ensureBackupDir(dir);
  const lock = acquireLock(dir, { op: "backup", trigger: options.trigger });
  if (!lock) return null;
  const now = options.now ?? (() => new Date());
  const started = now();
  const id = crypto.randomUUID();
  const work = join(dir, `.work-${id}`);
  const warnings: string[] = [];
  let archive: BackupRun["archive"];
  let targets: TargetResult[] = [];
  let error: string | undefined;
  try {
    sweepWorkDirs(dir);
    await mkdir(work, { mode: 0o700 });
    // D688: the list of DATA_DIR's files goes to a side file in the work folder, never to memory.
    const listPath = join(work, "data-files.ndjson");
    const { skipped, bytes, count, root } = await collectDataFiles(options.dataDir, [dir], { listPath });
    let databaseBytes = 0;
    for (const suffix of ["", "-wal"]) {
      try { databaseBytes += statSync(`${options.databasePath}${suffix}`).size; } catch { /* no WAL */ }
    }
    // The snapshot and the archive both sit in the work folder until the archive is verified; at worst
    // (nothing compresses) that is the database plus every file twice over the database.
    const needed = databaseBytes * 2 + bytes;
    const free = await freeBytes(dir);
    if (free - needed < options.minFreeBytes) {
      throw new Error(`Not enough free disk for a backup: it needs about ${needed} bytes and must leave MIN_FREE_DISK_BYTES (${options.minFreeBytes}) free; ${free} are free`);
    }
    const snapshotPath = join(work, "mynotes.sqlite");
    log(`Snapshotting the database (${databaseBytes} bytes with its WAL)`);
    const snapshot = snapshotDatabase(options.databasePath, snapshotPath);
    const name = archiveName(started);
    const archivePath = join(work, name);
    const storage: Manifest["storage"] = options.storage.backend === "s3"
      ? { backend: "s3", bucket: options.storage.bucket, prefix: options.storage.prefix, endpointHost: new URL(options.storage.endpoint).host }
      : { backend: "local" };
    log(`Packing ${count} files`);
    const written = await writeArchive(archivePath, {
      manifest: {
        format: "nook-backup", version: 1, createdAt: started.toISOString(), appVersion: options.appVersion, gitSha: options.gitSha, storage,
        database: { path: "mynotes.sqlite", integrity: "ok", migrations: snapshot.migrations }, counts: snapshot.counts
      },
      database: snapshotPath,
      files: dataFilesFrom(listPath, root),
      skipped
    });
    await rm(snapshotPath, { force: true });
    // Read the whole archive back before it goes anywhere: gzip, tar, and every file's SHA-256.
    const verified = await readArchive(archivePath, { scratchDir: work });
    if (verified.archiveSha256 !== written.sha256) throw new Error("The archive changed between writing and reading it back");
    const vanished = written.manifest.skipped.filter((entry) => entry.reason === "vanished").length;
    const links = written.manifest.skipped.length - vanished;
    if (vanished) warnings.push(`${vanished} file(s) were removed while the backup ran (purged from the Bin) and are not in it`);
    if (links) warnings.push(`${links} link(s) or special file(s) under DATA_DIR were left out`);
    archive = { name, size: written.size, sha256: written.sha256, files: written.manifest.fileCount, databaseBytes: written.manifest.database.bytes, storage: storage.backend };

    const stores = options.stores ?? storesFor(settings);
    targets = [];
    for (const store of stores) {
      const result: TargetResult = { kind: store.kind, location: store.location, ok: false };
      targets.push(result);
      try {
        log(`Copying ${name} to ${store.kind}`);
        await store.put(archivePath, name);
        result.ok = true;
      } catch (failure) {
        // S3 failures name the service's code only (never a URL or key); Nook's own refusals say what to fix.
        const own = failure instanceof Error && /BACKUP_S3_SSE|came back with/.test(failure.message);
        result.error = store.kind === "s3" && !own ? s3ErrorText(failure) : errorText(failure);
        continue;
      }
      try {
        const removed = await pruneArchives(store, settings.keep, name);
        result.pruned = removed.length;
      } catch (failure) {
        warnings.push(`Old archives in ${store.kind} could not be pruned: ${store.kind === "s3" ? s3ErrorText(failure) : errorText(failure)}`);
      }
    }
    const failed = targets.filter((target) => !target.ok);
    if (failed.length) error = failed.map((target) => `${target.kind}: ${target.error}`).join("; ");
  } catch (failure) {
    error = errorText(failure);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
  const finished = now();
  const run: BackupRun = {
    id, trigger: options.trigger, startedAt: started.toISOString(), finishedAt: finished.toISOString(), ok: !error, ms: finished.getTime() - started.getTime(),
    ...(error ? { error } : {}), ...(archive ? { archive } : {}), ...(targets.length ? { targets } : {}), ...(warnings.length ? { warnings } : {})
  };
  try {
    recordRun(dir, run);
  } finally {
    lock.release();
  }
  return run;
}
