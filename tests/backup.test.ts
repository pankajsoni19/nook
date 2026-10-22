import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import * as tar from "tar-stream";
import { ARCHIVE_PATTERN, archiveName, archiveTime, collectDataFiles, MANIFEST_NAME, readArchive, safeEntryName } from "../server/backup/archive";
import { runBackup, type JobOptions } from "../server/backup/job";
import { restoreInto, runDrill, parseSource } from "../server/backup/drill";
import { acquireLock, currentLock, readDrill, readStatus } from "../server/backup/state";
import { createLocalStore, createS3Store, pruneArchives } from "../server/backup/stores";
import type { BackupS3Settings } from "../server/backup/settings";
import { backupSettings, makeFixture, noLitestream, type Fixture } from "./support/backupFixture";
import { startFakeS3 } from "./support/fakeS3";

const roots: string[] = [];
const fixtures: Fixture[] = [];
function fixture(label?: string) {
  const made = makeFixture(label);
  roots.push(made.root);
  fixtures.push(made);
  return made;
}
afterAll(() => {
  for (const made of fixtures) made.db.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function jobOptions(made: Fixture, overrides: Partial<JobOptions> = {}): JobOptions {
  return {
    dataDir: made.dataDir, databasePath: made.databasePath, settings: backupSettings(made), minFreeBytes: 0, storage: { backend: "local" },
    appVersion: "0.45.0-test", gitSha: "test", trigger: "cli", ...overrides
  };
}

describe("archive names and paths", () => {
  test("names carry the time and a suffix; only those match the pattern", () => {
    const name = archiveName(new Date("2026-10-22T09:30:05.123Z"));
    expect(name).toMatch(/^nook-backup-20261022T093005Z-[0-9a-f]{6}\.tar\.gz$/);
    expect(ARCHIVE_PATTERN.test(name)).toBe(true);
    expect(archiveTime(name)).toBe(Date.parse("2026-10-22T09:30:05Z"));
    expect(archiveTime("mynotes-20261001T030000Z.tar.gz")).toBe(Date.parse("2026-10-01T03:00:00Z"));
    for (const other of ["nook-backup-20261022T093005Z.tar.gz", "nook-backup-20261022T093005Z-abcdef.tar.gz.partial", "x/nook-backup-20261022T093005Z-abcdef.tar.gz", "nook-backup-latest.tar.gz"]) expect(ARCHIVE_PATTERN.test(other)).toBe(false);
  });

  test("entry names that could escape the target are refused", () => {
    expect(safeEntryName("./notes/a/versions/000001.md")).toBe("notes/a/versions/000001.md");
    expect(safeEntryName("./")).toBeNull();
    for (const bad of ["../etc/passwd", "/etc/passwd", "notes/../../x", "a\\b", "a//b", "notes/./x"]) expect(() => safeEntryName(bad)).toThrow();
  });

  test("restore sources parse", () => {
    expect(parseSource("latest")).toEqual({ kind: "archive", name: null, path: null });
    expect(parseSource("litestream")).toEqual({ kind: "litestream", timestamp: null });
    expect(parseSource("litestream@2026-10-22T09:30:00Z")).toEqual({ kind: "litestream", timestamp: "2026-10-22T09:30:00Z" });
    expect(() => parseSource("litestream@yesterday")).toThrow();
    expect(parseSource("nook-backup-20261022T093005Z-abcdef.tar.gz")).toMatchObject({ kind: "archive", name: "nook-backup-20261022T093005Z-abcdef.tar.gz" });
    expect(parseSource("/srv/x.tar.gz")).toMatchObject({ kind: "archive", path: "/srv/x.tar.gz" });
  });
});

describe("an online backup to the local folder", () => {
  test("snapshots the database, packs DATA_DIR without the live files, and records the run", async () => {
    const made = fixture();
    symlinkSync("/etc/hostname", join(made.dataDir, "a-link"));
    const run = await runBackup(jobOptions(made));
    expect(run?.ok).toBe(true);
    expect(run?.archive?.name).toMatch(ARCHIVE_PATTERN);
    expect(run?.targets).toEqual([{ kind: "local", location: made.backupDir, ok: true, pruned: 0 }]);
    expect(run?.warnings?.some((line) => /link/.test(line))).toBe(true);
    const archive = join(made.backupDir, run!.archive!.name);
    const read = await readArchive(archive);
    const names = read.files.map((file) => file.path);
    expect(names[0]).toBe("mynotes.sqlite");
    expect(names).toContain(`notes/${made.noteId}/versions/000001.md`);
    expect(names).toContain(`documents/objects/${made.documentId}`);
    expect(names).toContain("storage-instance");
    expect(names).toContain("push/vapid.json");
    for (const left of ["mynotes.sqlite-wal", "mynotes.sqlite-shm", "server.heartbeat", "a-link"]) expect(names).not.toContain(left);
    expect(names.some((name) => name.startsWith("documents/.staging") || name.startsWith("backup/") || name.endsWith(".tmp"))).toBe(false);
    expect(read.manifest?.database.integrity).toBe("ok");
    expect(read.manifest?.counts.users).toBe(1);
    expect(read.manifest?.storage).toEqual({ backend: "local" });
    expect(read.manifest?.skipped).toEqual([{ path: "a-link", reason: "symlink" }]);
    // The work folder is gone; the status file names the archive.
    expect(readdirSync(made.backupDir).filter((name) => name.startsWith(".work"))).toEqual([]);
    const status = readStatus(made.backupDir);
    expect(status.lastSuccess?.archive?.name).toBe(run!.archive!.name);
    expect(status.consecutiveFailures).toBe(0);
  });

  test("the snapshot is consistent while another process writes", async () => {
    const made = fixture("consistency");
    made.db.exec("CREATE TABLE pair_a (n INTEGER NOT NULL, filler TEXT); CREATE TABLE pair_b (n INTEGER NOT NULL)");
    const writer = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "support", "backupWriter.ts"), made.databasePath, "2500"], { stdout: "pipe", stderr: "inherit" });
    await Bun.sleep(400);
    const runs = [];
    for (let index = 0; index < 3; index += 1) runs.push(await runBackup(jobOptions(made)));
    const committed = Number((await new Response(writer.stdout).text()).trim());
    expect(await writer.exited).toBe(0);
    expect(committed).toBeGreaterThan(50);
    for (const run of runs) {
      expect(run?.ok).toBe(true);
      const target = join(made.root, `check-${run!.id}`);
      await readArchive(join(made.backupDir, run!.archive!.name), { extractTo: target });
      const copy = new Database(join(target, "mynotes.sqlite"), { readonly: true });
      const a = copy.query("SELECT COUNT(*) AS c, COALESCE(MAX(n), 0) AS m FROM pair_a").get() as { c: number; m: number };
      const b = copy.query("SELECT COUNT(*) AS c, COALESCE(MAX(n), 0) AS m FROM pair_b").get() as { c: number; m: number };
      copy.close();
      expect(a).toEqual(b);
      expect(a.c).toBe(a.m);
    }
  }, 30_000);

  test("keeps BACKUP_KEEP archives and deletes only archive names", async () => {
    const made = fixture("retention");
    mkdirSync(made.backupDir, { recursive: true });
    const legacy = join(made.backupDir, "mynotes-20200101T000000Z.tar.gz");
    const other = join(made.backupDir, "nook-backup-notes.txt");
    writeFileSync(legacy, "offline archive");
    writeFileSync(other, "not an archive");
    const names: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const run = await runBackup(jobOptions(made, { settings: backupSettings(made, { keep: 2 }), now: () => new Date(Date.UTC(2026, 9, 22, 9, index)) }));
      expect(run?.ok).toBe(true);
      names.push(run!.archive!.name);
    }
    const left = (await createLocalStore(made.backupDir).list()).map((archive) => archive.name);
    expect(left).toEqual([names[3]!, names[2]!]);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(other)).toBe(true);
    // Four full backups: under a loaded host (the Docker verify stage runs the whole suite) they pass 5 s.
  }, 30_000);

  test("refuses below the free-disk floor, counts failures, and one job runs at a time", async () => {
    const made = fixture("floor");
    const failed = await runBackup(jobOptions(made, { minFreeBytes: Number.MAX_SAFE_INTEGER }));
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toMatch(/Not enough free disk/);
    await runBackup(jobOptions(made, { minFreeBytes: Number.MAX_SAFE_INTEGER }));
    expect(readStatus(made.backupDir).consecutiveFailures).toBe(2);
    const lock = acquireLock(made.backupDir, { op: "drill", trigger: "cli" });
    expect(lock).not.toBeNull();
    expect(currentLock(made.backupDir)?.op).toBe("drill");
    expect(await runBackup(jobOptions(made))).toBeNull();
    lock!.release();
    expect((await runBackup(jobOptions(made)))?.ok).toBe(true);
    expect(readStatus(made.backupDir).consecutiveFailures).toBe(0);
  });

  test("no configured key is ever inside an archive", async () => {
    const made = fixture("keys");
    // Keys live in the environment or in files outside DATA_DIR (config.ts refuses them inside); the
    // database holds only what they encrypt. Put a key file beside DATA_DIR and check no entry carries it.
    const key = Buffer.alloc(32, 41).toString("base64");
    writeFileSync(join(made.root, "vault.key"), key);
    made.db.query("UPDATE users SET totp_secret = ? WHERE id = ?").run("v1:ciphertext-only", made.userId);
    const run = await runBackup(jobOptions(made));
    const target = join(made.root, "extracted");
    const read = await readArchive(join(made.backupDir, run!.archive!.name), { extractTo: target });
    for (const file of read.files) expect(readFileSync(join(target, file.path)).includes(Buffer.from(key))).toBe(false);
    expect(read.files.some((file) => file.path.endsWith("vault.key"))).toBe(false);
  });
});

describe("archive verification", () => {
  test("a changed byte, a missing file, or an extra file fails the read", async () => {
    const made = fixture("tamper");
    const run = await runBackup(jobOptions(made));
    const path = join(made.backupDir, run!.archive!.name);
    // Corrupt the compressed stream in the middle.
    const bytes = readFileSync(path);
    const corrupt = Buffer.from(bytes);
    corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
    const corruptPath = join(made.root, "corrupt.tar.gz");
    writeFileSync(corruptPath, corrupt);
    await expect(readArchive(corruptPath)).rejects.toThrow();
    // A well-formed archive whose file disagrees with the manifest.
    const manifest = (await readArchive(path)).manifest!;
    const forged = join(made.root, "forged.tar.gz");
    const pack = tar.pack();
    const done = pipeline(pack, createGzip(), createWriteStream(forged));
    pack.entry({ name: "mynotes.sqlite" }, Buffer.from("not the database"));
    pack.entry({ name: MANIFEST_NAME }, Buffer.from(JSON.stringify(manifest)));
    pack.finalize();
    await done;
    await expect(readArchive(forged)).rejects.toThrow(/does not match its manifest|missing/);
  });

  test("links in an archive are refused on extraction", async () => {
    const made = fixture("links");
    const linked = join(made.root, "linked.tar.gz");
    const pack = tar.pack();
    const done = pipeline(pack, createGzip(), createWriteStream(linked));
    pack.entry({ name: "./mynotes.sqlite" }, Buffer.from("x"));
    pack.entry({ name: "./notes/evil", type: "symlink", linkname: "/etc/passwd" });
    pack.finalize();
    await done;
    await expect(readArchive(linked, { extractTo: join(made.root, "out"), legacy: true })).rejects.toThrow(/only regular files/);
  });

  test.skipIf(!Bun.which("tar"))("offline archives (scripts/backup.sh --force) read only with the legacy flag", async () => {
    const made = fixture("offline");
    // The offline script's layout (./ prefixes, the database with its WAL, no manifest).
    const offline = join(made.root, "mynotes-20261001T030000Z.tar.gz");
    const proc = Bun.spawnSync(["tar", "--exclude=./backup", "-C", made.dataDir, "-czf", offline, "."]);
    expect(proc.exitCode).toBe(0);
    await expect(readArchive(offline)).rejects.toThrow(/no manifest/);
    const read = await readArchive(offline, { legacy: true, extractTo: join(made.root, "offline-out") });
    expect(read.manifest).toBeNull();
    expect(read.files.map((file) => file.path)).toContain("mynotes.sqlite");
  });
});

describe("the restore drill and restore", () => {
  test("a good archive passes every check", async () => {
    const made = fixture("drill");
    await runBackup(jobOptions(made));
    const report = await runDrill({ from: "latest", settings: backupSettings(made), litestream: noLitestream, databasePath: made.databasePath, storage: { backend: "local" }, trigger: "cli" });
    expect(report?.ok).toBe(true);
    expect(report?.checks.map((check) => check.name)).toEqual(["Archive", "Database present", "Integrity check", "Schema", "Row counts", "Counts match the manifest", "Files the database names"]);
    expect(report?.counts.notes).toBe(1);
    expect(readDrill(made.backupDir).last?.ok).toBe(true);
    // The scratch copy is gone.
    expect(readdirSync(made.backupDir).filter((name) => name.startsWith(".drill"))).toEqual([]);
  });

  test("a corrupted archive, a missing file, and a newer schema fail it", async () => {
    const made = fixture("drill-bad");
    const run = await runBackup(jobOptions(made));
    const path = join(made.backupDir, run!.archive!.name);
    const bytes = readFileSync(path);
    bytes[bytes.length - 20] ^= 0x55;
    writeFileSync(path, bytes);
    const options = { settings: backupSettings(made), litestream: noLitestream, databasePath: made.databasePath, storage: { backend: "local" as const }, trigger: "cli" as const };
    const corrupt = await runDrill({ ...options, from: run!.archive!.name });
    expect(corrupt?.ok).toBe(false);
    expect(corrupt?.checks.at(-1)?.name).toBe("Restore");

    // A document whose object is gone from DATA_DIR: the archive is fine, the restore is not.
    rmSync(join(made.dataDir, "documents", "objects", made.documentId));
    const second = await runBackup(jobOptions(made));
    const missing = await runDrill({ ...options, from: second!.archive!.name });
    expect(missing?.ok).toBe(false);
    expect(missing?.checks.find((check) => check.name === "Files the database names")).toMatchObject({ ok: false });

    // A database from a newer Nook (a migration id this build does not have).
    made.db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (9999, 'from_the_future', ?)").run(new Date().toISOString());
    writeFileSync(join(made.dataDir, "documents", "objects", made.documentId), "document bytes\n");
    const third = await runBackup(jobOptions(made));
    const newer = await runDrill({ ...options, from: third!.archive!.name });
    expect(newer?.ok).toBe(false);
    expect(newer?.checks.find((check) => check.name === "Schema")?.detail).toMatch(/9999/);
  });

  test("restore refuses a used folder and fills an empty one", async () => {
    const made = fixture("restore");
    const run = await runBackup(jobOptions(made));
    const used = join(made.root, "used");
    mkdirSync(used);
    writeFileSync(join(used, "keep.txt"), "x");
    const options = { settings: backupSettings(made), litestream: noLitestream, databasePath: made.databasePath, storage: { backend: "local" as const } };
    await expect(restoreInto({ ...options, from: "latest", to: used })).rejects.toThrow(/not empty/);
    const target = join(made.root, "restored");
    const result = await restoreInto({ ...options, from: run!.archive!.name, to: target });
    expect(result.ok).toBe(true);
    expect(existsSync(join(target, "mynotes.sqlite"))).toBe(true);
    expect(existsSync(join(target, MANIFEST_NAME))).toBe(false);
    expect(readFileSync(join(target, "notes", made.noteId, "versions", "000001.md"), "utf8")).toBe("# A note\n");
    await expect(restoreInto({ ...options, from: "litestream", to: join(made.root, "ls") })).rejects.toThrow(/Litestream is not configured/);
  });
});

describe("S3 targets (fake S3)", () => {
  const fake = startFakeS3({ bucket: "nook-backups" });
  afterAll(() => fake.stop());
  const s3 = (prefix: string, overrides: Partial<BackupS3Settings> = {}): BackupS3Settings => ({
    bucket: fake.bucket, endpoint: fake.url, region: "us-east-1", accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey,
    timeoutMs: 10_000, prefix, basePrefix: "nook/", separate: false, sse: "off", ...overrides
  });

  test("both targets get the archive; retention keeps each target's newest and never touches other keys", async () => {
    const made = fixture("s3");
    const settings = backupSettings(made, { target: "both", keep: 2, s3: s3("nook/backups/") });
    // Things under and beside the prefix that are not ours.
    for (const key of ["nook/documents/0b8c2e9e-1111-4111-8111-111111111111", "nook/backups/readme.txt", "nook/backups/old/nook-backup-20200101T000000Z-aaaaaa.tar.gz", "nook/litestream/mynotes/0000/x.ltx", "nook/backups-other/nook-backup-20200101T000000Z-bbbbbb.tar.gz"]) {
      fake.objects.set(key, { bytes: new Uint8Array([1]), lastModified: new Date(), etag: '"x"', contentType: "application/octet-stream" });
    }
    const names: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const run = await runBackup(jobOptions(made, { settings, now: () => new Date(Date.UTC(2026, 9, 22, 10, index)) }));
      expect(run?.ok).toBe(true);
      expect(run?.targets?.map((target) => target.kind)).toEqual(["s3", "local"]);
      names.push(run!.archive!.name);
    }
    const inBucket = [...fake.objects.keys()].filter((key) => key.startsWith("nook/backups/nook-backup-")).sort();
    expect(inBucket).toEqual([`nook/backups/${names[1]}`, `nook/backups/${names[2]}`]);
    for (const key of ["nook/documents/0b8c2e9e-1111-4111-8111-111111111111", "nook/backups/readme.txt", "nook/backups/old/nook-backup-20200101T000000Z-aaaaaa.tar.gz", "nook/litestream/mynotes/0000/x.ltx", "nook/backups-other/nook-backup-20200101T000000Z-bbbbbb.tar.gz"]) expect(fake.objects.has(key)).toBe(true);
    expect((await createLocalStore(made.backupDir).list()).map((archive) => archive.name)).toEqual([names[2]!, names[1]!]);
    // The drill reads the newest from the bucket when the local folder has none.
    rmSync(made.backupDir, { recursive: true, force: true });
    const report = await runDrill({ from: "latest", settings, litestream: noLitestream, databasePath: made.databasePath, storage: { backend: "local" }, trigger: "cli" });
    expect(report?.ok).toBe(true);
    expect(report?.source).toBe(`archive ${names[2]} (s3)`);
  });

  test("a large archive goes up in parts and comes back byte for byte", async () => {
    const made = fixture("s3-large");
    writeFileSync(join(made.dataDir, "documents", "objects", crypto.randomUUID()), crypto.getRandomValues(new Uint8Array(19 * 1024 * 1024)));
    const settings = backupSettings(made, { target: "s3", s3: s3("big/") });
    const run = await runBackup(jobOptions(made, { settings }));
    expect(run?.ok).toBe(true);
    expect(fake.log.filter((line) => line.startsWith("PUT big/") && line.includes("partNumber=")).length).toBeGreaterThanOrEqual(3);
    // S3 only: no archive stays in the local folder.
    expect(await createLocalStore(made.backupDir).list()).toEqual([]);
    const back = join(made.root, "back.tar.gz");
    await createS3Store(settings.s3!).fetch(run!.archive!.name, back);
    expect((await readArchive(back)).archiveSha256).toBe(run!.archive!.sha256);
  }, 30_000);

  test("an S3 failure fails the run but keeps the local copy; SSE required removes an unencrypted upload", async () => {
    const made = fixture("s3-fail");
    fake.failNext(/^PUT fail\//, 20);
    const run = await runBackup(jobOptions(made, { settings: backupSettings(made, { target: "both", s3: s3("fail/") }) }));
    fake.clearFailures();
    expect(run?.ok).toBe(false);
    expect(run?.error).toMatch(/^s3: S3 error/);
    expect(run?.targets?.find((target) => target.kind === "local")?.ok).toBe(true);
    expect(readStatus(made.backupDir).consecutiveFailures).toBe(1);

    const sse = backupSettings(made, { target: "s3", s3: s3("sse/", { sse: "required" }) });
    const refused = await runBackup(jobOptions(made, { settings: sse }));
    expect(refused?.ok).toBe(false);
    expect(refused?.error).toMatch(/did not encrypt the archive/);
    expect([...fake.objects.keys()].some((key) => key.startsWith("sse/"))).toBe(false);
    fake.sseHeader = "AES256";
    try {
      expect((await runBackup(jobOptions(made, { settings: sse })))?.ok).toBe(true);
    } finally {
      fake.sseHeader = null;
    }
  });

  test("pruning ignores names that are not archives", async () => {
    const store = createS3Store(s3("prune/"));
    for (const name of ["nook-backup-20260101T000000Z-aaaaaa.tar.gz", "nook-backup-20260102T000000Z-bbbbbb.tar.gz", "nook-backup-20260103T000000Z-cccccc.tar.gz"]) {
      fake.objects.set(`prune/${name}`, { bytes: new Uint8Array([1]), lastModified: new Date(), etag: '"x"', contentType: "application/gzip" });
    }
    fake.objects.set("prune/nook-backup-20250101T000000Z-zzzzzz.tar.gz.partial", { bytes: new Uint8Array([1]), lastModified: new Date(), etag: '"x"', contentType: "application/gzip" });
    expect(await pruneArchives(store, 1, "nook-backup-20260102T000000Z-bbbbbb.tar.gz")).toEqual(["nook-backup-20260103T000000Z-cccccc.tar.gz", "nook-backup-20260101T000000Z-aaaaaa.tar.gz"]);
    expect(fake.objects.has("prune/nook-backup-20250101T000000Z-zzzzzz.tar.gz.partial")).toBe(true);
    await expect(store.remove("../documents/x")).rejects.toThrow(/Not a backup archive name/);
  });
});

describe("collecting DATA_DIR", () => {
  test("a backup folder outside the walk and nested exclusions", async () => {
    const made = fixture("collect");
    mkdirSync(made.backupDir, { recursive: true });
    writeFileSync(join(made.backupDir, "nook-backup-20260101T000000Z-aaaaaa.tar.gz"), "x");
    const { files } = await collectDataFiles(made.dataDir, [made.backupDir]);
    expect(files.some((file) => file.path.startsWith("backup/"))).toBe(false);
    expect(files.map((file) => file.path)).toContain("storage-instance");
  });
});
