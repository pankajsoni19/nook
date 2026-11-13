import { expect, test } from "bun:test";
import { keyedSendQueue } from "../src/tasks/keyedSendQueue";

// Review fix (timeline date changes, D764): a failed send drops the ones queued behind it for the same
// card, so they never replay stale optimistic dates with the revision the reload brought.
const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("sends for one card run in order, and only the last one is last", async () => {
  const enqueue = keyedSendQueue();
  const log: string[] = [];
  const first = deferred();
  enqueue("c1", async (isLast) => { await first.promise; log.push(`a last=${isLast()}`); }, () => undefined);
  const done = enqueue("c1", async (isLast) => { log.push(`b last=${isLast()}`); }, () => undefined);
  expect(log).toEqual([]);
  first.resolve();
  await done;
  expect(log).toEqual(["a last=false", "b last=true"]);
});

test("a failure drops the sends queued behind it; a later send starts again after the reload", async () => {
  const enqueue = keyedSendQueue();
  const log: string[] = [];
  const first = deferred();
  const reload = deferred();
  enqueue("c1", async () => { await first.promise; }, async () => { log.push("reload"); await reload.promise; });
  enqueue("c1", async () => { log.push("stale b"); }, () => { log.push("b error"); });
  enqueue("c1", async () => { log.push("stale c"); }, () => undefined);
  // Another card is not affected.
  const other = enqueue("c2", async () => { log.push("other"); }, () => undefined);
  await other;
  first.reject(new Error("CARD_CHANGED"));
  while (!log.includes("reload")) await new Promise((resolve) => setTimeout(resolve, 0));
  // Made while the reload runs: waits for it, then is sent.
  const after = enqueue("c1", async (isLast) => { log.push(`fresh last=${isLast()}`); }, () => undefined);
  reload.resolve();
  await after;
  expect(log).toEqual(["other", "reload", "fresh last=true"]);
});
