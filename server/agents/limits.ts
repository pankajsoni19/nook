import { db } from "../db";
import { AgentError } from "./status";

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

/**
 * The request slots of each surface (24 REST requests and 24 MCP requests in flight; server/restV1.ts,
 * server/mcp.ts), and the share of them a held plain run may take (Wave 42 review L2): a run that
 * is not streamed holds its request until it ends (up to 5 minutes), so at most half of a surface's
 * slots hold one; the rest stay for every other key's calls. A streamed run answers at once and holds none.
 */
export const REQUEST_SLOTS = { rest: 24, mcp: 24 } as const;
export const HELD_RUN_SLOTS = { rest: REQUEST_SLOTS.rest / 2, mcp: REQUEST_SLOTS.mcp / 2 } as const;
const held = { rest: 0, mcp: 0 };

/** Takes one held-run slot of the surface, or throws 503 `AGENT_BUSY`; returns its release (idempotent). */
export function holdPlainRun(surface: "rest" | "mcp"): () => void {
  if (held[surface] >= HELD_RUN_SLOTS[surface]) {
    throw new AgentError(503, "AGENT_BUSY", "This Nook is holding as many waiting runs as it can; stream the run (stream: true) or try again in a moment", { retryAfterSeconds: 5, scope: "instance" });
  }
  held[surface] += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held[surface] -= 1;
  };
}

/** Test hook: the held plain runs per surface. */
export const heldPlainRuns = () => ({ ...held });

/** Test hook. */
export function resetAgentRateLimitsForTests() {
  db.exec("DELETE FROM agent_rate_limits");
}
