import type { Migration } from "../types";
import { checkinsMigration } from "../099_checkins";
import { checkinsFtsMigration } from "../100_checkins_fts";

/**
 * Lane-owned migration list (docs/plan/WORKSPACE_MODULES.md §B.1): Standups' 099 (tables and purge
 * triggers) and 100 (answer search); 101 stays spare.
 */
export const checkinsMigrations: Migration[] = [checkinsMigration, checkinsFtsMigration];
