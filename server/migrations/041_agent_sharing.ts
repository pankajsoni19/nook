import { addColumn, type Migration } from "./types";

/**
 * Agent and chat sharing (Wave 43 "AC-D", docs/plan/research/2026-09-30-agentic-chat-module.md §6.2,
 * §10, D356, D361–D363, T311, T315, T316). 039 created `agent_access` (people and groups per agent
 * or chat) and `chat_public_shares` (frozen public snapshots), so this migration adds only what
 * sharing needs on top. The Messages plan's migration, which the AC-C as-built note moved to 041,
 * moves to 042.
 *
 * - `access_grants_v` (025, D270) is re-created with `agent_access` in it: one row per person
 *   shared with directly, and one per member of a group shared with, for agents and chats (and,
 *   later, knowledge bases). The central pages read it; the 025 halves are unchanged.
 * - `agent_access` gets one row per principal and item (a unique index; the table was empty until
 *   now, since nothing wrote it before this wave) and indexes for the member access page (by
 *   person, by group).
 * - `chats.copied_from_user_id` and `chats.copied_from_name`: "Continue as a copy" (D361) keeps who
 *   the copy came from, so the copy can say "Copied from <owner>'s chat". The name is kept as it was
 *   then (the person may later leave); nothing points back at the original chat, so its owner sees
 *   nothing of the copy.
 *
 * Needs 025 and 039. Transactional and filesystem-free; re-running changes nothing.
 */
export const agentSharingMigration: Migration = {
  id: 41,
  name: "agent_sharing",
  up(db) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS agent_access_unique ON agent_access(resource_kind, resource_id, COALESCE(user_id, ''), COALESCE(group_id, ''));
      CREATE INDEX IF NOT EXISTS agent_access_user ON agent_access(user_id) WHERE user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS agent_access_group ON agent_access(group_id) WHERE group_id IS NOT NULL;

      DROP VIEW IF EXISTS access_grants_v;
      CREATE VIEW access_grants_v AS
        SELECT 'note' AS kind, note_id AS resource_id, user_id, level, 'direct' AS via, NULL AS group_id FROM note_shares
        UNION ALL SELECT 'folder', folder_id, user_id, level, 'direct', NULL FROM folder_shares
        UNION ALL SELECT 'document', document_id, user_id, level, 'direct', NULL FROM document_shares
        UNION ALL SELECT 'board', board_id, user_id, level, 'direct', NULL FROM board_members
        UNION ALL SELECT 'task_view', view_id, user_id, 'view', 'direct', NULL FROM task_view_members
        UNION ALL SELECT 'collection', collection_id, user_id, level, 'direct', NULL FROM collection_members
        UNION ALL SELECT 'calendar', calendar_id, user_id, level, 'direct', NULL FROM calendar_members
        UNION ALL SELECT g.resource_kind, g.resource_id, gm.user_id, g.level, 'group', g.group_id
          FROM group_grants g JOIN group_members gm ON gm.group_id = g.group_id
        UNION ALL SELECT a.resource_kind, a.resource_id, a.user_id, a.level, 'direct', NULL
          FROM agent_access a WHERE a.user_id IS NOT NULL
        UNION ALL SELECT a.resource_kind, a.resource_id, gm.user_id, a.level, 'group', a.group_id
          FROM agent_access a JOIN group_members gm ON gm.group_id = a.group_id WHERE a.group_id IS NOT NULL;
    `);
    addColumn(db, "chats", "copied_from_user_id", "TEXT REFERENCES users(id) ON DELETE SET NULL");
    addColumn(db, "chats", "copied_from_name", "TEXT CHECK (copied_from_name IS NULL OR length(copied_from_name) <= 120)");
  }
};
