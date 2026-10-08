import { db } from "../db";
import { chargeRateWindows } from "../agents/limits";

/**
 * Knowledge limits kept in SQLite (`agent_rate_limits`, migration 040), so a restart forgets
 * neither (2026-10-08, the AC-E deferred items):
 *
 * - **`search_knowledge` through keys:** 60 searches a minute (sliding) and 2,000 a UTC day (fixed)
 *   per key, on top of the generic per-key MCP and REST limits (server/mcpRateLimit.ts), which every
 *   call is charged first. A refused search costs nothing more: no query embedding, no tokens.
 * - **Re-index all and Change embedding model:** once an hour per base, for everyone (owner
 *   included). Both re-embed every source at the owner's token cost, so they share one bucket. The
 *   row holds the time of the last one (`window_start`); the hourly sweep drops rows older than two
 *   days (`sweepAgentRateLimits`).
 */

export const KNOWLEDGE_SEARCH_LIMITS = {
  minute: { limit: 60, windowMs: 60_000 },
  day: { limit: 2_000, windowMs: 86_400_000 }
} as const;

/** Charges one key search. Returns 0 when admitted, else the seconds to wait. */
export function chargeKeySearch(keyId: string, nowMs = Date.now()): number {
  return chargeRateWindows([
    { bucket: `kb_search_minute:${keyId}`, ...KNOWLEDGE_SEARCH_LIMITS.minute },
    { bucket: `kb_search_day:${keyId}`, ...KNOWLEDGE_SEARCH_LIMITS.day, fixed: true }
  ], nowMs);
}

const reindexBucket = (kbId: string) => `kb_reindex:${kbId}`;

/** When the base was last re-indexed (or its model changed), in ms, or null. */
export function lastReindexAt(kbId: string): number | null {
  const row = db.query("SELECT window_start FROM agent_rate_limits WHERE bucket = ?").get(reindexBucket(kbId)) as { window_start: number } | null;
  return row?.window_start ?? null;
}

/** Records a re-index (or a model change) of the base now. */
export function recordReindex(kbId: string, atMs = Date.now()) {
  db.query(`INSERT INTO agent_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, 1, 0)
    ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = 1, previous_count = 0`).run(reindexBucket(kbId), atMs);
}

/** Test hook: forget every base's last re-index. */
export function resetReindexLimitsForTests() {
  db.query("DELETE FROM agent_rate_limits WHERE bucket LIKE 'kb_reindex:%'").run();
}
