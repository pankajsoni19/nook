import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUser, db, request, type Session } from "./support/harness";
import { registeredMigrations } from "../server/migrations";
import { taskArchiveMigration } from "../server/migrations/074_task_archive";
import { hydrateBoard } from "../src/tasks/tasksApi";

const { sweepAutoArchive, AUTO_ARCHIVE_BATCH } = await import("../server/tasks/archive");

/** Lane TASKS (D602–D609): collapsed columns, the per-person view, and auto-archived done cards. */

type Column = { id: string; name: string; state: string };
const DAY = 86_400_000;

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const stranger = await createUser(`${label} stranger`);
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columns = created.body.columns as [Column, Column, Column];
  expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  return { owner, member, stranger, boardId, columns, todo: columns[0], doing: columns[1], done: columns[2] };
}

async function addCard(session: Session, boardId: string, columnId: string, title: string) {
  const made = await call(session, "POST", `/boards/${boardId}/cards`, { columnId, title });
  expect(made.status).toBe(201);
  return made.body.card as { id: string; done_at: string | null; archived_at: string | null };
}

const cardRow = (id: string) => db.query("SELECT column_id, done_at, archived_at, deleted_at FROM cards WHERE id = ?").get(id) as { column_id: string; done_at: string | null; archived_at: string | null; deleted_at: string | null };
/** Moves the card's done clock back by `days` (what a fake clock would see after that long). */
const age = (id: string, days: number) => db.query("UPDATE cards SET done_at = ? WHERE id = ?").run(new Date(Date.now() - days * DAY).toISOString(), id);
const autoArchiveAudits = (boardId: string) => (db.query("SELECT actor_id, metadata_json FROM audit_log WHERE event_type = 'task.cards_auto_archived' ORDER BY rowid").all() as Array<{ actor_id: string | null; metadata_json: string }>)
  .map((row) => ({ actor: row.actor_id, ...JSON.parse(row.metadata_json) as Record<string, unknown> })).filter((row) => row.boardId === boardId);

describe("collapsed columns and the per-person view (D602, D606)", () => {
  test("each reader keeps their own collapsed columns and archived choice; it persists, ignores deleted columns, and needs read access", async () => {
    const { owner, member, stranger, boardId, todo, done } = await setup("View");
    let board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.view).toEqual({ collapsedColumnIds: [], showArchived: false });
    expect(board.board).toMatchObject({ auto_archive_days: 30, archived_count: 0 });

    // Stored in board order whatever the order sent, upper-case ids too; unknown ids are dropped.
    const saved = await call(owner, "PUT", `/boards/${boardId}/view`, { collapsedColumnIds: [done.id.toUpperCase(), todo.id, crypto.randomUUID()] });
    expect(saved.status).toBe(200);
    expect(saved.body.view).toEqual({ collapsedColumnIds: [todo.id, done.id], showArchived: false });
    board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.view.collapsedColumnIds).toEqual([todo.id, done.id]);
    // The member's view is their own (a viewer-level reader may keep one too).
    expect((await call(member, "GET", `/boards/${boardId}`)).body.view).toEqual({ collapsedColumnIds: [], showArchived: false });
    const memberAudits = () => (db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ?").get(member.userId) as { count: number }).count;
    const auditsBefore = memberAudits();
    expect((await call(member, "PUT", `/boards/${boardId}/view`, { showArchived: true })).body.view).toEqual({ collapsedColumnIds: [], showArchived: true });
    // The view is not audited (one person's display choice).
    expect(memberAudits()).toBe(auditsBefore);
    // A field left out keeps its value.
    expect((await call(owner, "PUT", `/boards/${boardId}/view`, { showArchived: true })).body.view).toEqual({ collapsedColumnIds: [todo.id, done.id], showArchived: true });

    // A deleted column drops out of the stored view.
    const extra = (await call(owner, "POST", `/boards/${boardId}/columns`, { name: "Later" })).body.column as Column;
    await call(owner, "PUT", `/boards/${boardId}/view`, { collapsedColumnIds: [extra.id] });
    expect((await call(owner, "DELETE", `/columns/${extra.id}`)).status).toBe(200);
    expect((await call(owner, "GET", `/boards/${boardId}`)).body.view.collapsedColumnIds).toEqual([]);

    // Non-readers get 404 like a missing board; bad bodies are 400.
    expect((await call(stranger, "PUT", `/boards/${boardId}/view`, { showArchived: true })).status).toBe(404);
    expect((await call(owner, "PUT", `/boards/${boardId}/view`, {})).status).toBe(400);
    expect((await call(owner, "PUT", `/boards/${boardId}/view`, { collapsedColumnIds: ["nope"] })).status).toBe(400);
    expect((await call(owner, "PUT", `/boards/${boardId}/view`, { showArchived: true, extra: 1 })).status).toBe(400);
  });

  test("a card dropped onto a collapsed column is filed at its top and the column stays collapsed", async () => {
    const { owner, boardId, todo, done } = await setup("Drop");
    const first = await addCard(owner, boardId, done.id, "Shipped earlier");
    const moving = await addCard(owner, boardId, todo.id, "Ship it");
    await call(owner, "PUT", `/boards/${boardId}/view`, { collapsedColumnIds: [done.id] });
    // The client sends afterCardId null for a collapsed target (D602): the top of the column.
    const moved = await call(owner, "POST", `/cards/${moving.id}/move`, { columnId: done.id, afterCardId: null });
    expect(moved.status).toBe(200);
    const board = hydrateBoard((await call(owner, "GET", `/boards/${boardId}`)).body as never);
    expect(board.cards.filter((card) => card.column_id === done.id).sort((a, b) => a.position - b.position).map((card) => card.id)).toEqual([moving.id, first.id]);
    expect((await call(owner, "GET", `/boards/${boardId}`)).body.view.collapsedColumnIds).toEqual([done.id]);
  });
});

describe("auto-archive of done cards (D603–D605, D607)", () => {
  test("the done clock starts on entering a done column, keeps running between done columns, and restarts on re-entry", async () => {
    const { owner, boardId, todo, doing, done } = await setup("Clock");
    const card = await addCard(owner, boardId, todo.id, "Write");
    expect(card.done_at).toBeNull();
    const created = await addCard(owner, boardId, done.id, "Born done");
    expect(created.done_at).not.toBeNull();

    await call(owner, "POST", `/cards/${card.id}/move`, { columnId: done.id, afterCardId: null });
    const entered = cardRow(card.id).done_at!;
    expect(entered).not.toBeNull();
    // A second done column: moving between them keeps the clock.
    const shipped = (await call(owner, "POST", `/boards/${boardId}/columns`, { name: "Shipped" })).body.column as Column;
    expect((await call(owner, "PATCH", `/columns/${shipped.id}`, { state: "done" })).status).toBe(200);
    age(card.id, 10);
    const aged = cardRow(card.id).done_at;
    await call(owner, "POST", `/cards/${card.id}/move`, { columnId: shipped.id, afterCardId: null });
    expect(cardRow(card.id).done_at).toBe(aged);
    // Within the same column too.
    await call(owner, "POST", `/cards/${card.id}/move`, { columnId: shipped.id });
    expect(cardRow(card.id).done_at).toBe(aged);
    // Out of done stops it; back in starts again from now.
    await call(owner, "POST", `/cards/${card.id}/move`, { columnId: doing.id, afterCardId: null });
    expect(cardRow(card.id).done_at).toBeNull();
    await call(owner, "POST", `/cards/${card.id}/move`, { columnId: done.id, afterCardId: null });
    expect(Date.parse(cardRow(card.id).done_at!)).toBeGreaterThan(Date.now() - 60_000);

    // A column that becomes done starts its cards' clocks; one that stops being done clears them (D610: archives stay).
    const other = await addCard(owner, boardId, doing.id, "In progress");
    await call(owner, "PATCH", `/columns/${doing.id}`, { state: "done" });
    expect(cardRow(other.id).done_at).not.toBeNull();
    await call(owner, "PATCH", `/columns/${doing.id}`, { state: "doing" });
    expect(cardRow(other.id).done_at).toBeNull();
  });

  test("the sweep archives only cards past the board's days in a done column; hidden from the board unless shown; audited as the system", async () => {
    const { owner, member, boardId, todo, done } = await setup("Sweep");
    const old = await addCard(owner, boardId, done.id, "Old and done");
    const recent = await addCard(owner, boardId, done.id, "Recently done");
    const open = await addCard(owner, boardId, todo.id, "Still open");
    age(old.id, 31);
    age(recent.id, 29);
    // A card not in a done column never archives, whatever its stored clock says.
    db.query("UPDATE cards SET done_at = ? WHERE id = ?").run(new Date(Date.now() - 400 * DAY).toISOString(), open.id);

    expect(sweepAutoArchive()).toBeGreaterThanOrEqual(1);
    expect(cardRow(old.id).archived_at).not.toBeNull();
    expect(cardRow(recent.id).archived_at).toBeNull();
    expect(cardRow(open.id).archived_at).toBeNull();
    // Never deleted: still live, same column.
    expect(cardRow(old.id)).toMatchObject({ column_id: done.id, deleted_at: null });
    expect(autoArchiveAudits(boardId)).toEqual([{ actor: null, boardId, count: 1, days: 30 }]);

    // A fake clock two days on: the 29-day card is due now.
    expect(sweepAutoArchive(Date.now() + 2 * DAY)).toBeGreaterThanOrEqual(1);
    expect(cardRow(recent.id).archived_at).not.toBeNull();
    // A second sweep finds nothing more on this board.
    sweepAutoArchive(Date.now() + 2 * DAY);
    expect(autoArchiveAudits(boardId).length).toBe(2);

    // Hidden from the board by default, counted on the summary; shown with the view's choice, marked.
    let board = (await call(member, "GET", `/boards/${boardId}`)).body;
    expect(board.cards.map((card: { id: string }) => card.id)).toEqual([open.id]);
    expect(board.board).toMatchObject({ card_count: 3, archived_count: 2 });
    await call(member, "PUT", `/boards/${boardId}/view`, { showArchived: true });
    board = (await call(member, "GET", `/boards/${boardId}`)).body;
    expect(board.cards.filter((card: { archived_at: string | null }) => card.archived_at).map((card: { id: string }) => card.id).sort()).toEqual([old.id, recent.id].sort());
    // The owner's own view still hides them.
    expect((await call(owner, "GET", `/boards/${boardId}`)).body.cards.length).toBe(1);
  });

  test("restoring: unarchive, moving out, or the Bin brings a card back with a fresh clock; reading levels and 404s hold", async () => {
    const { owner, member, stranger, boardId, todo, done } = await setup("Restore");
    const a = await addCard(owner, boardId, done.id, "A");
    const b = await addCard(owner, boardId, done.id, "B");
    const c = await addCard(owner, boardId, done.id, "C");
    for (const id of [a.id, b.id, c.id]) age(id, 40);
    sweepAutoArchive();
    for (const id of [a.id, b.id, c.id]) expect(cardRow(id).archived_at).not.toBeNull();

    expect((await call(stranger, "POST", `/cards/${a.id}/unarchive`)).status).toBe(404);
    const restored = await call(member, "POST", `/cards/${a.id}/unarchive`);
    expect(restored.status).toBe(200);
    expect(restored.body.card).toMatchObject({ id: a.id, archived_at: null, column_id: done.id });
    expect(Date.parse(cardRow(a.id).done_at!)).toBeGreaterThan(Date.now() - 60_000);
    // The next sweep leaves it alone: its clock restarted.
    sweepAutoArchive();
    expect(cardRow(a.id).archived_at).toBeNull();
    // Unarchiving a card that is not archived changes nothing.
    expect((await call(member, "POST", `/cards/${a.id}/unarchive`)).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'task.card_unarchive' AND metadata_json LIKE ?").get(`%${a.id}%`)).toEqual({ count: 1 });

    // Moving an archived card to another column puts it back in view.
    expect((await call(owner, "POST", `/cards/${b.id}/move`, { columnId: todo.id, afterCardId: null })).status).toBe(200);
    expect(cardRow(b.id)).toMatchObject({ archived_at: null, done_at: null, column_id: todo.id });

    // Binned and restored: back in view, the done clock restarted.
    expect((await call(owner, "DELETE", `/cards/${c.id}`)).status).toBe(200);
    expect((await request(`/bin/card/${c.id}/restore`, { method: "POST", body: "{}" }, owner)).status).toBe(200);
    expect(cardRow(c.id)).toMatchObject({ deleted_at: null, archived_at: null });
    expect(Date.parse(cardRow(c.id).done_at!)).toBeGreaterThan(Date.now() - 60_000);
  });

  test("auto-archive is per board: off, other days, binned boards; only managers change it; WIP and delete column ignore or name archived cards", async () => {
    const { owner, member, boardId, done } = await setup("Settings");
    // Members may not change it; managers and the owner may.
    expect((await call(member, "PATCH", `/boards/${boardId}`, { autoArchiveDays: 7 })).status).toBe(403);
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { autoArchiveDays: 0 })).status).toBe(400);
    expect((await call(owner, "PATCH", `/boards/${boardId}`, { autoArchiveDays: 366 })).status).toBe(400);
    const off = await call(owner, "PATCH", `/boards/${boardId}`, { autoArchiveDays: null });
    expect(off.status).toBe(200);
    expect(off.body.board.auto_archive_days).toBeNull();
    const card = await addCard(owner, boardId, done.id, "Done long ago");
    age(card.id, 300);
    sweepAutoArchive();
    expect(cardRow(card.id).archived_at).toBeNull();

    expect((await call(owner, "PATCH", `/boards/${boardId}`, { autoArchiveDays: 7 })).body.board.auto_archive_days).toBe(7);
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'task.board_auto_archive' ORDER BY rowid DESC LIMIT 1").get(owner.userId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({ boardId, days: 7 });
    const week = await addCard(owner, boardId, done.id, "A week and a day");
    age(week.id, 8);
    sweepAutoArchive();
    expect(cardRow(week.id).archived_at).not.toBeNull();

    // WIP counts only cards on view; a column whose cards are all archived says so when deleted.
    expect((await call(owner, "PATCH", `/columns/${done.id}`, { wipLimit: 1 })).status).toBe(200);
    expect((await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: done.id, title: "Fits" })).status).toBe(201);
    expect((await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: done.id, title: "Over" })).body.code).toBe("COLUMN_FULL");

    const lone = (await call(owner, "POST", `/boards/${boardId}/columns`, { name: "Archive me" })).body.column as Column;
    await call(owner, "PATCH", `/columns/${lone.id}`, { state: "done" });
    const hidden = await addCard(owner, boardId, lone.id, "Hidden");
    age(hidden.id, 30);
    sweepAutoArchive();
    const refused = await call(owner, "DELETE", `/columns/${lone.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "COLUMN_NOT_EMPTY", cardCount: 1, archivedCount: 1 });
    expect(refused.body.error).toContain("1 archived card");

    // A binned board's cards are left alone.
    const binnedBoard = await setup("Binned");
    const kept = await addCard(binnedBoard.owner, binnedBoard.boardId, binnedBoard.done.id, "In a binned board");
    age(kept.id, 90);
    expect((await call(binnedBoard.owner, "DELETE", `/boards/${binnedBoard.boardId}`)).status).toBe(200);
    sweepAutoArchive();
    expect(cardRow(kept.id).archived_at).toBeNull();
  });

  test("the sweep works in batches and re-checks each card when it writes", async () => {
    const { owner, boardId, todo, done } = await setup("Batch");
    const ids: string[] = [];
    const insert = db.query(`INSERT INTO cards (id, board_id, column_id, position, title, created_by, created_at, updated_at, done_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const longAgo = new Date(Date.now() - 60 * DAY).toISOString();
    db.transaction(() => {
      for (let index = 0; index < AUTO_ARCHIVE_BATCH + 20; index += 1) {
        const id = crypto.randomUUID();
        ids.push(id);
        insert.run(id, boardId, done.id, index + 1, `Card ${index}`, owner.userId, longAgo, longAgo, longAgo);
      }
    })();
    // One card leaves the done column before the sweep: it stays.
    await call(owner, "POST", `/cards/${ids[0]}/move`, { columnId: todo.id, afterCardId: null });
    sweepAutoArchive();
    const archived = (db.query("SELECT COUNT(*) AS count FROM cards WHERE board_id = ? AND archived_at IS NOT NULL").get(boardId) as { count: number }).count;
    expect(archived).toBe(AUTO_ARCHIVE_BATCH + 19);
    expect(cardRow(ids[0]!).archived_at).toBeNull();
    const audits = autoArchiveAudits(boardId);
    expect(audits.reduce((sum, row) => sum + Number(row.count), 0)).toBe(AUTO_ARCHIVE_BATCH + 19);
    expect(audits.length).toBe(2);
  });
});

describe("archiving by hand (D610)", () => {
  test("anyone who can edit archives a card in any column; it leaves the board, Undo (unarchive) brings it back; Tasks home still lists it, marked", async () => {
    const { owner, member, stranger, boardId, todo, done } = await setup("Manual");
    const card = await addCard(member, boardId, todo.id, "Archive me by hand");
    expect((await call(stranger, "POST", `/cards/${card.id}/archive`)).status).toBe(404);
    const archived = await call(member, "POST", `/cards/${card.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.card.archived_at).not.toBeNull();
    expect(cardRow(card.id)).toMatchObject({ column_id: todo.id, deleted_at: null });
    const audit = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'task.card_archive' ORDER BY rowid DESC LIMIT 1").get(member.userId) as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({ boardId, cardId: card.id });
    // Twice is a no-op (one audit row).
    const firstAt = cardRow(card.id).archived_at;
    await call(member, "POST", `/cards/${card.id}/archive`);
    expect(cardRow(card.id).archived_at).toBe(firstAt);
    expect(db.query("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'task.card_archive' AND metadata_json LIKE ?").get(`%${card.id}%`)).toEqual({ count: 1 });

    let board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.cards.some((item: { id: string }) => item.id === card.id)).toBe(false);
    expect(board.board.archived_count).toBe(1);
    // The sweep never unarchives it, and a column leaving done keeps archives (the card stays hidden).
    sweepAutoArchive();
    expect(cardRow(card.id).archived_at).toBe(firstAt);
    const inDone = await addCard(owner, boardId, done.id, "Done and archived by hand");
    await call(owner, "POST", `/cards/${inDone.id}/archive`);
    await call(owner, "PATCH", `/columns/${done.id}`, { state: "doing" });
    expect(cardRow(inDone.id)).toMatchObject({ done_at: null });
    expect(cardRow(inDone.id).archived_at).not.toBeNull();

    // Tasks home (the cross-board query) still finds it, with archived_at.
    const found = await call(owner, "POST", "/query", { q: `board:${boardId}` });
    expect(found.status).toBe(200);
    expect(found.body.cards.find((item: { id: string }) => item.id === card.id)?.archived_at).toBe(firstAt);

    // Undo.
    expect((await call(member, "POST", `/cards/${card.id}/unarchive`)).body.card.archived_at).toBeNull();
    board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.cards.some((item: { id: string }) => item.id === card.id)).toBe(true);
  });
});

describe("migration 074 task_archive", () => {
  const at = "2026-09-01T00:00:00.000Z";
  test("backfills done_at from updated_at for live cards in done columns, turns auto-archive on at 30 days, and re-running changes nothing", () => {
    const sqlite = new Database(":memory:", { strict: true });
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const migration of registeredMigrations.filter((item) => item.id < 74)) sqlite.transaction(() => migration.up(sqlite))();
    sqlite.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES ('u1', 'a@example.test', 'A', 'x', ?, 'member')").run(at);
    sqlite.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b1', 'u1', 'Board', ?, ?)").run(at, at);
    sqlite.query("INSERT INTO board_columns (id, board_id, name, position, is_done, state, created_at, updated_at) VALUES ('c1', 'b1', 'To do', 1, 0, 'todo', ?, ?), ('c2', 'b1', 'Done', 2, 1, 'done', ?, ?)").run(at, at, at, at);
    const card = sqlite.query("INSERT INTO cards (id, board_id, column_id, position, title, created_by, created_at, updated_at, deleted_at, purge_after) VALUES (?, 'b1', ?, 1, 'T', 'u1', ?, ?, ?, ?)");
    card.run("k-open", "c1", at, "2026-09-02T00:00:00.000Z", null, null);
    card.run("k-done", "c2", at, "2026-09-03T00:00:00.000Z", null, null);
    card.run("k-binned", "c2", at, "2026-09-04T00:00:00.000Z", "2026-09-05T00:00:00.000Z", "2026-10-05T00:00:00.000Z");

    taskArchiveMigration.up(sqlite);
    expect(sqlite.query("SELECT id, done_at, archived_at FROM cards ORDER BY id").all()).toEqual([
      { id: "k-binned", done_at: null, archived_at: null },
      { id: "k-done", done_at: "2026-09-03T00:00:00.000Z", archived_at: null },
      { id: "k-open", done_at: null, archived_at: null }
    ]);
    expect(sqlite.query("SELECT auto_archive_days FROM boards").get()).toEqual({ auto_archive_days: 30 });
    // New boards get 30 too; the rules hold.
    sqlite.query("INSERT INTO boards (id, owner_id, name, created_at, updated_at) VALUES ('b2', 'u1', 'New', ?, ?)").run(at, at);
    expect(sqlite.query("SELECT auto_archive_days FROM boards WHERE id = 'b2'").get()).toEqual({ auto_archive_days: 30 });
    expect(() => sqlite.query("UPDATE boards SET auto_archive_days = 0 WHERE id = 'b2'").run()).toThrow();
    expect(() => sqlite.query("INSERT INTO board_view_prefs (board_id, user_id, collapsed_columns, updated_at) VALUES ('b1', 'u1', '{}', ?)").run(at)).toThrow();
    sqlite.query("INSERT INTO board_view_prefs (board_id, user_id, collapsed_columns, show_archived, updated_at) VALUES ('b1', 'u1', '[\"c2\"]', 1, ?)").run(at);
    // The view goes with the board.
    sqlite.query("DELETE FROM boards WHERE id = 'b1'").run();
    expect(sqlite.query("SELECT COUNT(*) AS count FROM board_view_prefs").get()).toEqual({ count: 0 });

    taskArchiveMigration.up(sqlite);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM boards").get()).toEqual({ count: 1 });
  });
});

describe("MCP and search keep archived cards, flagged (D607)", () => {
  test("list_cards lists archived cards with archived: true unless archived is false; archived: true lists only them; get_card and search_cards say so", async () => {
    const { createMcpApiKey } = await import("../server/mcp");
    const { invokeMcpToolForTests } = await import("../server/mcpTools");
    const { owner, boardId, todo, done } = await setup("Mcp");
    const open = await addCard(owner, boardId, todo.id, "Mcp open card");
    const old = await addCard(owner, boardId, done.id, "Mcp archived card");
    age(old.id, 45);
    sweepAutoArchive();
    const key = createMcpApiKey(owner.userId, "Archive agent", ["tasks:read"]);
    const run = async (name: string, args: Record<string, unknown>) => JSON.parse((await invokeMcpToolForTests(name, args, key.id)).content[0]!.text) as Record<string, any>;

    const all = await run("list_cards", { boardId });
    expect(all.board.auto_archive_days).toBe(30);
    const flags = new Map(all.cards.map((card: { id: string; archived: boolean; archived_at: string | null }) => [card.id, [card.archived, card.archived_at !== null]]));
    expect(flags).toEqual(new Map([[open.id, [false, false]], [old.id, [true, true]]]));
    expect((await run("list_cards", { boardId, archived: false })).cards.map((card: { id: string }) => card.id)).toEqual([open.id]);
    expect((await run("list_cards", { boardId, archived: true })).cards.map((card: { id: string }) => card.id)).toEqual([old.id]);
    expect((await run("get_card", { cardId: old.id })).card).toMatchObject({ archived: true });
    const found = await run("search_cards", { query: "Mcp archived card" });
    expect(found.results).toEqual([expect.objectContaining({ id: old.id, is_archived: 1 })]);
  });

  test("archive_card and unarchive_card (D627): tasks:write, edit level, audited with the key, items-scoped", async () => {
    const { createMcpApiKey } = await import("../server/mcp");
    const { invokeMcpToolForTests } = await import("../server/mcpTools");
    const { owner, member, boardId, todo } = await setup("McpArchive");
    const card = await addCard(owner, boardId, todo.id, "Agent tidies this");
    const writer = createMcpApiKey(member.userId, "Tidy agent", ["tasks:read", "tasks:write"]);
    const reader = createMcpApiKey(member.userId, "Read agent", ["tasks:read"]);
    const run = async (name: string, args: Record<string, unknown>, keyId = writer.id) => {
      const result = await invokeMcpToolForTests(name, args, keyId);
      return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
    };
    // A read-only key cannot call it.
    expect((await run("archive_card", { cardId: card.id }, reader.id)).isError).toBe(true);
    const archived = await run("archive_card", { cardId: card.id });
    expect(archived.isError).toBe(false);
    expect(archived.value.card).toMatchObject({ id: card.id, column_id: todo.id, archived: true });
    expect(cardRow(card.id)).toMatchObject({ column_id: todo.id, deleted_at: null });
    const audit = (event: string) => JSON.parse((db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = ? ORDER BY rowid DESC LIMIT 1").get(member.userId, event) as { metadata_json: string }).metadata_json);
    expect(audit("task.card_archive")).toEqual({ boardId, cardId: card.id, via: "mcp", keyId: writer.id });
    expect((await call(owner, "GET", `/boards/${boardId}`)).body.cards.some((item: { id: string }) => item.id === card.id)).toBe(false);
    const back = await run("unarchive_card", { cardId: card.id });
    expect(back.value.card).toMatchObject({ id: card.id, archived: false, archived_at: null });
    expect(audit("task.card_unarchive")).toEqual({ boardId, cardId: card.id, via: "mcp", keyId: writer.id });
    // A card on a board the key's user cannot open is NOT_FOUND.
    const other = await setup("McpArchiveOther");
    const foreign = await addCard(other.owner, other.boardId, other.todo.id, "Not yours");
    const refused = await run("archive_card", { cardId: foreign.id });
    expect(refused.isError).toBe(true);
    expect(cardRow(foreign.id).archived_at).toBeNull();
  });
});
