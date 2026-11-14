import type { Migration } from "../types";
import { timeMigration } from "../093_time";
import { timeSearchMigration } from "../094_time_search";

/**
 * Lane-owned migration list (docs/plan/WORKSPACE_MODULES.md §B.1): Time's 093 (projects, member rates,
 * entries, tags, approvals, reminder settings; needs 009, 083, 085, 086, 088) and 094 (entry search and
 * purge triggers; needs 093). 095 is unused.
 */
export const timeMigrations: Migration[] = [timeMigration, timeSearchMigration];
