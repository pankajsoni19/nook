import { afterAll, describe, expect, test } from "bun:test";
import "./support/harness";
import { startFakeProvider } from "./support/fakeProvider";
import { AGENT_BOUNDS, DEFAULT_COMPAT } from "../shared/agents";

const { runLoop, keptUsage } = await import("../server/agents/loop");
type TokenUsage = { promptTokens: number; completionTokens: number; estimated: boolean };

/**
 * TODO "Cut-reply charging": the run does not stop at the stored bound. Text a step sends back to
 * the model as context (a step that asks for tools) was used and is charged in full; the ending
 * step's text only becomes the stored reply, so it is charged for what still fits after the earlier
 * steps' text, and nothing for text generated once the stored reply was already full.
 */

const fake = startFakeProvider(0);
afterAll(() => fake.stop());
const cap = AGENT_BOUNDS.assistantMessageChars;

async function run(input: string) {
  const charged: Array<{ usage: TokenUsage; more: boolean }> = [];
  const steps: TokenUsage[] = [];
  const events: TokenUsage[] = [];
  let streamed = 0;
  const result = await runLoop({
    connection: { id: "fake", baseUrl: fake.baseUrl, apiKey: null, model: "gpt-6-luna", compat: DEFAULT_COMPAT },
    messages: [{ role: "user", content: input }],
    maxSteps: 3,
    temperature: null,
    maxOutputTokens: null,
    signal: new AbortController().signal,
    sink: { delta: (text) => { streamed += text.length; }, usage: (usage) => { events.push(usage); }, step: (step) => { steps.push(step.usage); } },
    charge: (usage, more) => { charged.push({ usage, more }); },
    tools: () => [{ name: "lookup", description: "Looks up", parameters: { type: "object", properties: {} } }],
    execute: async () => ({ content: "ok" })
  });
  return { result, charged, steps, events, streamed };
}

describe("cut-reply charging across steps", () => {
  test("a step that went back to the model is charged in full; the ending step only for what the stored reply keeps", async () => {
    const { result, charged, steps, events, streamed } = await run("toolbig:200:200");
    expect(result.status).toBe("stop");
    expect(result.steps).toBe(2);
    expect(streamed).toBe(400 * 1024);
    // Step 1: 200 KiB of text and a tool call, within the per-call bound: the provider's figures stand.
    expect(charged[0]).toEqual({ usage: expect.objectContaining({ completionTokens: 200 * 1024 / 4 + 8, estimated: false }), more: true });
    // Step 2 ends the run: only cap − 200 KiB characters of its 200 KiB fit in the stored reply.
    const kept = Math.ceil((cap - 200 * 1024) / 4);
    expect(charged[1]).toEqual({ usage: expect.objectContaining({ completionTokens: kept, estimated: true }), more: false });
    expect(kept).toBeLessThan(200 * 1024 / 4);
    // The Audit log's steps, the usage events, and the run total all say the same.
    expect(steps).toEqual(charged.map((item) => item.usage));
    expect(events).toEqual(charged.map((item) => item.usage));
    expect(result.usage).toMatchObject({ completionTokens: 200 * 1024 / 4 + 8 + kept, estimated: true });
    expect(result.usage.promptTokens).toBe(charged[0]!.usage.promptTokens + charged[1]!.usage.promptTokens);
    // Together the output charged equals (about) the stored reply plus the tool call: never the 400 KiB generated.
    expect(result.usage.completionTokens).toBe(Math.ceil(cap / 4) + 8);
  });

  test("once the stored reply is full, the ending step's text is not charged; the earlier step's cut stays per call", async () => {
    const { result, charged } = await run("toolbig:300:100");
    expect(result.steps).toBe(2);
    // Step 1 passed the per-call bound: what went back to the model (the kept text) is charged, estimated.
    expect(charged[0]!.usage).toMatchObject({ completionTokens: Math.ceil(cap / 4), estimated: true });
    // Step 2's 100 KiB were generated after the stored reply was full and thrown away.
    expect(charged[1]!.usage).toMatchObject({ completionTokens: 0, estimated: true });
    expect(charged[1]!.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.completionTokens).toBe(Math.ceil(cap / 4));
  });

  test("a run within the bound is charged the provider's figures, unchanged", async () => {
    const { result, charged } = await run("toolbig:4:4");
    expect(charged.map((item) => item.usage.estimated)).toEqual([false, false]);
    expect(result.usage).toMatchObject({ completionTokens: 1024 + 8 + 1024, estimated: false });
  });

  test("keptUsage: unchanged when the text fits the room, else the kept text ÷ 4 (never more than reported), estimated", () => {
    const reported = { promptTokens: 50, completionTokens: 1000, estimated: false };
    expect(keptUsage(reported, "x".repeat(400), 400)).toBe(reported);
    expect(keptUsage(reported, "x".repeat(401), 400)).toEqual({ promptTokens: 50, completionTokens: 100, estimated: true });
    expect(keptUsage(reported, "x".repeat(401), 0)).toEqual({ promptTokens: 50, completionTokens: 0, estimated: true });
    expect(keptUsage({ promptTokens: 1, completionTokens: 3, estimated: false }, "x".repeat(401), 400)).toEqual({ promptTokens: 1, completionTokens: 3, estimated: true });
  });
});
