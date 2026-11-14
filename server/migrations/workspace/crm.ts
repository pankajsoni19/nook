import type { Migration } from "../types";
import { crmMigration } from "../102_crm";
import { crmFtsMigration } from "../103_crm_fts";
import { crmPurgeMigration } from "../104_crm_purge";

/**
 * Contacts (lane CRM, docs/plan/WORKSPACE_MODULES.md §D.5): 102 (pipelines, stages, deals,
 * interactions, lists, views, follow-ups, import jobs), 103 (search index and its triggers), 104 (purge
 * triggers). 105 is unused.
 */
export const crmMigrations: Migration[] = [crmMigration, crmFtsMigration, crmPurgeMigration];
