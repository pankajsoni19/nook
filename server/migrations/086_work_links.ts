import type { Migration } from "./types";

/**
 * Work links, item activity, and item comments (docs/plan/WORKSPACE_MODULES.md §B.4, §B.5, D804,
 * D805).
 *
 * - `work_links`: one row per relation between two items of any kinds (`relates`, `contributes`,
 *   `tracks`, `source`, `blocks`, `mentions`), unique per pair and relation. Kinds are free words
 *   (a lane adds a kind without a migration); existing link tables (card relations, `event_links`,
 *   `attachment_links`, card hierarchy) stay authoritative and are read by the resolver.
 * - Purge triggers on the existing item tables remove their `work_links` rows when a row is deleted
 *   for good (the Bin keeps rows, so links come back on restore). Each lane adds the same for its own.
 * - `item_activity`: the history of a workspace item (D740–D746's shapes), with an optional container.
 * - `item_comments`: comments with one level of replies; reactions (`target_kind = 'item_comment'`)
 *   and files (`attachment_links.host_kind = 'item_comment'`) go with a purged comment.
 *
 * `card_activity` is unchanged (its kind is free text; the new card kinds are rows in
 * shared/cardActivity.ts). Needs 001, 006, 009, 012, 013, 022, 046, and 050. Transactional and
 * filesystem-free; re-running changes nothing.
 */
export const workLinksMigration: Migration = {
  id: 86,
  name: "work_links",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_links (
        id TEXT PRIMARY KEY,
        a_kind TEXT NOT NULL CHECK (length(a_kind) BETWEEN 1 AND 32 AND a_kind NOT GLOB '*[^a-z_]*'),
        a_id TEXT NOT NULL CHECK (length(a_id) BETWEEN 1 AND 64),
        b_kind TEXT NOT NULL CHECK (length(b_kind) BETWEEN 1 AND 32 AND b_kind NOT GLOB '*[^a-z_]*'),
        b_id TEXT NOT NULL CHECK (length(b_id) BETWEEN 1 AND 64),
        relation TEXT NOT NULL CHECK (relation IN ('relates','contributes','tracks','source','blocks','mentions')),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_via TEXT NOT NULL DEFAULT 'web' CHECK (created_via IN ('web','mcp','rest','agent','proposal','system','public')),
        created_at TEXT NOT NULL,
        CHECK (NOT (a_kind = b_kind AND a_id = b_id))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS work_links_unique ON work_links(a_kind, a_id, b_kind, b_id, relation);
      CREATE INDEX IF NOT EXISTS work_links_b ON work_links(b_kind, b_id);

      CREATE TABLE IF NOT EXISTS item_activity (
        id TEXT PRIMARY KEY,
        item_kind TEXT NOT NULL CHECK (length(item_kind) BETWEEN 1 AND 32 AND item_kind NOT GLOB '*[^a-z_]*'),
        item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 64),
        container_kind TEXT CHECK (container_kind IS NULL OR (length(container_kind) BETWEEN 1 AND 32 AND container_kind NOT GLOB '*[^a-z_]*')),
        container_id TEXT CHECK (container_id IS NULL OR length(container_id) <= 64),
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        actor_label TEXT NOT NULL DEFAULT '' CHECK (length(actor_label) <= 120),
        via TEXT CHECK (via IS NULL OR via IN ('mcp','rest','agent','proposal','system','public')),
        kind TEXT NOT NULL CHECK (length(kind) BETWEEN 2 AND 40 AND kind NOT GLOB '*[^a-z0-9_]*'),
        payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND length(payload) <= 4096),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS item_activity_item ON item_activity(item_kind, item_id, created_at, id);
      CREATE INDEX IF NOT EXISTS item_activity_container ON item_activity(container_kind, container_id, created_at) WHERE container_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS item_comments (
        id TEXT PRIMARY KEY CHECK (length(id) = 36),
        item_kind TEXT NOT NULL CHECK (length(item_kind) BETWEEN 1 AND 32 AND item_kind NOT GLOB '*[^a-z_]*'),
        item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 64),
        parent_id TEXT REFERENCES item_comments(id) ON DELETE CASCADE,
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        body_md TEXT NOT NULL CHECK (length(body_md) <= 20000),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS item_comments_item ON item_comments(item_kind, item_id, created_at);
      CREATE INDEX IF NOT EXISTS item_comments_parent ON item_comments(parent_id) WHERE parent_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS item_comments_purge AFTER DELETE ON item_comments
      BEGIN
        DELETE FROM reactions WHERE target_kind = 'item_comment' AND target_id = OLD.id;
        DELETE FROM attachment_links WHERE host_kind = 'item_comment' AND host_id = OLD.id;
      END;
    `);
    for (const [table, kind, column] of PURGED_KINDS) {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${kind}_work_links_purge AFTER DELETE ON ${table}
        BEGIN DELETE FROM work_links WHERE (a_kind = '${kind}' AND a_id = OLD.${column}) OR (b_kind = '${kind}' AND b_id = OLD.${column}); END;`);
    }
  }
};

/** The existing item tables, the work kind of their rows, and the id column (a whiteboard is its document). */
export const PURGED_KINDS: ReadonlyArray<readonly [table: string, kind: string, column: string]> = [
  ["cards", "card", "id"], ["boards", "board", "id"], ["board_sprints", "sprint", "id"], ["notes", "note", "id"], ["documents", "document", "id"],
  ["whiteboards", "whiteboard", "document_id"], ["events", "event", "id"], ["calendars", "calendar", "id"], ["collections", "collection", "id"],
  ["collection_rows", "row", "id"], ["reports", "report", "id"]
];
