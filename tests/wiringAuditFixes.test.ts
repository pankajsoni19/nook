import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { krsForBoards, refreshGoalsForBoards } = await import("../server/wiring/tasksGoals");
const { flushCardChangesForTests, onCardChange } = await import("../server/tasks/cardEvents");
const { recordCardActivity } = await import("../server/tasks/activity");

/**
 * W3-WIRE audit fixes (§D.8): card changes recompute only the view and filter KRs that can count the
 * changed board, without forcing them (D1059a); an edited or retried standup answer updates its goal
 * check-in instead of adding one (D1059b); a rolled-back change folded into an earlier activity entry
 * is never reported (D1059c).
 */

type Json = Record<string, any>;
const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? (method === "GET" ? {} : { body: "{}" }) : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = JSON.parse(text) as Json; } catch { json = { text }; }
  return { status: response.status, body: json };
};
async function board(session: Session, name: string) {
  const created = await api(session, "POST", "/tasks/boards", { name });
  const columns = created.body.columns as Array<{ id: string; is_done: number }>;
  return { id: created.body.board.id as string, todo: columns[0]!.id, done: columns.find((column) => column.is_done === 1)!.id };
}

let owner: Session;
let outsider: Session;
beforeAll(async () => {
  owner = await createUser("Wiring audit owner");
  outsider = await createUser("Wiring audit outsider");
});

describe("card changes and spanning KRs (D1059a)", () => {
  test("only filter KRs whose owner can read the board are picked, and they keep Goals' debounce", async () => {
    const target = await board(owner, "Reach board");
    await api(owner, "POST", `/tasks/boards/${target.id}/cards`, { columnId: target.todo, title: "Launch one" });
    const filterKr = (session: Session, title: string) => api(session, "POST", "/goals", { title, keyResults: [{ title: "Launch cards", source: { kind: "tasks", config: { scope: "filter", query: "Launch", measure: "cards" } } }] });
    const mine = await filterKr(owner, "Owner's filter goal");
    expect(mine.status).toBe(201);
    const theirs = await filterKr(outsider, "Outsider's filter goal");
    expect(theirs.status).toBe(201);
    const boardGoal = await api(owner, "POST", "/goals", { title: "Board goal", keyResults: [{ title: "Cards", source: { kind: "tasks", config: { scope: "board", id: target.id, measure: "cards" } } }] });
    const mineKr = mine.body.goal.keyResults[0].id as string;
    const theirKr = theirs.body.goal.keyResults[0].id as string;
    const boardKr = boardGoal.body.goal.keyResults[0].id as string;
    const picked = krsForBoards([target.id]).map((kr) => kr.id);
    expect(picked).toContain(mineKr);
    expect(picked).toContain(boardKr);
    expect(picked).not.toContain(theirKr);
    // Both just computed: a change recomputes the board KR now, the filter KR waits for its debounce.
    const stamp = new Date(Date.now() - 1000).toISOString();
    db.query("UPDATE key_results SET auto_updated_at = ? WHERE id IN (?, ?)").run(stamp, mineKr, boardKr);
    await refreshGoalsForBoards([target.id]);
    const at = (id: string) => (db.query("SELECT auto_updated_at FROM key_results WHERE id = ?").get(id) as { auto_updated_at: string }).auto_updated_at;
    expect(at(mineKr)).toBe(stamp);
    expect(at(boardKr)).not.toBe(stamp);
  });
});

describe("standup goal updates are keyed by the answer (D1059b)", () => {
  test("editing the answer updates its check-in: one row, one activity entry, the new value", async () => {
    const created = await api(owner, "POST", "/checkins", { template: "standup", name: "Keyed standup", participants: { people: [owner.userId], groups: [] } });
    const checkinId = created.body.checkin.id as string;
    const set = { version: 1, sections: [], logic: [], endings: [], questions: [{ id: "goals", type: "long_text", title: "Goal updates", role: "goal_update" }] };
    expect((await api(owner, "PUT", `/checkins/${checkinId}/questions`, { set })).status).toBe(200);
    expect((await api(owner, "POST", `/checkins/${checkinId}/questions/publish`)).status).toBe(200);
    await api(owner, "POST", `/checkins/${checkinId}/rounds`);
    const roundId = (db.query("SELECT id FROM checkin_rounds WHERE checkin_id = ?").get(checkinId) as { id: string }).id;
    const goal = await api(owner, "POST", "/goals", { title: "Keyed goal", keyResults: [{ title: "Calls", targetValue: 10, currentValue: 0 }] });
    const goalId = goal.body.goal.id as string;
    const krId = goal.body.goal.keyResults[0].id as string;
    const answer = (value: number, text: string) => api(owner, "POST", `/checkin-rounds/${roundId}/answer`, { answers: { goals: text }, goalUpdates: [{ goalId, values: { [krId]: value } }] });
    expect((await answer(3, "Three calls")).status).toBe(201);
    const edited = await answer(5, "Five calls");
    expect(edited.status).toBeLessThan(300);
    expect((await answer(5, "Five calls")).status).toBeLessThan(300);
    const rows = db.query("SELECT note_md, values_json, source_ref FROM goal_checkins WHERE goal_id = ?").all(goalId) as Json[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note_md).toContain("Five calls");
    expect(JSON.parse(rows[0]!.values_json)).toEqual({ [krId]: 5 });
    expect((db.query("SELECT current_value FROM key_results WHERE id = ?").get(krId) as Json).current_value).toBe(5);
    expect((db.query("SELECT COUNT(*) AS n FROM item_activity WHERE item_kind = 'goal' AND item_id = ? AND kind = 'checked_in'").get(goalId) as Json).n).toBe(1);
  });
});

describe("folded card activity is reported only when it commits (D1059c)", () => {
  test("a rolled-back fold reports nothing; a committed one does", async () => {
    const target = await board(owner, "Fold board");
    const cardId = (await api(owner, "POST", `/tasks/boards/${target.id}/cards`, { columnId: target.todo, title: "Fold me" })).body.card.id as string;
    const write = (to: string) => recordCardActivity({ cardId, boardId: target.id, actorId: owner.userId, kind: "description", payload: { to: { label: to } } });
    const first = db.transaction(() => write("first"))();
    await flushCardChangesForTests();
    const heard: string[] = [];
    const stop = onCardChange((changes) => { for (const change of changes) heard.push(`${change.kind}:${change.activityId}`); });
    try {
      expect(() => db.transaction(() => { write("rolled back"); throw new Error("refused"); })()).toThrow("refused");
      await flushCardChangesForTests();
      expect(heard).toEqual([]);
      // The earlier entry is untouched by the rollback.
      expect(db.query("SELECT json_extract(payload, '$.to.label') AS label FROM card_activity WHERE id = ?").get(first)).toEqual({ label: "first" });
      const kept = db.transaction(() => write("kept"))();
      await flushCardChangesForTests();
      expect(heard).toEqual([`description:${kept}`]);
      // Still one folded entry on the card for the two committed writes.
      expect(db.query("SELECT COUNT(*) AS n FROM card_activity WHERE card_id = ? AND kind = 'description'").get(cardId)).toEqual({ n: 1 });
    } finally { stop(); }
  });
});
