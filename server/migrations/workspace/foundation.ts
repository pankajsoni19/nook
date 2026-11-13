import type { Migration } from "../types";
import { workspaceWordsMigration } from "../085_workspace_words";
import { workLinksMigration } from "../086_work_links";
import { questionsMigration } from "../087_questions";
import { peopleMigration } from "../088_people";
import { schedulesPublicMigration } from "../089_schedules_public";

/**
 * Wave 1 foundation migrations (W1-CORE, 085–089): 085 (workspace words: the CHECK-list rebuilds of
 * api_key_grants, proposals, notifications, team_settings; item_members, item_group_grants, and
 * access_grants_v) needs 021, 025, 039, 041, 050, and 052; 086 (work links, item activity, item
 * comments) needs 022 and 046; 087 (question sets and responses) needs 086; 088 (contact books,
 * companies, contacts) needs 083, 085, and 086; 089 (schedules, public links, verification, UI prefs)
 * needs only 001.
 */
export const foundationMigrations: Migration[] = [workspaceWordsMigration, workLinksMigration, questionsMigration, peopleMigration, schedulesPublicMigration];
