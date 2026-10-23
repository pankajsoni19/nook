/**
 * Wire types of Settings → Backups (lane BACKUP, D611–D619): `GET /api/admin/backups`. The server's
 * status files (BACKUP_DIR/status.json, drill.json) hold the same shapes. No credential is ever in them.
 */

export type BackupTrigger = "schedule" | "manual" | "cli";

export type BackupTargetResult = { kind: "local" | "s3"; location: string; ok: boolean; error?: string; pruned?: number };

export type BackupRun = {
  id: string;
  trigger: BackupTrigger;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  ms: number;
  error?: string;
  archive?: { name: string; size: number; sha256: string; files: number; databaseBytes: number; storage: "local" | "s3"; /** D687: objects copied from the bucket (BACKUP_S3_OBJECTS=copy). */ objects?: number; objectBytes?: number };
  targets?: BackupTargetResult[];
  warnings?: string[];
};

export type BackupStatus = {
  lastRun: BackupRun | null;
  lastSuccess: BackupRun | null;
  consecutiveFailures: number;
  /** Newest first, at most 20. */
  recent: BackupRun[];
};

export type DrillCheck = { name: string; ok: boolean; detail: string; warning?: boolean };

export type DrillReport = {
  id: string;
  trigger: BackupTrigger;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  ms: number;
  source: string;
  checks: DrillCheck[];
  counts: Record<string, number>;
  error?: string;
};

export type DrillStatus = { last: DrillReport | null; recent: DrillReport[] };

export type LitestreamStatusView = {
  enabled: boolean;
  /** Enabled and a bucket is configured. */
  configured: boolean;
  /** This server runs under Litestream (the image's start script). */
  active: boolean;
  location: string | null;
  retention: string | null;
  /** D690: LITESTREAM_LEVELS ("30s", "5m", …, L1 first) and LITESTREAM_L0_RETENTION, or null for Litestream's own. */
  levels: string[] | null;
  l0Retention: string | null;
  metrics: { txid: number; syncErrors: number; walBytes: number; databaseBytes: number } | null;
  replica: { txid: number; uploadedAt: string; snapshotAt: string | null } | null;
  error: string | null;
};

export type BackupArchiveView = { name: string; size: number; createdAt: string; locations: Array<"local" | "s3">; offline: boolean };

export type BackupsView = {
  settings: {
    enabled: boolean;
    interval: string;
    keep: number;
    target: "local" | "s3" | "both";
    localDir: string;
    s3: { bucket: string; prefix: string; endpointHost: string; separate: boolean; sse: "off" | "required" } | null;
    alertAfter: number;
    drillInterval: string | null;
    storage: "local" | "s3";
    /** D687: BACKUP_S3_OBJECTS, and (with S3 storage and copy) what the bucket's live files add to each archive, from the database's sizes. */
    objects: "off" | "copy";
    objectsEstimate: { count: number; bytes: number } | null;
  };
  running: { kind: "backup" | "drill"; trigger: BackupTrigger; startedAt: string; progress?: string } | null;
  status: BackupStatus;
  nextBackupAt: string | null;
  nextDrillAt: string | null;
  drill: DrillStatus;
  archives: BackupArchiveView[];
  archivesError: string | null;
  litestream: LitestreamStatusView;
};
