import { db } from "../db";
import { backupInProgress } from "../backup/service";
import { logger } from "../log";
import { nextFireIso, type ScheduleRule } from "../../shared/schedules";
import { scheduleHandler, toSchedule, type ScheduleRow } from "./service";

const slog = logger("schedules");

/**
 * The schedules dispatcher (docs/plan/WORKSPACE_MODULES.md §B.6, D808, T504), on the reminders
 * pattern: a 30 s unref'd tick, one at a time, at most 200 due schedules per tick, paused while a
 * backup reads DATA_DIR (like the sweeper).
 *
 * Each due schedule is claimed (`claimed_at`), then its occurrence is written to `schedule_fires`
 * (primary key `(schedule_id, fire_at)`) **before** the handler runs. A second tick, a second process,
 * or a restart after a crash between claim and finish finds the row and never runs that occurrence
 * again: at most once per occurrence. The handler runs in its own transaction (sync handlers) and its
 * failure is recorded (`failed`, the error's first 200 characters) without retrying the occurrence.
 * Then the next fire is computed after the later of the occurrence and now (missed occurrences after
 * an outage are not replayed one by one), and the claim is released.
 */

export const SCHEDULE_TICK_MS = 30_000;
export const SCHEDULE_BATCH = 200;
/** A claim older than this is left from a crash and is released. */
export const SCHEDULE_CLAIM_TIMEOUT_MS = 5 * 60_000;
/** Fire history is kept 90 days (§H). */
export const SCHEDULE_FIRES_RETENTION_MS = 90 * 86_400_000;

const iso = (ms: number) => new Date(ms).toISOString();

export type ScheduleTickCounts = { ran: number; failed: number; skipped: number; duplicate: number; unhandled: number };

let ticking = false;

/** Releases claims left by a crash (their occurrences stay recorded, so nothing runs twice). */
export function releaseStaleScheduleClaims(nowMs = Date.now()) {
  return db.query("UPDATE schedules SET claimed_at = NULL WHERE claimed_at IS NOT NULL AND claimed_at < ?").run(iso(nowMs - SCHEDULE_CLAIM_TIMEOUT_MS)).changes;
}

function advance(row: ScheduleRow, fireAt: string, nowMs: number, fired: boolean) {
  const rule = JSON.parse(row.rule_json) as ScheduleRule;
  const next = nextFireIso(rule, row.tz, Math.max(Date.parse(fireAt), nowMs));
  db.query("UPDATE schedules SET next_fire_at = ?, claimed_at = NULL, last_fired_at = CASE WHEN ? THEN ? ELSE last_fired_at END, updated_at = ? WHERE id = ?")
    .run(next, fired ? 1 : 0, fireAt, iso(nowMs), row.id);
}

function finishFire(row: ScheduleRow, fireAt: string, status: "done" | "failed" | "skipped_late", nowMs: number, error?: string) {
  db.query("UPDATE schedule_fires SET status = ?, error = ?, finished_at = ? WHERE schedule_id = ? AND fire_at = ?").run(status, error?.slice(0, 200) ?? null, iso(nowMs), row.id, fireAt);
}

/** One tick at `nowMs` (tests pass a clock). Single-flight; returns null when another tick runs or a backup is in progress. */
export async function runScheduleTick(options: { nowMs?: number } = {}): Promise<ScheduleTickCounts | null> {
  if (ticking) return null;
  if (backupInProgress()) return null;
  ticking = true;
  const counts: ScheduleTickCounts = { ran: 0, failed: 0, skipped: 0, duplicate: 0, unhandled: 0 };
  try {
    const nowMs = options.nowMs ?? Date.now();
    releaseStaleScheduleClaims(nowMs);
    const due = db.query("SELECT * FROM schedules WHERE enabled = 1 AND claimed_at IS NULL AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at LIMIT ?")
      .all(iso(nowMs), SCHEDULE_BATCH) as ScheduleRow[];
    for (const row of due) {
      const fireAt = row.next_fire_at!;
      // Claim and record the occurrence in one transaction: whoever inserts the fire row runs it.
      const claim = db.transaction(() => {
        if (db.query("UPDATE schedules SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL AND next_fire_at = ?").run(iso(nowMs), row.id, fireAt).changes !== 1) return "lost" as const;
        const inserted = db.query("INSERT OR IGNORE INTO schedule_fires (schedule_id, fire_at, status, started_at) VALUES (?, ?, 'running', ?)").run(row.id, fireAt, iso(nowMs)).changes;
        return inserted === 1 ? "run" as const : "duplicate" as const;
      })();
      if (claim === "lost") continue;
      if (claim === "duplicate") {
        // Already fired (a crash after the fire row, before the advance): never again (T504).
        advance(row, fireAt, nowMs, false);
        counts.duplicate += 1;
        continue;
      }
      const handler = scheduleHandler(row.purpose);
      if (!handler) {
        // The module is not installed (or no longer registers it): record and move on.
        finishFire(row, fireAt, "failed", nowMs, "no handler");
        advance(row, fireAt, nowMs, false);
        counts.unhandled += 1;
        continue;
      }
      if (handler.skipIfLateMs !== undefined && nowMs - Date.parse(fireAt) > handler.skipIfLateMs) {
        finishFire(row, fireAt, "skipped_late", nowMs);
        advance(row, fireAt, nowMs, false);
        counts.skipped += 1;
        continue;
      }
      try {
        const schedule = toSchedule(row);
        let pending: Promise<void> | null = null;
        db.transaction(() => {
          const result = handler.run(schedule, fireAt);
          if (result instanceof Promise) pending = result;
        })();
        if (pending) await pending;
        finishFire(row, fireAt, "done", nowMs);
        counts.ran += 1;
      } catch (error) {
        slog.error(`Schedule handler failed: purpose=${row.purpose}`, error);
        finishFire(row, fireAt, "failed", nowMs, error instanceof Error ? error.message : "failed");
        counts.failed += 1;
      }
      advance(row, fireAt, nowMs, true);
    }
  } finally {
    ticking = false;
  }
  return counts;
}

/** Sweeper step: fire history older than 90 days. */
export function sweepScheduleFires(nowMs = Date.now()) {
  return db.query("DELETE FROM schedule_fires WHERE started_at < ?").run(iso(nowMs - SCHEDULE_FIRES_RETENTION_MS)).changes;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts the 30 s tick (not under tests, which drive ticks with a clock). */
export function startScheduleDispatcher() {
  if (timer) return;
  if (process.env.NODE_ENV === "test") return;
  timer = setInterval(() => {
    runScheduleTick().catch((error) => slog.error("Schedule tick failed", error));
  }, SCHEDULE_TICK_MS);
  timer.unref();
}
