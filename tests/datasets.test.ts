import { describe, expect, test } from "bun:test";
import { createUser, db, request } from "./support/harness";

const { runDatasetQuery, DatasetError } = await import("../server/datasets/registry");

/** Datasets (docs/plan/WORKSPACE_MODULES.md §B.10, D811, T502): structured queries only, the viewer's scope always applied. */

describe("datasets", () => {
  test("tasks.cards counts only cards on boards the viewer can read, by bucket and dimension", async () => {
    const owner = await createUser("Datasets owner");
    const other = await createUser("Datasets other");
    const board = await (await request("/tasks/boards", { method: "POST", body: JSON.stringify({ name: "Dataset board" }) }, owner)).json() as { board: { id: string; columns?: Array<{ id: string }> } };
    const boardId = board.board.id;
    const columnId = (db.query("SELECT id FROM board_columns WHERE board_id = ? ORDER BY position LIMIT 1").get(boardId) as { id: string }).id;
    for (const title of ["One", "Two", "Three"]) {
      const created = await request(`/tasks/boards/${boardId}/cards`, { method: "POST", body: JSON.stringify({ title, columnId }) }, owner);
      expect(created.status).toBeLessThan(300);
    }
    const query = { dataset: "tasks.cards", measures: [{ fn: "count" as const }], dimensions: ["board"], filters: [{ column: "board_id", op: "eq" as const, value: boardId }], timeBucket: "day" as const };
    expect(runDatasetQuery(query, { userId: owner.userId, role: "member" }).rows).toEqual([["Dataset board", new Date().toISOString().slice(0, 10), 3]]);
    expect(runDatasetQuery(query, { userId: other.userId, role: "member" }).rows).toEqual([]);
  });

  test("names, functions, and operators come from the dataset; values are bound, never spliced", async () => {
    const viewer = await createUser("Datasets fuzz");
    const run = (query: Record<string, unknown>) => runDatasetQuery(query as never, { userId: viewer.userId, role: "member" });
    for (const bad of [
      { dataset: "nope", measures: [{ fn: "count" }] },
      { dataset: "tasks.cards", measures: [] },
      { dataset: "tasks.cards", measures: [{ fn: "sum", column: "board" }] },
      { dataset: "tasks.cards", measures: [{ fn: "count" }], dimensions: ["estimate"] },
      { dataset: "tasks.cards", measures: [{ fn: "count" }], dimensions: ["b.name; DROP TABLE cards"] },
      { dataset: "tasks.cards", measures: [{ fn: "count", as: "x\" FROM users --" }] },
      { dataset: "tasks.cards", measures: [{ fn: "count" }], sort: [{ column: "1; --", dir: "asc" }] },
      { dataset: "tasks.cards", measures: [{ fn: "count" }], timeRange: { from: "yesterday" } },
      { dataset: "tasks.cards", measures: [{ fn: "count" }], tz: "Mars/Base" }
    ]) expect(() => run(bad)).toThrow(DatasetError);
    // Quotes and SQL in values are just values.
    expect(run({ dataset: "tasks.cards", measures: [{ fn: "count" }], filters: [{ column: "board", op: "eq", value: "' OR 1=1 --" }] }).rows).toEqual([[0]]);
    expect(run({ dataset: "tasks.cards", measures: [{ fn: "count" }], filters: [{ column: "board", op: "in", value: ["x') OR ('1'='1"] }] }).rows).toEqual([[0]]);
    const http = await request("/datasets/query", { method: "POST", body: JSON.stringify({ dataset: "tasks.cards", measures: [{ fn: "count" }], sql: "SELECT 1" }) }, viewer);
    expect(http.status).toBe(400);
  });
});
