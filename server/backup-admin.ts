import { config } from "./config";
import { formatDuration } from "./backup/settings";
import { runBackup } from "./backup/job";
import { readableStores, restoreInto, runDrill } from "./backup/drill";
import { currentLock, readDrill, readStatus, type DrillCheck, type DrillReport, type Trigger } from "./backup/state";
import { s3ErrorText } from "./backup/stores";
import { logger } from "./log";

/**
 * Host CLI for online backups, the restore drill, and restores (lane BACKUP, D611–D619). Run it with
 * the server's environment (inside the container: `docker compose exec app bun server/backup-admin.ts …`,
 * or `docker compose run --rm app …` while the server is stopped). It opens the live database read-only
 * and never runs a migration; it prints names, sizes, counts, and checks, never credentials.
 *
 *   backup                         one online backup now (the server keeps running), to BACKUP_TARGET
 *   list                           the archives in each target, newest first
 *   status                         the last runs and the last drill
 *   restore-drill [--from latest|<archive name>|<path>|litestream[@<RFC 3339 time>]] [--strict] [--keep]
 *                                  restores into a scratch folder under BACKUP_DIR, checks it, removes it
 *   restore --from <same> --to <empty folder> [--files-from latest|<archive>|<path>] [--db-only]
 *                                  a real restore into an empty folder (refuses a used one)
 *
 * Exit codes: 0 done (or the drill passed), 1 failed, 2 usage or settings, 75 another backup or drill is running.
 */

const usage = "Usage: bun server/backup-admin.ts backup | list | status | restore-drill [--from latest|<archive>|<path>|litestream[@<time>]] [--strict] [--keep] | restore --from <source> --to <empty folder> [--files-from <archive>] [--db-only]";
const BUSY = 75;
const log = logger("backup");
const args = process.argv.slice(2);
const command = args[0];

function option(name: string) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`--${name} needs a value. ${usage}`, 2);
  return value;
}
const flag = (name: string) => args.includes(`--${name}`);

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

const trigger = (): Trigger => {
  const value = option("trigger") ?? "cli";
  if (value !== "cli" && value !== "schedule" && value !== "manual") fail(`--trigger must be cli, schedule, or manual. ${usage}`, 2);
  return value;
};

const mib = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 2 : 1)} MiB`;

function printChecks(checks: DrillCheck[]) {
  for (const entry of checks) console.log(`  ${entry.ok ? (entry.warning ? "warn" : " ok ") : "FAIL"}  ${entry.name}: ${entry.detail}`);
}

function printDrill(report: DrillReport) {
  console.log(`Restore drill ${report.ok ? "passed" : "FAILED"} in ${(report.ms / 1000).toFixed(1)} s: ${report.source}`);
  printChecks(report.checks);
}

const settings = config.backup;
const common = { settings, litestream: config.litestream, databasePath: config.databasePath, storage: config.storage };

switch (command) {
  case "backup": {
    const run = await runBackup({
      dataDir: config.dataDir, databasePath: config.databasePath, settings, minFreeBytes: config.minFreeDiskBytes, storage: config.storage,
      appVersion: config.appVersion, gitSha: config.gitSha, trigger: trigger(),
      log: (line) => log.info(line)
    });
    // (D687: runBackup puts its progress in the lock itself.)
    if (!run) {
      const lock = currentLock(settings.localDir);
      fail(`Another backup or restore drill is running${lock ? ` (${lock.op}, started ${lock.startedAt})` : ""}; try again when it has finished.`, BUSY);
    }
    if (run.ok) {
      log.info("Backup finished", { archive: run.archive?.name, bytes: run.archive?.size, files: run.archive?.files, ms: run.ms, targets: run.targets?.map((target) => target.kind).join(",") });
      console.log(`Backup created: ${run.archive?.name} (${mib(run.archive?.size ?? 0)}, ${run.archive?.files} file${run.archive?.files === 1 ? "" : "s"}) in ${run.targets?.map((target) => target.location).join(" and ")}`);
      if (run.archive?.storage === "s3") console.log(run.archive.objects !== undefined
        ? `STORAGE_BACKEND=s3 with BACKUP_S3_OBJECTS=copy: the archive also holds ${run.archive.objects} object(s) from the bucket (${mib(run.archive.objectBytes ?? 0)}).`
        : "STORAGE_BACKEND=s3: the archive holds the database and DATA_DIR; file bytes stay in the bucket (docs/OPERATIONS.md, Backup and restore).");
    } else {
      log.error("Backup failed", { error: run.error, ms: run.ms });
      console.error(`Backup failed: ${run.error}`);
    }
    for (const warning of run.warnings ?? []) console.error(`Warning: ${warning}`);
    process.exit(run.ok ? 0 : 1);
    break;
  }
  case "list": {
    let failed = false;
    for (const store of readableStores(settings)) {
      try {
        const archives = await store.list({ legacy: store.kind === "local" });
        console.log(`${store.kind} ${store.location}: ${archives.length} archive(s)`);
        for (const archive of archives) console.log(`  ${archive.name}  ${mib(archive.size)}  ${new Date(archive.modifiedMs).toISOString()}`);
      } catch (error) {
        failed = true;
        console.error(`${store.kind} ${store.location}: ${store.kind === "s3" ? s3ErrorText(error) : error instanceof Error ? error.message : "unreadable"}`);
      }
    }
    process.exit(failed ? 1 : 0);
    break;
  }
  case "status": {
    const status = readStatus(settings.localDir);
    const drill = readDrill(settings.localDir);
    console.log(`Online backups: ${settings.enabled ? `every ${formatDuration(settings.intervalMs)}, keep ${settings.keep}, to ${settings.target}` : "off (BACKUP_ENABLED=false)"}`);
    console.log(`Last success: ${status.lastSuccess ? `${status.lastSuccess.finishedAt} ${status.lastSuccess.archive?.name}` : "never"}`);
    if (status.lastRun && !status.lastRun.ok) console.log(`Last run failed (${status.consecutiveFailures} in a row): ${status.lastRun.error}`);
    if (drill.last) printDrill(drill.last);
    const lock = currentLock(settings.localDir);
    if (lock) console.log(`Running now: ${lock.op} since ${lock.startedAt}${lock.progress ? `; ${lock.progress}` : ""}`);
    break;
  }
  case "restore-drill": {
    const report = await runDrill({ ...common, from: option("from") ?? "latest", trigger: trigger(), strict: flag("strict"), keepScratch: flag("keep"), log: (line) => log.info(line) });
    if (!report) fail("Another backup or restore drill is running; try again when it has finished.", BUSY);
    printDrill(report);
    if (report.ok) log.info("Restore drill passed", { source: report.source, ms: report.ms });
    else log.error("Restore drill failed", { source: report.source, error: report.error ?? report.checks.find((entry) => !entry.ok)?.detail });
    process.exit(report.ok ? 0 : 1);
    break;
  }
  case "restore": {
    const from = option("from");
    const to = option("to");
    if (!from || !to) fail(usage, 2);
    try {
      const result = await restoreInto({ ...common, from, to, filesFrom: option("files-from"), databaseOnly: flag("db-only"), log: (line) => console.log(line) });
      console.log(`Restore into ${result.target} ${result.ok ? "checked" : "has problems"}:`);
      printChecks(result.checks);
      if (result.ok) {
        console.log("Next: point MYNOTES_DATA_DIR at that folder (or move it into place), keep the same .env keys, and start Nook.");
        if (config.storage.backend === "s3") console.log("S3 storage: a restored data directory is behind the bucket's claim. After a real disaster restore only, run bun server/storage-admin.ts reclaim (docs/OPERATIONS.md, S3 storage).");
      }
      process.exit(result.ok ? 0 : 1);
    } catch (error) {
      fail(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    break;
  }
  default:
    fail(usage, 2);
}
