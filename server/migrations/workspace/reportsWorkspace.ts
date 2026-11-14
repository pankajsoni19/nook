import type { Migration } from "../types";
import { reportsWorkspaceMigration } from "../113_reports_workspace";

/** Lane-owned migration list (docs/plan/WORKSPACE_MODULES.md §B.1): the lane appends its migrations here, in id order. 114 is unused. */
export const reportsWorkspaceMigrations: Migration[] = [reportsWorkspaceMigration];
