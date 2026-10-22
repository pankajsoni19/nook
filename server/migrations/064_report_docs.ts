import { addColumn, type Migration } from "./types";

/**
 * Reports: several docs per report, and docs on an instruction (lane DOCS, D515–D522).
 *
 * - `report_docs`: the docs a report is built from, in order (`position` 0 is the first doc). Each is a
 *   Nook note or file (`source = 'nook'`, no server) or a doc behind an admin's tool server (`server`,
 *   `server_id`, the tool and argument the person named), its link or id (`ref`), its title when last
 *   read, the SHA-256 the report was last generated (or an applied change was made) from (`hash`;
 *   NULL until then), who added it, and how: `create` (New report or Regenerate), `change` (an applied
 *   instruction that carried it), or `settings` (Doc settings). At most 8 per report (the app's rule).
 *   `reports.doc_source`, `doc_server_id`, `doc_tool`, `doc_arg`, and `doc_ref` stay as a mirror of
 *   the first doc, so readers of one doc (the browse tools, MCP, old clients) keep working, and
 *   `reports.doc_hash` is the hash of the doc set the report was generated from (the one doc's own
 *   hash when there is one, so the metric catalog's key is unchanged).
 * - `report_doc_snapshots.doc_id`: the doc a snapshot belongs to (each doc keeps its own snapshots).
 * - `report_runs.docs_json`: the docs a generation or edit read, as `[{label, docId, snapshotId,
 *   title}]` (`report_runs.doc_snapshot_id` stays the first doc's snapshot).
 * - `report_instructions.kind` (`change`, or `add`: "Add a new section") and `after_block_id` (the
 *   block the new section follows; NULL: at the end).
 * - `report_instruction_docs`: docs attached to an instruction, read with its author's access when it
 *   was added (title, hash, size, and the markdown, at most 512 KiB). An Apply adds them to the
 *   report's docs (`joined_doc_id`, or `join_note` saying why not); the markdown is cleared once the
 *   instruction is decided or ends (Apply, Reject, Cancel, and the instruction sweep for the rest;
 *   not a trigger, which would count in the status updates' changed rows), so a rejected doc's text
 *   is not kept.
 *
 * Backfill: every report with a doc link gets its one `report_docs` row (position 0, `added_via =
 * 'create'`, added by the owner, `hash` = `reports.doc_hash`, the title of its newest snapshot), and
 * its snapshots and runs point at it. Needs 050, 052, and 056. Transactional and filesystem-free;
 * re-running changes nothing.
 */
export const reportDocsMigration: Migration = {
  id: 64,
  name: "report_docs",
  up(db) {
    // A database without 050 yet (tests that apply every migration but one) has no reports (053's rule).
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get()) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_docs (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 63),
        source TEXT NOT NULL CHECK (source IN ('nook','server')),
        server_id TEXT REFERENCES agent_tool_servers(id) ON DELETE SET NULL,
        tool TEXT CHECK (tool IS NULL OR length(tool) <= 128),
        arg TEXT CHECK (arg IS NULL OR length(arg) BETWEEN 1 AND 64),
        ref TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 2048),
        title TEXT CHECK (title IS NULL OR length(title) <= 500),
        hash TEXT CHECK (hash IS NULL OR length(hash) = 64),
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        added_via TEXT NOT NULL DEFAULT 'create' CHECK (added_via IN ('create','change','settings')),
        created_at TEXT NOT NULL,
        CHECK (source = 'server' OR server_id IS NULL)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_docs_report ON report_docs(report_id, position);

      CREATE TABLE IF NOT EXISTS report_instruction_docs (
        id TEXT PRIMARY KEY,
        instruction_id TEXT NOT NULL REFERENCES report_instructions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 15),
        source TEXT NOT NULL CHECK (source IN ('nook','server')),
        server_id TEXT REFERENCES agent_tool_servers(id) ON DELETE SET NULL,
        tool TEXT CHECK (tool IS NULL OR length(tool) <= 128),
        arg TEXT CHECK (arg IS NULL OR length(arg) BETWEEN 1 AND 64),
        ref TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 2048),
        title TEXT CHECK (title IS NULL OR length(title) <= 500),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        markdown TEXT NOT NULL CHECK (length(CAST(markdown AS BLOB)) <= 524288),
        joined_doc_id TEXT,
        join_note TEXT CHECK (join_note IS NULL OR length(join_note) <= 300),
        created_at TEXT NOT NULL,
        UNIQUE (instruction_id, position)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS report_instruction_docs_kept ON report_instruction_docs(instruction_id) WHERE markdown <> '';
    `);
    addColumn(db, "report_doc_snapshots", "doc_id", "TEXT CHECK (doc_id IS NULL OR length(doc_id) <= 64)");
    db.exec("CREATE INDEX IF NOT EXISTS report_doc_snapshots_doc ON report_doc_snapshots(report_id, doc_id, fetched_at DESC)");
    addColumn(db, "report_runs", "docs_json", "TEXT CHECK (docs_json IS NULL OR (json_valid(docs_json) AND length(docs_json) <= 16384))");
    addColumn(db, "report_instructions", "kind", "TEXT NOT NULL DEFAULT 'change' CHECK (kind IN ('change','add'))");
    addColumn(db, "report_instructions", "after_block_id", "TEXT CHECK (after_block_id IS NULL OR length(after_block_id) BETWEEN 1 AND 40)");

    // Backfill: the one doc of every report that has a link, as its first doc.
    const reports = db.query(`SELECT r.id, r.owner_id, r.doc_source, r.doc_server_id, r.doc_tool, r.doc_arg, r.doc_ref, r.doc_hash, r.created_at,
        (SELECT s.title FROM report_doc_snapshots s WHERE s.report_id = r.id ORDER BY s.fetched_at DESC, s.rowid DESC LIMIT 1) AS title
      FROM reports r WHERE r.doc_ref IS NOT NULL AND length(r.doc_ref) > 0 AND NOT EXISTS (SELECT 1 FROM report_docs d WHERE d.report_id = r.id)`).all() as Array<{
      id: string; owner_id: string; doc_source: string | null; doc_server_id: string | null; doc_tool: string | null; doc_arg: string | null; doc_ref: string; doc_hash: string | null; created_at: string; title: string | null;
    }>;
    // Prepared only when there is something to copy: with foreign keys on, an INSERT into report_docs
    // needs agent_tool_servers (039) to exist, which a test database built without 039 lacks.
    if (!reports.length) return;
    const insert = db.query(`INSERT INTO report_docs (id, report_id, position, source, server_id, tool, arg, ref, title, hash, added_by, added_via, created_at)
      VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM users WHERE id = ?), 'create', ?)`);
    const snapshots = db.query("UPDATE report_doc_snapshots SET doc_id = ? WHERE report_id = ? AND doc_id IS NULL");
    for (const report of reports) {
      const id = crypto.randomUUID();
      const nook = report.doc_source === "nook";
      insert.run(id, report.id, nook ? "nook" : "server", nook ? null : report.doc_server_id, report.doc_tool?.slice(0, 128) ?? null, report.doc_arg ?? null,
        report.doc_ref.slice(0, 2048), report.title?.slice(0, 500) ?? null, report.doc_hash, report.owner_id, report.created_at);
      snapshots.run(id, report.id);
    }
  }
};
