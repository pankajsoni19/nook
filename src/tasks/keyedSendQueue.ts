/**
 * Writes to one card sent in order (the timeline's date changes, D764): each waits for the one before
 * it, so it carries the revision that one saved. When a send fails, the sends queued behind it for the
 * same card are dropped: the caller reloads the card, and replaying them with the fresh revision would
 * overwrite someone else's change with stale optimistic values. A send made after the failure starts a
 * new queue (still after the failed one's reload).
 */
export type QueuedSend = (isLast: () => boolean) => Promise<void>;

export function keyedSendQueue() {
  const queues = new Map<string, { chain: Promise<void>; pending: number; failed: boolean }>();
  return function enqueue(key: string, send: QueuedSend, onError: (reason: unknown) => Promise<void> | void): Promise<void> {
    const previous = queues.get(key);
    const queue = previous && !previous.failed ? previous : { chain: previous?.chain ?? Promise.resolve(), pending: 0, failed: false };
    queue.pending += 1;
    queue.chain = queue.chain.then(async () => {
      try {
        if (queue.failed) return;
        await send(() => queue.pending === 1);
      } catch (reason) {
        queue.failed = true;
        await onError(reason);
      } finally {
        queue.pending -= 1;
        if (!queue.pending && queues.get(key) === queue) queues.delete(key);
      }
    });
    queues.set(key, queue);
    return queue.chain;
  };
}
