import type { Migration } from "../types";
import { goalsMigration } from "../096_goals";
import { goalsSearchMigration } from "../097_goals_search";

/** Lane-owned migration list (docs/plan/WORKSPACE_MODULES.md §B.1): Goals 096–097 (098 unused). */
export const goalsMigrations: Migration[] = [goalsMigration, goalsSearchMigration];
