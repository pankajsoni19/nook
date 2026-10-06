/**
 * Long-lived requests and Bun's idle timeout (Wave 43 fixes, QA D1).
 *
 * Bun closes a connection that has neither sent nor received a byte for `idleTimeout` seconds
 * (10 s unless the server says otherwise), and that includes a handler still waiting to answer.
 * Normal requests keep that limit (`SERVER_IDLE_TIMEOUT_SECONDS`, set explicitly in server/index.ts).
 * The requests that are meant to stay open lift it for themselves with `keepRequestOpen`:
 * - the SSE streams: GET /api/chats/:id/updates, GET /api/runs/:id/events, and a streamed
 *   POST /api/v1/agents/:id/runs;
 * - the calls that wait for an agent run's answer: a plain POST /api/v1/agents/:id/runs, and
 *   run_agent over MCP or POST /api/v1/tools/run_agent.
 * The SSE streams also write a `: ping` comment every `SSE_TIMING.pingMs` (well under any proxy's
 * idle limit), and the shared-chat stream re-checks access every `SSE_TIMING.accessCheckMs`,
 * independently of the pings.
 */

export const SERVER_IDLE_TIMEOUT_SECONDS = 10;

export const SSE_TIMING = { pingMs: 5_000, accessCheckMs: 15_000 };

/** Tests only: change the ping and access-check intervals; returns a function that restores them. */
export function setSseTimingForTests(patch: Partial<typeof SSE_TIMING>) {
  const before = { ...SSE_TIMING };
  Object.assign(SSE_TIMING, patch);
  return () => { Object.assign(SSE_TIMING, before); };
}

type IdleServer = { timeout(request: Request, seconds: number): void };
let bunServer: IdleServer | null = null;

/** server/index.ts's fetch hands Bun's server here on every request (the second argument of fetch). */
export function noteServer(server: unknown) {
  if (server && typeof (server as IdleServer).timeout === "function") bunServer = server as IdleServer;
}

/** No idle timeout for this request (Bun's `server.timeout(request, 0)`). `request` must be the original one Bun passed in. */
export function keepRequestOpen(request: Request) {
  try {
    bunServer?.timeout(request, 0);
  } catch {
    // Not a request of this server (an in-process test calling app.fetch): nothing to lift.
  }
}
