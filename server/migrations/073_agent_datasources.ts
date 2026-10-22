import { addColumn, type Migration } from "./types";

/**
 * Chat agents and report data sources (lane AGENTSQL, D590–D599, T425–T429):
 *
 * - `report_datasources.agent_use`: whether chat agents may use the data source, and for whom: `off`
 *   (the default: no agent ever reaches it), `admins`, or `members` (members and admins; never
 *   viewers, guests, or integrations). An admin sets it in Settings → Report data sources.
 * - `agent_datasources`: an agent's picked data sources (the agent editor's "Data sources" section),
 *   one row per agent and data source; they go with the agent or the data source.
 * - `chat_sql_results`: the result table a `run_sql` call showed in a chat (at most 1,000 rows and
 *   512 KiB of rows), keyed by chat like `chat_tool_images` (a continued copy gets its own rows); the
 *   Bin's purge removes a chat's rows with the chat. The SQL is kept for the disclosure and "Turn into
 *   a report"; who may read a result is checked when it is read (D595).
 *
 * Needs 039 and 050. Transactional and filesystem-free; re-running changes nothing.
 */
export const agentDatasourcesMigration: Migration = {
  id: 73,
  name: "agent_datasources",
  up(db) {
    // A database without the reports tables yet (tests that apply every migration but one) gets nothing.
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'report_datasources'").get()) return;
    addColumn(db, "report_datasources", "agent_use", "TEXT NOT NULL DEFAULT 'off' CHECK (agent_use IN ('off','admins','members'))");
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_datasources (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        datasource_id TEXT NOT NULL REFERENCES report_datasources(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, datasource_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_datasources_source ON agent_datasources(datasource_id);
      CREATE TABLE IF NOT EXISTS chat_sql_results (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        datasource_id TEXT,
        user_id TEXT,
        sql TEXT NOT NULL CHECK (length(sql) <= 20000),
        sql_sha256 TEXT NOT NULL CHECK (length(sql_sha256) = 64),
        columns_json TEXT NOT NULL CHECK (json_valid(columns_json) AND length(columns_json) <= 65536),
        rows_json TEXT NOT NULL CHECK (json_valid(rows_json) AND length(rows_json) <= 524288),
        row_count INTEGER NOT NULL CHECK (row_count BETWEEN 0 AND 1000),
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
        ms INTEGER,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS chat_sql_results_message ON chat_sql_results(message_id);
    `);
  }
};
