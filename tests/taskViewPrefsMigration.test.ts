import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { registeredMigrations } from "../server/migrations";
import { taskViewPrefsMigration } from "../server/migrations/077_task_view_prefs";

/** Migration 077 (lane VIEWS, D644, T443): one person's collapsed lanes per view or My work, bounded and personal. */
describe("migration 077 task_view_prefs", () => {
  test("creates the table once; keys are a view id or my; the JSON is a bounded array; rows go with the person", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const migration of registeredMigrations.filter((item) => item.id < 77)) sqlite.transaction(() => migration.up(sqlite))();
    sqlite.transaction(() => taskViewPrefsMigration.up(sqlite))();
    sqlite.transaction(() => taskViewPrefsMigration.up(sqlite))();
    const at = "2026-10-23T00:00:00.000Z";
    sqlite.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    const insert = (key: string, lanes: string) => sqlite.query("INSERT INTO task_view_prefs (user_id, view_key, collapsed_lanes, updated_at) VALUES ('u1', ?, ?, ?)").run(key, lanes, at);
    insert("my", JSON.stringify(["s:done"]));
    insert(crypto.randomUUID(), "[]");
    expect(() => insert("other", "[]")).toThrow();
    expect(() => insert(crypto.randomUUID(), "{}")).toThrow();
    expect(() => insert(crypto.randomUUID(), "not json")).toThrow();
    expect(() => insert(crypto.randomUUID(), JSON.stringify(["x".repeat(1100)]))).toThrow();
    expect(() => insert("my", "[]")).toThrow();
    sqlite.query("DELETE FROM users WHERE id = 'u1'").run();
    expect(sqlite.query("SELECT COUNT(*) AS count FROM task_view_prefs").get()).toEqual({ count: 0 });
  });
});
