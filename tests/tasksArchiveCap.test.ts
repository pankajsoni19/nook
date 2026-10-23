import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { ARCHIVED_PAGE, LIMITS } = await import("../server/tasks/service");

/** Lane CAP (D632–D634): archived cards leave the card cap; the board sends archived cards by page. */

type Column = { id: string; name: string };

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const stranger = await createUser(`${label} stranger`);
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  const columns = created.body.columns as [Column, Column, Column];
  return { owner, stranger, boardId: created.body.board.id as string, todo: columns[0], done: columns[2] };
}

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
let position = 1;
/**
 * Inserts `count` live cards straight into the database; archived ones get `archived_at` one minute
 * apart from `from` (so the newest archived is the last inserted). Returns their ids in order.
 */
function seed(boardId: string, columnId: string, userId: string, count: number, archived: { from: number } | null = null) {
  const ids: string[] = [];
  const insert = db.query(`INSERT INTO cards (id, board_id, column_id, position, title, description, description_excerpt, created_by, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, ?)`);
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = crypto.randomUUID();
      const stamp = new Date(BASE).toISOString();
      insert.run(id, boardId, columnId, (position += 1) * 1024, `Seeded ${index}`, userId, stamp, stamp, archived ? new Date(archived.from + index * 60_000).toISOString() : null);
      ids.push(id);
    }
  })();
  return ids;
}

const row = (id: string) => db.query("SELECT column_id, archived_at, deleted_at FROM cards WHERE id = ?").get(id) as { column_id: string; archived_at: string | null; deleted_at: string | null };

describe("archived cards do not count toward the card cap (D632, D633)", () => {
  test("create counts only cards that are not archived; unarchive, a move out, and a Bin restore at the cap are refused", async () => {
    const { owner, boardId, todo, done } = await setup("Cap");
    const archived = seed(boardId, done.id, owner.userId, 50, { from: BASE });
    seed(boardId, todo.id, owner.userId, LIMITS.liveCardsPerBoard - 2);
    // 998 active and 50 archived: two more fit, then the cap.
    const binned = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: todo.id, title: "Will be binned" })).body.card.id as string;
    expect((await call(owner, "DELETE", `/cards/${binned}`)).status).toBe(200);
    const last = await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: todo.id, title: "999th" });
    expect(last.status).toBe(201);
    expect((await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: todo.id, title: "1000th" })).status).toBe(201);
    const refused = await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: todo.id, title: "1001st" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "LIMIT_REACHED" });
    expect(refused.body.error).toContain("not counting archived");
    expect((await call(owner, "GET", `/boards/${boardId}`)).body.board).toMatchObject({ card_count: 1050, archived_count: 50 });

    // At the cap, nothing may come back into view: unarchive, a move to another column, a Bin restore.
    const unarchive = await call(owner, "POST", `/cards/${archived[0]}/unarchive`);
    expect(unarchive.status).toBe(409);
    expect(unarchive.body).toMatchObject({ code: "LIMIT_REACHED" });
    expect(unarchive.body.error).toContain("archive or bin a card");
    expect(row(archived[0]!).archived_at).not.toBeNull();
    expect((await call(owner, "POST", `/cards/${archived[1]}/move`, { columnId: todo.id, afterCardId: null })).status).toBe(409);
    expect(row(archived[1]!)).toMatchObject({ column_id: done.id });
    expect(row(archived[1]!).archived_at).not.toBeNull();
    // A move within its own column keeps it archived, so it is allowed.
    expect((await call(owner, "POST", `/cards/${archived[1]}/move`, { columnId: done.id, afterCardId: null })).status).toBe(200);
    const restore = await request(`/bin/card/${binned}/restore`, { method: "POST", body: "{}" }, owner);
    expect(restore.status).toBe(409);
    expect(row(binned).deleted_at).not.toBeNull();

    // Archiving one card makes room for exactly one other.
    expect((await call(owner, "POST", `/cards/${last.body.card.id}/archive`)).status).toBe(200);
    expect((await call(owner, "POST", `/cards/${archived[0]}/unarchive`)).status).toBe(200);
    expect(row(archived[0]!).archived_at).toBeNull();
    expect((await call(owner, "POST", `/cards/${archived[2]}/unarchive`)).status).toBe(409);
  });

  test("the backstop counts every live card, archived ones included", async () => {
    const { owner, boardId, todo, done } = await setup("Backstop");
    seed(boardId, done.id, owner.userId, LIMITS.cardsPerBoard - 1, { from: BASE });
    expect((await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: todo.id, title: "Last that fits" })).status).toBe(201);
    const refused = await call(owner, "POST", `/boards/${boardId}/cards`, { columnId: todo.id, title: "Over the backstop" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "LIMIT_REACHED" });
    expect(refused.body.error).toContain(`${LIMITS.cardsPerBoard} cards, archived ones included`);
  });
});

describe("the board sends archived cards by page (D634)", () => {
  test(`at most ${ARCHIVED_PAGE} archived cards, newest archived first, then pages by cursor; live cards are all sent`, async () => {
    const { owner, stranger, boardId, todo, done } = await setup("Page");
    const live = seed(boardId, todo.id, owner.userId, 30);
    const total = ARCHIVED_PAGE * 2 + 25;
    const archived = seed(boardId, done.id, owner.userId, total, { from: BASE });
    const newestFirst = [...archived].reverse();

    // Hidden (the default): no archived cards and no page.
    let board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.cards).toHaveLength(live.length);
    expect(board.archivedPage).toBeUndefined();

    await call(owner, "PUT", `/boards/${boardId}/view`, { showArchived: true });
    board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.board.archived_count).toBe(total);
    const archivedIds = (cards: Array<{ id: string; archived_at?: string }>) => cards.filter((card) => card.archived_at).map((card) => card.id);
    expect(board.cards.filter((card: { archived_at?: string }) => !card.archived_at).map((card: { id: string }) => card.id).sort()).toEqual([...live].sort());
    const first = archivedIds(board.cards);
    expect(new Set(first)).toEqual(new Set(newestFirst.slice(0, ARCHIVED_PAGE)));
    expect(typeof board.archivedPage.next).toBe("string");

    const second = await call(owner, "GET", `/boards/${boardId}/archived?before=${encodeURIComponent(board.archivedPage.next)}`);
    expect(second.status).toBe(200);
    expect(second.body.cards.every((card: { archived_at?: string; board_id?: string }) => card.archived_at && !("board_id" in card))).toBe(true);
    expect(new Set(archivedIds(second.body.cards))).toEqual(new Set(newestFirst.slice(ARCHIVED_PAGE, ARCHIVED_PAGE * 2)));
    const third = await call(owner, "GET", `/boards/${boardId}/archived?before=${encodeURIComponent(second.body.archivedPage.next)}`);
    expect(new Set(archivedIds(third.body.cards))).toEqual(new Set(newestFirst.slice(ARCHIVED_PAGE * 2)));
    expect(third.body.archivedPage.next).toBeNull();

    // Same archived_at on two cards: the id breaks the tie, so no card is skipped or repeated.
    const tied = seed(boardId, done.id, owner.userId, 3, { from: BASE - 86_400_000 });
    db.query(`UPDATE cards SET archived_at = ? WHERE id IN (${tied.map(() => "?").join(", ")})`).run(new Date(BASE - 86_400_000).toISOString(), ...tied);
    const seen = new Set<string>();
    let next: string | null = (await call(owner, "GET", `/boards/${boardId}`)).body.archivedPage.next;
    for (const id of archivedIds((await call(owner, "GET", `/boards/${boardId}`)).body.cards)) seen.add(id);
    while (next) {
      const page = await call(owner, "GET", `/boards/${boardId}/archived?before=${encodeURIComponent(next)}`);
      for (const id of archivedIds(page.body.cards)) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      next = page.body.archivedPage.next;
    }
    expect(seen.size).toBe(total + tied.length);

    // A bad cursor is 400; a non-reader gets 404.
    expect((await call(owner, "GET", `/boards/${boardId}/archived?before=nope`)).status).toBe(400);
    expect((await call(stranger, "GET", `/boards/${boardId}/archived?before=${encodeURIComponent(board.archivedPage.next)}`)).status).toBe(404);
  });

  test("a full board with many archived cards stays bounded: 1,000 live plus one page", async () => {
    const { owner, boardId, todo, done } = await setup("Bound");
    seed(boardId, todo.id, owner.userId, LIMITS.liveCardsPerBoard);
    seed(boardId, done.id, owner.userId, 3000, { from: BASE });
    await call(owner, "PUT", `/boards/${boardId}/view`, { showArchived: true });
    const response = await request(`/tasks/boards/${boardId}`, {}, owner);
    const text = await response.text();
    const body = JSON.parse(text) as { cards: unknown[] };
    expect(body.cards).toHaveLength(LIMITS.liveCardsPerBoard + ARCHIVED_PAGE);
    // Bare cards are about 450 bytes each; 1,200 of them stay well under the D113 ceiling.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(1_200_000);
  });

  test("MCP list_cards lists one page of archived cards with archived_page, and pages with archivedBefore", async () => {
    const { createMcpApiKey } = await import("../server/mcp");
    const { invokeMcpToolForTests } = await import("../server/mcpTools");
    const { owner, boardId, todo, done } = await setup("McpPage");
    const live = seed(boardId, todo.id, owner.userId, 5);
    const archived = seed(boardId, done.id, owner.userId, ARCHIVED_PAGE + 7, { from: BASE });
    const key = createMcpApiKey(owner.userId, "Page agent", ["tasks:read"]);
    const run = async (args: Record<string, unknown>) => {
      const result = await invokeMcpToolForTests("list_cards", { boardId, ...args }, key.id);
      return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, any> };
    };
    const all = (await run({})).value;
    expect(all.cards).toHaveLength(live.length + ARCHIVED_PAGE);
    expect(all.archived_page).toMatchObject({ total: archived.length });
    const rest = (await run({ archived: true, archivedBefore: all.archived_page.next })).value;
    expect(rest.cards.map((card: { id: string }) => card.id).sort()).toEqual(archived.slice(0, 7).sort());
    expect(rest.archived_page.next).toBeNull();
    const liveOnly = (await run({ archived: false })).value;
    expect(liveOnly.cards).toHaveLength(live.length);
    expect(liveOnly.archived_page).toBeUndefined();
    expect((await run({ archivedBefore: "nope" })).isError).toBe(true);
  });
});
