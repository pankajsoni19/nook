import type { Migration } from "./types";
import { addColumn } from "./types";
import { tableSql } from "./rebuild";

/**
 * Reports on "This workspace" (docs/plan/WORKSPACE_MODULES.md §D.8, lane W3-REPORTS, D1060–D1062, T600–T602).
 *
 * - `reports.source`: `clickhouse` (every report so far) or `workspace`: the report's queries are
 *   structured dataset queries (shared/datasets.ts) run on Nook's own data with each reader's access,
 *   and `datasource_id` stays NULL. The plan widened `report_datasources.kind` with a rebuild; that
 *   table is a parent (reports SET NULL, the schema cache and agent_datasources CASCADE), and the
 *   transactional runner cannot turn foreign keys off, so dropping it would fire those actions (D1060).
 *   A column on `reports` needs no rebuild.
 * - Workspace reports never keep rows (D1062): a reader's numbers are their own, computed when they
 *   open the report, so a stored row could only ever show one person's access to another. Triggers
 *   empty `rows_json` (results, parameter-set results) and `values_json` (select options) of a
 *   workspace report on insert and update, whichever code path writes them; row counts, timings, and
 *   errors stay for Runs and the status.
 *
 * Needs 050, 063, and 069 (absent tables are skipped). Transactional and filesystem-free; re-running
 * changes nothing.
 */
export const reportsWorkspaceMigration: Migration = {
  id: 113,
  name: "reports_workspace",
  up(db) {
    if (!tableSql(db, "reports")) return;
    addColumn(db, "reports", "source", "TEXT NOT NULL DEFAULT 'clickhouse' CHECK (source IN ('clickhouse','workspace'))");
    const workspace = "EXISTS (SELECT 1 FROM reports w WHERE w.id = NEW.report_id AND w.source = 'workspace')";
    if (tableSql(db, "report_results")) db.exec(`
      CREATE TRIGGER IF NOT EXISTS report_results_workspace_insert AFTER INSERT ON report_results WHEN NEW.rows_json <> '[]' AND ${workspace}
      BEGIN UPDATE report_results SET rows_json = '[]' WHERE id = NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS report_results_workspace_update AFTER UPDATE OF rows_json ON report_results WHEN NEW.rows_json <> '[]' AND ${workspace}
      BEGIN UPDATE report_results SET rows_json = '[]' WHERE id = NEW.id; END;`);
    if (tableSql(db, "report_param_results")) db.exec(`
      CREATE TRIGGER IF NOT EXISTS report_param_results_workspace_insert AFTER INSERT ON report_param_results WHEN NEW.rows_json <> '[]' AND ${workspace}
      BEGIN UPDATE report_param_results SET rows_json = '[]' WHERE id = NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS report_param_results_workspace_update AFTER UPDATE OF rows_json ON report_param_results WHEN NEW.rows_json <> '[]' AND ${workspace}
      BEGIN UPDATE report_param_results SET rows_json = '[]' WHERE id = NEW.id; END;`);
    if (tableSql(db, "report_param_options")) db.exec(`
      CREATE TRIGGER IF NOT EXISTS report_param_options_workspace_insert AFTER INSERT ON report_param_options WHEN NEW.values_json <> '[]' AND ${workspace}
      BEGIN UPDATE report_param_options SET values_json = '[]' WHERE report_id = NEW.report_id AND param_id = NEW.param_id; END;
      CREATE TRIGGER IF NOT EXISTS report_param_options_workspace_update AFTER UPDATE OF values_json ON report_param_options WHEN NEW.values_json <> '[]' AND ${workspace}
      BEGIN UPDATE report_param_options SET values_json = '[]' WHERE report_id = NEW.report_id AND param_id = NEW.param_id; END;`);
    if (tableSql(db, "report_param_linked_options")) db.exec(`
      CREATE TRIGGER IF NOT EXISTS report_param_linked_options_workspace_insert AFTER INSERT ON report_param_linked_options WHEN NEW.values_json <> '[]' AND ${workspace}
      BEGIN UPDATE report_param_linked_options SET values_json = '[]' WHERE report_id = NEW.report_id AND param_id = NEW.param_id AND parents_hash = NEW.parents_hash; END;
      CREATE TRIGGER IF NOT EXISTS report_param_linked_options_workspace_update AFTER UPDATE OF values_json ON report_param_linked_options WHEN NEW.values_json <> '[]' AND ${workspace}
      BEGIN UPDATE report_param_linked_options SET values_json = '[]' WHERE report_id = NEW.report_id AND param_id = NEW.param_id AND parents_hash = NEW.parents_hash; END;`);
  }
};
