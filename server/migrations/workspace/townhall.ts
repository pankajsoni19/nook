import type { Migration } from "../types";
import { townhallMigration } from "../115_townhall";
import { townhallNamedAskerMigration } from "../116_townhall_named_asker";

/** Lane-owned migration list (docs/plan/WORKSPACE_MODULES.md §B.1): the lane appends its migrations here, in id order. 117 is unused. */
export const townhallMigrations: Migration[] = [townhallMigration, townhallNamedAskerMigration];
