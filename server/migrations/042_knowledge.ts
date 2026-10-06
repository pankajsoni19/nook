import { addColumn, type Migration } from "./types";

/**
 * Knowledge bases (Wave 44 "AC-E", docs/plan/research/2026-09-30-agentic-chat-module.md §9, §10,
 * D367–D369, T320, T321). 039 created `knowledge_bases`, `kb_sources`, `kb_chunks`, and
 * `kb_chunk_fts`, and nothing has written them before this wave, so this migration adds only what
 * indexing and search need. The Messages plan's migration, which the AC-D as-built note moved to
 * 042, moves to 043.
 *
 * - `kb_chunk_fts` is re-created with the heading path as a second column (BM25 then matches a
 *   section's title as well as its text), still an external-content table over `kb_chunks`, and
 *   kept in step by triggers: a chunk inserted is indexed, a chunk deleted (directly, or by the
 *   cascade from its source or its base) is removed. Chunks are never updated in place.
 * - `kb_sources` gains `chunk_count`, `bytes`, `added_by`, and `created_at` for the base's page; a
 *   unique index keeps one row per note or file per base, and an index serves the queue.
 * - Purging a knowledge base also removes the agents' picks of it (`agent_tools.kb_id` has no
 *   foreign key), as 039's trigger removes its grants and access rows (T206 parity).
 * - `access_grants_v` (041) already lists every `agent_access` row whatever its kind, so knowledge
 *   bases shared through the Access sheet appear there without a change.
 *
 * Needs 039. Transactional and filesystem-free; re-running changes nothing.
 */
export const knowledgeMigration: Migration = {
  id: 42,
  name: "knowledge",
  up(db) {
    const ftsColumns = (db.query("PRAGMA table_info(kb_chunk_fts)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!ftsColumns.includes("heading")) {
      db.exec(`
        DROP TABLE IF EXISTS kb_chunk_fts;
        CREATE VIRTUAL TABLE kb_chunk_fts USING fts5(heading, text, content='kb_chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
        INSERT INTO kb_chunk_fts (kb_chunk_fts) VALUES ('rebuild');
      `);
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_insert AFTER INSERT ON kb_chunks
      BEGIN
        INSERT INTO kb_chunk_fts (rowid, heading, text) VALUES (NEW.id, COALESCE(NEW.heading, ''), NEW.text);
      END;
      CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_delete AFTER DELETE ON kb_chunks
      BEGIN
        INSERT INTO kb_chunk_fts (kb_chunk_fts, rowid, heading, text) VALUES ('delete', OLD.id, COALESCE(OLD.heading, ''), OLD.text);
      END;
      CREATE TRIGGER IF NOT EXISTS kb_chunks_no_update BEFORE UPDATE ON kb_chunks
      BEGIN
        SELECT RAISE(ABORT, 'kb_chunks rows are replaced, never updated');
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_bases_purge_agent_tools AFTER DELETE ON knowledge_bases
      BEGIN
        DELETE FROM agent_tools WHERE source = 'knowledge' AND kb_id = OLD.id;
      END;

      CREATE INDEX IF NOT EXISTS knowledge_bases_owner ON knowledge_bases(owner_id, deleted_at);
      CREATE INDEX IF NOT EXISTS kb_sources_kb ON kb_sources(kb_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS kb_sources_ref ON kb_sources(kb_id, kind, ref_id) WHERE ref_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS kb_sources_ref_lookup ON kb_sources(kind, ref_id) WHERE ref_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS kb_chunks_source ON kb_chunks(source_id);
      CREATE INDEX IF NOT EXISTS agent_tools_kb ON agent_tools(kb_id) WHERE kb_id IS NOT NULL;
    `);
    addColumn(db, "kb_sources", "chunk_count", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "kb_sources", "bytes", "INTEGER");
    addColumn(db, "kb_sources", "added_by", "TEXT REFERENCES users(id) ON DELETE SET NULL");
    addColumn(db, "kb_sources", "created_at", "TEXT");
  }
};
