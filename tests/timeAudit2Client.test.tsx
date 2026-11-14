import { afterAll, describe, expect, test } from "bun:test";
import { installDom, mockApi, render } from "./support/dom";
import { primeUnits } from "../src/ui/units";
import { EntrySheet } from "../src/time/EntrySheet";
import { TimerSheet } from "../src/time/TimerBar";
import { resetTimerStoreForTests } from "../src/time/timerStore";
import type { TimeEntry } from "../shared/time";

/** Audit 2 (TG1, TG8; D1140, D1141): saving an entry sends only what the person changed. */
installDom("http://nook.test/time");
primeUnits();
afterAll(() => resetTimerStoreForTests({ loaded: false }));

const entry = (overrides: Partial<TimeEntry> = {}): TimeEntry => ({
  id: "e1", user: { id: "u1", name: "Riya" }, project: { id: "p1", name: "Acme website", color: "blue", client: null }, description: "Fix the login loop",
  // Seconds and milliseconds the sheet's HH:MM fields cannot hold.
  startedAt: new Date(Math.floor((Date.now() - 7200_000) / 60_000) * 60_000 + 37_250).toISOString(), endedAt: null, durationS: 3600, running: false, tz: "UTC", billable: false,
  rateMinor: null, amountMinor: null, currency: null, tags: [], target: { kind: "card", hidden: true }, source: "manual", locked: false, canEdit: true, revision: 3, ...overrides
});

async function typeInto(input: HTMLInputElement, value: string) {
  const { act } = await import("react");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the entry sheet", () => {
  test("changing the description keeps a hidden work item and the exact start", async () => {
    const api = mockApi({ "PATCH /time/entries/e1": (call) => ({ entry: entry({ description: (call.body as { description: string }).description }) }) });
    const view = await render(<EntrySheet entry={entry()} onClose={() => undefined} />);
    const description = await view.waitFor(() => document.querySelector('input[placeholder="Description"]') as HTMLInputElement | null);
    await typeInto(description, "Fix the login loop for good");
    await view.click(view.button("Save")!);
    const patch = await view.waitFor(() => api.calls.find((call) => call.method === "PATCH"));
    const body = patch.body as Record<string, unknown>;
    expect(body.description).toBe("Fix the login loop for good");
    expect("target" in body).toBe(false);
    expect("startedAt" in body).toBe(false);
    expect(body.expectedRevision).toBe(3);
  });

  test("changing the start sends it", async () => {
    const api = mockApi({ "PATCH /time/entries/e1": () => ({ entry: entry() }) });
    const view = await render(<EntrySheet entry={entry()} onClose={() => undefined} />);
    const start = await view.waitFor(() => document.querySelector('input[placeholder="09:00"]') as HTMLInputElement | null);
    await typeInto(start, "00:05");
    await view.click(view.button("Save")!);
    const patch = await view.waitFor(() => api.calls.find((call) => call.method === "PATCH"));
    expect(typeof (patch.body as Record<string, unknown>).startedAt).toBe("string");
  });
});

describe("the running timer's sheet", () => {
  test("saving keeps a hidden work item", async () => {
    resetTimerStoreForTests({ entry: null });
    const running = entry({ running: true, startedAt: new Date(Date.now() - 600_000).toISOString() });
    const api = mockApi({ "PATCH /time/entries/e1": () => ({ entry: running }) });
    const view = await render(<TimerSheet entry={running} onClose={() => undefined} />);
    const description = await view.waitFor(() => document.querySelector('input[placeholder="Description"]') as HTMLInputElement | null);
    await typeInto(description, "Something else");
    await view.click(view.button("Save")!);
    const patch = await view.waitFor(() => api.calls.find((call) => call.method === "PATCH"));
    expect("target" in (patch.body as Record<string, unknown>)).toBe(false);
  });
});
