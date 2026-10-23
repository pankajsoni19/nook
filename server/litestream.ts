import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LitestreamSettings } from "./backup/settings";
import { formatDuration, goDuration } from "./backup/settings";
import { s3Client } from "./backup/stores";
import type { LitestreamStatusView } from "../shared/backups";

/**
 * Litestream (lane BACKUP, D615–D616): continuous replication of mynotes.sqlite to S3.
 *
 * The image starts through scripts/nook-start.sh. With LITESTREAM_ENABLED=true and a bucket, it runs
 * `bun server/litestream.ts prepare /tmp/litestream.yml`, which writes the replica's settings (bucket,
 * key path, endpoint, region, retention; never a credential) and prints the credentials as shell
 * `export` lines for Litestream's own environment variables, then execs
 * `litestream replicate -exec "bun server/index.ts"`: Litestream supervises Nook, forwards SIGTERM to
 * it, and exits when it exits. Otherwise the script execs bun directly, as before.
 *
 *   bun server/litestream.ts prepare <config.yml>   exit 0 written, 3 off (or no bucket), 1 refused
 *   bun server/litestream.ts config                 prints the settings it would write (no credentials)
 */

/** Litestream's level directories (v0.5): 0000 is the raw stream, 0009 the snapshots. */
const L0 = "0000";
const SNAPSHOTS = "0009";

const isAws = (endpoint: string) => /^https:\/\/s3\.[a-z0-9-]+\.amazonaws\.com$/.test(endpoint);
const quote = (value: string) => JSON.stringify(value);

/** The replica's YAML (D615). No credential ever goes in it; `-no-expand-env` keeps `$` literal. */
export function litestreamYaml(settings: LitestreamSettings, databasePath: string) {
  const s3 = settings.s3;
  if (!s3) throw new Error("Litestream needs an S3 bucket");
  // Snapshots every day (or every retention period, when that is shorter), kept for the retention period.
  const interval = Math.min(settings.retentionMs, 86_400_000);
  const lines = [
    "# Written by Nook at start (server/litestream.ts). Credentials come from LITESTREAM_ACCESS_KEY_ID and",
    "# LITESTREAM_SECRET_ACCESS_KEY in Litestream's environment, never from this file.",
    ...(settings.metricsAddr ? [`addr: ${quote(settings.metricsAddr)}`] : []),
    // D690: only when set; otherwise Litestream's own levels (30s, 5m, 1h) and L0 retention (5m).
    ...(settings.levelsMs ? ["levels:", ...settings.levelsMs.map((ms) => `  - interval: ${goDuration(ms)}`)] : []),
    ...(settings.l0RetentionMs != null ? [`l0-retention: ${goDuration(settings.l0RetentionMs)}`] : []),
    "snapshot:",
    `  interval: ${hours(interval)}`,
    `  retention: ${hours(settings.retentionMs)}`,
    "dbs:",
    `  - path: ${quote(databasePath)}`,
    "    replica:",
    "      type: s3",
    `      bucket: ${quote(s3.bucket)}`,
    `      path: ${quote(s3.path)}`,
    `      region: ${quote(s3.region ?? "us-east-1")}`,
    ...(isAws(s3.endpoint) ? [] : [`      endpoint: ${quote(s3.endpoint)}`, "      force-path-style: true"])
  ];
  return `${lines.join("\n")}\n`;
}

/** A duration as Go understands it, in whole hours or minutes ("168h", "90m"). */
function hours(ms: number) {
  return ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** Litestream's credentials, as single-quoted shell exports (the start script evals them). */
export function litestreamExports(settings: LitestreamSettings) {
  const s3 = settings.s3;
  if (!s3) return "";
  const sh = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  return [
    `export LITESTREAM_ACCESS_KEY_ID=${sh(s3.accessKeyId)}`,
    `export LITESTREAM_SECRET_ACCESS_KEY=${sh(s3.secretAccessKey)}`,
    "export NOOK_LITESTREAM=1"
  ].join("\n");
}

/** The environment a `litestream` child needs (restore, the drill): the parent's, plus the credentials. */
export function litestreamEnv(settings: LitestreamSettings): Record<string, string | undefined> {
  return { ...process.env, LITESTREAM_ACCESS_KEY_ID: settings.s3?.accessKeyId, LITESTREAM_SECRET_ACCESS_KEY: settings.s3?.secretAccessKey };
}

export const litestreamBin = () => process.env.LITESTREAM_BIN?.trim() || Bun.which("litestream");

/** Whether this server runs under Litestream (the start script exported NOOK_LITESTREAM=1). */
export const supervisedByLitestream = () => process.env.NOOK_LITESTREAM === "1";

/**
 * Restores the replica into `outPath` (a new file), as of `timestamp` (RFC 3339) or the latest,
 * with Litestream's own full integrity check. The config (no credentials) lives in a temporary folder.
 */
export async function litestreamRestore(settings: LitestreamSettings, options: { databasePath: string; outPath: string; timestamp?: string; bin?: string | null }) {
  const bin = options.bin ?? litestreamBin();
  if (!bin) throw new Error("The litestream binary is not installed here (it is in the Docker image); set LITESTREAM_BIN to its path");
  // The config holds no credential; it goes to a private temporary folder, never next to the restored data.
  const configDir = mkdtempSync(join(tmpdir(), "nook-litestream-"));
  const configPath = join(configDir, "litestream.yml");
  writeFileSync(configPath, litestreamYaml({ ...settings, metricsAddr: null }, options.databasePath), { mode: 0o600 });
  try {
    await runRestore(bin, configPath, settings, options);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

async function runRestore(bin: string, configPath: string, settings: LitestreamSettings, options: { databasePath: string; outPath: string; timestamp?: string }) {
  const args = [bin, "restore", "-config", configPath, "-no-expand-env", "-o", options.outPath, "-integrity-check", "full", ...(options.timestamp ? ["-timestamp", options.timestamp] : []), options.databasePath];
  const child = Bun.spawn(args, { env: litestreamEnv(settings), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) {
    const reason = (stderr || stdout).split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? `exit ${code}`;
    throw new Error(`Litestream restore failed: ${reason.replace(/(access|secret)[^ ]*key[^ ]*=\S+/gi, "[redacted]").slice(0, 300)}`);
  }
}

export type LitestreamStatus = LitestreamStatusView;

function metricValue(text: string, name: string) {
  const match = new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.eE+-]+)$`, "m").exec(text);
  return match ? Number(match[1]) : null;
}

/** Litestream's state for Settings → Backups (D615). Each part is best effort with a short deadline. */
export async function litestreamStatus(settings: LitestreamSettings): Promise<LitestreamStatus> {
  const s3 = settings.s3;
  const status: LitestreamStatus = {
    enabled: settings.enabled, configured: settings.enabled && s3 !== null, active: supervisedByLitestream(),
    location: s3 ? `s3://${s3.bucket}/${s3.path} at ${new URL(s3.endpoint).host}` : null,
    retention: settings.enabled ? formatDuration(settings.retentionMs) : null,
    levels: settings.levelsMs ? settings.levelsMs.map(goDuration) : null, l0Retention: settings.l0RetentionMs != null ? goDuration(settings.l0RetentionMs) : null,
    metrics: null, replica: null, error: null
  };
  if (!status.configured || !s3) return status;
  if (status.active && settings.metricsAddr) {
    try {
      const response = await fetch(`http://${settings.metricsAddr}/metrics`, { signal: AbortSignal.timeout(1500) });
      const text = await response.text();
      const txid = metricValue(text, "litestream_txid");
      if (txid !== null) status.metrics = { txid, syncErrors: metricValue(text, "litestream_sync_error_count") ?? 0, walBytes: metricValue(text, "litestream_wal_size") ?? 0, databaseBytes: metricValue(text, "litestream_db_size") ?? 0 };
      // Something else answers on that address (Litestream could not bind it), or Litestream has no database yet.
      else status.error = `No Litestream metrics at ${settings.metricsAddr} (another program may hold that port; see LITESTREAM_METRICS_ADDR)`;
    } catch {
      status.error = "Litestream's metrics endpoint did not answer";
    }
  }
  try {
    const client = s3Client(s3);
    const newest = async (level: string) => {
      let best: { key: string; at: string } | null = null;
      let continuationToken: string | undefined;
      do {
        const page = await Promise.race([
          client.list({ prefix: `${s3.path}/${level}/`, ...(continuationToken ? { continuationToken } : {}) }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), s3.timeoutMs))
        ]);
        for (const entry of page.contents ?? []) if (!best || entry.key > best.key) best = { key: entry.key, at: entry.lastModified ?? "" };
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken);
      return best;
    };
    const latest = await newest(L0) ?? await newest("0001");
    const snapshot = await newest(SNAPSHOTS);
    const txid = latest ? Number.parseInt(/-([0-9a-f]{16})\.ltx$/.exec(latest.key)?.[1] ?? "0", 16) : 0;
    if (latest || snapshot) status.replica = { txid, uploadedAt: latest?.at ? new Date(latest.at).toISOString() : snapshot!.at, snapshotAt: snapshot?.at ? new Date(snapshot.at).toISOString() : null };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    status.error = `The replica could not be listed (${typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "no answer"})`;
  }
  return status;
}

if (import.meta.main) {
  const [command, target] = process.argv.slice(2);
  // config.ts validates every setting the server will read, so a bad .env stops here as it would at boot.
  const { config } = await import("./config");
  const settings = config.litestream;
  if (command === "config") {
    if (!settings.s3) {
      console.error(settings.enabled ? "LITESTREAM_ENABLED=true but no S3 bucket is configured" : "LITESTREAM_ENABLED is not true");
      process.exit(3);
    }
    process.stdout.write(litestreamYaml(settings, config.databasePath));
  } else if (command === "prepare" && target) {
    if (!settings.enabled) process.exit(3);
    if (!settings.s3) {
      console.error("WARNING: LITESTREAM_ENABLED=true but no S3 bucket is configured (STORAGE_BACKEND=s3, S3_BUCKET, or BACKUP_S3_BUCKET); Nook starts without Litestream.");
      process.exit(3);
    }
    const path = resolve(target);
    const real = (value: string) => { try { return realpathSync(value); } catch { return resolve(value); } };
    if (`${real(dirname(path))}/`.startsWith(`${real(config.dataDir)}/`)) {
      console.error("The Litestream config must be written outside DATA_DIR");
      process.exit(1);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, litestreamYaml(settings, config.databasePath), { mode: 0o600 });
    process.stdout.write(`${litestreamExports(settings)}\n`);
  } else {
    console.error("Usage: bun server/litestream.ts prepare <config.yml> | config");
    process.exit(2);
  }
}
