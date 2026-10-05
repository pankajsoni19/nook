import type { Migration } from "./types";

/**
 * Agent chat (Wave 40 "AC-A", docs/plan/research/2026-09-30-agentic-chat-module.md §10, D341–D370,
 * T302–T326). The plan called this `037_agent_chat`; 037 and 038 shipped for the vault, so it is 039.
 * One migration creates every table the module will use, so later slices (tool servers, the Audit
 * log, sharing, knowledge bases) add behaviour only:
 *
 * - `agent_settings`: instance policy rows (`key`, `value_json`, each with a revision).
 * - `agent_providers`: OpenAI-compatible endpoints; the API key is an AES-256-GCM envelope under
 *   `AGENT_SECRETS_KEY` (D354) with a plaintext hint (`sk-…a1B2`); one row is the default.
 * - `agent_tool_servers`, `agent_tool_policies`, `agent_tools`, `agent_user_links`: AC-B.
 * - `agents`: the agent record (prompt, model override, steps, starters), owner-private in AC-A,
 *   with the Bin columns.
 * - `agent_access`: module-local sharing rows (AC-D).
 * - `chats`, `chat_messages`: a chat is a tree of messages (`parent_id`, `active_leaf_id`, D360),
 *   with the Bin columns on the chat; `chat_fts` indexes titles and user messages.
 * - `chat_public_shares`: AC-D (frozen snapshots behind the `public_chat_links` policy, AC-O1).
 * - `agent_runs`, `agent_audit_entries`, `agent_audit_steps`: every run is a row (D344); the audit
 *   content tables are written by AC-C only. `agent_usage_daily` backs the budgets (§2.4).
 * - `knowledge_bases`, `kb_sources`, `kb_chunks`, `kb_chunk_fts`: AC-E.
 *
 * `api_key_grants` (025) fixes its `module`, `permission`, and `resource_kind` words in CHECK
 * constraints, which SQLite cannot alter, so this migration rebuilds that one table once with the
 * words of this plan (`agents`; `run`; `agent`, `knowledge_base`) and of the Messages plan
 * (`messages`; `post`; `channel`, 2026-09-30-messages-module.md §5), copying every row and column
 * (038's `protected_at_grant` included) and re-creating both indexes and all six triggers verbatim
 * (T326). Nothing about any key's reach changes. `access_grants_v` is re-created by AC-D when agent
 * rows join it.
 *
 * Needs 001, 005, 025, 032, and 038. Transactional and filesystem-free; re-running changes nothing
 * (the rebuild only runs while the old CHECK list lacks `agents`).
 */
export const agentChatMigration: Migration = {
  id: 39,
  name: "agent_chat",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_settings (
        key TEXT PRIMARY KEY CHECK (key IN ('enabled','default_provider_id','create_roles','chat_roles','daily_tokens_user','daily_tokens_key',
          'daily_tokens_instance','public_chat_links','audit_retention_days','agents_per_user','kbs_per_user')),
        value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 2048),
        revision INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        base_url TEXT NOT NULL CHECK (length(base_url) <= 512),
        api_key_ct TEXT,
        api_key_hint TEXT CHECK (api_key_hint IS NULL OR length(api_key_hint) <= 12),
        default_model TEXT NOT NULL CHECK (length(default_model) BETWEEN 1 AND 128),
        embedding_model TEXT CHECK (embedding_model IS NULL OR length(embedding_model) <= 128),
        embedding_dims INTEGER CHECK (embedding_dims IS NULL OR embedding_dims BETWEEN 64 AND 3072),
        compat_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(compat_json)),
        prices_json TEXT CHECK (prices_json IS NULL OR json_valid(prices_json)),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS agent_providers_one_default ON agent_providers(is_default) WHERE is_default = 1;

      CREATE TABLE IF NOT EXISTS agent_tool_servers (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 1 AND 24),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        transport TEXT NOT NULL CHECK (transport IN ('http','stdio')),
        url TEXT CHECK (url IS NULL OR length(url) <= 512),
        stdio_id TEXT,
        auth_kind TEXT NOT NULL DEFAULT 'none' CHECK (auth_kind IN ('none','bearer','header')),
        auth_header TEXT,
        secret_ct TEXT,
        secret_hint TEXT CHECK (secret_hint IS NULL OR length(secret_hint) <= 12),
        timeout_ms INTEGER NOT NULL DEFAULT 30000 CHECK (timeout_ms BETWEEN 5000 AND 120000),
        result_cap_bytes INTEGER NOT NULL DEFAULT 16384 CHECK (result_cap_bytes BETWEEN 1024 AND 65536),
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','selected','all_users')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        status TEXT NOT NULL DEFAULT 'unknown',
        last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 200),
        tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tools_json)),
        tools_synced_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((transport = 'http') = (url IS NOT NULL)),
        CHECK ((transport = 'stdio') = (stdio_id IS NOT NULL))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_tool_policies (
        server_id TEXT NOT NULL REFERENCES agent_tool_servers(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        policy TEXT NOT NULL CHECK (policy IN ('auto','confirm','off')),
        PRIMARY KEY (server_id, tool_name)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 280),
        icon TEXT CHECK (icon IS NULL OR length(icon) <= 16),
        color TEXT CHECK (color IS NULL OR length(color) <= 16),
        system_prompt TEXT NOT NULL DEFAULT '' CHECK (length(system_prompt) <= 16384),
        starters_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(starters_json)),
        provider_id TEXT REFERENCES agent_providers(id) ON DELETE SET NULL,
        model TEXT CHECK (model IS NULL OR length(model) <= 128),
        max_steps INTEGER NOT NULL DEFAULT 8 CHECK (max_steps BETWEEN 1 AND 50),
        temperature REAL CHECK (temperature IS NULL OR temperature BETWEEN 0 AND 2),
        max_output_tokens INTEGER CHECK (max_output_tokens IS NULL OR max_output_tokens BETWEEN 1 AND 16384),
        nook_direct_writes INTEGER NOT NULL DEFAULT 0 CHECK (nook_direct_writes IN (0,1)),
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','selected','all_users')),
        all_users_level TEXT NOT NULL DEFAULT 'view' CHECK (all_users_level IN ('view','manage')),
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT, deleted_by TEXT, purge_after TEXT, purge_started_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agents_owner ON agents(owner_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS agent_tools (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('server','nook','knowledge')),
        server_id TEXT REFERENCES agent_tool_servers(id) ON DELETE CASCADE,
        tool_name TEXT,
        kb_id TEXT,
        policy TEXT CHECK (policy IS NULL OR policy IN ('confirm','off'))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS agent_tools_unique ON agent_tools(agent_id, source, COALESCE(server_id,''), COALESCE(tool_name,''), COALESCE(kb_id,''));
      CREATE TABLE IF NOT EXISTS agent_access (
        resource_kind TEXT NOT NULL CHECK (resource_kind IN ('agent','knowledge_base','tool_server','chat')),
        resource_id TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        group_id TEXT REFERENCES user_groups(id) ON DELETE CASCADE,
        level TEXT NOT NULL CHECK (level IN ('view','manage')),
        granted_by TEXT,
        created_at TEXT NOT NULL,
        CHECK ((user_id IS NULL) <> (group_id IS NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_access_resource ON agent_access(resource_kind, resource_id);
      CREATE TABLE IF NOT EXISTS agent_user_links (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        nook_key_id TEXT REFERENCES mcp_api_keys(id) ON DELETE SET NULL,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
        PRIMARY KEY (agent_id, user_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        title TEXT NOT NULL CHECK (length(title) <= 120),
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
        active_leaf_id TEXT,
        always_allow_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(always_allow_json)),
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','selected','all_users')),
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT, deleted_by TEXT, purge_after TEXT, purge_started_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS chats_owner ON chats(owner_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        parent_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
        content TEXT NOT NULL DEFAULT '' CHECK (length(content) <= 262144),
        tool_calls_json TEXT CHECK (tool_calls_json IS NULL OR json_valid(tool_calls_json)),
        tool_call_id TEXT, tool_name TEXT, server_id TEXT, ok INTEGER, duration_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming','complete','error','cancelled','interrupted','awaiting_confirmation','step_limit')),
        error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
        model TEXT, usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)), run_id TEXT,
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat_id, created_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(chat_id UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
      CREATE TABLE IF NOT EXISTS chat_public_shares (
        chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND length(snapshot_json) <= 2097152),
        include_tool_results INTEGER NOT NULL DEFAULT 0 CHECK (include_tool_results IN (0,1)),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        via TEXT NOT NULL CHECK (via IN ('chat','api','mcp')),
        agent_id TEXT NOT NULL,
        agent_revision INTEGER NOT NULL,
        prompt_sha256 TEXT NOT NULL,
        preamble_version INTEGER NOT NULL,
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        key_id TEXT REFERENCES mcp_api_keys(id) ON DELETE CASCADE,
        provider_id TEXT,
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','awaiting_confirmation','ok','error','cancelled','interrupted','timeout','step_limit','budget')),
        error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
        steps INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        tokens_estimated INTEGER NOT NULL DEFAULT 0 CHECK (tokens_estimated IN (0,1)),
        cost_micros INTEGER,
        client_address TEXT,
        label TEXT CHECK (label IS NULL OR length(label) <= 60),
        queued_at TEXT NOT NULL,
        started_at TEXT, first_token_at TEXT, finished_at TEXT, purge_after TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_runs_key ON agent_runs(key_id, queued_at DESC) WHERE via <> 'chat';
      CREATE INDEX IF NOT EXISTS agent_runs_chat ON agent_runs(chat_id, queued_at DESC) WHERE chat_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS agent_runs_live ON agent_runs(status) WHERE status IN ('queued','running','awaiting_confirmation');
      CREATE TABLE IF NOT EXISTS agent_audit_entries (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        input_text TEXT NOT NULL CHECK (length(input_text) <= 131072),
        output_text TEXT CHECK (output_text IS NULL OR length(output_text) <= 262144)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_audit_steps (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('model','tool')),
        server_id TEXT, tool_name TEXT, text TEXT, args_json TEXT, result_text TEXT,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
        ok INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER,
        duration_ms INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS agent_usage_daily (
        day TEXT NOT NULL CHECK (length(day) = 10),
        user_id TEXT NOT NULL,
        key_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL,
        runs INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, user_id, key_id, agent_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
        description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 280),
        provider_id TEXT REFERENCES agent_providers(id) ON DELETE SET NULL,
        embedding_model TEXT NOT NULL,
        dims INTEGER NOT NULL CHECK (dims BETWEEN 64 AND 3072),
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','selected','all_users')),
        status TEXT NOT NULL DEFAULT 'empty',
        chunk_count INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT, deleted_by TEXT, purge_after TEXT, purge_started_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS kb_sources (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('note','document','text')),
        ref_id TEXT,
        title TEXT NOT NULL,
        text TEXT CHECK (text IS NULL OR length(text) <= 262144),
        content_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        indexed_at TEXT,
        CHECK ((kind = 'text') = (ref_id IS NULL))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS kb_chunks (
        id INTEGER PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
        ord INTEGER NOT NULL,
        heading TEXT,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS kb_chunks_kb ON kb_chunks(kb_id, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunk_fts USING fts5(text, content='kb_chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');

      -- Purging an agent, a chat, or a knowledge base (a hard DELETE; the Bin keeps rows) removes the
      -- grants and module-local access rows that name it (T206 parity).
      CREATE TRIGGER IF NOT EXISTS agents_purge_access_grants AFTER DELETE ON agents
      BEGIN
        DELETE FROM api_key_grants WHERE resource_kind = 'agent' AND resource_id = OLD.id;
        DELETE FROM agent_access WHERE resource_kind = 'agent' AND resource_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS chats_purge_access_rows AFTER DELETE ON chats
      BEGIN
        DELETE FROM agent_access WHERE resource_kind = 'chat' AND resource_id = OLD.id;
        DELETE FROM chat_fts WHERE chat_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_bases_purge_access_grants AFTER DELETE ON knowledge_bases
      BEGIN
        DELETE FROM api_key_grants WHERE resource_kind = 'knowledge_base' AND resource_id = OLD.id;
        DELETE FROM agent_access WHERE resource_kind = 'knowledge_base' AND resource_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS agent_tool_servers_purge_access AFTER DELETE ON agent_tool_servers
      BEGIN
        DELETE FROM agent_access WHERE resource_kind = 'tool_server' AND resource_id = OLD.id;
      END;
    `);

    rebuildApiKeyGrants(db);
  }
};

/** The words 025 listed, widened by this plan and the Messages plan. Every existing value stays. */
export const GRANT_WORDS = {
  module: ["notes", "files", "tasks", "today", "calendar", "collections", "team", "inbox", "bin", "whiteboards", "vault", "agents", "messages"],
  permission: ["read", "comment", "write", "draft", "publish", "create", "run", "post"],
  resourceKind: ["folder", "note", "document", "board", "task_view", "collection", "calendar", "routine", "whiteboard", "vault", "agent", "knowledge_base", "channel"]
} as const;

const quoted = (words: readonly string[]) => words.map((word) => `'${word}'`).join(",");

/**
 * The 12-step rebuild (https://www.sqlite.org/lang_altertable.html#otheralter) of `api_key_grants`
 * with the CHECK lists widened. Foreign keys stay on: the table is a child (of `mcp_api_keys`) and
 * nothing references it, so the copy and the drop pass the checks; triggers on other tables that
 * delete from it by name keep working. Idempotent: skipped once the table already accepts `agents`.
 */
export function rebuildApiKeyGrants(db: Parameters<Migration["up"]>[0]) {
  const current = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_key_grants'").get() as { sql: string } | null)?.sql ?? "";
  if (!current || /'agents'/.test(current)) return;
  // 031, 037, and 038 may reach an install after this one (each id is applied on its own): without
  // 038's column the copy writes its default, and 038 later finds the column and triggers in place.
  const columns = (db.query("PRAGMA table_info(api_key_grants)").all() as Array<{ name: string }>).map((column) => column.name);
  const protectedSource = columns.includes("protected_at_grant") ? "protected_at_grant" : "0";
  // The Messages migration (040) may have rebuilt it first with its own words: keep them too.
  db.exec(`
    CREATE TABLE api_key_grants_new (
      id TEXT PRIMARY KEY,
      key_id TEXT NOT NULL REFERENCES mcp_api_keys(id) ON DELETE CASCADE,
      module TEXT NOT NULL CHECK (module IN (${quoted(GRANT_WORDS.module)})),
      permission TEXT NOT NULL CHECK (permission IN (${quoted(GRANT_WORDS.permission)})),
      resource_kind TEXT CHECK (resource_kind IS NULL OR resource_kind IN (${quoted(GRANT_WORDS.resourceKind)})),
      resource_id TEXT CHECK (resource_id IS NULL OR length(resource_id) <= 64),
      env_id TEXT CHECK (env_id IS NULL OR length(env_id) <= 64),
      created_at TEXT NOT NULL,
      protected_at_grant INTEGER NOT NULL DEFAULT 0 CHECK (protected_at_grant IN (0,1)),
      CHECK ((resource_kind IS NULL) = (resource_id IS NULL)),
      CHECK (env_id IS NULL OR module = 'vault')
    );
    INSERT INTO api_key_grants_new (id, key_id, module, permission, resource_kind, resource_id, env_id, created_at, protected_at_grant)
      SELECT id, key_id, module, permission, resource_kind, resource_id, env_id, created_at, ${protectedSource} FROM api_key_grants;
    DROP TABLE api_key_grants;
    -- Triggers on other tables (notes_purge_access_grants, vaults_purge_access_grants, ...) name this
    -- table; with the modern rename check they would make the rename fail while the table is gone,
    -- so the rename runs in legacy mode (the documented step for exactly this case) and nothing
    -- outside the renamed table is rewritten.
    PRAGMA legacy_alter_table = ON;
    ALTER TABLE api_key_grants_new RENAME TO api_key_grants;
    PRAGMA legacy_alter_table = OFF;

    CREATE UNIQUE INDEX IF NOT EXISTS api_key_grant_unique ON api_key_grants(key_id, module, permission,
      COALESCE(resource_kind, '*'), COALESCE(resource_id, '*'), COALESCE(env_id, '*'));
    CREATE INDEX IF NOT EXISTS api_key_grants_resource ON api_key_grants(resource_kind, resource_id) WHERE resource_id IS NOT NULL;

    -- 025: the kind wall (D264).
    CREATE TRIGGER IF NOT EXISTS api_key_grants_kind_wall BEFORE INSERT ON api_key_grants
    WHEN (NEW.module = 'vault') IS NOT (SELECT kind = 'vault' FROM mcp_api_keys WHERE id = NEW.key_id)
    BEGIN SELECT RAISE(ABORT, 'KEY_KIND_WALL'); END;
    CREATE TRIGGER IF NOT EXISTS api_key_grants_kind_wall_update BEFORE UPDATE OF key_id, module ON api_key_grants
    WHEN (NEW.module = 'vault') IS NOT (SELECT kind = 'vault' FROM mcp_api_keys WHERE id = NEW.key_id)
    BEGIN SELECT RAISE(ABORT, 'KEY_KIND_WALL'); END;

    -- 038: the vault grant shape and the protected flag.
    CREATE TRIGGER IF NOT EXISTS api_key_grants_vault_shape BEFORE INSERT ON api_key_grants
    WHEN NEW.module = 'vault' AND (SELECT kind FROM mcp_api_keys WHERE id = NEW.key_id) = 'vault' AND (
      NEW.resource_kind IS NOT 'vault' OR NEW.resource_id IS NULL OR NEW.permission NOT IN ('read', 'write')
      OR (NEW.env_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault_environments e WHERE e.id = NEW.env_id AND e.vault_id = NEW.resource_id))
      OR (NEW.protected_at_grant = 1 AND (NEW.env_id IS NULL OR (SELECT vault_protected_access FROM mcp_api_keys WHERE id = NEW.key_id) IS NOT 1))
    )
    BEGIN SELECT RAISE(ABORT, 'VAULT_GRANT_SHAPE'); END;
    CREATE TRIGGER IF NOT EXISTS api_key_grants_protected_vault_only BEFORE INSERT ON api_key_grants
    WHEN NEW.protected_at_grant = 1 AND NEW.module IS NOT 'vault'
    BEGIN SELECT RAISE(ABORT, 'VAULT_GRANT_SHAPE'); END;
    CREATE TRIGGER IF NOT EXISTS api_key_grants_protected_vault_only_update BEFORE UPDATE OF protected_at_grant ON api_key_grants
    WHEN NEW.protected_at_grant = 1 AND NEW.module IS NOT 'vault'
    BEGIN SELECT RAISE(ABORT, 'VAULT_GRANT_SHAPE'); END;
    CREATE TRIGGER IF NOT EXISTS api_key_grants_vault_shape_update BEFORE UPDATE ON api_key_grants
    WHEN NEW.module = 'vault'
    BEGIN SELECT RAISE(ABORT, 'VAULT_GRANT_SHAPE'); END;
  `);
}
