import type { RunEvent } from "../../shared/agents";

/**
 * The in-memory event ring of each live run (plan §2.3, D345): the last `RING_SIZE` events with
 * ascending `seq`, plus the listeners of open SSE streams. `GET /api/runs/:id/events?after=<seq>`
 * replays from the ring; when the ring has moved past `after`, or the run has ended and its channel
 * is gone, the route sends one `snapshot` built from the database instead. A channel stays for
 * `KEEP_AFTER_CLOSE_MS` after the run ends, so a client that reconnects right after the end still
 * gets the tail.
 */

export const RING_SIZE = 2000;
const KEEP_AFTER_CLOSE_MS = 5 * 60_000;

export type SequencedEvent = RunEvent & { seq: number };
export type Listener = (event: SequencedEvent | null) => void;

export class RunChannel {
  private seq = 0;
  private readonly ring: SequencedEvent[] = [];
  private readonly listeners = new Set<Listener>();
  closed = false;
  private expiry: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly runId: string, private readonly onExpire: () => void) {}

  /** Appends an event and tells every listener. Nothing is emitted after close. */
  emit(event: RunEvent) {
    if (this.closed) return;
    this.seq += 1;
    const sequenced = { ...event, seq: this.seq } as SequencedEvent;
    this.ring.push(sequenced);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    for (const listener of [...this.listeners]) {
      try { listener(sequenced); } catch { this.listeners.delete(listener); }
    }
  }

  /** Ends the channel (after `done`): listeners get `null`, and the ring stays for late resumes. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.listeners]) {
      try { listener(null); } catch { /* gone */ }
    }
    this.listeners.clear();
    this.expiry = setTimeout(() => this.onExpire(), KEEP_AFTER_CLOSE_MS);
    this.expiry.unref?.();
  }

  dispose() {
    if (this.expiry) clearTimeout(this.expiry);
    this.listeners.clear();
  }

  get lastSeq() {
    return this.seq;
  }

  /**
   * The events after `after`, or `"overflow"` when the ring no longer holds them (the client must
   * reload from a snapshot). `after = 0` replays everything the ring still has unless it overflowed.
   */
  replay(after: number): SequencedEvent[] | "overflow" {
    if (this.ring.length === 0) return [];
    if (after + 1 < this.ring[0]!.seq) return "overflow";
    // Past everything this run emitted (a stale or forged cursor, review L7): the client needs the snapshot, not silence.
    if (after > this.seq) return "overflow";
    return this.ring.filter((event) => event.seq > after);
  }

  subscribe(listener: Listener) {
    if (this.closed) { listener(null); return () => undefined; }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get listenerCount() {
    return this.listeners.size;
  }
}

const channels = new Map<string, RunChannel>();

export function openChannel(runId: string): RunChannel {
  const channel = new RunChannel(runId, () => { channels.delete(runId); });
  channels.set(runId, channel);
  return channel;
}

export const channelOf = (runId: string) => channels.get(runId) ?? null;

/** Test hook. */
export function resetChannelsForTests() {
  for (const channel of channels.values()) channel.dispose();
  channels.clear();
}

/** One SSE frame: `id: <seq>`, `event: <type>`, `data: <json>`. Comments (keep-alives) are `: ping`. */
export function sseFrame(event: SequencedEvent) {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
