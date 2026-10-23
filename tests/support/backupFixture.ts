/**
 * A small Nook data directory for the backup tests (lane BACKUP): a migrated database in WAL mode with
 * one person, a published note (and its Markdown version), a document (and its object), plus the
 * other things DATA_DIR holds (storage-instance, push keys) and the things a backup must leave out
 * (staging, a heartbeat, a temp file, the backup folder itself).
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../server/migrations";
import type { BackupSettings, LitestreamSettings } from "../../server/backup/settings";

export type Fixture = { root: string; dataDir: string; databasePath: string; backupDir: string; db: Database; userId: string; noteId: string; documentId: string };

export function makeFixture(label = "backup"): Fixture {
  const root = mkdtempSync(join(tmpdir(), `nook-${label}-`));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = join(dataDir, "mynotes.sqlite");
  const db = new Database(databasePath, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  runMigrations(db);
  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, ?, ?, 'admin')").run(userId, "owner@example.test", "Owner", "x", now);
  const noteId = crypto.randomUUID();
  db.query("INSERT INTO notes (id, owner_id, title, current_version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").run(noteId, userId, "A note", now, now);
  mkdirSync(join(dataDir, "notes", noteId, "versions"), { recursive: true });
  writeFileSync(join(dataDir, "notes", noteId, "versions", "000001.md"), "# A note\n");
  writeFileSync(join(dataDir, "notes", noteId, "current.md"), "# A note\n");
  const documentId = crypto.randomUUID();
  const bytes = Buffer.from("document bytes\n");
  db.query(`INSERT INTO documents (id, owner_id, name, mime_type, preview_kind, size_bytes, sha256, created_at, updated_at) VALUES (?, ?, 'a.txt', 'text/plain', 'text', ?, ?, ?, ?)`)
    .run(documentId, userId, bytes.byteLength, createHash("sha256").update(bytes).digest("hex"), now, now);
  mkdirSync(join(dataDir, "documents", "objects"), { recursive: true });
  writeFileSync(join(dataDir, "documents", "objects", documentId), bytes);
  mkdirSync(join(dataDir, "documents", ".staging"), { recursive: true });
  writeFileSync(join(dataDir, "documents", ".staging", `${crypto.randomUUID()}.part`), "upload in flight");
  writeFileSync(join(dataDir, "storage-instance"), `${crypto.randomUUID()} 1\n`);
  mkdirSync(join(dataDir, "push"), { recursive: true });
  writeFileSync(join(dataDir, "push", "vapid.json"), "{}\n");
  writeFileSync(join(dataDir, "server.heartbeat"), "beat");
  writeFileSync(join(dataDir, "notes", noteId, "draft.md.1234.tmp"), "half written");
  const backupDir = join(dataDir, "backup");
  return { root, dataDir, databasePath, backupDir, db, userId, noteId, documentId };
}

export function backupSettings(fixture: Pick<Fixture, "backupDir">, overrides: Partial<BackupSettings> = {}): BackupSettings {
  return { enabled: true, intervalMs: 86_400_000, keep: 14, target: "local", localDir: fixture.backupDir, s3: null, alertAfter: 2, drillIntervalMs: null, objects: "off", ...overrides };
}

export const noLitestream: LitestreamSettings = { enabled: false, s3: null, retentionMs: 7 * 86_400_000, metricsAddr: null, levelsMs: null, l0RetentionMs: null };
