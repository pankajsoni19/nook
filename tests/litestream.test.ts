import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./support/harness";
import { parseStorageConfig } from "../server/config";
import { formatDuration, parseBackupSettings, parseDuration, parseLitestreamSettings } from "../server/backup/settings";
import { litestreamExports, litestreamYaml } from "../server/litestream";
import { runDrill, restoreInto } from "../server/backup/drill";
import { backupSettings, makeFixture } from "./support/backupFixture";
import { startFakeS3 } from "./support/fakeS3";

// Backup and Litestream settings, the generated Litestream config, the image's start script, and (when a
// litestream binary is at hand: LITESTREAM_TEST_BIN, or `litestream` on PATH) a real replicate-and-restore
// against the fake S3 (lane BACKUP, D611–D617).

const root = mkdtempSync(join(tmpdir(), "nook-litestream-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const dataDir = join(root, "data");
const parse = (env: Record<string, string>, storage = parseStorageConfig(env, dataDir)) => parseBackupSettings(env, { storage, dataDir, parseS3: parseStorageConfig });
const parseLs = (env: Record<string, string>) => parseLitestreamSettings(env, { storage: parseStorageConfig(env, dataDir), dataDir, parseS3: parseStorageConfig });
const S3_ENV = { S3_BUCKET: "nook-files", S3_REGION: "eu-west-1", S3_ACCESS_KEY_ID: "AKIDEXAMPLE", S3_SECRET_ACCESS_KEY: "secret/with'quote", S3_PREFIX: "nook" };

describe("backup settings", () => {
  test("defaults: on, daily, 14 kept, local in DATA_DIR/backup, alerts after 2, no drill", () => {
    expect(parse({})).toEqual({ enabled: true, intervalMs: 86_400_000, keep: 14, target: "local", localDir: join(dataDir, "backup"), s3: null, alertAfter: 2, drillIntervalMs: null });
  });

  test("durations, counts, and targets are checked", () => {
    expect(parseDuration("6h", "X", 60_000, 86_400_000)).toBe(21_600_000);
    expect(parseDuration("2w", "X", 60_000, 30 * 86_400_000)).toBe(1_209_600_000);
    expect(formatDuration(21_600_000)).toBe("6h");
    expect(formatDuration(604_800_000)).toBe("1w");
    for (const [env, message] of [
      [{ BACKUP_INTERVAL: "5m" }, /BACKUP_INTERVAL/], [{ BACKUP_INTERVAL: "daily" }, /BACKUP_INTERVAL/], [{ BACKUP_KEEP: "0" }, /BACKUP_KEEP/],
      [{ BACKUP_TARGET: "ftp" }, /BACKUP_TARGET/], [{ BACKUP_TARGET: "s3" }, /needs an S3 bucket/], [{ BACKUP_ENABLED: "yes" }, /BACKUP_ENABLED/],
      [{ BACKUP_DIR: "relative/dir" }, /absolute/], [{ BACKUP_DIR: dataDir }, /DATA_DIR itself/], [{ BACKUP_S3_PREFIX: "../x" }, /BACKUP_S3_PREFIX/],
      [{ BACKUP_S3_SSE: "aes" }, /BACKUP_S3_SSE/], [{ BACKUP_DRILL_INTERVAL: "10m" }, /BACKUP_DRILL_INTERVAL/]
    ] as const) expect(() => parse(env as Record<string, string>)).toThrow(message);
    expect(parse({ BACKUP_INTERVAL: "6h", BACKUP_KEEP: "30", BACKUP_DRILL_INTERVAL: "7d", BACKUP_ENABLED: "false" })).toMatchObject({ enabled: false, intervalMs: 21_600_000, keep: 30, drillIntervalMs: 604_800_000 });
  });

  test("S3: under S3_PREFIX in the storage bucket (the default target with S3 storage), or S3_BUCKET with local files", () => {
    const storage = parse({ ...S3_ENV, STORAGE_BACKEND: "s3" });
    expect(storage.target).toBe("s3");
    expect(storage.s3).toMatchObject({ bucket: "nook-files", prefix: "nook/backups/", basePrefix: "nook/", separate: false, sse: "off", endpoint: "https://s3.eu-west-1.amazonaws.com" });
    const local = parse({ ...S3_ENV, BACKUP_TARGET: "both", BACKUP_S3_PREFIX: "archive/nook", BACKUP_S3_SSE: "required" });
    expect(local).toMatchObject({ target: "both", s3: { prefix: "nook/archive/nook/", sse: "required" } });
    // S3_BUCKET without a backup target leaves archives local.
    expect(parse(S3_ENV).s3).toBeNull();
  });

  test("a separate backup bucket takes only BACKUP_S3_* settings and names them in errors", () => {
    const separate = parse({ ...S3_ENV, STORAGE_BACKEND: "s3", BACKUP_S3_BUCKET: "nook-backups", BACKUP_S3_ENDPOINT: "https://abc.r2.cloudflarestorage.com", BACKUP_S3_REGION: "auto", BACKUP_S3_ACCESS_KEY_ID: "B", BACKUP_S3_SECRET_ACCESS_KEY: "C" });
    expect(separate.s3).toMatchObject({ bucket: "nook-backups", prefix: "backups/", basePrefix: "", separate: true, accessKeyId: "B", endpoint: "https://abc.r2.cloudflarestorage.com" });
    expect(() => parse({ BACKUP_TARGET: "s3", BACKUP_S3_BUCKET: "nook-backups", BACKUP_S3_REGION: "auto" })).toThrow(/BACKUP_S3_ACCESS_KEY_ID/);
    expect(() => parse({ BACKUP_TARGET: "s3", BACKUP_S3_BUCKET: "nook-backups", BACKUP_S3_ACCESS_KEY_ID: "B", BACKUP_S3_SECRET_ACCESS_KEY: "C", BACKUP_S3_ENDPOINT: "http://10.0.0.5:9000" })).toThrow(/BACKUP_S3_ENDPOINT must use https/);
  });

  test("Litestream: off by default; on with a bucket, its own prefix beside the backups", () => {
    expect(parseLs({})).toEqual({ enabled: false, s3: null, retentionMs: 604_800_000, metricsAddr: "127.0.0.1:9090" });
    expect(parseLs({ LITESTREAM_ENABLED: "true" }).s3).toBeNull();
    const on = parseLs({ ...S3_ENV, LITESTREAM_ENABLED: "true", LITESTREAM_RETENTION: "72h", LITESTREAM_METRICS_ADDR: "" });
    expect(on).toMatchObject({ enabled: true, retentionMs: 259_200_000, metricsAddr: null, s3: { bucket: "nook-files", path: "nook/litestream/mynotes" } });
    expect(() => parseLs({ LITESTREAM_METRICS_ADDR: "0.0.0.0:9090" })).toThrow(/loopback/);
  });
});

describe("the Litestream config", () => {
  test("AWS: bucket, path, region, snapshots, and no credential; an endpoint adds path-style", () => {
    const aws = litestreamYaml(parseLs({ ...S3_ENV, LITESTREAM_ENABLED: "true" }), "/data/mynotes.sqlite");
    expect(aws).toContain('addr: "127.0.0.1:9090"');
    expect(aws).toContain('  - path: "/data/mynotes.sqlite"');
    expect(aws).toContain('      bucket: "nook-files"');
    expect(aws).toContain('      path: "nook/litestream/mynotes"');
    expect(aws).toContain('      region: "eu-west-1"');
    expect(aws).toContain("  interval: 24h\n  retention: 168h");
    expect(aws).not.toContain("endpoint");
    expect(aws).not.toContain("AKIDEXAMPLE");
    expect(aws).not.toContain("secret/with");
    const minio = litestreamYaml(parseLs({ ...S3_ENV, S3_REGION: "", S3_ENDPOINT: "http://127.0.0.1:9000", LITESTREAM_ENABLED: "true", LITESTREAM_RETENTION: "12h" }), "/data/mynotes.sqlite");
    expect(minio).toContain('      endpoint: "http://127.0.0.1:9000"\n      force-path-style: true');
    expect(minio).toContain('      region: "us-east-1"');
    expect(minio).toContain("  interval: 12h\n  retention: 12h");
  });

  test("credentials leave only as quoted exports for Litestream's environment", () => {
    const exports = litestreamExports(parseLs({ ...S3_ENV, LITESTREAM_ENABLED: "true" }));
    expect(exports).toBe(["export LITESTREAM_ACCESS_KEY_ID='AKIDEXAMPLE'", "export LITESTREAM_SECRET_ACCESS_KEY='secret/with'\"'\"'quote'", "export NOOK_LITESTREAM=1"].join("\n"));
    const shell = Bun.spawnSync(["sh", "-c", `${exports}\nprintf %s "$LITESTREAM_SECRET_ACCESS_KEY"`]);
    expect(shell.stdout.toString()).toBe("secret/with'quote");
  });
});

// The Docker verify stage copies server, src, shared, and tests only (no scripts/): the start script is checked in the repository.
const startScript = join(import.meta.dir, "..", "scripts", "nook-start.sh");
describe.skipIf(!existsSync(startScript))("the image's start script", () => {
  const script = join(import.meta.dir, "..", "scripts", "nook-start.sh");
  const config = join(root, "tmp", "litestream.yml");
  const start = (env: Record<string, string>) => {
    const result = Bun.spawnSync(["sh", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, DATA_DIR: dataDir, NODE_ENV: "test", LOG_LEVEL: "silent", NOOK_BUN: process.execPath, NOOK_START_DRY_RUN: "1", LITESTREAM_CONFIG: config, LITESTREAM_BIN: "/bin/true", ...env } });
    return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString() };
  };

  test("Litestream off (the default): bun alone", () => {
    expect(start({})).toMatchObject({ code: 0, stdout: `${process.execPath} server/index.ts` });
  });

  test("on without a bucket or without the binary: bun alone, with a warning", () => {
    const noBucket = start({ LITESTREAM_ENABLED: "true" });
    expect(noBucket.stdout).toBe(`${process.execPath} server/index.ts`);
    expect(noBucket.stderr).toMatch(/no S3 bucket/);
    const noBinary = start({ ...S3_ENV, LITESTREAM_ENABLED: "true", LITESTREAM_BIN: join(root, "missing-litestream") });
    expect(noBinary.stdout).toBe(`${process.execPath} server/index.ts`);
    expect(noBinary.stderr).toMatch(/no litestream binary/);
  });

  test("on with a bucket: Litestream supervises bun, its config holds no credential", () => {
    const supervised = start({ ...S3_ENV, LITESTREAM_ENABLED: "TRUE" });
    expect(supervised.code).toBe(0);
    expect(supervised.stdout).toBe(`/bin/true replicate -config ${config} -no-expand-env -exec ${process.execPath} server/index.ts`);
    const written = readFileSync(config, "utf8");
    expect(written).toContain('bucket: "nook-files"');
    expect(written).not.toContain("AKIDEXAMPLE");
    expect(supervised.stdout + supervised.stderr).not.toContain("AKIDEXAMPLE");
  });

  test("a bad setting refuses to start; the config is never written inside DATA_DIR", () => {
    expect(start({ ...S3_ENV, LITESTREAM_ENABLED: "true", LITESTREAM_RETENTION: "forever" }).code).toBe(1);
    expect(start({ ...S3_ENV, LITESTREAM_ENABLED: "true", LITESTREAM_CONFIG: join(dataDir, "litestream.yml") }).code).toBe(1);
    expect(existsSync(join(dataDir, "litestream.yml"))).toBe(false);
  });
});

const litestreamBin = process.env.LITESTREAM_TEST_BIN || Bun.which("litestream");

describe.skipIf(!litestreamBin)("Litestream against the fake S3 (needs the binary)", () => {
  test("replicates while Nook writes; the drill restores the latest and a point in time", async () => {
    const fake = startFakeS3({ bucket: "nook-ls" });
    const made = makeFixture("litestream");
    try {
      const settings = { enabled: true, s3: { bucket: fake.bucket, endpoint: fake.url, region: "us-east-1", accessKeyId: fake.accessKeyId, secretAccessKey: fake.secretAccessKey, timeoutMs: 10_000, basePrefix: "nook/", separate: false, path: "nook/litestream/mynotes" }, retentionMs: 86_400_000, metricsAddr: null };
      const yml = join(made.root, "litestream.yml");
      await Bun.write(yml, litestreamYaml(settings, made.databasePath));
      made.db.exec("CREATE TABLE marks (n INTEGER)");
      const child = Bun.spawn([litestreamBin!, "replicate", "-config", yml, "-no-expand-env"], { env: { ...process.env, LITESTREAM_ACCESS_KEY_ID: fake.accessKeyId, LITESTREAM_SECRET_ACCESS_KEY: fake.secretAccessKey }, stdout: "ignore", stderr: "ignore" });
      try {
        for (let n = 0; n < 20; n += 1) made.db.query("INSERT INTO marks VALUES (?)").run(n);
        await Bun.sleep(3000);
        const between = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        await Bun.sleep(1500);
        for (let n = 20; n < 50; n += 1) made.db.query("INSERT INTO marks VALUES (?)").run(n);
        await Bun.sleep(3000);
        expect([...fake.objects.keys()].some((key) => key.startsWith("nook/litestream/mynotes/0000/"))).toBe(true);
        const options = { settings: backupSettings(made), litestream: settings, databasePath: made.databasePath, storage: { backend: "local" as const }, trigger: "cli" as const, litestreamBin };
        const latest = await runDrill({ ...options, from: "litestream" });
        expect(latest?.ok).toBe(true);
        expect(latest?.counts.users).toBe(1);
        const target = join(made.root, "restored");
        const restored = await restoreInto({ ...options, from: `litestream@${between}`, to: target, databaseOnly: true });
        expect(restored.ok).toBe(true);
        const copy = new Database(join(target, "mynotes.sqlite"), { readonly: true });
        expect((copy.query("SELECT COUNT(*) AS n FROM marks").get() as { n: number }).n).toBe(20);
        copy.close();
      } finally {
        child.kill("SIGTERM");
        await child.exited;
      }
    } finally {
      made.db.close();
      rmSync(made.root, { recursive: true, force: true });
      fake.stop();
    }
  }, 60_000);
});
