import { dirname, join } from "node:path";
import { LOCAL_MODEL } from "../../../shared/localEmbedding";
import { LocalModelError, verifyModelFiles } from "./model";

/**
 * The local embedding model's worker thread (D544, D546). It loads the model once (after checking
 * every file's sha256), then embeds one text per message, so a request thread is never blocked and
 * the main thread decides the order (searches before indexing) and the bounds.
 *
 * Runtime: ONNX Runtime Web's WASM backend (pure WebAssembly, single-threaded, no native code, so it
 * runs on the Alpine image as anywhere) and Hugging Face's pure-JS tokenizers. One text is one run
 * with no padding: int8 models quantize activations per tensor, so padding a batch would change a
 * text's vector with its neighbours; alone, the same text always gives the same vector, and the
 * vectors equal transformers.js's for the same model.
 *
 * A text longer than the model's 512 tokens is read in windows of 512 (each with the E5 prefix), at
 * most `windows` of them; the vector is the token-weighted mean of the windows' mean-pooled vectors,
 * L2-normalized. `stub` (tests only): a deterministic hash embedding of the same size, no files.
 */

type Init = { type: "init"; dir: string; stub: { delayMs: number } | null };
type Job = { type: "embed"; id: number; text: string; inputType: "document" | "query"; maxChars: number; windows: number };
export type WorkerReply =
  | { type: "ready"; loadMs: number }
  | { type: "done"; id: number; vector: Float32Array; tokens: number; ms: number }
  | { type: "failed"; id: number | null; code: string; message: string };

type Engine = { embed(text: string, inputType: Job["inputType"], windows: number): Promise<{ vector: Float32Array; tokens: number }> };

declare const self: Worker;

const normalize = (vector: Float32Array) => {
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) sum += vector[index]! * vector[index]!;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let index = 0; index < vector.length; index += 1) vector[index] = vector[index]! / norm;
  return vector;
};

/** Tests only: words hashed into the model's size (FNV-1a), so similar texts point the same way. */
function stubEngine(delayMs: number): Engine {
  return {
    async embed(text, inputType) {
      if (delayMs > 0) await Bun.sleep(delayMs);
      const vector = new Float32Array(LOCAL_MODEL.dims);
      const words = `${LOCAL_MODEL.prefixes[inputType]}${text}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      for (const word of words) {
        let hash = 0x811c9dc5;
        for (let index = 0; index < word.length; index += 1) hash = Math.imul(hash ^ word.charCodeAt(index), 0x01000193) >>> 0;
        vector[hash % LOCAL_MODEL.dims]! += (hash >>> 31) === 1 ? -1 : 1;
      }
      if (words.length === 0) vector[0] = 1;
      return { vector: normalize(vector), tokens: words.length + 2 };
    }
  };
}

async function modelEngine(dir: string): Promise<Engine> {
  await verifyModelFiles(dir);
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const ort = await import("onnxruntime-web");
  const tokenizer = new Tokenizer(JSON.parse(await Bun.file(join(dir, "tokenizer.json")).text()), JSON.parse(await Bun.file(join(dir, "tokenizer_config.json")).text()));
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = `file://${dirname(Bun.resolveSync("onnxruntime-web", import.meta.dir))}/`;
  ort.env.logLevel = "error";
  const session = await ort.InferenceSession.create(new Uint8Array(await Bun.file(join(dir, "onnx/model_quantized.onnx")).arrayBuffer()), { executionProviders: ["wasm"], graphOptimizationLevel: "all", enableCpuMemArena: false, enableMemPattern: false });
  const output = session.outputNames[0]!;
  const typed = session.inputNames.includes("token_type_ids");
  const start = tokenizer.token_to_id("<s>")!;
  const end = tokenizer.token_to_id("</s>")!;
  const size = LOCAL_MODEL.maxTokens - 2;

  async function run(ids: number[]): Promise<Float32Array> {
    const length = ids.length;
    const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, (id) => BigInt(id)), [1, length]),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(length).fill(1n), [1, length])
    };
    if (typed) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(length), [1, length]);
    const result = await session.run(feeds);
    const hidden = result[output]!;
    const data = hidden.data as Float32Array;
    const dims = hidden.dims[2]!;
    const pooled = new Float32Array(dims);
    for (let token = 0; token < length; token += 1) for (let at = 0; at < dims; at += 1) pooled[at]! += data[token * dims + at]!;
    for (let at = 0; at < dims; at += 1) pooled[at] = pooled[at]! / length;
    for (const tensor of Object.values(result)) tensor.dispose?.();
    return pooled;
  }

  return {
    async embed(text, inputType, windows) {
      const prefix = LOCAL_MODEL.prefixes[inputType];
      const first = tokenizer.encode(prefix + text).ids;
      // One window: exactly what the model and transformers.js read (special tokens included).
      if (first.length <= LOCAL_MODEL.maxTokens) return { vector: normalize(await run(first)), tokens: first.length };
      const body = tokenizer.encode(prefix + text, { add_special_tokens: false }).ids;
      const prefixIds = tokenizer.encode(prefix, { add_special_tokens: false }).ids;
      const pieces: number[][] = [[start, ...body.slice(0, size), end]];
      for (let at = size; at < body.length && pieces.length < windows; at += size - prefixIds.length) pieces.push([start, ...prefixIds, ...body.slice(at, at + size - prefixIds.length), end]);
      const sum = new Float32Array(LOCAL_MODEL.dims);
      let tokens = 0;
      for (const piece of pieces) {
        const pooled = await run(piece);
        for (let at = 0; at < sum.length; at += 1) sum[at]! += pooled[at]! * piece.length;
        tokens += piece.length;
      }
      return { vector: normalize(sum), tokens };
    }
  };
}

let engine: Promise<Engine> | null = null;
const reply = (message: WorkerReply, transfer: Transferable[] = []) => self.postMessage(message, transfer);
const failure = (id: number | null, error: unknown): WorkerReply => error instanceof LocalModelError
  ? { type: "failed", id, code: error.code, message: error.message }
  : { type: "failed", id, code: "LOCAL_FAILED", message: `The local embedding model failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}` };

self.onmessage = async (event: MessageEvent<Init | Job>) => {
  const message = event.data;
  if (message.type === "init") {
    const started = performance.now();
    engine = message.stub ? Promise.resolve(stubEngine(message.stub.delayMs)) : modelEngine(message.dir);
    try {
      await engine;
      reply({ type: "ready", loadMs: Math.round(performance.now() - started) });
    } catch (error) {
      reply(failure(null, error));
    }
    return;
  }
  if (message.type === "embed") {
    try {
      if (!engine) throw new LocalModelError("LOCAL_FAILED", "The local embedding model was not started");
      const ready = await engine;
      const started = performance.now();
      const { vector, tokens } = await ready.embed(message.text.slice(0, message.maxChars), message.inputType, message.windows);
      reply({ type: "done", id: message.id, vector, tokens, ms: Math.round(performance.now() - started) }, [vector.buffer]);
    } catch (error) {
      reply(failure(message.id, error));
    }
  }
};
