import { addColumn, type Migration } from "./types";

/**
 * Budget alerts fire once per crossing (audit 2, TG2, D1142): `time_projects.budget_alerted` holds the
 * last alert sent as `<period>:<threshold>` (`2026-11:80`, `total:100`). The 80% and 100% alerts go
 * out the first time usage crosses them in a budget period; writes after that (and after the managers
 * read the alert) send nothing more. Changing the budget clears it.
 *
 * Needs 093. Transactional and filesystem-free; re-running changes nothing.
 */
export const timeBudgetAlertsMigration: Migration = {
  id: 120,
  name: "time_budget_alerts",
  up(db) {
    addColumn(db, "time_projects", "budget_alerted", "TEXT CHECK (budget_alerted IS NULL OR length(budget_alerted) <= 40)");
  }
};
