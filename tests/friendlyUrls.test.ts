import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { registeredMigrations } from "../server/migrations";
import { shortIdsMigration } from "../server/migrations/083_short_ids";
import { isShortId, itemPath, newShortId, shortIdOfSegment, slugify, slugSegment, SLUG_MAX } from "../shared/friendlyUrls";

const { boardPath, cardPath, collectionPath, collectionRowPath, documentPath, notePath, reportPath, sprintsPath, whiteboardPath } = await import("../server/friendlyPaths");
const { paths } = await import("../server/mail/links");
const { templatePath } = await import("../server/httpLog");

/**
 * Friendly URLs (docs/plan/FRIENDLY_URLS.md, D770–D789, T490–T492, migration 083): the shared slug and
 * short-id helpers, the migration's backfill and insert trigger, the generic resolver
 * (GET /api/links/:kind/:ref) with access-denied ≡ not-found, the server's link builders, and the log.
 */

async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, text, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}
const resolve = (session: Session, kind: string, ref: string) => call(session, "GET", `/links/${kind}/${encodeURIComponent(ref)}`);

describe("slugs and short ids (shared/friendlyUrls.ts, D771, D772)", () => {
  test("slugify lowercases, folds accents, transliterates the easy letters, drops other scripts, collapses dashes", () => {
    expect(slugify("Release Checklist")).toBe("release-checklist");
    expect(slugify("  Café crème — Q3/Q4 plans!  ")).toBe("cafe-creme-q3-q4-plans");
    expect(slugify("Straße & Øresund")).toBe("strasse-and-oresund");
    expect(slugify("Łódź Ærø")).toBe("lodz-aero");
    expect(slugify("---a___b---")).toBe("a-b");
    expect(slugify("日本語のノート")).toBe("");
    expect(slugify("Notes 日本 2026 🎉")).toBe("notes-2026");
    expect(slugify("")).toBe("");
    expect(slugify(null)).toBe("");
    const long = slugify("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(long.endsWith("-")).toBe(false);
    expect(slugify("x".repeat(100)).length).toBe(SLUG_MAX);
    expect(slugSegment("Release checklist", "3f9x2ab01k")).toBe("release-checklist-3f9x2ab01k");
    expect(slugSegment("", "3f9x2ab01k")).toBe("untitled-3f9x2ab01k");
    expect(slugSegment("日本語", "3f9x2ab01k")).toBe("untitled-3f9x2ab01k");
    expect(itemPath("note", "Release checklist", "3f9x2ab01k")).toBe("/notes/release-checklist-3f9x2ab01k");
    expect(itemPath("report", null, "3f9x2ab01k")).toBe("/reports/untitled-3f9x2ab01k");
  });

  test("short ids are ten base36 characters starting with a digit, random and unique; segments yield them in any case", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 20_000; index += 1) {
      const id = newShortId();
      expect(isShortId(id)).toBe(true);
      seen.add(id);
    }
    expect(seen.size).toBe(20_000);
    expect(shortIdOfSegment("release-checklist-3f9x2ab01k")).toBe("3f9x2ab01k");
    expect(shortIdOfSegment("Release-Checklist-3F9X2AB01K")).toBe("3f9x2ab01k");
    expect(shortIdOfSegment("3f9x2ab01k")).toBe("3f9x2ab01k");
    expect(shortIdOfSegment("wrong-slug-entirely-3f9x2ab01k")).toBe("3f9x2ab01k");
    // A word, a UUID, a card key, a short id without its leading digit, or an encoded mess is never one.
    for (const bad of ["objectives", "quarterly-objectives", "0b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f70", "MYT-12", "abcdefghij", "x-3f9x2ab01", "%E0%A4%A", "", undefined]) expect(shortIdOfSegment(bad)).toBeNull();
  });
});

describe("migration 083", () => {
  test("backfills a unique short id on every note and collection (binned ones too), and new rows get one from the trigger", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const migration of registeredMigrations.filter((item) => item.id < 83)) sqlite.transaction(() => migration.up(sqlite))();
    const at = "2026-11-01T00:00:00.000Z";
    sqlite.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    for (let index = 0; index < 50; index += 1) {
      sqlite.query("INSERT INTO notes (id, owner_id, title, created_at, updated_at, deleted_at) VALUES (?, 'u1', ?, ?, ?, ?)").run(`n${index}`, `Note ${index}`, at, at, index % 7 === 0 ? at : null);
      sqlite.query("INSERT INTO collections (id, owner_id, name, schema_json, created_at, updated_at) VALUES (?, 'u1', ?, '{\"fields\":[]}', ?, ?)").run(`c${index}`, `Collection ${index}`, at, at);
    }
    sqlite.transaction(() => shortIdsMigration.up(sqlite))();
    for (const table of ["notes", "collections"]) {
      const ids = (sqlite.query(`SELECT short_id FROM ${table}`).all() as Array<{ short_id: string | null }>).map((row) => row.short_id);
      expect(ids.every((id) => isShortId(id))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // Re-running changes nothing.
    const before = sqlite.query("SELECT id, short_id FROM notes ORDER BY id").all();
    sqlite.transaction(() => shortIdsMigration.up(sqlite))();
    expect(sqlite.query("SELECT id, short_id FROM notes ORDER BY id").all()).toEqual(before);
    // The insert trigger, one fresh id per row, even within one statement.
    sqlite.exec(`INSERT INTO notes (id, owner_id, title, created_at, updated_at) VALUES ('m1', 'u1', 'A', '${at}', '${at}'), ('m2', 'u1', 'B', '${at}', '${at}')`);
    const fresh = (sqlite.query("SELECT short_id FROM notes WHERE id IN ('m1', 'm2')").all() as Array<{ short_id: string }>).map((row) => row.short_id);
    expect(fresh.every((id) => isShortId(id))).toBe(true);
    expect(fresh[0]).not.toBe(fresh[1]);
    // An explicit id is kept; a duplicate is refused by the unique index; the CHECK refuses a malformed one.
    sqlite.query("INSERT INTO notes (id, owner_id, title, created_at, updated_at, short_id) VALUES ('m3', 'u1', 'C', ?, ?, '9aaaaaaaaa')").run(at, at);
    expect(sqlite.query("SELECT short_id FROM notes WHERE id = 'm3'").get()).toEqual({ short_id: "9aaaaaaaaa" });
    expect(() => sqlite.query("INSERT INTO notes (id, owner_id, title, created_at, updated_at, short_id) VALUES ('m4', 'u1', 'D', ?, ?, '9aaaaaaaaa')").run(at, at)).toThrow();
    expect(() => sqlite.query("INSERT INTO notes (id, owner_id, title, created_at, updated_at, short_id) VALUES ('m5', 'u1', 'E', ?, ?, 'ABCDEFGHIJ')").run(at, at)).toThrow();
    for (const table of ["notes", "documents", "collections", "reports"]) {
      expect(sqlite.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_${table}_short_id'`).get()).toBeTruthy();
      expect(sqlite.query(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_${table}_short_id'`).get()).toBeTruthy();
    }
  });
});

describe("GET /api/links/:kind/:ref (D775, T490)", () => {
  test("resolves notes, whiteboards, collections, and boards the caller can read; anything else is the same 404 with no title", async () => {
    const owner = await createUser("friendly-owner");
    const other = await createUser("friendly-other");

    const note = (await call(owner, "POST", "/notes", {})).body.note as { id: string };
    db.query("UPDATE notes SET title = 'Secret plans' WHERE id = ?").run(note.id);
    const noteShort = (db.query("SELECT short_id FROM notes WHERE id = ?").get(note.id) as { short_id: string }).short_id;
    expect(isShortId(noteShort)).toBe(true);
    const whiteboard = (await call(owner, "POST", "/whiteboards", { name: "Launch map" })).body.whiteboard as { id: string; short_id: string };
    expect(isShortId(whiteboard.short_id)).toBe(true);
    const collection = (await call(owner, "POST", "/collections", { name: "Hiring pipeline" })).body.collection as { id: string; short_id: string };
    expect(isShortId(collection.short_id)).toBe(true);
    const board = (await call(owner, "POST", "/tasks/boards", { name: "Friendly board", code: "FUB" })).body.board as { id: string; code: string };

    // The owner: every kind, by a whole segment, a bare short id, a stale slug, any case.
    expect((await resolve(owner, "note", `whatever-${noteShort}`)).body).toEqual({ id: note.id, title: "Secret plans" });
    expect((await resolve(owner, "note", noteShort.toUpperCase())).body.id).toBe(note.id);
    expect((await resolve(owner, "whiteboard", whiteboard.short_id)).body).toEqual({ id: whiteboard.id, title: "Launch map" });
    expect((await resolve(owner, "collection", `old-name-${collection.short_id}`)).body).toEqual({ id: collection.id, title: "Hiring pipeline" });
    expect((await resolve(owner, "board", "fub")).body).toEqual({ id: board.id, code: "FUB" });
    // A whiteboard is not a file, and a note's short id is not a collection's.
    expect((await resolve(owner, "file", whiteboard.short_id)).status).toBe(404);
    expect((await resolve(owner, "collection", noteShort)).status).toBe(404);

    // Someone who cannot read them: exactly the answer for an id that does not exist (T490).
    const unknown = await resolve(other, "note", "9zzzzzzzzz");
    expect(unknown.status).toBe(404);
    for (const [kind, ref] of [["note", noteShort], ["whiteboard", whiteboard.short_id], ["collection", collection.short_id], ["board", "FUB"]] as const) {
      const denied = await resolve(other, kind, ref);
      expect(denied.status).toBe(404);
      expect(denied.text).toBe(unknown.text);
      expect(denied.text).not.toContain("Secret");
    }
    // Malformed refs and kinds are the same 404.
    for (const [kind, ref] of [["note", "not-a-short-id"], ["vault", noteShort], ["board", "1AB"]] as const) expect((await resolve(owner, kind, ref)).text).toBe(unknown.text);

    // A binned note no longer resolves, for its owner either.
    db.query("UPDATE notes SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), note.id);
    expect((await resolve(owner, "note", noteShort)).text).toBe(unknown.text);

    // A board's former code still resolves to it, with the current code (D714).
    expect((await call(owner, "PATCH", `/tasks/boards/${board.id}`, { code: "FUB2" })).status).toBe(200);
    expect((await resolve(owner, "board", "FUB")).body).toEqual({ id: board.id, code: "FUB2" });
  });
});

describe("links the server writes (D780)", () => {
  test("cards by key, boards by code, items by slug and short id; the UUID form for rows without one", async () => {
    const owner = await createUser("friendly-links");
    const board = (await call(owner, "POST", "/tasks/boards", { name: "Links board", code: "FUL" })).body as { board: { id: string }; columns: Array<{ id: string }> };
    const card = (await call(owner, "POST", `/tasks/boards/${board.board.id}/cards`, { columnId: board.columns[0]!.id, title: "Write docs" })).body.card as { id: string; number: number };
    expect(cardPath(board.board.id, card.id)).toBe(`/tasks/FUL-${card.number}`);
    expect(paths.card(board.board.id, card.id)).toBe(`/tasks/FUL-${card.number}`);
    expect(boardPath(board.board.id)).toBe("/tasks/FUL");
    expect(sprintsPath(board.board.id)).toBe("/tasks/FUL/sprints");
    expect(paths.board(board.board.id.toUpperCase())).toBe("/tasks/FUL");

    const whiteboard = (await call(owner, "POST", "/whiteboards", { name: "Q3 Roadmap: Café" })).body.whiteboard as { id: string; short_id: string };
    expect(whiteboardPath(whiteboard.id)).toBe(`/whiteboards/q3-roadmap-cafe-${whiteboard.short_id}`);
    expect(documentPath(whiteboard.id)).toBe(`/whiteboards/q3-roadmap-cafe-${whiteboard.short_id}`);
    const collection = (await call(owner, "POST", "/collections", { name: "Bugs" })).body.collection as { id: string; short_id: string };
    expect(collectionPath(collection.id)).toBe(`/collections/bugs-${collection.short_id}`);
    const rowId = crypto.randomUUID();
    expect(collectionRowPath(collection.id, rowId)).toBe(`/collections/bugs-${collection.short_id}/row/${rowId}`);
    const note = (await call(owner, "POST", "/notes", {})).body.note as { id: string };
    const noteShort = (db.query("SELECT short_id FROM notes WHERE id = ?").get(note.id) as { short_id: string }).short_id;
    expect(notePath(note.id)).toBe(`/notes/new-note-${noteShort}`);
    expect(paths.note(note.id)).toBe(`/notes/new-note-${noteShort}`);

    // Unknown rows (a mail preview's sample ids): the long form the app always accepted.
    const ghost = crypto.randomUUID();
    expect(cardPath(ghost, ghost)).toBe(`/tasks/${ghost}/card/${ghost}`);
    expect(notePath(ghost)).toBe(`/notes/${ghost}`);
    expect(reportPath(ghost)).toBe(`/reports/${ghost}`);
    expect(documentPath(ghost)).toBe(`/files/${ghost}`);
    expect(() => notePath("../etc")).toThrow();
  });

  test("the request log keeps only an app page's first segment, never a title, folder, code, or key (T491)", () => {
    expect(templatePath("/notes/engineering/release-checklist-3f9x2ab01k")).toBe("/notes/:path");
    expect(templatePath("/tasks/MYT-12")).toBe("/tasks/:path");
    expect(templatePath("/tasks")).toBe("/tasks");
    expect(templatePath("/")).toBe("/");
    expect(templatePath("/api/reports/0b8c6a1e-6f53-4b8e-9a51-2a3c4d5e6f70")).toBe("/api/reports/:id");
  });
});
