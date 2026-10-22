import { fakeEmbedding } from "../tests/support/fakeProvider";

/**
 * A fake Voyage AI embeddings endpoint (D542) for tests and local QA: `POST /v1/embeddings` only, on
 * 127.0.0.1. Like Voyage it sizes vectors by `output_dimension` (256, 512, 1,024, or 2,048 for its
 * sized models), refuses OpenAI's `dimensions` field and `encoding_format: "float"` (Voyage takes only
 * null or base64), reports `usage.total_tokens`, and has no `/v1/models` and no chat (404). Every
 * request's path, headers, and body are recorded. It never calls the internet and ignores the key.
 *
 *   bun --no-env-file scripts/fakeVoyageProvider.ts   (FAKE_VOYAGE_PORT, default 22382)
 */

export type VoyageCall = { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null };
export type FakeVoyage = { baseUrl: string; port: number; calls: VoyageCall[]; stop: () => void };

const SIZES = [256, 512, 1024, 2048];
const SIZED = /^voyage-(?:4(?:-|$)|3-large|3\.5|code-3)/i;

export function startFakeVoyage(port = 0): FakeVoyage {
  const calls: VoyageCall[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      const body = request.method === "POST" ? await request.json().catch(() => null) as Record<string, unknown> | null : null;
      calls.push({ method: request.method, path: url.pathname, headers, body });
      const refuse = (detail: string) => Response.json({ detail }, { status: 400 });
      if (request.method !== "POST" || url.pathname !== "/v1/embeddings") return Response.json({ detail: "Not Found" }, { status: 404 });
      if (!body || typeof body.model !== "string") return refuse("model is required");
      if ("dimensions" in body) return refuse("Unknown argument dimensions; use output_dimension");
      if (body.encoding_format !== undefined && body.encoding_format !== null && body.encoding_format !== "base64") return refuse("encoding_format must be null or base64");
      const inputs = typeof body.input === "string" ? [body.input] : Array.isArray(body.input) ? body.input.filter((item): item is string => typeof item === "string") : [];
      if (inputs.length === 0 || inputs.length > 1000) return refuse("input must have 1 to 1,000 texts");
      const asked = body.output_dimension;
      if (asked !== undefined && asked !== null && (!SIZED.test(body.model) || !SIZES.includes(asked as number))) return refuse(`output_dimension ${String(asked)} is not supported for ${body.model}`);
      const dims = typeof asked === "number" ? asked : 1024;
      const tokens = inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
      return Response.json({ object: "list", data: inputs.map((text, index) => ({ object: "embedding", embedding: fakeEmbedding(text, dims), index })), model: body.model, usage: { total_tokens: tokens } });
    }
  });
  const bound = server.port ?? port;
  return { baseUrl: `http://127.0.0.1:${bound}/v1`, port: bound, calls, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const voyage = startFakeVoyage(Number(process.env.FAKE_VOYAGE_PORT ?? 22382));
  console.log(`Fake Voyage AI embeddings on ${voyage.baseUrl}`);
}
