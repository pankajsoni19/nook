import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The agent-run depth guard (Wave 42 "AC-C", plan §7.2, T318): every run (a chat's, an API call's,
 * or `run_agent`'s) executes inside this store, which follows its async work: model calls, tool
 * calls, and Nook tools run in process through `runTool`. `run_agent` refuses to start while a run
 * is in the store, so an agent can never start another run, whatever key its Nook tools use (the
 * tool is also left out of the Nook tools agents are offered).
 */

export type AgentRunFrame = { runId: string; via: "chat" | "api" | "mcp" };

const frames = new AsyncLocalStorage<AgentRunFrame>();

/** The run this code is executing inside, or null outside every run. */
export const currentAgentRun = (): AgentRunFrame | null => frames.getStore() ?? null;

/** Runs `operation` (and everything it awaits or schedules) inside the run's frame. */
export const withinAgentRun = <T>(frame: AgentRunFrame, operation: () => T): T => frames.run(frame, operation);
