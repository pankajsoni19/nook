import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createUser, db, request } from "./support/harness";
import { config } from "../server/config";
import { runBackup } from "../server/backup/job";
import { runDrill } from "../server/backup/drill";
import { acquireLock, readAlert, recordRun, type BackupRun } from "../server/backup/state";
import { backupInProgress, backupTick, checkAlerts, nextBackupAt, runningJob, setBackupRunnerForTests, startJob, FIRST_BACKUP_DELAY_MS, RETRY_AFTER_MS } from "../server/backup/service";
import type { BackupsView } from "../shared/backups";

// Settings → Backups and its jobs (lane BACKUP, D614, D618), on the shared server. Jobs run in process
// here (the server's runner starts `bun server/backup-admin.ts` at low priority); BACKUP_ENABLED is false
// in the harness, so nothing is scheduled behind the other tests.

const admin = await createUser("Backup admin");
db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
const member = await createUser("Backup member");
const dir = config.backup.localDir;

setBackupRunnerForTests(async (kind, trigger) => {
  const common = { settings: config.backup, databasePath: config.databasePath, storage: config.storage, trigger };
  if (kind === "backup") {
    const run = await runBackup({ ...common, dataDir: config.dataDir, minFreeBytes: 0, appVersion: config.appVersion, gitSha: config.gitSha });
    return run === null ? 75 : run.ok ? 0 : 1;
  }
  const report = await runDrill({ ...common, from: "latest", litestream: config.litestream });
  return report === null ? 75 : report.ok ? 0 : 1;
});
afterAll(() => {
  setBackupRunnerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("Settings → Backups", () => {
  test("is for admins only (404 for anyone else)", async () => {
    expect((await request("/admin/backups", {}, member)).status).toBe(404);
    expect((await request("/admin/backups/run", { method: "POST", body: "{}" }, member)).status).toBe(404);
    const response = await request("/admin/backups", {}, admin);
    expect(response.status).toBe(200);
    const view = await response.json() as BackupsView;
    expect(view.settings).toMatchObject({ enabled: false, interval: "1d", keep: 14, target: "local", s3: null, storage: config.storage.backend });
    expect(view.nextBackupAt).toBeNull();
    expect(view.litestream).toMatchObject({ enabled: false, configured: false, active: false });
    // Nothing in the answer looks like a credential.
    expect(JSON.stringify(view)).not.toMatch(/secret|accessKey/i);
  });

  test("Back up now runs a backup of the live server; the view lists it; a second start while one runs is 409", async () => {
    const started = await request("/admin/backups/run", { method: "POST", body: "{}" }, admin);
    expect(started.status).toBe(202);
    expect((await request("/admin/backups/drill", { method: "POST", body: "{}" }, admin)).status).toBe(409);
    await runningJob()?.done;
    const view = await (await request("/admin/backups", {}, admin)).json() as BackupsView;
    expect(view.running).toBeNull();
    expect(view.status.lastRun?.ok).toBe(true);
    expect(view.status.lastRun?.trigger).toBe("manual");
    expect(view.archives.map((archive) => archive.name)).toContain(view.status.lastRun!.archive!.name);
    expect(db.query("SELECT 1 FROM audit_log WHERE actor_id = ? AND event_type = 'backup.run'").get(admin.userId)).not.toBeNull();

    const drill = await request("/admin/backups/drill", { method: "POST", body: "{}" }, admin);
    expect(drill.status).toBe(202);
    await runningJob()?.done;
    const after = await (await request("/admin/backups", {}, admin)).json() as BackupsView;
    expect(after.drill.last?.ok).toBe(true);
    expect(after.drill.last?.checks.find((check) => check.name === "Integrity check")?.ok).toBe(true);
  }, 60_000);

  test("a job held elsewhere (the CLI) makes the buttons busy, and the sweeper waits for a backup", async () => {
    const lock = acquireLock(dir, { op: "backup", trigger: "cli" })!;
    try {
      expect(backupInProgress()).toBe(true);
      const busy = await request("/admin/backups/run", { method: "POST", body: "{}" }, admin);
      expect(busy.status).toBe(409);
      expect((await busy.json() as { code: string }).code).toBe("BUSY");
      const view = await (await request("/admin/backups", {}, admin)).json() as BackupsView;
      expect(view.running).toMatchObject({ kind: "backup", trigger: "cli" });
    } finally {
      lock.release();
    }
    expect(backupInProgress()).toBe(false);
    expect((await request("/admin/backups/run", { method: "POST", body: '{"x":1}' }, admin)).status).toBe(400);
  });
});

describe("the schedule and alerts", () => {
  const failed = (minutesAgo: number): BackupRun => {
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    return { id: crypto.randomUUID(), trigger: "schedule", startedAt: at, finishedAt: at, ok: false, ms: 10, error: "s3: S3 error AccessDenied" };
  };

  test("next run: the interval after a success, an hour after a failure, and nothing while off", () => {
    const saved = { ...config.backup };
    try {
      config.backup.enabled = true;
      config.backup.intervalMs = 6 * 3_600_000;
      const ok = { ...failed(0), ok: true };
      expect(nextBackupAt({ lastRun: ok, lastSuccess: ok, consecutiveFailures: 0, recent: [] })).toBe(Date.parse(ok.finishedAt) + 6 * 3_600_000);
      const bad = failed(0);
      expect(nextBackupAt({ lastRun: bad, lastSuccess: null, consecutiveFailures: 1, recent: [] })).toBe(Date.parse(bad.finishedAt) + RETRY_AFTER_MS);
      expect(nextBackupAt({ lastRun: null, lastSuccess: null, consecutiveFailures: 0, recent: [] })! - Date.now()).toBeLessThanOrEqual(FIRST_BACKUP_DELAY_MS);
      config.backup.enabled = false;
      expect(nextBackupAt()).toBeNull();
    } finally {
      Object.assign(config.backup, saved);
    }
  });

  test("admins get one bell notice once BACKUP_ALERT_AFTER runs fail in a row, and again only a day later", () => {
    const notices = () => (db.query("SELECT kind, count FROM access_notices WHERE user_id = ? AND kind = 'backup_failed' ORDER BY created_at").all(admin.userId) as Array<{ kind: string; count: number }>);
    const before = notices().length;
    recordRun(dir, failed(30));
    expect(checkAlerts()).toBe(false);
    recordRun(dir, failed(20));
    expect(checkAlerts()).toBe(true);
    expect(notices().length).toBe(before + 1);
    expect(notices().at(-1)?.count).toBe(2);
    expect(db.query("SELECT 1 FROM access_notices WHERE user_id = ? AND kind = 'backup_failed'").get(member.userId)).toBeNull();
    recordRun(dir, failed(10));
    expect(checkAlerts()).toBe(false);
    expect(checkAlerts({ nowMs: Date.now() + 25 * 3_600_000 })).toBe(true);
    expect(notices().length).toBe(before + 2);
    // A success clears the streak and the marker.
    recordRun(dir, { ...failed(0), ok: true });
    checkAlerts();
    expect(readAlert(dir).alertedAt).toBeNull();
  });

  test("the bell line opens Settings → Backups", async () => {
    const response = await request("/notifications?limit=50", {}, admin);
    const body = await response.json() as { notifications: Array<{ kind?: string; text?: string; title?: string; href?: string; path?: string }> };
    const line = JSON.stringify(body);
    expect(line).toContain("backups in a row failed");
    expect(line).toContain("/settings/backups");
  });

  test("a tick starts nothing while backups are off and nothing is due", () => {
    expect(backupTick()).toBeNull();
    expect(startJob("backup", "manual")).not.toBeNull();
    // One at a time inside the server too.
    expect(startJob("drill", "manual")).toBeNull();
    return runningJob()?.done;
  }, 60_000);
});
