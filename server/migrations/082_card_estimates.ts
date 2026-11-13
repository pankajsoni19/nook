import { addColumn, type Migration } from "./types";

/**
 * Card estimates (lane ESTIMATES, docs/plan/TASK_ESTIMATES.md, D750–D757):
 *
 * - `boards.estimate_kind`: what a card's estimate means on this board, `none` (the default: no
 *   field, nothing shown), `points`, or `hours` (D750).
 * - `boards.estimate_scale`: the points scale, `fibonacci` (0, 1, 2, 3, 5, 8, 13, 21; the default)
 *   or `free`; kept but unused for hours and none (D751).
 * - `cards.estimate`: one number, 0–999, or NULL for no estimate. The service also checks at most
 *   two decimals and, on a Fibonacci board, scale membership (shared/estimates.ts, D753); changing
 *   the board's kind or scale never rewrites it (D752).
 *
 * Every existing board starts with estimates off and every card without one. Needs 009.
 * Transactional and filesystem-free; re-running changes nothing.
 */
export const cardEstimatesMigration: Migration = {
  id: 82,
  name: "card_estimates",
  up(db) {
    addColumn(db, "boards", "estimate_kind", "TEXT NOT NULL DEFAULT 'none' CHECK (estimate_kind IN ('none','points','hours'))");
    addColumn(db, "boards", "estimate_scale", "TEXT NOT NULL DEFAULT 'fibonacci' CHECK (estimate_scale IN ('fibonacci','free'))");
    addColumn(db, "cards", "estimate", "REAL CHECK (estimate IS NULL OR (estimate >= 0 AND estimate <= 999))");
  }
};
