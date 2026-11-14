import type { Migration } from "../types";
import { townhallMigration } from "../115_townhall";

/** Lane-owned migration list (docs/plan/WORKSPACE_MODULES.md §B.1): the lane appends its migrations here, in id order. 116–117 are unused. */
export const townhallMigrations: Migration[] = [townhallMigration];
