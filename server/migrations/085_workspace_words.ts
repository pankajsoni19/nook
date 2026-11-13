import type { Migration } from "./types";
import { checkWords } from "./050_reports";
import { inListWords, rebuildTable, tableSql, widenInList } from "./rebuild";
import { WORKSPACE_CONTAINER_KINDS, WORKSPACE_MODULE_IDS, WORKSPACE_PROPOSAL_KINDS, WORKSPACE_PROPOSAL_TARGETS } from "../../shared/workspaceModules";

/**
 * Workspace words (docs/plan/WORKSPACE_MODULES.md §D.0, D800, D803, D809, T510): every CHECK-listed
 * word the seven workspace modules need, once, so their lanes never rebuild a shared table.
 *
 * - `api_key_grants`: modules `forms,time,goals,checkins,crm,bookings,townhall`; resource kinds
 *   `form,time_project,goal,checkin,contact_book,booking_type,townhall_session` (050's rebuild, with
 *   the words the table holds now kept).
 * - `proposals`: kinds `time_log,goal_checkin,contact_create,contact_update,deal_create,deal_update,
 *   interaction_log,checkin_answer,form_create,townhall_question` and their target types.
 * - `notifications`: kind `module` and its columns (`module`, `topic`, `title`, `body`, `href`,
 *   `item_kind`, `item_id`, `actor_id`, `dedupe_key`), one unread row per user and dedupe key.
 * - `team_settings`: keys `public_forms`, `public_booking_pages`, `default_currency`.
 * - `item_members`, `item_group_grants`: one generic member table and one group-grant table for the
 *   seven container kinds (D803); `access_grants_v` is re-created with both unioned in. Rows go with
 *   their user or group (foreign keys cascade: the grant cleanup on user and group deletion).
 *
 * Every rebuild is the 12-step pattern (server/migrations/rebuild.ts): all rows and columns copied,
 * indexes and triggers re-created verbatim, the row count verified. Needs 001, 021, 025, 026, 039,
 * 041, 050, and 052 (it adds to their tables; any absent table is skipped). Transactional and
 * filesystem-free; re-running changes nothing (each step checks for its own word first).
 */
export const workspaceWordsMigration: Migration = {
  id: 85,
  name: "workspace_words",
  up(db) {
    rebuildGrants(db);
    rebuildProposals(db);
    rebuildNotifications(db);
    rebuildTeamSettings(db);
    createMemberTables(db);
    recreateAccessView(db);
  }
};

export const PROPOSAL_WORDS = { kinds: WORKSPACE_PROPOSAL_KINDS, targets: WORKSPACE_PROPOSAL_TARGETS } as const;
export const TEAM_SETTING_KEYS = ["public_forms", "public_booking_pages", "default_currency"] as const;
const CONTAINER_LIST = WORKSPACE_CONTAINER_KINDS.map((kind) => `'${kind}'`).join(",");

const has = (db: Parameters<Migration["up"]>[0], table: string) => tableSql(db, table) !== null;

function rebuildGrants(db: Parameters<Migration["up"]>[0]) {
  const current = tableSql(db, "api_key_grants");
  if (!current || checkWords(current, "module").includes("forms")) return;
  let next = widenInList(current, "module", WORKSPACE_MODULE_IDS);
  next = widenInList(next, "resource_kind IS NULL OR resource_kind", WORKSPACE_CONTAINER_KINDS);
  rebuildTable(db, "api_key_grants", next);
}

function rebuildProposals(db: Parameters<Migration["up"]>[0]) {
  const current = tableSql(db, "proposals");
  if (!current || inListWords(current, "kind").includes("time_log")) return;
  let next = widenInList(current, "kind", WORKSPACE_PROPOSAL_KINDS);
  next = widenInList(next, "target_type", WORKSPACE_PROPOSAL_TARGETS);
  rebuildTable(db, "proposals", next);
}

/** The columns a module notification adds (§B.7). */
const NOTIFICATION_COLUMNS = `,
  module TEXT CHECK (module IS NULL OR (length(module) BETWEEN 1 AND 20 AND module NOT GLOB '*[^a-z_]*')),
  topic TEXT CHECK (topic IS NULL OR (length(topic) BETWEEN 2 AND 40 AND topic NOT GLOB '*[^a-z0-9_.]*')),
  title TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 200),
  body TEXT CHECK (body IS NULL OR length(body) <= 500),
  href TEXT CHECK (href IS NULL OR (length(href) <= 500 AND substr(href, 1, 1) = '/' AND substr(href, 2, 1) NOT IN ('/', '\\'))),
  item_kind TEXT CHECK (item_kind IS NULL OR (length(item_kind) BETWEEN 1 AND 32 AND item_kind NOT GLOB '*[^a-z_]*')),
  item_id TEXT CHECK (item_id IS NULL OR length(item_id) <= 64),
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  dedupe_key TEXT CHECK (dedupe_key IS NULL OR length(dedupe_key) <= 120),
  CHECK (kind <> 'module' OR (module IS NOT NULL AND topic IS NOT NULL AND title IS NOT NULL AND href IS NOT NULL))`;

function rebuildNotifications(db: Parameters<Migration["up"]>[0]) {
  const current = tableSql(db, "notifications");
  if (!current || inListWords(current, "kind").includes("module")) return;
  const widened = widenInList(current, "kind", ["module"]);
  const close = widened.lastIndexOf(")");
  const next = `${widened.slice(0, close)}${NOTIFICATION_COLUMNS}${widened.slice(close)}`;
  rebuildTable(db, "notifications", next, { extraColumns: ["module", "topic", "title", "body", "href", "item_kind", "item_id", "actor_id", "dedupe_key"] });
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_unread ON notifications(user_id, dedupe_key) WHERE read_at IS NULL AND dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS notifications_item ON notifications(item_kind, item_id) WHERE item_id IS NOT NULL;
  `);
}

function rebuildTeamSettings(db: Parameters<Migration["up"]>[0]) {
  const current = tableSql(db, "team_settings");
  if (!current || inListWords(current, "key").includes("public_forms")) return;
  rebuildTable(db, "team_settings", widenInList(current, "key", TEAM_SETTING_KEYS));
}

function createMemberTables(db: Parameters<Migration["up"]>[0]) {
  if (!has(db, "users") || !has(db, "user_groups")) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_members (
      item_kind TEXT NOT NULL CHECK (item_kind IN (${CONTAINER_LIST})),
      item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 64),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      level TEXT NOT NULL CHECK (level IN ('view','comment','edit','manage')),
      added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_kind, item_id, user_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS item_members_user ON item_members(user_id, item_kind);
    CREATE TABLE IF NOT EXISTS item_group_grants (
      item_kind TEXT NOT NULL CHECK (item_kind IN (${CONTAINER_LIST})),
      item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 64),
      group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
      level TEXT NOT NULL CHECK (level IN ('view','comment','edit','manage')),
      granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_kind, item_id, group_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS item_group_grants_group ON item_group_grants(group_id);
  `);
}

/** access_grants_v with the generic member and group-grant rows unioned in (T510: nothing else changes). */
function recreateAccessView(db: Parameters<Migration["up"]>[0]) {
  const view = (db.query("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'access_grants_v'").get() as { sql: string } | null)?.sql;
  if (!view || /item_members/.test(view) || !has(db, "item_members")) return;
  const body = view.replace(/^\s*CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?"?access_grants_v"?\s+AS\s+/i, "").replace(/;\s*$/, "");
  db.exec(`
    DROP VIEW access_grants_v;
    CREATE VIEW access_grants_v AS
      ${body}
      UNION ALL SELECT m.item_kind, m.item_id, m.user_id, m.level, 'direct', NULL FROM item_members m
      UNION ALL SELECT g.item_kind, g.item_id, gm.user_id, g.level, 'group', g.group_id
        FROM item_group_grants g JOIN group_members gm ON gm.group_id = g.group_id;
  `);
}
