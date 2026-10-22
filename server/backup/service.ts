import { join } from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { config } from "../config";
import { audit, db } from "../db";
import { logger } from "../log";
import { notifyAccess } from "../access/notices";
import { mailBackupFailed } from "../mail/triggers";
import { litestreamStatus, type LitestreamStatus } from "../litestream";
import { parseJson } from "../validation";
import { archiveTime } from "./archive";
import { readableStores } from "./drill";
import { formatDuration } from "./settings";
import { currentLock, readAlert, readDrill, readStatus, writeAlert, type BackupStatus, type DrillStatus, type Trigger } from "./state";
import { s3ErrorText } from "./stores";
import type { BackupsView } from "../../shared/backups";

/**
 * Online backups inside the server (D614, D618): the schedule, "Back up now" and "Run restore drill",
 * alerts to admins, and Settings → Backups. Every job runs as a child process at low priority
 * (`nice -n 10 bun server/backup-admin.ts …`), so a large VACUUM INTO or gzip never blocks requests, and
 * the job's own lock (BACKUP_DIR/.lock) keeps one backup or drill at a time across the server and the CLI.
 */

const slog = logger("backup");
const TICK_MS = 60_000;
/** A server that has never backed up waits this long after boot (a restart loop does not back up each time). */
export const FIRST_BACKUP_DELAY_MS = 10 * 60_000;
/** After a failed run the next try comes after this, or the interval when that is shorter. */
export const RETRY_AFTER_MS = 3_600_000;
/** While backups keep failing, admins hear again at most once a day. */
const REALERT_MS = 86_400_000;

export type JobKind = "backup" | "drill";
type Runner = (kind: JobKind, trigger: Trigger) => Promise<number>;

/** The real runner: a niced child with the server's own environment; its log lines go to the server's output. */
const spawnRunner: Runner = async (kind, trigger) => {
  const script = join(import.meta.dir, "..", "backup-admin.ts");
  const args = [process.execPath, "--no-env-file", script, kind === "backup" ? "backup" : "restore-drill", "--trigger", trigger];
  const nice = Bun.which("nice");
  const child = Bun.spawn(nice ? [nice, "-n", "10", ...args] : args, { stdin: "ignore", stdout: "inherit", stderr: "inherit", env: process.env });
  return child.exited;
};

let runner: Runner = spawnRunner;
/** Test hook: run jobs in process (null restores the child process). */
export function setBackupRunnerForTests(next: Runner | null) {
  runner = next ?? spawnRunner;
}

let running: { kind: JobKind; trigger: Trigger; startedAt: string; done: Promise<void> } | null = null;
const bootAt = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

/** The job this server started and is waiting for, if any. */
export const runningJob = () => running;

/**
 * Starts a backup or a drill unless one is running here or elsewhere (the lock). Returns false when busy.
 * The returned job's `done` settles when the child exits; alerts are checked then.
 */
export function startJob(kind: JobKind, trigger: Trigger) {
  if (running || currentLock(config.backup.localDir)) return null;
  const startedAt = new Date().toISOString();
  const done = (async () => {
    try {
      const code = await runner(kind, trigger);
      if (code === 75) slog.warn(`The ${kind} did not start: another backup or drill holds the lock`);
    } catch (error) {
      slog.error(`The ${kind} could not be started`, error);
    } finally {
      running = null;
      archiveCache = null;
      try {
        checkAlerts({ drillJustRan: kind === "drill" && trigger === "schedule" });
      } catch (error) {
        slog.error("Backup alert check failed", error);
      }
    }
  })();
  running = { kind, trigger, startedAt, done };
  return running;
}

/** When the next scheduled backup is due (ms), or null when backups are off. */
export function nextBackupAt(status: BackupStatus = readStatus(config.backup.localDir)) {
  const settings = config.backup;
  if (!settings.enabled) return null;
  const last = status.lastRun;
  if (!last) return bootAt + FIRST_BACKUP_DELAY_MS;
  const finished = Date.parse(last.finishedAt);
  return finished + (last.ok ? settings.intervalMs : Math.min(settings.intervalMs, RETRY_AFTER_MS));
}

/** When the next scheduled drill is due (ms), or null (no BACKUP_DRILL_INTERVAL, or no backup to drill yet). */
export function nextDrillAt(drill: DrillStatus = readDrill(config.backup.localDir), status: BackupStatus = readStatus(config.backup.localDir)) {
  const interval = config.backup.drillIntervalMs;
  if (!interval || !status.lastSuccess) return null;
  const last = drill.last;
  // The first drill comes half an hour after the first backup it can read.
  return last ? Date.parse(last.finishedAt) + interval : Date.parse(status.lastSuccess.finishedAt) + 30 * 60_000;
}

const activeAdmins = () => (db.query("SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL AND kind = 'person'").all() as Array<{ id: string }>).map((row) => row.id);

/**
 * Tells admins (bell, and mail when it is on) once backups have failed BACKUP_ALERT_AFTER times in a
 * row, again a day later if they are still failing, and whenever a scheduled drill failed. Runs after
 * each job and on every tick (a CLI run's failures count too). The marker is BACKUP_DIR/alert.json.
 */
export function checkAlerts(options: { drillJustRan?: boolean; nowMs?: number } = {}) {
  const dir = config.backup.localDir;
  const nowMs = options.nowMs ?? Date.now();
  const status = readStatus(dir);
  const alert = readAlert(dir);
  const admins = activeAdmins();
  if (options.drillJustRan) {
    const drill = readDrill(dir).last;
    if (drill && !drill.ok) {
      const error = drill.error ?? drill.checks.find((entry) => !entry.ok)?.detail ?? "A check failed";
      for (const userId of admins) {
        notifyAccess({ userId, kind: "backup_drill_failed", actorId: null });
        mailBackupFailed(userId, { kind: "drill", failures: 1, error: `${drill.checks.find((entry) => !entry.ok)?.name ?? "Restore"}: ${error}`, lastSuccessAt: status.lastSuccess?.finishedAt ?? null });
      }
      slog.error("Restore drill failed; admins notified", { admins: admins.length });
    }
  }
  if (status.consecutiveFailures < config.backup.alertAfter) {
    if (alert.alertedAt) writeAlert(dir, { alertedAt: null, failures: 0 });
    return false;
  }
  const due = !alert.alertedAt || (nowMs - Date.parse(alert.alertedAt) >= REALERT_MS && status.consecutiveFailures > alert.failures);
  if (!due) return false;
  for (const userId of admins) {
    notifyAccess({ userId, kind: "backup_failed", actorId: null, count: status.consecutiveFailures });
    mailBackupFailed(userId, { kind: "backup", failures: status.consecutiveFailures, error: status.lastRun?.error ?? "Unknown error", lastSuccessAt: status.lastSuccess?.finishedAt ?? null });
  }
  writeAlert(dir, { alertedAt: new Date(nowMs).toISOString(), failures: status.consecutiveFailures });
  slog.error(`Backups failed ${status.consecutiveFailures} times in a row; admins notified`, { admins: admins.length });
  return true;
}

/** One scheduler tick: a due backup, else a due drill; then alerts. */
export function backupTick(nowMs = Date.now()) {
  if (running) return null;
  const status = readStatus(config.backup.localDir);
  const backupDue = nextBackupAt(status);
  if (backupDue !== null && nowMs >= backupDue) return startJob("backup", "schedule");
  const drillDue = nextDrillAt(readDrill(config.backup.localDir), status);
  if (drillDue !== null && nowMs >= drillDue) return startJob("drill", "schedule");
  checkAlerts({ nowMs });
  return null;
}

/** Starts the minute tick (boot). Nothing runs at boot itself. */
export function startBackupScheduler() {
  if (timer) return;
  const settings = config.backup;
  if (settings.enabled) slog.info(`Online backups every ${formatDuration(settings.intervalMs)}, keeping ${settings.keep}, to ${settings.target}${settings.drillIntervalMs ? `; restore drill every ${formatDuration(settings.drillIntervalMs)}` : ""}`);
  else slog.info("Online backups are off (BACKUP_ENABLED=false); Back up now and the CLI still work");
  timer = setInterval(() => {
    try {
      backupTick();
    } catch (error) {
      slog.error("Backup scheduler tick failed", error);
    }
  }, TICK_MS);
  timer.unref();
}

/** Whether a backup is reading DATA_DIR right now (the sweeper leaves files and the Bin alone meanwhile). */
export const backupInProgress = () => currentLock(config.backup.localDir)?.op === "backup";

let archiveCache: { at: number; value: Pick<BackupsView, "archives" | "archivesError"> } | null = null;
let litestreamCache: { at: number; value: LitestreamStatus } | null = null;
const CACHE_MS = 30_000;

async function archiveList(): Promise<Pick<BackupsView, "archives" | "archivesError">> {
  if (archiveCache && Date.now() - archiveCache.at < CACHE_MS) return archiveCache.value;
  const byName = new Map<string, BackupsView["archives"][number]>();
  const errors: string[] = [];
  for (const store of readableStores(config.backup)) {
    try {
      for (const archive of await store.list({ legacy: store.kind === "local" })) {
        const entry = byName.get(archive.name) ?? { name: archive.name, size: archive.size, createdAt: new Date(archiveTime(archive.name) ?? archive.modifiedMs).toISOString(), locations: [], offline: !archive.name.startsWith("nook-backup-") };
        entry.locations.push(store.kind);
        byName.set(archive.name, entry);
      }
    } catch (error) {
      errors.push(store.kind === "s3" ? `The bucket could not be listed (${s3ErrorText(error)})` : "The backup folder could not be read");
    }
  }
  const value = { archives: [...byName.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200), archivesError: errors.join("; ") || null };
  archiveCache = { at: Date.now(), value };
  return value;
}

async function cachedLitestream() {
  if (litestreamCache && Date.now() - litestreamCache.at < CACHE_MS) return litestreamCache.value;
  const value = await litestreamStatus(config.litestream);
  litestreamCache = { at: Date.now(), value };
  return value;
}

/** Settings → Backups (D618): settings without credentials, the last runs, the archives, the drill, and Litestream. */
export async function backupsView(): Promise<BackupsView> {
  const settings = config.backup;
  const dir = settings.localDir;
  const status = readStatus(dir);
  const drill = readDrill(dir);
  const lock = currentLock(dir);
  const s3 = settings.s3;
  const next = nextBackupAt(status);
  const nextDrill = nextDrillAt(drill, status);
  return {
    settings: {
      enabled: settings.enabled, interval: formatDuration(settings.intervalMs), keep: settings.keep, target: settings.target, localDir: dir,
      s3: s3 ? { bucket: s3.bucket, prefix: s3.prefix, endpointHost: new URL(s3.endpoint).host, separate: s3.separate, sse: s3.sse } : null,
      alertAfter: settings.alertAfter, drillInterval: settings.drillIntervalMs ? formatDuration(settings.drillIntervalMs) : null, storage: config.storage.backend
    },
    running: running ? { kind: running.kind, trigger: running.trigger, startedAt: running.startedAt } : lock ? { kind: lock.op === "drill" ? "drill" : "backup", trigger: lock.trigger, startedAt: lock.startedAt } : null,
    status,
    nextBackupAt: next === null ? null : new Date(Math.max(next, Date.now())).toISOString(),
    nextDrillAt: nextDrill === null ? null : new Date(Math.max(nextDrill, Date.now())).toISOString(),
    drill,
    ...await archiveList(),
    litestream: await cachedLitestream()
  };
}

const emptyBody = z.object({}).strict();

/** GET /api/admin/backups, POST /api/admin/backups/run, POST /api/admin/backups/drill (admins; 404 for anyone else). */
export function registerBackupRoutes(app: Hono<AppEnv>) {
  const admin = (c: Context<AppEnv>) => c.get("user").role === "admin";
  const notFound = (c: Context<AppEnv>) => c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
  app.get("/api/admin/backups", async (c) => admin(c) ? c.json(await backupsView()) : notFound(c));
  for (const [path, kind] of [["/api/admin/backups/run", "backup"], ["/api/admin/backups/drill", "drill"]] as const) {
    app.post(path, async (c) => {
      if (!admin(c)) return notFound(c);
      try {
        await parseJson(c.req.raw, emptyBody);
      } catch {
        return c.json({ error: "Invalid request", code: "INVALID" }, 400);
      }
      const job = startJob(kind, "manual");
      if (!job) return c.json({ error: kind === "backup" ? "A backup or restore drill is already running" : "A backup or restore drill is already running", code: "BUSY" }, 409);
      audit(c.get("user").id, null, kind === "backup" ? "backup.run" : "backup.drill", { trigger: "manual" });
      slog.info(kind === "backup" ? "Backup started from Settings" : "Restore drill started from Settings");
      return c.json({ started: true, kind, startedAt: job.startedAt }, 202);
    });
  }
}
