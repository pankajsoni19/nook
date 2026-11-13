import type { Migration } from "../types";

/** Lane-owned migration list (docs/plan/WORKSPACE_MODULES.md §B.1): the lane appends its migrations here, in id order. */
export const goalsMigrations: Migration[] = [];
