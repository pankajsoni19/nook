import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync, constants } from "node:fs";
import { join } from "node:path";

/**
 * Backup bookkeeping in BACKUP_DIR (D614): the job lock, the last runs, the last drill, and the
 * alert marker. Plain JSON files rather than tables, so a host CLI run and the server see the same
 * state, a restored database never carries another server's backup history, and nothing here needs a
 * migration. None of it holds a secret: names, sizes, hashes, times, and error lines.
 */

export const LOCK_FILE = ".lock";
export const STATUS_FILE = "status.json";
export const DRILL_FILE = "drill.json";
export const ALERT_FILE = "alert.json";
/** The lock is refreshed every 15 s while a job runs; one untouched for two minutes belongs to a job that died. */
export const LOCK_STALE_MS = 120_000;
const LOCK_REFRESH_MS = 15_000;
const RECENT = 20;

import type { BackupRun, BackupStatus, BackupTrigger, DrillReport, DrillStatus } from "../../shared/backups";
export type { BackupRun, BackupStatus, DrillCheck, DrillReport, DrillStatus, BackupTargetResult as TargetResult } from "../../shared/backups";
export type Trigger = BackupTrigger;
export type AlertState = { alertedAt: string | null; failures: number };

const EMPTY_STATUS: BackupStatus = { lastRun: null, lastSuccess: null, consecutiveFailures: 0, recent: [] };

function readJson<T>(path: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(path, "utf8")) as T };
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export const ensureBackupDir = (dir: string) => mkdirSync(dir, { recursive: true, mode: 0o700 });

export const readStatus = (dir: string): BackupStatus => readJson(join(dir, STATUS_FILE), EMPTY_STATUS);

/** Records a finished backup run (called by the job, under the lock). */
export function recordRun(dir: string, run: BackupRun) {
  const status = readStatus(dir);
  const next: BackupStatus = {
    lastRun: run,
    lastSuccess: run.ok ? run : status.lastSuccess,
    consecutiveFailures: run.ok ? 0 : status.consecutiveFailures + 1,
    recent: [run, ...status.recent].slice(0, RECENT)
  };
  writeJson(join(dir, STATUS_FILE), next);
  return next;
}

export const readDrill = (dir: string): DrillStatus => readJson(join(dir, DRILL_FILE), { last: null, recent: [] });

export function recordDrill(dir: string, report: DrillReport) {
  const status = readDrill(dir);
  // The newest report in full; earlier ones without their checks (the list shows only the outcome).
  const next: DrillStatus = { last: report, recent: [report, ...status.recent.map((entry) => ({ ...entry, checks: [] }))].slice(0, RECENT) };
  writeJson(join(dir, DRILL_FILE), next);
  return next;
}

export const readAlert = (dir: string): AlertState => readJson(join(dir, ALERT_FILE), { alertedAt: null, failures: 0 });
export const writeAlert = (dir: string, state: AlertState) => writeJson(join(dir, ALERT_FILE), state);

export type LockInfo = { op: "backup" | "drill" | "restore"; pid: number; startedAt: string; trigger: Trigger; /** D687: how far the job is, in words (copying the bucket's objects). */ progress?: string };

/** The job holding the lock right now, or null (no lock, or a stale one). */
export function currentLock(dir: string, nowMs = Date.now()): LockInfo | null {
  const path = join(dir, LOCK_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (nowMs - mtimeMs > LOCK_STALE_MS) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockInfo;
  } catch {
    // Fresh but not yet (or no longer) readable: still held.
    return { op: "backup", pid: 0, startedAt: new Date(mtimeMs).toISOString(), trigger: "cli" };
  }
}

/**
 * One job at a time (D614), across the server and host CLI runs: `BACKUP_DIR/.lock`, created with
 * O_EXCL and touched every 15 s. A lock nobody touched for two minutes is taken over. Returns null when
 * another job holds it.
 */
export function acquireLock(dir: string, info: Omit<LockInfo, "pid" | "startedAt">) {
  ensureBackupDir(dir);
  const path = join(dir, LOCK_FILE);
  const body = JSON.stringify({ ...info, pid: process.pid, startedAt: new Date().toISOString() } satisfies LockInfo);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeSync(fd, body);
      closeSync(fd);
      const timer = setInterval(() => {
        try { utimesSync(path, new Date(), new Date()); } catch { /* released */ }
      }, LOCK_REFRESH_MS);
      timer.unref?.();
      let released = false;
      return {
        /** Records how far the job is (D687), for Settings → Backups and `status`; the lock stays the job's. */
        progress(text: string) {
          if (released) return;
          try { writeFileSync(path, JSON.stringify({ ...JSON.parse(body) as LockInfo, progress: text } satisfies LockInfo)); } catch { /* released meanwhile */ }
        },
        release() {
          if (released) return;
          released = true;
          clearInterval(timer);
          rmSync(path, { force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (currentLock(dir)) return null;
      // Stale: its job died without removing it.
      rmSync(path, { force: true });
    }
  }
  return null;
}
