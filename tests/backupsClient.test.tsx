import { describe, expect, test } from "bun:test";
import { installDom, mockApi, render } from "./support/dom";
import type { BackupsView } from "../shared/backups";

installDom("http://nook.test/settings/backups");

const { Backups } = await import("../src/settings/Backups");
const { act } = await import("react");

// Settings → Backups (lane BACKUP, D618): what the page says for a failing S3 setup, and Back up now.

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
function view(overrides: Partial<BackupsView> = {}): BackupsView {
  const ok = { id: "r1", trigger: "schedule" as const, startedAt: at(120), finishedAt: at(119), ok: true, ms: 4200, archive: { name: "nook-backup-20261022T030000Z-abcdef.tar.gz", size: 12_582_912, sha256: "0".repeat(64), files: 40, databaseBytes: 8_000_000, storage: "s3" as const }, targets: [{ kind: "s3" as const, location: "s3://nook/backups/", ok: true }] };
  const failed = { id: "r2", trigger: "schedule" as const, startedAt: at(10), finishedAt: at(9), ok: false, ms: 900, error: "s3: S3 error AccessDenied" };
  return {
    settings: { enabled: true, interval: "6h", keep: 14, target: "s3", localDir: "/data/backup", s3: { bucket: "nook", prefix: "nook/backups/", endpointHost: "s3.eu-west-1.amazonaws.com", separate: false, sse: "off" }, alertAfter: 2, drillInterval: null, storage: "s3", objects: "off", objectsEstimate: null },
    running: null,
    status: { lastRun: failed, lastSuccess: ok, consecutiveFailures: 2, recent: [failed, ok] },
    nextBackupAt: new Date(Date.now() + 50 * 60_000).toISOString(),
    nextDrillAt: null,
    drill: { last: { id: "d1", trigger: "manual", startedAt: at(60), finishedAt: at(59), ok: true, ms: 3000, source: "archive nook-backup-20261022T030000Z-abcdef.tar.gz (s3)", checks: [{ name: "Integrity check", ok: true, detail: "PRAGMA integrity_check: ok" }, { name: "Objects in the bucket", ok: true, detail: "All 40 documents the backup names are in the bucket" }], counts: { users: 3 } }, recent: [] },
    archives: [{ name: "nook-backup-20261022T030000Z-abcdef.tar.gz", size: 12_582_912, createdAt: at(120), locations: ["s3"], offline: false }],
    archivesError: null,
    litestream: { enabled: true, configured: true, active: true, location: "s3://nook/nook/litestream/mynotes at s3.eu-west-1.amazonaws.com", retention: "7d", metrics: { txid: 120, syncErrors: 0, walBytes: 4096, databaseBytes: 8_000_000 }, replica: { txid: 118, uploadedAt: at(1), snapshotAt: at(300) }, error: null },
    ...overrides
  };
}

describe("Settings → Backups", () => {
  test("shows the failure streak, the schedule, what the archive holds with S3 files, the drill, Litestream, and the archives", async () => {
    mockApi({ "GET /admin/backups": () => view() });
    const page = await render(<Backups />);
    await page.waitFor(() => document.querySelector(".backups-settings .report-source-list"));
    const text = document.body.textContent ?? "";
    expect(text).toContain("2 failed in a row");
    expect(text).toContain("s3: S3 error AccessDenied");
    expect(text).toContain("Every 6 hours, keeping the newest 14");
    expect(text).toContain("Files stay in the S3 bucket and are not copied");
    expect(text).toContain("Integrity check");
    expect(text).toContain("Replicating");
    expect(text).toContain("2 transactions behind");
    expect(text).toContain("To any time in the last 7 days");
    expect(text).toContain("nook-backup-20261022T030000Z-abcdef.tar.gz");
    expect(text).not.toMatch(/secret|access key/i);
  });

  test("D687: with BACKUP_S3_OBJECTS=copy it says what the bucket's files add, and a running copy shows its progress", async () => {
    const base = view();
    mockApi({ "GET /admin/backups": () => view({ settings: { ...base.settings, objects: "copy", objectsEstimate: { count: 1234, bytes: 5 * 1024 ** 3 } }, running: { kind: "backup", trigger: "schedule", startedAt: at(2), progress: "Copying objects from the bucket: 600 of 1234 (2.4 GiB of about 5.0 GiB)" } }) });
    const page = await render(<Backups />);
    await page.waitFor(() => document.querySelector(".backups-settings .report-source-list"));
    const text = document.body.textContent ?? "";
    expect(text).toContain("a copy of the bucket's files (BACKUP_S3_OBJECTS=copy): 1,234 files, about 5");
    expect(text).toContain("more in every backup");
    expect(text).toContain("Copying objects from the bucket: 600 of 1234");
    expect(text).not.toContain("Files stay in the S3 bucket and are not copied");
  });

  test("Back up now starts a job and the page follows it until it ends", async () => {
    let running = false;
    const api = mockApi({
      "GET /admin/backups": () => view(running ? { running: { kind: "backup", trigger: "manual", startedAt: at(0) } } : {}),
      "POST /admin/backups/run": () => { running = true; return { started: true }; }
    });
    const page = await render(<Backups />);
    await page.waitFor(() => page.button("Back up now"));
    await act(async () => { page.button("Back up now")!.click(); });
    await page.waitFor(() => page.button("Backing up…"));
    expect(page.button("Backing up…")!.disabled).toBe(true);
    expect(page.button("Run restore drill")!.disabled).toBe(true);
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({});
  });
});
