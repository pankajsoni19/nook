/**
 * A fake OpenAI-compatible server for the agent chat tests (plan §15 item 1): `GET /v1/models` and
 * a streaming `POST /v1/chat/completions` on 127.0.0.1, which the harness allows through
 * AGENT_ALLOWED_PRIVATE_HOSTS. It never calls the internet and ignores the API key, but records
 * every request's headers and body so tests can prove what left Nook. The last user message steers
 * the reply:
 *
 *   `echo:<text>`      stream `<text>` in word-sized chunks (the default: "You said: …")
 *   `slow:<n>:<text>`  stream `<text>` with `n` ms between chunks (cancellation, resume)
 *   `status:<code>`    answer with that HTTP status and a JSON error body
 *   `nousage:<text>`   stream `<text>` without a usage chunk (estimated tokens)
 *   `stall:`           send one chunk, then nothing (the idle timeout)
 *   `redirect:`        answer 302 to itself
 *   `huge:<kb>`        stream `<kb>` KiB of text (the byte cap)
 *   `tool:`            stream a tool call (AC-B's shape; AC-A must ignore it and stop)
 */

export type ProviderCall = { method: string; path: string; headers: Record<string, string>; body: unknown };

export type FakeProvider = { baseUrl: string; port: number; calls: ProviderCall[]; stop: () => void; models: string[] };

const encoder = new TextEncoder();
const chunk = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
const delta = (text: string, model: string) => ({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });

export function startFakeProvider(port: number, options: { models?: string[] } = {}): FakeProvider {
  const calls: ProviderCall[] = [];
  const models = options.models ?? ["gpt-6-luna", "gpt-6-mini", "text-embedding-3-small"];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      let body: unknown = null;
      if (request.method === "POST") {
        try { body = await request.json(); } catch { body = null; }
      }
      calls.push({ method: request.method, path: url.pathname, headers, body });
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: models.map((id) => ({ id, object: "model" })) });
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const payload = body as { model?: string; messages?: Array<{ role: string; content: string }>; stream?: boolean } | null;
        const model = payload?.model ?? "gpt-6-luna";
        const last = [...(payload?.messages ?? [])].reverse().find((turn) => turn.role === "user")?.content ?? "";
        const match = /^(echo|slow|status|nousage|stall|redirect|huge|tool):(.*)$/s.exec(last);
        const mode = match?.[1] ?? "echo";
        const rest = match ? match[2]! : `You said: ${last}`;
        if (mode === "status") return Response.json({ error: { message: `Simulated failure sk-secret-should-not-echo-123456789012345 (${rest})`, type: "server_error" } }, { status: Number(rest) || 500 });
        if (mode === "redirect") return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${port}/v1/chat/completions` } });
        let text = rest;
        let gap = 0;
        if (mode === "slow") {
          const [ms, ...parts] = rest.split(":");
          gap = Number(ms) || 50;
          text = parts.join(":");
        }
        if (mode === "huge") text = "x".repeat(Math.max(1, Number(rest) || 1) * 1024);
        const words = mode === "huge" ? text.match(/.{1,4096}/g) ?? [] : text.split(/(?<=\s)/);
        const promptTokens = Math.ceil((payload?.messages ?? []).reduce((sum, turn) => sum + turn.content.length, 0) / 4);
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              if (mode === "tool") {
                controller.enqueue(chunk({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":" } }] }, finish_reason: null }] }));
                controller.enqueue(chunk({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] }, finish_reason: "tool_calls" }] }));
                controller.enqueue(chunk({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 8 } }));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }
              if (mode === "stall") {
                controller.enqueue(chunk(delta("Starting…", model)));
                // Never closes on its own; the egress idle timeout ends it. Kept open for a minute.
                await new Promise((resolve) => setTimeout(resolve, 60_000));
                controller.close();
                return;
              }
              for (const word of words) {
                controller.enqueue(chunk(delta(word, model)));
                if (gap) await new Promise((resolve) => setTimeout(resolve, gap));
              }
              controller.enqueue(chunk({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
              if (mode !== "nousage") controller.enqueue(chunk({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(text.length / 4), prompt_tokens_details: { cached_tokens: 0 } } }));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch {
              // The client went away mid-stream.
            }
          }
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      }
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    }
  });
  return { baseUrl: `http://127.0.0.1:${port}/v1`, port, calls, models, stop: () => server.stop(true) };
}
