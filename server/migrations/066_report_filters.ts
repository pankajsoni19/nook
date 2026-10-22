import type { Migration } from "./types";

/**
 * Report filters, slice 1 (lane FILTERS, docs/plan/REPORT_FILTERS.md; D532, D534):
 *
 * - `report_param_results.query_hash`: the sha256 of a query's SQL and the bound values of only the
 *   placeholders it reads (D532). A filter change re-runs only the queries that read it; a query's
 *   result is found by this hash across every cached set of the report. NULL on rows from before
 *   066 (they are re-run once when next asked for). Indexed per report and query.
 * - `report_instructions.request_json`: the owner's structured request behind an instruction (D534:
 *   `{ kind: "add_filter", id, label, table, column, chType, optionsQuery }` or `{ kind:
 *   "remove_filter", id }`), at most 4 KiB of valid JSON; NULL for every other instruction.
 *
 * Needs 052 and 063. Transactional and filesystem-free; re-running changes nothing.
 */
export const reportFiltersMigration: Migration = {
  id: 66,
  name: "report_filters",
  up(db) {
    const has = (table: string) => Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    const columnsOf = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    // A database without 063 yet (tests that apply every migration but one) has no parameter results.
    if (has("report_param_results")) {
      if (!columnsOf("report_param_results").includes("query_hash")) {
        db.exec("ALTER TABLE report_param_results ADD COLUMN query_hash TEXT CHECK (query_hash IS NULL OR length(query_hash) = 64)");
      }
      db.exec("CREATE INDEX IF NOT EXISTS report_param_results_query ON report_param_results(report_id, query_key, query_hash)");
    }
    // A database without 052 yet has no instructions.
    if (has("report_instructions") && !columnsOf("report_instructions").includes("request_json")) {
      db.exec("ALTER TABLE report_instructions ADD COLUMN request_json TEXT CHECK (request_json IS NULL OR (json_valid(request_json) AND length(request_json) <= 4096))");
    }
  }
};
