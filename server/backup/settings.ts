import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { S3StorageConfig, StorageConfig } from "../config";

/**
 * Backups and Litestream from `.env` (lane BACKUP, D611–D619). Pure: config.ts passes its own S3
 * parser in, so this module imports nothing at run time and the CLI, the server, and the tests read
 * the same rules. Every malformed value refuses to start with a message naming the variable.
 */

export type BackupTarget = "local" | "s3" | "both";

/** Where archives go in a bucket: the parsed S3 settings plus the full key prefix (always ending in "/"). */
export type BackupS3Settings = Omit<S3StorageConfig, "backend" | "prefix"> & {
  /** Key prefix of the backup archives: `<S3_PREFIX><BACKUP_S3_PREFIX>` in the storage bucket, or BACKUP_S3_PREFIX in a separate one. */
  prefix: string;
  /** The S3_PREFIX the storage backend uses ("" in a separate backup bucket), so Litestream sits beside it. */
  basePrefix: string;
  /** True when BACKUP_S3_BUCKET names a bucket of its own (and its own BACKUP_S3_* credentials). */
  separate: boolean;
  /** BACKUP_S3_SSE=required: an archive the bucket did not encrypt at rest is removed and the run fails (D619). */
  sse: "off" | "required";
};

export type BackupSettings = {
  enabled: boolean;
  intervalMs: number;
  keep: number;
  target: BackupTarget;
  /** Archives, the work directory, the lock, and the status files. Default DATA_DIR/backup. */
  localDir: string;
  s3: BackupS3Settings | null;
  /** Consecutive failed runs before admins are told (bell, and mail when it is on). */
  alertAfter: number;
  /** BACKUP_DRILL_INTERVAL: a restore drill on its own schedule, or null (off, the default). */
  drillIntervalMs: number | null;
};

export type LitestreamSettings = {
  /** LITESTREAM_ENABLED=true. Replication runs only when `s3` is set too (the image's start script decides). */
  enabled: boolean;
  /** The replica: bucket, endpoint, region, and the key path `<base prefix><LITESTREAM_S3_PREFIX>mynotes`. */
  s3: (Omit<BackupS3Settings, "prefix" | "sse"> & { path: string }) | null;
  /** How long Litestream keeps snapshots and what it needs for point-in-time restore (LITESTREAM_RETENTION, default 7 days). */
  retentionMs: number;
  /** Litestream's Prometheus endpoint inside the container (LITESTREAM_METRICS_ADDR, default 127.0.0.1:9090; empty = off). */
  metricsAddr: string | null;
};

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `30m`, `6h`, `1d`, `2w` (one number and one unit), within [min, max]. */
export function parseDuration(raw: string, name: string, minMs: number, maxMs: number) {
  const match = /^(\d{1,4})\s*([mhdw])$/i.exec(raw.trim());
  const ms = match ? Number(match[1]) * UNITS[match[2]!.toLowerCase()]! : Number.NaN;
  if (!(ms >= minMs && ms <= maxMs)) throw new Error(`${name} must be a number and a unit (m, h, d, or w), such as 6h or 1d, from ${formatDuration(minMs)} to ${formatDuration(maxMs)}`);
  return ms;
}

/** 21_600_000 → "6h"; the largest unit that divides it. */
export function formatDuration(ms: number) {
  for (const unit of ["w", "d", "h", "m"] as const) if (ms % UNITS[unit]! === 0) return `${ms / UNITS[unit]!}${unit}`;
  return `${Math.round(ms / 60_000)}m`;
}

function booleanSetting(env: Record<string, string | undefined>, name: string, fallback: boolean) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function integerSetting(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= min && value <= max)) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

/** A key prefix ("backups/"): letters, digits, dots, hyphens, underscores, and slashes; no . or .. segment; ends in "/". */
function keyPrefix(env: Record<string, string | undefined>, name: string, fallback: string) {
  const raw = env[name]?.trim() || fallback;
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(raw) || raw.startsWith("/") || raw.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`${name} may hold letters, digits, dots, hyphens, underscores, and slashes (up to 100), must not start with / or contain . or .. segments`);
  }
  return raw.endsWith("/") ? raw : `${raw}/`;
}

const BACKUP_S3_NAMES = ["ENDPOINT", "REGION", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "ACCESS_KEY_ID_FILE", "SECRET_ACCESS_KEY_FILE", "ALLOW_HTTP", "TIMEOUT_MS"] as const;

type S3Parser = (env: Record<string, string | undefined>, dataRoot: string | null) => StorageConfig;

/**
 * The bucket backups and Litestream use: BACKUP_S3_BUCKET with its own BACKUP_S3_* settings when set
 * (a bucket apart from the files, perhaps another account); else the storage bucket (STORAGE_BACKEND=s3);
 * else the S3_* settings when S3_BUCKET is set although files stay local. Null when none is configured.
 */
export function parseBackupBucket(env: Record<string, string | undefined>, storage: StorageConfig, dataRoot: string | null, parseS3: S3Parser) {
  const separate = Boolean(env.BACKUP_S3_BUCKET?.trim());
  let parsed: S3StorageConfig | null = null;
  if (separate) {
    const mapped: Record<string, string | undefined> = { STORAGE_BACKEND: "s3", S3_BUCKET: env.BACKUP_S3_BUCKET, S3_PREFIX: "" };
    for (const name of BACKUP_S3_NAMES) mapped[`S3_${name}`] = env[`BACKUP_S3_${name}`];
    try {
      parsed = parseS3(mapped, dataRoot) as S3StorageConfig;
    } catch (error) {
      // The storage parser names S3_* settings; here they are the BACKUP_S3_* ones.
      throw new Error((error instanceof Error ? error.message : String(error)).replace(/\bS3_/g, "BACKUP_S3_").replace("STORAGE_BACKEND=s3 needs", "BACKUP_S3_BUCKET needs"));
    }
  } else if (storage.backend === "s3") {
    parsed = storage;
  } else if (env.S3_BUCKET?.trim()) {
    parsed = parseS3({ ...env, STORAGE_BACKEND: "s3" }, dataRoot) as S3StorageConfig;
  }
  if (!parsed) return null;
  const { backend: _backend, prefix, ...rest } = parsed;
  return { ...rest, basePrefix: separate ? "" : prefix, separate };
}

/** Backups (D611–D614). `storage` and `parseS3` come from config.ts. */
export function parseBackupSettings(env: Record<string, string | undefined>, options: { storage: StorageConfig; dataDir: string; parseS3: S3Parser }): BackupSettings {
  const enabled = booleanSetting(env, "BACKUP_ENABLED", true);
  const intervalMs = env.BACKUP_INTERVAL?.trim() ? parseDuration(env.BACKUP_INTERVAL, "BACKUP_INTERVAL", 15 * 60_000, 30 * 86_400_000) : 86_400_000;
  const keep = integerSetting(env, "BACKUP_KEEP", 14, 1, 1000);
  const alertAfter = integerSetting(env, "BACKUP_ALERT_AFTER", 2, 1, 100);
  const drillRaw = env.BACKUP_DRILL_INTERVAL?.trim().toLowerCase();
  const drillIntervalMs = !drillRaw || drillRaw === "off" ? null : parseDuration(drillRaw, "BACKUP_DRILL_INTERVAL", 3_600_000, 90 * 86_400_000);
  const dirRaw = env.BACKUP_DIR?.trim();
  if (dirRaw && !isAbsolute(dirRaw)) throw new Error("BACKUP_DIR must be an absolute path");
  const localDir = resolve(dirRaw || resolve(options.dataDir, "backup"));
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  if (real(localDir) === real(options.dataDir)) throw new Error("BACKUP_DIR must not be DATA_DIR itself (use a folder inside it, such as the default DATA_DIR/backup, or one outside it)");
  if (`${real(options.dataDir)}/`.startsWith(`${real(localDir)}/`)) throw new Error("BACKUP_DIR must not contain DATA_DIR");
  const targetRaw = env.BACKUP_TARGET?.trim().toLowerCase();
  if (targetRaw && !["local", "s3", "both"].includes(targetRaw)) throw new Error("BACKUP_TARGET must be local, s3, or both");
  const target = (targetRaw || (options.storage.backend === "s3" ? "s3" : "local")) as BackupTarget;
  const sseRaw = env.BACKUP_S3_SSE?.trim().toLowerCase() || "off";
  if (sseRaw !== "off" && sseRaw !== "required") throw new Error("BACKUP_S3_SSE must be off or required");
  const bucket = parseBackupBucket(env, options.storage, options.dataDir, options.parseS3);
  if (target !== "local" && !bucket) throw new Error(`BACKUP_TARGET=${target} needs an S3 bucket: STORAGE_BACKEND=s3, or S3_BUCKET with the S3_* settings, or BACKUP_S3_BUCKET with the BACKUP_S3_* settings`);
  const prefix = keyPrefix(env, "BACKUP_S3_PREFIX", "backups/");
  const s3 = bucket && target !== "local" ? { ...bucket, prefix: `${bucket.basePrefix}${prefix}`, sse: sseRaw as "off" | "required" } : null;
  return { enabled, intervalMs, keep, target, localDir, s3, alertAfter, drillIntervalMs };
}

/** Litestream (D615, D616). Uses the same bucket as backups (parseBackupBucket); never refuses to start for a missing bucket. */
export function parseLitestreamSettings(env: Record<string, string | undefined>, options: { storage: StorageConfig; dataDir: string; parseS3: S3Parser }): LitestreamSettings {
  const enabled = booleanSetting(env, "LITESTREAM_ENABLED", false);
  const retentionMs = env.LITESTREAM_RETENTION?.trim() ? parseDuration(env.LITESTREAM_RETENTION, "LITESTREAM_RETENTION", 3_600_000, 365 * 86_400_000) : 7 * 86_400_000;
  const metricsRaw = env.LITESTREAM_METRICS_ADDR === undefined ? "127.0.0.1:9090" : env.LITESTREAM_METRICS_ADDR.trim();
  if (metricsRaw && !/^(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(metricsRaw)) throw new Error("LITESTREAM_METRICS_ADDR must be a loopback address and port, such as 127.0.0.1:9090 (or empty to turn it off)");
  const prefix = keyPrefix(env, "LITESTREAM_S3_PREFIX", "litestream/");
  const bucket = enabled ? parseBackupBucket(env, options.storage, options.dataDir, options.parseS3) : null;
  return { enabled, s3: bucket ? { ...bucket, path: `${bucket.basePrefix}${prefix}mynotes` } : null, retentionMs, metricsAddr: metricsRaw || null };
}
