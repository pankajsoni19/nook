import type { Migration } from "../types";
import { formsMigration } from "../090_forms";
import { formsFtsMigration } from "../091_forms_fts";

/** Lane-owned migration list (docs/plan/WORKSPACE_MODULES.md §B.1): Forms 090 (forms, actions, runs, visits) and 091 (search); 092 is spare. */
export const formsMigrations: Migration[] = [formsMigration, formsFtsMigration];
