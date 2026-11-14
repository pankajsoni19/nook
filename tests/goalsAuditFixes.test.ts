import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { refreshGoalSources } = await import("../server/goals/service");

/**
 * Goals audit fixes (§D.3): a percent KR fed by a count and target is unchanged when its share is (D924).
 */

type Json = Record<string, any>;
const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? (method === "GET" ? {} : { body: "{}" }) : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Json };
};

let owner: Session;
beforeAll(async () => { owner = await createUser("Goals audit owner"); });

describe("percent KRs from a count source (D924)", () => {
  test("a refresh with the same count changes nothing; a new count does", async () => {
    const created = await api(owner, "POST", "/tasks/boards", { name: "Percent board" });
    const boardId = created.body.board.id as string;
    const columns = created.body.columns as Array<{ id: string; is_done: number }>;
    const todo = columns[0]!.id;
    const done = columns.find((column) => column.is_done === 1)!.id;
    const first = (await api(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId: todo, title: "One" })).body.card.id as string;
    await api(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId: todo, title: "Two" });
    await api(owner, "POST", `/tasks/cards/${first}/move`, { columnId: done, afterCardId: null });
    const goal = await api(owner, "POST", "/goals", { title: "Percent goal", keyResults: [{ title: "Share done", metric: "percent", targetValue: 100, source: { kind: "tasks", config: { scope: "board", id: boardId, measure: "cards" } } }] });
    expect(goal.status).toBe(201);
    const goalId = goal.body.goal.id as string;
    const krId = goal.body.goal.keyResults[0].id as string;
    await refreshGoalSources(goalId, { force: true });
    expect((db.query("SELECT current_value FROM key_results WHERE id = ?").get(krId) as Json).current_value).toBe(50);
    expect(await refreshGoalSources(goalId, { force: true })).toBe(0);
    expect(await refreshGoalSources(goalId, { force: true })).toBe(0);
    const second = (db.query("SELECT id FROM cards WHERE board_id = ? AND id <> ?").get(boardId, first) as Json).id as string;
    await api(owner, "POST", `/tasks/cards/${second}/move`, { columnId: done, afterCardId: null });
    expect(await refreshGoalSources(goalId, { force: true })).toBe(1);
    expect((db.query("SELECT current_value FROM key_results WHERE id = ?").get(krId) as Json).current_value).toBe(100);
  });
});
