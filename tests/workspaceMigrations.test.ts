import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registeredMigrations, runMigrations } from "../server/migrations";
import { workspaceMigrations } from "../server/migrations/workspace";
import { workspaceWordsMigration } from "../server/migrations/085_workspace_words";
import { WORKSPACE_CONTAINER_KINDS, WORKSPACE_MODULE_IDS, WORKSPACE_PROPOSAL_KINDS } from "../shared/workspaceModules";

/**
 * Migrations 085–089 on a production-shaped database (docs/plan/WORKSPACE_MODULES.md §D.0, §H, T510):
 * a file database built through 083 and filled the way a running Nook fills it (people, groups,
 * general and vault keys with every kind of grant, routines and runs, proposals of every kind and
 * status, reminder and proposal notifications, policies, member and group shares), copied, then
 * migrated. Nothing is lost: every row of the rebuilt tables is identical, access_grants_v returns the
 * same rows, the indexes and triggers on the rebuilt tables are the same, the new words are accepted,
 * and re-running changes nothing.
 */

const now = "2026-11-01T10:00:00.000Z";
const id = () => crypto.randomUUID();

function buildThrough083(path: string) {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of registeredMigrations.filter((item) => item.id <= 83)) {
    db.transaction(() => {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, now);
    })();
  }
  return db;
}

function seed(db: Database) {
  const users = { admin: id(), member: id(), guest: id(), service: id() };
  const user = db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role, kind) VALUES (?, ?, ?, 'x', ?, ?, ?)");
  user.run(users.admin, "admin@example.test", "Ada Admin", now, "admin", "person");
  user.run(users.member, "member@example.test", "Mo Member", now, "member", "person");
  user.run(users.guest, "guest@example.test", "Gus Guest", now, "guest", "person");
  user.run(users.service, "svc@example.invalid", "CI bot", now, "member", "service");
  const group = id();
  db.query("INSERT INTO user_groups (id, name, created_by, created_at, updated_at) VALUES (?, 'Engineering', ?, ?, ?)").run(group, users.admin, now, now);
  db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(group, users.member, now);
  db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(group, users.guest, now);
  // A board shared with a person and a group.
  const board = id();
  db.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at, visibility) VALUES (?, ?, 'Roadmap', ?, ?, 'selected')").run(board, users.admin, now, now);
  db.query("INSERT INTO board_members (board_id, user_id, created_at, level) VALUES (?, ?, ?, 'edit')").run(board, users.member, now);
  db.query("INSERT INTO group_grants (resource_kind, resource_id, group_id, level, granted_by, created_at) VALUES ('board', ?, ?, 'view', ?, ?)").run(board, group, users.admin, now);
  // Keys: a general key with module-wide, chosen-item, and every-module grants; a vault key with environment grants.
  const general = id();
  const vaultKey = id();
  const key = db.query("INSERT INTO mcp_api_keys (id, user_id, name, key_prefix, token_hash, created_at, kind, surfaces, vault_protected_access) VALUES (?, ?, ?, ?, ?, ?, ?, 'both', ?)");
  key.run(general, users.member, "laptop", "nk_abcd", id(), now, "general", 0);
  key.run(vaultKey, users.admin, "deploy", "nkv_abcd", id(), now, "vault", 1);
  const vault = id();
  const env = id();
  db.query("INSERT INTO vaults (id, owner_id, name, created_at, updated_at) VALUES (?, ?, 'Prod', ?, ?)").run(vault, users.admin, now, now);
  db.query("INSERT INTO vault_environments (id, vault_id, slug, name, position, created_at) VALUES (?, ?, 'prod', 'Production', 0, ?)").run(env, vault, now);
  const grant = db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, env_id, created_at, protected_at_grant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const module of ["notes", "files", "tasks", "today", "calendar", "collections", "inbox", "bin", "whiteboards", "agents", "reports"]) grant.run(id(), general, module, module === "bin" ? "write" : "read", null, null, null, now, 0);
  grant.run(id(), general, "tasks", "write", "board", board, null, now, 0);
  grant.run(id(), general, "agents", "run", "agent", id(), null, now, 0);
  grant.run(id(), vaultKey, "vault", "read", "vault", vault, null, now, 0);
  grant.run(id(), vaultKey, "vault", "write", "vault", vault, env, now, 0);
  // A routine with a run, and proposals of every built-in kind in several states.
  const routine = id();
  db.query(`INSERT INTO routines (id, owner_id, name, name_fold, instructions, output_kinds, cadence, tz, created_at, updated_at)
    VALUES (?, ?, 'Triage', 'triage', 'Do it', '["card_create"]', 'manual', 'UTC', ?, ?)`).run(routine, users.member, now, now);
  const run = id();
  db.query("INSERT INTO routine_runs (id, routine_id, owner_id, status, started_at, lease_expires_at) VALUES (?, ?, ?, 'succeeded', ?, ?)").run(run, routine, users.member, now, now);
  const proposal = db.query(`INSERT INTO proposals (id, owner_id, key_id, key_name, routine_id, run_id, kind, target_type, target_id, title, payload, status, created_at, expires_at)
    VALUES (?, ?, ?, 'laptop', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const kinds: Array<[string, string]> = [["note_draft", "note"], ["card_create", "board"], ["card_update", "card"], ["card_comment", "card"], ["event_create", "calendar"], ["event_update", "event"], ["row_create", "collection"], ["row_update", "row"]];
  for (const [index, [kind, target]] of kinds.entries()) {
    proposal.run(id(), users.member, general, index % 2 ? routine : null, index % 2 ? run : null, kind, target, id(), `Proposal ${index}`, JSON.stringify({ index }), ["pending", "applied", "rejected", "expired"][index % 4]!, now, now);
  }
  // Notifications: a fired reminder and a proposals burst, one read.
  const reminder = id();
  db.query("INSERT INTO reminders (id, user_id, title, tz, created_at) VALUES (?, ?, 'Call the bank', 'UTC', ?)").run(reminder, users.member, now);
  db.query("INSERT INTO notifications (id, user_id, reminder_id, created_at, kind) VALUES (?, ?, ?, ?, 'reminder')").run(id(), users.member, reminder, now);
  db.query("INSERT INTO notifications (id, user_id, created_at, read_at, kind, run_id, proposal_key_id, proposal_count) VALUES (?, ?, ?, ?, 'proposals', ?, ?, 3)").run(id(), users.member, now, now, run, general);
  // Policies.
  const setting = db.query("INSERT INTO team_settings (key, value_json, revision, updated_by, updated_at) VALUES (?, ?, 2, ?, ?)");
  setting.run("key_max_days", "180", users.admin, now);
  setting.run("share_with_guests", "false", users.admin, now);
  return { users, group, board, general, vaultKey };
}

const rows = (db: Database, sql: string) => db.query(sql).all() as Array<Record<string, unknown>>;
const sorted = (list: Array<Record<string, unknown>>) => list.map((row) => JSON.stringify(row)).sort();
const dependents = (db: Database, table: string) => sorted(rows(db, `SELECT type, name, sql FROM sqlite_master WHERE tbl_name = '${table}' AND type IN ('index','trigger') AND sql IS NOT NULL`));
const REBUILT = ["api_key_grants", "proposals", "notifications", "team_settings"] as const;

describe("migrations 085-089 on a production-shaped 083 database (T510)", () => {
  test("keep every grant, proposal, notification, setting, and access row; widen the words; re-run safely", () => {
    const dir = mkdtempSync(join(tmpdir(), "nook-workspace-migrations-"));
    try {
      const original = join(dir, "nook-083.sqlite");
      const built = buildThrough083(original);
      const seeded = seed(built);
      built.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      built.close();
      // A copy, as an operator would migrate a restored backup.
      const copy = join(dir, "nook-copy.sqlite");
      copyFileSync(original, copy);
      const db = new Database(copy, { strict: true });
      db.exec("PRAGMA foreign_keys = ON");
      const before = Object.fromEntries(REBUILT.map((table) => [table, sorted(rows(db, `SELECT * FROM ${table}`))]));
      const beforeDependents = Object.fromEntries(REBUILT.map((table) => [table, dependents(db, table)]));
      const beforeView = sorted(rows(db, "SELECT * FROM access_grants_v"));
      expect(before.api_key_grants!.length).toBe(15);
      expect(before.proposals!.length).toBe(8);
      expect(before.notifications!.length).toBe(2);

      expect(runMigrations(db)).toBe(workspaceMigrations.length);
      for (const table of REBUILT) {
        const after = sorted(rows(db, `SELECT ${(db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name).filter((name) => !["module", "topic", "title", "body", "href", "item_kind", "item_id", "actor_id", "dedupe_key"].includes(name) || table !== "notifications").join(", ")} FROM ${table}`));
        expect({ table, same: after }).toEqual({ table, same: before[table]! });
      }
      // The rebuilt tables keep their indexes and triggers (notifications gains two indexes).
      for (const table of ["api_key_grants", "proposals", "team_settings"] as const) expect({ table, dependents: dependents(db, table) }).toEqual({ table, dependents: beforeDependents[table]! });
      expect(dependents(db, "notifications").length).toBe(beforeDependents.notifications!.length + 2);
      // access_grants_v: every row it had, and nothing else until item members exist.
      expect(sorted(rows(db, "SELECT * FROM access_grants_v"))).toEqual(beforeView);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });

      // The new words are accepted.
      for (const module of WORKSPACE_MODULE_IDS) db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES (?, ?, ?, 'read', ?)").run(id(), seeded.general, module, now);
      for (const kind of WORKSPACE_CONTAINER_KINDS) db.query("INSERT INTO api_key_grants (id, key_id, module, permission, resource_kind, resource_id, created_at) VALUES (?, ?, 'forms', 'write', ?, ?, ?)").run(id(), seeded.general, kind, id(), now);
      for (const kind of WORKSPACE_PROPOSAL_KINDS) {
        db.query(`INSERT INTO proposals (id, owner_id, key_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at) VALUES (?, ?, ?, 'laptop', ?, 'goal', ?, 'New', '{}', ?, ?)`)
          .run(id(), seeded.users.member, seeded.general, kind, id(), now, now);
      }
      for (const key of ["public_forms", "public_booking_pages", "default_currency"]) db.query("INSERT INTO team_settings (key, value_json, updated_at) VALUES (?, 'true', ?)").run(key, now);
      // The kind wall and the vault shape triggers still guard the rebuilt grants table.
      expect(() => db.query("INSERT INTO api_key_grants (id, key_id, module, permission, created_at) VALUES (?, ?, 'forms', 'read', ?)").run(id(), seeded.vaultKey, now)).toThrow(/KEY_KIND_WALL/);
      // Module notifications: one unread row per user and dedupe key; an href must be a relative path.
      const notify = db.query(`INSERT INTO notifications (id, user_id, kind, created_at, module, topic, title, href, dedupe_key) VALUES (?, ?, 'module', ?, 'forms', 'forms.response', 'New response', ?, ?)`);
      notify.run(id(), seeded.users.member, now, "/forms/x", "k1");
      expect(() => notify.run(id(), seeded.users.member, now, "/forms/x", "k1")).toThrow(/UNIQUE/);
      expect(() => notify.run(id(), seeded.users.member, now, "//evil.example", "k2")).toThrow(/CHECK/);
      expect(() => notify.run(id(), seeded.users.member, now, "https://evil.example", "k3")).toThrow(/CHECK/);
      expect(() => db.query("INSERT INTO notifications (id, user_id, kind, created_at) VALUES (?, ?, 'module', ?)").run(id(), seeded.users.member, now)).toThrow(/CHECK/);
      // Item members and group grants join access_grants_v; they go with their user or group.
      db.query("INSERT INTO item_members (item_kind, item_id, user_id, level, created_at) VALUES ('form', 'f1', ?, 'edit', ?)").run(seeded.users.member, now);
      db.query("INSERT INTO item_group_grants (item_kind, item_id, group_id, level, created_at) VALUES ('goal', 'g1', ?, 'view', ?)").run(seeded.group, now);
      expect(rows(db, "SELECT kind, resource_id, via FROM access_grants_v WHERE kind IN ('form','goal') ORDER BY kind, user_id").length).toBe(3);
      expect(() => db.query("INSERT INTO item_members (item_kind, item_id, user_id, level, created_at) VALUES ('board', 'b1', ?, 'edit', ?)").run(seeded.users.member, now)).toThrow(/CHECK/);
      db.query("DELETE FROM user_groups WHERE id = ?").run(seeded.group);
      expect(rows(db, "SELECT 1 FROM item_group_grants").length).toBe(0);

      // Re-running 085 changes nothing.
      const snapshot = Object.fromEntries(REBUILT.map((table) => [table, sorted(rows(db, `SELECT * FROM ${table}`))]));
      db.transaction(() => workspaceWordsMigration.up(db))();
      for (const table of REBUILT) expect(sorted(rows(db, `SELECT * FROM ${table}`))).toEqual(snapshot[table]!);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("088 fills short ids by default, keeps one email per book, and purges a book's people, links, members, and grants", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    const owner = id();
    db.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, 'o@example.test', 'Owner', 'x', ?)").run(owner, now);
    const book = id();
    db.query("INSERT INTO contact_books (id, owner_id, name, created_at, updated_at) VALUES (?, ?, 'Sales', ?, ?)").run(book, owner, now, now);
    const shortId = (db.query("SELECT short_id FROM contact_books WHERE id = ?").get(book) as { short_id: string }).short_id;
    expect(shortId).toMatch(/^[0-9][0-9a-z]{9}$/);
    const contact = id();
    db.query("INSERT INTO contacts (id, book_id, display_name, created_at, updated_at) VALUES (?, ?, 'Ana', ?, ?)").run(contact, book, now, now);
    db.query("INSERT INTO contact_channels (id, book_id, contact_id, kind, value, value_norm, created_at) VALUES (?, ?, ?, 'email', 'ana@acme.test', 'ana@acme.test', ?)").run(id(), book, contact, now);
    expect(() => db.query("INSERT INTO contact_channels (id, book_id, contact_id, kind, value, value_norm, created_at) VALUES (?, ?, ?, 'email', 'ANA@acme.test', 'ana@acme.test', ?)").run(id(), book, contact, now)).toThrow(/UNIQUE/);
    db.query("INSERT INTO work_links (id, a_kind, a_id, b_kind, b_id, relation, created_at) VALUES (?, 'booking', 'bk1', 'contact', ?, 'source', ?)").run(id(), contact, now);
    db.query("INSERT INTO item_members (item_kind, item_id, user_id, level, created_at) VALUES ('contact_book', ?, ?, 'view', ?)").run(book, owner, now);
    db.query("DELETE FROM contact_books WHERE id = ?").run(book);
    for (const table of ["contacts", "contact_channels", "work_links", "item_members"]) expect({ table, rows: rows(db, `SELECT 1 FROM ${table}`).length }).toEqual({ table, rows: 0 });
  });
});
