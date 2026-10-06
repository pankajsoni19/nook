import { db } from "../db";

/**
 * Per-key run limits for API and MCP runs (Wave 42 "AC-C", plan §7.2, T314): 20 runs a minute and
 * 500 a UTC day per key, kept in SQLite (`agent_rate_limits`, migration 040) so a restart does not
 * reset them. Concurrency (2 per key) is in memory with the live runs (server/agents/runs.ts).
 *
 * The minute is a sliding window estimated from the current and previous fixed windows (the vault's
 * pattern, server/vault/limits.ts); the day is the fixed UTC day, like the token budgets. Both are
 * checked before either is charged, so a refused run costs nothing anywhere.
 */
export const KEY_RUN_LIMITS = {
  minute: { limit: 20, windowMs: 60_000 },
  day: { limit: 500, windowMs: 86_400_000 }
} as const;

type Row = { window_start: number; count: number; previous_count: number };

/** Checks and charges one run for the key. Returns 0 when admitted, else the seconds to wait. */
export function chargeKeyRun(keyId: string, nowMs = Date.now()): number {
  return db.transaction(() => {
    const planned: Array<{ bucket: string; windowStart: number; count: number; previous: number }> = [];
    for (const [name, { limit, windowMs }] of Object.entries(KEY_RUN_LIMITS)) {
      const bucket = `run_${name}:${keyId}`;
      const windowStart = Math.floor(nowMs / windowMs) * windowMs;
      const row = db.query("SELECT window_start, count, previous_count FROM agent_rate_limits WHERE bucket = ?").get(bucket) as Row | null;
      const count = row && row.window_start === windowStart ? row.count : 0;
      const previous = row && row.window_start === windowStart ? row.previous_count : row && row.window_start === windowStart - windowMs ? row.count : 0;
      // The day is fixed (it resets at midnight UTC); the minute slides.
      const estimate = name === "day" ? count : previous * (1 - (nowMs - windowStart) / windowMs) + count;
      if (estimate + 1 > limit) return Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000));
      planned.push({ bucket, windowStart, count, previous });
    }
    for (const plan of planned) {
      db.query(`INSERT INTO agent_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, ?, ?)
        ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = excluded.count, previous_count = excluded.previous_count`)
        .run(plan.bucket, plan.windowStart, plan.count + 1, plan.previous);
    }
    return 0;
  })();
}

/** Today's runs for a key so far (GET /api/v1/me-style answers and tests). */
export function keyRunsToday(keyId: string, nowMs = Date.now()) {
  const windowStart = Math.floor(nowMs / KEY_RUN_LIMITS.day.windowMs) * KEY_RUN_LIMITS.day.windowMs;
  const row = db.query("SELECT window_start, count FROM agent_rate_limits WHERE bucket = ?").get(`run_day:${keyId}`) as Row | null;
  return row && row.window_start === windowStart ? row.count : 0;
}

/** Drops the windows older than a day (the hourly sweep). */
export function sweepAgentRateLimits(nowMs = Date.now()) {
  return db.query("DELETE FROM agent_rate_limits WHERE window_start < ?").run(nowMs - 2 * KEY_RUN_LIMITS.day.windowMs).changes;
}

/** Test hook. */
export function resetAgentRateLimitsForTests() {
  db.exec("DELETE FROM agent_rate_limits");
}
