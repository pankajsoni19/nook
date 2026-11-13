import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import type { CardActivityEntry } from "../shared/cardActivity";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");

/**
 * Card history for the lanes merged beside it (integration): `start` (D720), `estimate` (D750), and
 * `board_move` (D716), recorded in the change's transaction (shared/cardActivity.ts lists the kinds).
 */

type Column = { id: string; name: string };
type Card = { id: string; revision: number; column_id: string };

async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

let people: { owner: Session; member: Session } | null = null;
async function users() {
  people ??= { owner: await createUser("Integration activity owner"), member: await createUser("Integration activity member") };
  return people;
}

async function board(session: Session, name: string, extra: Record<string, unknown> = {}) {
  const created = await call(session, "POST", "/boards", { name, ...extra });
  expect(created.status).toBe(201);
  return { id: created.body.board.id as string, columns: created.body.columns as [Column, Column, Column] };
}

async function addCard(session: Session, boardId: string, columnId: string, title: string, extra: Record<string, unknown> = {}) {
  const created = await call(session, "POST", `/boards/${boardId}/cards`, { columnId, title, ...extra });
  expect(created.status).toBe(201);
  return created.body.card as Card;
}

const revision = (cardId: string) => (db.query("SELECT revision FROM cards WHERE id = ?").get(cardId) as { revision: number }).revision;
async function patch(session: Session, cardId: string, body: Record<string, unknown>) {
  const result = await call(session, "PATCH", `/cards/${cardId}`, { ...body, revision: revision(cardId) });
  expect(result.status).toBe(200);
  return result.body.card as Card;
}

const stored = (cardId: string) => (db.query("SELECT kind, board_id, via, payload FROM card_activity WHERE card_id = ? ORDER BY created_at, id").all(cardId) as Array<{ kind: string; board_id: string; via: string | null; payload: string }>)
  .map((row) => ({ kind: row.kind, board: row.board_id, via: row.via, ...JSON.parse(row.payload) as Record<string, unknown> }));
const age = (cardId: string) => db.query("UPDATE card_activity SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '-5 minutes') WHERE card_id = ?").run(cardId);

describe("start dates in the history (D720)", () => {
  test("set, changed (coalesced like due), and cleared, shaped like the due date", async () => {
    const { owner } = await users();
    const { id: boardId, columns } = await board(owner, "Start history");
    const card = await addCard(owner, boardId, columns[0].id, "Kickoff");
    await patch(owner, card.id, { startOn: "2026-11-12", startTime: "09:00", startTz: "Europe/Berlin" });
    // A quick second edit folds into the first: one entry from nothing to the latest start.
    await patch(owner, card.id, { startOn: "2026-11-13" });
    const starts = () => stored(card.id).filter((row) => row.kind === "start");
    expect(starts()).toEqual([{ kind: "start", board: boardId, via: null, from: null, to: { id: "2026-11-13T09:00", label: "2026-11-13 09:00", detail: "Europe/Berlin" } }]);
    age(card.id);
    await patch(owner, card.id, { startOn: null });
    expect(starts().at(-1)).toMatchObject({ from: { id: "2026-11-13T09:00" }, to: null });
    // A due date change is still its own kind.
    await patch(owner, card.id, { dueOn: "2026-11-20" });
    expect(stored(card.id).map((row) => row.kind)).toEqual(["created", "start", "start", "due"]);
  });
});

describe("estimates in the history (D750)", () => {
  test("the label carries the board's unit when it was set; cleared reads as none; MCP edits say so", async () => {
    const { owner } = await users();
    const points = await board(owner, "Estimate points");
    expect((await call(owner, "PATCH", `/boards/${points.id}`, { estimateKind: "points", estimateScale: "fibonacci" })).status).toBe(200);
    const card = await addCard(owner, points.id, points.columns[0].id, "Sized");
    await patch(owner, card.id, { estimate: 5 });
    const estimates = () => stored(card.id).filter((row) => row.kind === "estimate");
    expect(estimates()).toEqual([{ kind: "estimate", board: points.id, via: null, from: null, to: { id: "5", label: "5 pts", detail: "points" } }]);
    age(card.id);
    await patch(owner, card.id, { estimate: null });
    expect(estimates().at(-1)).toMatchObject({ from: { id: "5", label: "5 pts" }, to: null });
    // Saving the same value again records nothing.
    await patch(owner, card.id, { estimate: null });
    expect(estimates()).toHaveLength(2);

    const hours = await board(owner, "Estimate hours");
    expect((await call(owner, "PATCH", `/boards/${hours.id}`, { estimateKind: "hours" })).status).toBe(200);
    const timed = await addCard(owner, hours.id, hours.columns[0].id, "Timed");
    const key = createApiKey(owner.userId, { name: "Estimate agent", surfaces: "both", grants: [{ module: "tasks", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const result = JSON.parse((await invokeMcpToolForTests("update_card", { cardId: timed.id, baseRevision: revision(timed.id), estimate: 3 }, key.id, "mcp")).content[0]!.text);
    expect(result.code).toBeUndefined();
    expect(stored(timed.id).filter((row) => row.kind === "estimate")).toEqual([{ kind: "estimate", board: hours.id, via: "mcp", from: null, to: { id: "3", label: "3h", detail: "hours" } }]);
  });
});

describe("moving a card to another board (D716)", () => {
  test("is recorded on the card with both boards and keys; its earlier history moves with it", async () => {
    const { owner, member } = await users();
    const source = await board(owner, "My tasks", { code: "MYT" });
    const target = await board(owner, "Roadmap", { code: "ROA" });
    // Tags: "Backend" exists on both boards, "Spike" only on the source, so the move drops it.
    const tag = async (boardId: string, name: string) => (await call(owner, "POST", `/boards/${boardId}/tags`, { name, color: "blue" })).body.tag.id as string;
    const backend = await tag(source.id, "Backend");
    const spike = await tag(source.id, "Spike");
    await tag(target.id, "Backend");
    await addCard(owner, source.id, source.columns[0].id, "First");
    const card = await addCard(owner, source.id, source.columns[0].id, "Second", { tagIds: [backend, spike] });
    await patch(owner, card.id, { title: "Second, renamed" });
    // The member reads only the destination.
    expect((await call(owner, "PUT", `/boards/${target.id}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);

    const moved = await call(owner, "POST", `/cards/${card.id}/move-board`, { boardId: target.id });
    expect(moved.status).toBe(200);
    expect(moved.body.droppedTags).toEqual(["Spike"]);

    const rows = stored(card.id);
    expect(rows.map((row) => row.kind)).toEqual(["created", "title", "board_move", "tag_removed"]);
    // Rows written before the move keep the old board's id; reads go by card.
    expect(rows.slice(0, 2).map((row) => row.board)).toEqual([source.id, source.id]);
    expect(rows[2]).toEqual({ kind: "board_move", board: target.id, via: null,
      from: { id: source.id, label: "My tasks", detail: "MYT-2" }, to: { id: target.id, label: "Roadmap", detail: "ROA-1" } });
    expect(rows[3]).toMatchObject({ item: { id: spike, label: "Spike" } });

    // The owner reads the whole history on the new board, the move first (newest first).
    const page = await call(owner, "GET", `/cards/${card.id}/activity`);
    expect(page.status).toBe(200);
    expect(page.body.activity.map((entry: CardActivityEntry) => entry.kind)).toEqual(["tag_removed", "board_move", "title", "created"]);
    // A reader of the new board only sees neither the old board's name nor the card's key there.
    const seen = await call(member, "GET", `/cards/${card.id}/activity`);
    expect(seen.status).toBe(200);
    const move = (seen.body.activity as CardActivityEntry[]).find((entry) => entry.kind === "board_move")!;
    expect(move.payload).toEqual({ from: { label: "a board you can't open" }, to: { id: target.id, label: "Roadmap", detail: "ROA-1" } });
    expect(seen.body.activity.map((entry: CardActivityEntry) => entry.kind)).toEqual(["tag_removed", "board_move", "title", "created"]);

    // MCP reads it by the card's new key and by its old one.
    const key = createApiKey(owner.userId, { name: "Move reader", surfaces: "both", grants: [{ module: "tasks", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    for (const ref of ["ROA-1", "myt-2"]) {
      const result = JSON.parse((await invokeMcpToolForTests("get_card_activity", { cardId: ref }, key.id, "mcp")).content[0]!.text) as { activity: CardActivityEntry[]; code?: string };
      expect(result.code).toBeUndefined();
      expect(result.activity[1]).toMatchObject({ kind: "board_move", payload: { from: { label: "My tasks", detail: "MYT-2" }, to: { label: "Roadmap", detail: "ROA-1" } } });
    }
  });

  test("a refused move records nothing", async () => {
    const { owner, member } = await users();
    const source = await board(owner, "Refused source");
    const target = await board(member, "Not shared");
    const card = await addCard(owner, source.id, source.columns[0].id, "Stays");
    expect((await call(owner, "POST", `/cards/${card.id}/move-board`, { boardId: target.id })).status).toBe(404);
    expect(stored(card.id).map((row) => row.kind)).toEqual(["created"]);
  });
});
