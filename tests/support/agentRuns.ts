import { afterEach, beforeAll } from "bun:test";
import { db } from "./harness";
import type { ProviderCall } from "./fakeProvider";

const { activeRuns } = await import("../../server/agents/runs");
const { liveExternalRuns } = await import("../../server/agents/external");
const { heldPlainRuns } = await import("../../server/agents/limits");

/**
 * Agent runs end in the background: a test that fails before it awaits its runs, or one whose run is
 * marked `running` before its provider call is made, leaves work in flight for the next test (its
 * slots, its provider calls, its Audit log rows). Under load (the Docker `verify` stage) that work
 * lands in the next test's counts. Call this at the top of a file that starts agent runs: after every
 * test, any run still live is stopped, and the test ends only once no run of an account the file made
 * is queued, running, or awaiting confirmation, and no slot or held request is taken.
 */
export function settleAgentRunsAfterEach(timeoutMs = 20_000) {
  let firstUserRowid = 0;
  beforeAll(() => {
    firstUserRowid = (db.query("SELECT COALESCE(MAX(rowid), 0) AS id FROM users").get() as { id: number }).id;
  });
  afterEach(async () => {
    for (const run of activeRuns()) run.controller.abort("stop");
    const liveRows = () => (db.query(`SELECT COUNT(*) AS count FROM agent_runs r JOIN users u ON u.id = r.user_id
      WHERE u.rowid > ? AND r.status IN ('queued','running','awaiting_confirmation')`).get(firstUserRowid) as { count: number }).count;
    const settled = () => activeRuns().length === 0 && liveExternalRuns().length === 0 && heldPlainRuns().rest === 0 && heldPlainRuns().mcp === 0 && liveRows() === 0;
    const until = Date.now() + timeoutMs;
    while (!settled()) {
      if (Date.now() > until) throw new Error(`agent runs still live after the test: ${activeRuns().length} active, ${liveExternalRuns().length} external, ${liveRows()} rows`);
      for (const run of activeRuns()) run.controller.abort("stop");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
}

/** A marker unique to one test, to put in a run's input and find that run's provider calls by. */
export const runMarker = () => `m${crypto.randomUUID().replaceAll("-", "")}`;

/** The fake provider's completion calls whose request carries `marker` (every call of a run carries its input). */
export const completionsWith = (calls: ProviderCall[], marker: string) =>
  calls.filter((call) => call.path === "/v1/chat/completions" && JSON.stringify(call.body).includes(marker));
