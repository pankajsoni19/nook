import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { krsForBoards, refreshGoalsForBoards } = await import("../server/wiring/tasksGoals");

/**
 * W3-WIRE audit fixes (§D.8): card changes recompute only the view and filter KRs that can count the
 * changed board, without forcing them (D1059a).
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
