import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./support/harness";
import { LOCAL_MODEL, LOCAL_MODELS } from "../shared/localEmbedding";

const { config } = await import("../server/config");
const { localEmbed, localEmbedStats, resetLocalEmbedderForTests } = await import("../server/knowledge/local/embedder");
const { verifiedProblem } = await import("../server/knowledge/local/model");

/**
 * The real local model (D544, D546), opt-in because it loads 135 MB and takes seconds per text:
 *
 *   LOCAL_EMBEDDINGS_MODEL_TEST=1 bun --no-env-file test tests/localEmbeddingsModel.test.ts
 *
 * with the files in LOCAL_EMBEDDINGS_DIR (default ./models/multilingual-e5-small; fetch them with
 * scripts/fetchLocalModel.ts). It checks the vectors against transformers.js 4.3.1's for the same
 * model (mean pooling, normalized), that the same text always gives the same vector, that meaning
 * (also across languages) ranks the right passage first, long texts in windows, and that a changed
 * file is refused before it is loaded. It prints the load time and the CPU time per chunk.
 *
 * D686: the English variant (bge-small-en-v1.5) runs too when its files are in
 * LOCAL_EMBEDDINGS_ENGLISH_DIR (default ./models/bge-small-en-v1.5; `scripts/fetchLocalModel.ts --variant
 * english`): CLS pooling, its query instruction, deterministic unit vectors, meaning ranks first, long
 * texts in windows, and its worker's resident memory.
 */

const enabled = process.env.LOCAL_EMBEDDINGS_MODEL_TEST === "1";
const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);
const rejection = (promise: Promise<unknown>) => promise.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));
const dir = config.localEmbeddings.dir;

afterAll(() => {
  resetLocalEmbedderForTests();
  config.localEmbeddings.dir = dir;
});

describe.skipIf(!enabled)("the real local model (opt-in)", () => {
  test("matches transformers.js, deterministic, unit length, 384 wide", async () => {
    resetLocalEmbedderForTests();
    config.localEmbeddings.stub = null;
    const first = await localEmbed(["how do I reset my password"], "query");
    const again = await localEmbed(["how do I reset my password"], "query");
    const vector = first.vectors[0]!;
    expect(vector.length).toBe(LOCAL_MODEL.dims);
    expect(Math.abs(Math.sqrt(dot(vector, vector)) - 1)).toBeLessThan(1e-5);
    expect(Array.from(again.vectors[0]!)).toEqual(Array.from(vector));
    // transformers.js 4.3.1, pipeline("feature-extraction", { dtype: "q8" }), pooling mean, normalize, on "query: how do I reset my password".
    const reference = [0.05400, -0.02612, 0.01198, -0.05757];
    reference.forEach((value, index) => expect(Math.abs(vector[index]! - value)).toBeLessThan(5e-5));
    console.log(`local model: loaded in ${localEmbedStats.loadMs} ms`);
  }, 120_000);

  test("meaning ranks the right passage first, also across languages", async () => {
    const [query] = (await localEmbed(["how do I reset my password"], "query")).vectors;
    const passages = (await localEmbed(["To reset your password, open Settings and choose Security.", "Our yoga classes start at 7am every weekday.", "Para restablecer tu contraseña, abre Configuración y elige Seguridad."], "document")).vectors;
    const [english, unrelated, spanish] = passages.map((passage) => dot(query!, passage));
    expect(english!).toBeGreaterThan(unrelated!);
    expect(spanish!).toBeGreaterThan(unrelated!);
  }, 120_000);

  test("a chunk-sized text, and one past 512 tokens read in windows; the CPU time per chunk", async () => {
    const chunk = "Breathing practice slows the heart and settles the mind before a class begins. ".repeat(40).slice(0, 3200);
    const started = performance.now();
    const cpu = process.cpuUsage();
    const result = await localEmbed([chunk], "document");
    const used = process.cpuUsage(cpu);
    const ms = performance.now() - started;
    expect(result.vectors[0]!.length).toBe(LOCAL_MODEL.dims);
    expect(result.tokens).toBeGreaterThan(LOCAL_MODEL.maxTokens);
    const short = await localEmbed([chunk.slice(0, 1000)], "document");
    expect(dot(result.vectors[0]!, short.vectors[0]!)).toBeGreaterThan(0.8);
    console.log(`local model: one 3,200-character chunk (${result.tokens} tokens, ${Math.ceil(result.tokens / LOCAL_MODEL.maxTokens)} windows) in ${Math.round(ms)} ms wall, process CPU ${Math.round((used.user + used.system) / 1000)} ms`);
  }, 120_000);

  test("a file that does not match its pinned sha256 is refused before it is loaded", async () => {
    resetLocalEmbedderForTests();
    const copy = mkdtempSync(join(tmpdir(), "nook-local-model-"));
    try {
      mkdirSync(join(copy, "onnx"));
      symlinkSync(join(dir, "onnx/model_quantized.onnx"), join(copy, "onnx/model_quantized.onnx"));
      symlinkSync(join(dir, "tokenizer.json"), join(copy, "tokenizer.json"));
      const original = await Bun.file(join(dir, "tokenizer_config.json")).text();
      // Same size, one byte changed.
      writeFileSync(join(copy, "tokenizer_config.json"), original.replace("512", "513"));
      config.localEmbeddings.dir = copy;
      expect(await rejection(localEmbed(["anything"], "document"))).toContain("does not match its pinned sha256");
      // D548: Settings → AI's check finds it too (and the real files pass).
      expect(await verifiedProblem(copy)).toContain("tokenizer_config.json in");
      expect(await verifiedProblem(dir)).toBeNull();
    } finally {
      config.localEmbeddings.dir = dir;
      resetLocalEmbedderForTests();
      rmSync(copy, { recursive: true, force: true });
    }
  }, 120_000);
});

const englishDir = process.env.LOCAL_EMBEDDINGS_ENGLISH_DIR ?? join(import.meta.dir, "..", "models", LOCAL_MODELS.english.id);

describe.skipIf(!enabled)("the real English model (opt-in, D686)", () => {
  test("loads, deterministic, unit length, 384 wide; meaning ranks first; long texts in windows", async () => {
    resetLocalEmbedderForTests();
    config.localEmbeddings.stub = null;
    config.localEmbeddings.variant = "english";
    config.localEmbeddings.dir = englishDir;
    try {
      expect(await verifiedProblem(englishDir, LOCAL_MODELS.english)).toBeNull();
      const first = await localEmbed(["how do I reset my password"], "query");
      const again = await localEmbed(["how do I reset my password"], "query");
      const query = first.vectors[0]!;
      expect(query.length).toBe(LOCAL_MODELS.english.dims);
      expect(Math.abs(Math.sqrt(dot(query, query)) - 1)).toBeLessThan(1e-5);
      expect(Array.from(again.vectors[0]!)).toEqual(Array.from(query));
      const passages = (await localEmbed(["To reset your password, open Settings and choose Security.", "Our yoga classes start at 7am every weekday.", "The kanban board has three columns."], "document")).vectors;
      const [right, ...others] = passages.map((passage) => dot(query, passage));
      for (const other of others) expect(right!).toBeGreaterThan(other! + 0.1);
      const chunk = "Breathing practice slows the heart and settles the mind before a class begins. ".repeat(40).slice(0, 3200);
      const cpu = process.cpuUsage();
      const long = await localEmbed([chunk], "document");
      const used = process.cpuUsage(cpu);
      expect(long.tokens).toBeGreaterThan(LOCAL_MODELS.english.maxTokens);
      const short = await localEmbed([chunk.slice(0, 1000)], "document");
      expect(dot(long.vectors[0]!, short.vectors[0]!)).toBeGreaterThan(0.8);
      console.log(`English model: loaded in ${localEmbedStats.loadMs} ms; a 3,200-character chunk (${long.tokens} tokens) in process CPU ${Math.round((used.user + used.system) / 1000)} ms`);
    } finally {
      config.localEmbeddings.variant = "multilingual";
      config.localEmbeddings.dir = dir;
      resetLocalEmbedderForTests();
    }
  }, 120_000);
});
