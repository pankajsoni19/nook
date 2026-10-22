import { config } from "../../config";
import { logger } from "../../log";
import { ProviderError } from "../../agents/loop";
import { LOCAL_MODEL, LOCAL_MODEL_BYTES, type LocalEmbeddingStatus } from "../../../shared/localEmbedding";
import { filesProblem } from "./model";
import type { WorkerReply } from "./worker";

/**
 * The local embedding model's queue on the main thread (D546). One worker thread, one text at a time
 * (a concurrency of 1: at most one CPU core is ever busy with it), searches before indexing (a query
 * waits for at most the text in progress), and bounds on everything:
 *
 * - `batch`: the texts per `embedTexts` batch (the budget and model-change checks run between batches);
 * - `queue`: the texts waiting at once; past it a request is refused at once (busy), never queued;
 * - `maxChars` and `windows`: a text's characters, and its 512-token windows (4: 2,048 tokens);
 * - `jobMs`: one text's time; past it the worker is stopped (and started again for the next text);
 * - `idleMs`: the worker (and the model's memory) is let go after this long without work.
 *
 * Errors are `ProviderError`s, as a remote provider's, so indexing marks the source and search falls
 * back to keywords the same way.
 */
export const LOCAL_EMBED_BOUNDS = { batch: 8, queue: 256, maxChars: 16_000, windows: 4, jobMs: 120_000, idleMs: 10 * 60_000, loadMs: 120_000 };

const log = logger("knowledge");

type Task = { text: string; inputType: "document" | "query"; resolve: (value: { vector: Float32Array; tokens: number }) => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void };

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let current: { id: number; task: Task; timer: ReturnType<typeof setTimeout> } | null = null;
const queries: Task[] = [];
const documents: Task[] = [];
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let readyWaiters: { resolve: () => void; reject: (error: Error) => void } | null = null;
/** Counters for tests and the admin's Test: texts embedded, workers started, the last load's time. */
export const localEmbedStats = { embedded: 0, started: 0, loadMs: null as number | null, maxQueued: 0 };

const fail = (message: string) => new ProviderError("PROVIDER_ERROR", message);

/** Whether this server allows the local model, and whether its files are in place (sizes only; the worker checks sha256). */
export function localEmbeddingStatus(added: boolean): LocalEmbeddingStatus {
  const base = { model: LOCAL_MODEL.id, dims: LOCAL_MODEL.dims, bytes: LOCAL_MODEL_BYTES, added };
  if (!config.localEmbeddings.enabled) return { ...base, allowed: false, available: false, reason: "Turned off on this server (LOCAL_EMBEDDINGS=off)." };
  const problem = config.localEmbeddings.stub ? null : filesProblem(config.localEmbeddings.dir);
  return { ...base, allowed: true, available: problem === null, reason: problem };
}

function stopWorker(reason: string) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (worker) {
    worker.terminate();
    log.info("Local embedding model stopped", { reason });
  }
  worker = null;
  ready = null;
  readyWaiters?.reject(fail("The local embedding model stopped while loading"));
  readyWaiters = null;
}

function startWorker(): Promise<void> {
  if (ready) return ready;
  const started = new Worker(new URL("./worker.ts", import.meta.url).href, { smol: true } as WorkerOptions);
  worker = started;
  localEmbedStats.started += 1;
  ready = new Promise<void>((resolve, reject) => { readyWaiters = { resolve, reject }; });
  const loadTimer = setTimeout(() => { if (readyWaiters) { readyWaiters.reject(fail("The local embedding model took too long to load")); readyWaiters = null; stopWorker("load timeout"); } }, LOCAL_EMBED_BOUNDS.loadMs);
  started.onmessage = (event: MessageEvent<WorkerReply>) => {
    const message = event.data;
    if (message.type === "ready") {
      clearTimeout(loadTimer);
      localEmbedStats.loadMs = message.loadMs;
      log.info("Local embedding model loaded", { ms: message.loadMs });
      readyWaiters?.resolve();
      readyWaiters = null;
      return;
    }
    if (message.type === "failed" && message.id === null) {
      clearTimeout(loadTimer);
      readyWaiters?.reject(fail(message.message));
      readyWaiters = null;
      stopWorker("load failed");
      return;
    }
    if (!current || message.id !== current.id) return;
    const { task, timer } = current;
    clearTimeout(timer);
    current = null;
    if (message.type === "done") {
      localEmbedStats.embedded += 1;
      task.resolve({ vector: message.vector, tokens: message.tokens });
    } else {
      task.reject(fail(message.message));
    }
    pump();
  };
  started.onerror = (event) => {
    log.error("Local embedding worker failed", { message: (event as ErrorEvent).message?.slice(0, 200) ?? "" });
    clearTimeout(loadTimer);
    const running = current;
    current = null;
    if (running) { clearTimeout(running.timer); running.task.reject(fail("The local embedding model failed")); }
    stopWorker("error");
    pump();
  };
  started.postMessage({ type: "init", dir: config.localEmbeddings.dir, stub: config.localEmbeddings.stub });
  return ready;
}

function pump() {
  if (current) return;
  const task = queries.shift() ?? documents.shift();
  if (!task) {
    if (worker && !idleTimer) idleTimer = setTimeout(() => stopWorker("idle"), LOCAL_EMBED_BOUNDS.idleMs);
    return;
  }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (task.signal && task.onAbort) task.signal.removeEventListener("abort", task.onAbort);
  if (task.signal?.aborted) { task.reject(fail("Stopped")); pump(); return; }
  const id = nextId++;
  // Placeholder until the worker is ready: `current` holds the slot, so nothing else starts meanwhile.
  current = { id, task, timer: setTimeout(() => undefined, 0) };
  startWorker().then(() => {
    if (!current || current.id !== id || !worker) return;
    current.timer = setTimeout(() => {
      if (!current || current.id !== id) return;
      current = null;
      task.reject(fail(`The local embedding model took longer than ${Math.round(LOCAL_EMBED_BOUNDS.jobMs / 1000)} s on one text`));
      stopWorker("job timeout");
      pump();
    }, LOCAL_EMBED_BOUNDS.jobMs);
    worker.postMessage({ type: "embed", id, text: task.text, inputType: task.inputType, maxChars: LOCAL_EMBED_BOUNDS.maxChars, windows: LOCAL_EMBED_BOUNDS.windows });
  }, (error: Error) => {
    if (current?.id === id) current = null;
    task.reject(error);
    // The next text tries a fresh load (the files may have been put in place meanwhile).
    pump();
  });
}

/**
 * Embeds texts with the local model, one at a time on its worker; resolves when all are done.
 * Searches (`query`) go before indexing (`document`). Refused at once when the server forbids the
 * model or the queue is full.
 */
export async function localEmbed(texts: readonly string[], inputType: "document" | "query", signal?: AbortSignal): Promise<{ vectors: Float32Array[]; tokens: number }> {
  if (!config.localEmbeddings.enabled) throw fail("Local embeddings are turned off on this server (LOCAL_EMBEDDINGS=off)");
  if (texts.length > LOCAL_EMBED_BOUNDS.batch) throw fail(`At most ${LOCAL_EMBED_BOUNDS.batch} texts go to the local model at once`);
  if (queries.length + documents.length + texts.length > LOCAL_EMBED_BOUNDS.queue) throw fail("The local embedding model is busy; try again shortly");
  if (signal?.aborted) throw fail("Stopped");
  const lane = inputType === "query" ? queries : documents;
  const results = texts.map((text) => new Promise<{ vector: Float32Array; tokens: number }>((resolve, reject) => {
    const task: Task = { text, inputType, resolve, reject, signal };
    if (signal) {
      task.onAbort = () => {
        const at = lane.indexOf(task);
        if (at >= 0) { lane.splice(at, 1); reject(fail("Stopped")); }
      };
      signal.addEventListener("abort", task.onAbort, { once: true });
    }
    lane.push(task);
  }));
  localEmbedStats.maxQueued = Math.max(localEmbedStats.maxQueued, queries.length + documents.length);
  pump();
  const done = await Promise.all(results);
  return { vectors: done.map((item) => item.vector), tokens: done.reduce((sum, item) => sum + item.tokens, 0) };
}

/** Tests: the queue's state, and a full stop (the worker, its timers, and every waiting text). */
export const localQueueForTests = () => ({ queries: queries.length, documents: documents.length, running: current !== null, worker: worker !== null });
export function resetLocalEmbedderForTests() {
  for (const task of [...queries.splice(0), ...documents.splice(0)]) task.reject(fail("Stopped"));
  if (current) { clearTimeout(current.timer); current.task.reject(fail("Stopped")); current = null; }
  stopWorker("reset");
  Object.assign(localEmbedStats, { embedded: 0, started: 0, loadMs: null, maxQueued: 0 });
}
