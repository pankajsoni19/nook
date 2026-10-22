import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { resetCardSearchRateLimit } = await import("../server/tasks/cardSearch");

/** Wave 13D typed card relations and card search over REST (WAVE_13_TASK_CARD_UX.md D104–D107, §3.2, T90, T91, T95). */

beforeEach(() => resetCardSearchRateLimit());

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any>, headers: response.headers };
}
const tasks = (session: Session | undefined, method: string, path: string, body?: unknown) => call(session, method, `/tasks${path}`, body);

async function board(session: Session, name: string) {
  const created = await tasks(session, "POST", "/boards", { name });
  return { id: created.body.board.id as string, columns: created.body.columns as Array<{ id: string; name: string }> };
}
async function card(session: Session, boardId: string, columnId: string, title: string) {
  const created = await tasks(session, "POST", `/boards/${boardId}/cards`, { columnId, title });
  expect(created.status).toBe(201);
  return created.body.card as { id: string; revision: number };
}

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const stranger = await createUser(`${label} stranger`);
  const shared = await board(owner, `${label} shared`);
  expect((await tasks(owner, "PUT", `/boards/${shared.id}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  const other = await board(member, `${label} member board`);
  const secret = await board(owner, `${label} secret board`);
  return {
    owner, member, stranger, shared, other, secret,
    a: await card(owner, shared.id, shared.columns[0]!.id, `${label} alpha`),
    b: await card(member, shared.id, shared.columns[1]!.id, `${label} beta`),
    m: await card(member, other.id, other.columns[0]!.id, `${label} member card`),
    p: await card(owner, secret.id, secret.columns[0]!.id, `${label} secret plan`)
  };
}

const relations = async (session: Session, cardId: string) => {
  const response = await tasks(session, "GET", `/cards/${cardId}`);
  expect(response.status).toBe(200);
  return response.body.relations as Array<Record<string, any>>;
};
const auditRows = (actorId: string, event: string) => (db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = ? ORDER BY rowid").all(actorId, event) as Array<{ metadata_json: string }>)
  .map((row) => JSON.parse(row.metadata_json) as Record<string, unknown>);

describe("typed card relations (D104, D105, D107)", () => {
  test("creating across boards needs read access to both cards; each side sees its own type; revisions never change", async () => {
    const s = await setup("Rel create");
    const created = await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "depends_on", cardId: s.m.id });
    expect(created.status).toBe(201);
    expect(created.body.relation).toMatchObject({
      type: "depends_on", restricted: false, creator_name: "Rel create member",
      card: { id: s.m.id, board_id: s.other.id, board_name: "Rel create member board", title: "Rel create member card", column_name: "To do", is_done: 0, due_on: null }
    });
    const relationId = created.body.relation.id as string;
    // The other side sees the inverse.
    const fromM = await relations(s.member, s.m.id);
    expect(fromM).toEqual([expect.objectContaining({ id: relationId, type: "needed_by", restricted: false, card: expect.objectContaining({ id: s.a.id }) })]);
    // Stored once, as (m blocks a).
    expect(db.query("SELECT source_card_id, target_card_id, kind, created_by FROM card_relations WHERE id = ?").get(relationId))
      .toEqual({ source_card_id: s.m.id, target_card_id: s.a.id, kind: "blocks", created_by: s.member.userId });
    // Edges never change either card's revision or updated_at (D107).
    const before = db.query("SELECT id, revision, updated_at FROM cards WHERE id IN (?, ?) ORDER BY id").all(s.a.id, s.m.id);
    expect((await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "relates_to", cardId: s.b.id })).status).toBe(201);
    expect(db.query("SELECT id, revision, updated_at FROM cards WHERE id IN (?, ?) ORDER BY id").all(s.a.id, s.m.id)).toEqual(before);
    expect((await tasks(s.owner, "GET", `/cards/${s.a.id}`)).body.card.revision).toBe(1);
    // relates is stored in canonical order whichever side created it.
    const relates = db.query("SELECT source_card_id, target_card_id FROM card_relations WHERE kind = 'relates' AND (source_card_id = ?1 OR target_card_id = ?1)").get(s.b.id) as { source_card_id: string; target_card_id: string };
    expect(relates.source_card_id < relates.target_card_id).toBe(true);
    // Newest first.
    expect((await relations(s.member, s.a.id)).map((relation) => relation.type)).toEqual(["relates_to", "depends_on"]);
    expect(auditRows(s.member.userId, "task.relation_create")[0]).toEqual({ boardId: s.shared.id, cardId: s.a.id, relationId, kind: "blocks" });
  });

  test("an unreadable, binned, or unknown target gets the same 404; strangers get 404 on the card; self is 400 (T91)", async () => {
    const s = await setup("Rel oracle");
    const unknown = await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "relates_to", cardId: crypto.randomUUID() });
    const unreadable = await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "relates_to", cardId: s.p.id });
    expect(unknown.status).toBe(404);
    expect(unreadable).toEqual({ ...unknown, headers: unreadable.headers });
    await tasks(s.member, "DELETE", `/cards/${s.b.id}`);
    const binned = await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "relates_to", cardId: s.b.id });
    expect(binned.body).toEqual(unknown.body);
    // A stranger cannot use their own card to probe, nor touch the member's card.
    const strangerBoard = await board(s.stranger, "Rel oracle stranger board");
    const strangerCard = await card(s.stranger, strangerBoard.id, strangerBoard.columns[0]!.id, "Probe");
    expect((await tasks(s.stranger, "POST", `/cards/${strangerCard.id}/relations`, { type: "relates_to", cardId: s.a.id })).body).toEqual(unknown.body);
    expect((await tasks(s.stranger, "POST", `/cards/${s.a.id}/relations`, { type: "relates_to", cardId: strangerCard.id })).status).toBe(404);
    // Self and bad input.
    expect((await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "relates_to", cardId: s.a.id })).status).toBe(400);
    expect((await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "blocks", cardId: s.m.id })).status).toBe(400);
    expect((await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "parent", cardId: s.m.id })).status).toBe(400);
    expect((await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "relates_to", cardId: s.m.id, extra: 1 })).status).toBe(400);
    expect(db.query("SELECT COUNT(*) AS count FROM card_relations WHERE source_card_id = ?1 OR target_card_id = ?1").get(s.a.id)).toEqual({ count: 0 });
  });

  test("RELATION_EXISTS in both directions, only after both cards are readable", async () => {
    const s = await setup("Rel exists");
    const created = await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "needed_by", cardId: s.b.id });
    for (const [from, to, type] of [[s.a.id, s.b.id, "needed_by"], [s.a.id, s.b.id, "relates_to"], [s.b.id, s.a.id, "depends_on"], [s.b.id, s.a.id, "duplicates"]] as const) {
      const again = await tasks(s.owner, "POST", `/cards/${from}/relations`, { type, cardId: to });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("RELATION_EXISTS");
      expect(again.body.relation).toMatchObject({ id: created.body.relation.id, type: from === s.a.id ? "needed_by" : "depends_on", restricted: false });
    }
    expect(db.query("SELECT COUNT(*) AS count FROM card_relations WHERE source_card_id = ?1 OR target_card_id = ?1").get(s.a.id)).toEqual({ count: 1 });
  });

  test("a card the viewer cannot read is a restricted row with no card fields; revoking access turns it restricted at once (T90)", async () => {
    const s = await setup("Rel restricted");
    // The owner links a shared card to a card on a private board.
    const created = await tasks(s.owner, "POST", `/cards/${s.a.id}/relations`, { type: "duplicates", cardId: s.p.id });
    expect(created.status).toBe(201);
    const seen = await relations(s.member, s.a.id);
    expect(seen).toEqual([{ id: created.body.relation.id, type: "duplicates", restricted: true, created_at: created.body.relation.created_at }]);
    const raw = JSON.stringify((await tasks(s.member, "GET", `/cards/${s.a.id}`)).body);
    for (const secret of [s.p.id, s.secret.id, "Rel restricted secret plan", "Rel restricted secret board"]) expect(raw).not.toContain(secret);
    // No creator either (the card's own creator_name elsewhere in the body is the owner).
    expect(JSON.stringify(seen)).not.toContain("Rel restricted owner");
    // The owner sees it in full.
    expect((await relations(s.owner, s.a.id))[0]).toMatchObject({ restricted: false, card: { id: s.p.id, title: "Rel restricted secret plan" } });

    // Revoking the member's access to the shared board: a relation from the member's card becomes restricted.
    expect((await tasks(s.member, "POST", `/cards/${s.m.id}/relations`, { type: "relates_to", cardId: s.b.id })).status).toBe(201);
    expect((await relations(s.member, s.m.id))[0]).toMatchObject({ restricted: false });
    expect((await tasks(s.owner, "PUT", `/boards/${s.shared.id}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    const after = await relations(s.member, s.m.id);
    expect(after).toHaveLength(1);
    expect(Object.keys(after[0]!).sort()).toEqual(["created_at", "id", "restricted", "type"]);
    expect(after[0]!.restricted).toBe(true);
  });

  test("Bin: a binned card the viewer can read is hidden and comes back on restore; unreadable stays restricted; purge cascades", async () => {
    const s = await setup("Rel bin");
    const toB = await tasks(s.owner, "POST", `/cards/${s.a.id}/relations`, { type: "relates_to", cardId: s.b.id });
    const toP = await tasks(s.owner, "POST", `/cards/${s.a.id}/relations`, { type: "depends_on", cardId: s.p.id });
    expect((await relations(s.member, s.a.id)).map((relation) => relation.restricted)).toEqual([true, false]);

    // Binning a readable card hides it (for both users who can read it).
    expect((await tasks(s.member, "DELETE", `/cards/${s.b.id}`)).status).toBe(200);
    expect((await relations(s.member, s.a.id)).map((relation) => relation.id)).toEqual([toP.body.relation.id]);
    expect((await relations(s.owner, s.a.id)).map((relation) => relation.id)).toEqual([toP.body.relation.id]);
    // Binning the unreadable card: the member still sees a restricted row (binning is not disclosed); the owner sees nothing.
    expect((await tasks(s.owner, "DELETE", `/cards/${s.p.id}`)).status).toBe(200);
    expect(await relations(s.member, s.a.id)).toEqual([{ id: toP.body.relation.id, type: "depends_on", restricted: true, created_at: toP.body.relation.created_at }]);
    expect(await relations(s.owner, s.a.id)).toEqual([]);
    // A binned board hides its cards' relations from its readers too.
    expect((await call(s.owner, "POST", `/bin/card/${s.p.id}/restore`)).status).toBe(200);
    expect((await tasks(s.owner, "DELETE", `/boards/${s.secret.id}`)).status).toBe(200);
    expect(await relations(s.owner, s.a.id)).toEqual([]);
    expect((await call(s.owner, "POST", `/bin/board/${s.secret.id}/restore`)).status).toBe(200);

    // Restore brings the relation back.
    expect((await call(s.member, "POST", `/bin/card/${s.b.id}/restore`)).status).toBe(200);
    expect((await relations(s.owner, s.a.id)).map((relation) => relation.id).sort()).toEqual([toB.body.relation.id, toP.body.relation.id].sort());
    // Routes of a binned card are 404.
    await tasks(s.owner, "DELETE", `/cards/${s.b.id}`);
    expect((await tasks(s.owner, "POST", `/cards/${s.b.id}/relations`, { type: "relates_to", cardId: s.m.id })).status).toBe(404);
    expect((await tasks(s.owner, "DELETE", `/cards/${s.b.id}/relations/${toB.body.relation.id}`)).status).toBe(404);
    // Purge cascades.
    expect((await call(s.owner, "DELETE", `/bin/card/${s.b.id}`)).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS count FROM card_relations WHERE id = ?").get(toB.body.relation.id)).toEqual({ count: 0 });
  });

  test("relations made in the same millisecond list newest first, whatever their random ids", async () => {
    const s = await setup("Rel tie");
    const created_at = new Date().toISOString();
    // The newer relation gets the smaller id, so ordering by id instead of insertion would flip them.
    const insert = db.query("INSERT INTO card_relations (id, source_card_id, target_card_id, kind, created_by, created_at) VALUES (?, ?, ?, 'blocks', ?, ?)");
    insert.run("ffffffff-0000-4000-8000-000000000000", s.a.id, s.b.id, s.owner.userId, created_at);
    insert.run("00000000-0000-4000-8000-000000000000", s.a.id, s.p.id, s.owner.userId, created_at);
    expect((await relations(s.owner, s.a.id)).map((relation) => relation.id)).toEqual(["00000000-0000-4000-8000-000000000000", "ffffffff-0000-4000-8000-000000000000"]);
  });

  test("delete: any reader of either end; through an unrelated card is 404; a restricted relation may be removed", async () => {
    const s = await setup("Rel delete");
    const toP = await tasks(s.owner, "POST", `/cards/${s.a.id}/relations`, { type: "relates_to", cardId: s.p.id });
    const toM = await tasks(s.member, "POST", `/cards/${s.b.id}/relations`, { type: "needed_by", cardId: s.m.id });
    // Not an end of the relation: 404, even for a reader of both cards.
    expect((await tasks(s.member, "DELETE", `/cards/${s.a.id}/relations/${toM.body.relation.id}`)).status).toBe(404);
    expect((await tasks(s.member, "DELETE", `/cards/${s.a.id}/relations/${crypto.randomUUID()}`)).status).toBe(404);
    // A stranger gets 404 on the card.
    expect((await tasks(s.stranger, "DELETE", `/cards/${s.a.id}/relations/${toP.body.relation.id}`)).status).toBe(404);
    // The member removes a restricted relation from a card they can read.
    const removed = await tasks(s.member, "DELETE", `/cards/${s.a.id}/relations/${toP.body.relation.id}`);
    expect(removed).toMatchObject({ status: 200, body: { ok: true } });
    expect(await relations(s.owner, s.a.id)).toEqual([]);
    // Deleting from the other end works too, and never touches revisions.
    expect((await tasks(s.member, "DELETE", `/cards/${s.m.id}/relations/${toM.body.relation.id}`)).status).toBe(200);
    expect((await tasks(s.member, "GET", `/cards/${s.b.id}`)).body.card.revision).toBe(1);
    expect(auditRows(s.member.userId, "task.relation_delete").map((row) => row.relationId)).toEqual([toP.body.relation.id, toM.body.relation.id]);
  });

  test("at most 50 relations per card, on either end (relation spam)", async () => {
    const s = await setup("Rel cap");
    const insertCard = db.query(`INSERT INTO cards (id, board_id, column_id, position, title, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Filler', ?, ?, ?)`);
    const insertRelation = db.query("INSERT INTO card_relations (id, source_card_id, target_card_id, kind, created_by, created_at) VALUES (?, ?, ?, 'blocks', ?, ?)");
    const stamp = new Date().toISOString();
    db.transaction(() => {
      for (let index = 0; index < 50; index += 1) {
        const filler = crypto.randomUUID();
        insertCard.run(filler, s.other.id, s.other.columns[2]!.id, 10_000 + index, s.member.userId, stamp, stamp);
        insertRelation.run(crypto.randomUUID(), filler, s.m.id, s.member.userId, stamp);
      }
    })();
    // The full card refuses both as the source and as the target.
    expect((await tasks(s.member, "POST", `/cards/${s.m.id}/relations`, { type: "relates_to", cardId: s.a.id })).body.code).toBe("LIMIT_REACHED");
    expect((await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "relates_to", cardId: s.m.id })).body.code).toBe("LIMIT_REACHED");
    expect(await relations(s.member, s.m.id)).toHaveLength(50);
    expect((await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "relates_to", cardId: s.b.id })).status).toBe(201);
  });

  test("the board payload carries relation_count and open_blockers per viewer", async () => {
    const s = await setup("Rel counts");
    const done = s.shared.columns[2]!.id;
    const c = await card(s.owner, s.shared.id, done, "Rel counts done blocker");
    await tasks(s.owner, "POST", `/cards/${s.a.id}/relations`, { type: "depends_on", cardId: s.b.id });   // open blocker
    await tasks(s.owner, "POST", `/cards/${s.a.id}/relations`, { type: "depends_on", cardId: c.id });     // in a done column
    await tasks(s.owner, "POST", `/cards/${s.a.id}/relations`, { type: "depends_on", cardId: s.p.id });   // unreadable for the member
    expect((await tasks(s.member, "POST", `/cards/${s.a.id}/relations`, { type: "needed_by", cardId: s.m.id })).status).toBe(201); // a blocks m; restricted for the owner
    const cardOf = async (session: Session, cardId: string) => ((await tasks(session, "GET", `/boards/${s.shared.id}`)).body.cards as Array<Record<string, any>>).find((item) => item.id === cardId)!;
    expect(await cardOf(s.owner, s.a.id)).toMatchObject({ relation_count: 4, open_blockers: 2 });
    expect(await cardOf(s.member, s.a.id)).toMatchObject({ relation_count: 4, open_blockers: 1 });
    expect(await cardOf(s.member, s.b.id)).toMatchObject({ relation_count: 1, open_blockers: 0 });
    // A card with no relations still carries zeros.
    const lone = await card(s.owner, s.shared.id, s.shared.columns[0]!.id, "Lone");
    expect(await cardOf(s.owner, lone.id)).toMatchObject({ relation_count: 0, open_blockers: 0 });
    // A binned blocker the viewer can read is hidden and no longer counts.
    await tasks(s.owner, "DELETE", `/cards/${s.b.id}`);
    expect(await cardOf(s.owner, s.a.id)).toMatchObject({ relation_count: 3, open_blockers: 1 });
    expect(await cardOf(s.member, s.a.id)).toMatchObject({ relation_count: 3, open_blockers: 0 });
  });
});

describe("card search (D106, T95)", () => {
  const search = (session: Session, query: string) => tasks(session, "GET", `/cards/search?${query}`);

  test("returns only live cards on readable boards, titles only, with the current board first", async () => {
    const s = await setup("Srch");
    const hits = await search(s.member, "q=srch");
    expect(hits.status).toBe(200);
    const ids = (hits.body.results as Array<{ id: string }>).map((hit) => hit.id);
    expect(ids).toContain(s.a.id);
    expect(ids).toContain(s.m.id);
    expect(ids).not.toContain(s.p.id);
    expect(hits.body.truncated).toBe(false);
    expect(hits.body.results.find((hit: { id: string }) => hit.id === s.a.id)).toEqual({ id: s.a.id, board_id: s.shared.id, board_name: "Srch shared", title: "Srch alpha", column_name: "To do", is_done: 0, is_archived: 0 });
    // Parity with GET /boards/:b: every hit is a card the viewer can load.
    for (const hit of hits.body.results as Array<{ id: string; board_id: string }>) {
      const cards = ((await tasks(s.member, "GET", `/boards/${hit.board_id}`)).body.cards as Array<{ id: string }>).map((item) => item.id);
      expect(cards).toContain(hit.id);
    }
    // The owner finds the private card; the stranger finds none of these.
    expect(((await search(s.owner, "q=secret%20plan")).body.results as Array<{ id: string }>).map((hit) => hit.id)).toEqual([s.p.id]);
    const strangerIds = ((await search(s.stranger, "q=srch")).body.results as Array<{ id: string }>).map((hit) => hit.id);
    for (const id of [s.a.id, s.b.id, s.m.id, s.p.id]) expect(strangerIds).not.toContain(id);
    // Binned cards are gone; excludeCardId drops the card being edited.
    await tasks(s.member, "DELETE", `/cards/${s.b.id}`);
    const after = ((await search(s.member, `q=srch&excludeCardId=${s.a.id}`)).body.results as Array<{ id: string }>).map((hit) => hit.id);
    expect(after).not.toContain(s.b.id);
    expect(after).not.toContain(s.a.id);
    expect(after).toContain(s.m.id);
    // boardId puts that board's cards first, and is only a hint.
    const hinted = (await search(s.member, `q=srch&boardId=${s.other.id}`)).body.results as Array<{ board_id: string }>;
    expect(hinted[0]!.board_id).toBe(s.other.id);
    const foreign = ((await search(s.member, `q=srch&boardId=${s.secret.id}`)).body.results as Array<{ id: string }>).map((hit) => hit.id);
    expect(foreign).not.toContain(s.p.id);
  });

  test("% and _ are literal; prefix matches rank first; limit and truncated; bad input is 400", async () => {
    const user = await createUser("Srch literal");
    const own = await board(user, "Srch literal board");
    const column = own.columns[0]!.id;
    await card(user, own.id, column, "zq 100% done");
    await card(user, own.id, column, "zq snake_case");
    await card(user, own.id, column, "zq plain");
    const titles = async (query: string) => ((await search(user, query)).body.results as Array<{ title: string }>).map((hit) => hit.title);
    expect(await titles("q=%25")).toEqual(["zq 100% done"]);
    expect(await titles("q=_")).toEqual(["zq snake_case"]);
    expect(await titles("q=ZQ%20P")).toEqual(["zq plain"]);
    // Prefix matches first.
    await card(user, own.id, column, "Needle later");
    await card(user, own.id, column, "the needle");
    expect((await titles("q=needle"))[0]).toBe("Needle later");
    const limited = await search(user, "q=zq&limit=2");
    expect(limited.body.results).toHaveLength(2);
    expect(limited.body.truncated).toBe(true);
    for (const query of ["", "q=", "q=%20%20", `q=${"x".repeat(101)}`, "q=a&limit=0", "q=a&limit=21", "q=a&limit=abc", "q=a&boardId=nope", "q=a&excludeCardId=1"]) {
      expect((await search(user, query)).status).toBe(400);
    }
    // /cards/search is never taken for a card id.
    expect((await tasks(user, "GET", "/cards/search")).status).toBe(400);
  });

  test("rate-limited like /api/search: 20 per 10 seconds per user", async () => {
    const user = await createUser("Srch rate");
    for (let index = 0; index < 20; index += 1) expect((await search(user, "q=x")).status).toBe(200);
    const limited = await search(user, "q=x");
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Another user is unaffected.
    expect((await search(await createUser("Srch rate other"), "q=x")).status).toBe(200);
  });
});
