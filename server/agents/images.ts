import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { AppEnv } from "../auth";
import { db, now } from "../db";
import { sniff, SNIFF_BYTES } from "../mimeSniff";
import { TOOL_IMAGE_BOUNDS, type ToolImageRef } from "../../shared/agents";
import { checkEgressUrl, EgressError, egressFetch } from "./egress";
import type { McpImage } from "./mcpClient";
import { AgentError } from "./status";

/**
 * Images in chats (D370 as amended, T304): the image proxy for outside pictures a person chose to
 * load, and the store for pictures MCP tools return. Both answer only image bytes that sniff as PNG,
 * JPEG, GIF, or WebP (never SVG, whatever the upstream or the tool claimed), with the content
 * route's strict header set (server/documents.ts `applyContentSecurityHeaders`: a sandboxing CSP,
 * `nosniff`, no referrer, same-origin CORP, `private, no-store`) plus `Content-Disposition: inline`.
 *
 * The proxy (`GET /api/agents/image-proxy?url=`) exists so the app's CSP can stay `img-src 'self'
 * data:` and the reader's address never reaches the image's host:
 * - It needs a session (all of /api does; API keys never authenticate there) and the agent module,
 *   and guests get 404 (agentGate). It answers only a request carrying `X-Nook-Image-Proxy: 1`, which
 *   an `<img>`, a link, a form, or another site's page cannot send (another origin would need a CORS
 *   preflight Nook never grants), and refuses a `Sec-Fetch-Site` other than same-origin. So nothing
 *   in a note, a file, or a reply can make a browser call it without the person's click.
 * - The fetch is `egressFetch`: https (http only for AGENT_ALLOWED_PRIVATE_HOSTS), no credentials in
 *   the URL, DNS checked and pinned, private and local addresses and Nook's own origin refused,
 *   redirects refused (not followed), no cookie or key sent, and its byte cap and timeouts. Nothing
 *   logs the URL.
 * - Per person: `IMAGE_PROXY_LIMITS.perMinute` images a minute (sliding, in `agent_rate_limits`) and
 *   `concurrent` at a time; the body is buffered under `maxBytes` and checked by its first bytes.
 */

export const IMAGE_PROXY_LIMITS = { maxBytes: 5 * 1024 * 1024, perMinute: 60, concurrent: 4, urlChars: 2048, firstByteMs: 10_000, idleMs: 10_000, totalMs: 30_000 } as const;
export const IMAGE_PROXY_HEADER = "x-nook-image-proxy";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The image type of these bytes, or null: the sniff decides, never a declared type. */
export function imageTypeOf(head: Uint8Array): ToolImageRef["mimeType"] | null {
  const type = sniff(head.subarray(0, SNIFF_BYTES), "", head.byteLength).mimeType;
  return IMAGE_TYPES.has(type) ? type as ToolImageRef["mimeType"] : null;
}

/** An image response: the bytes, their sniffed type, inline, and the strict headers the index applies on these paths. */
function imageResponse(bytes: Uint8Array, mimeType: string) {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store"
    }
  });
}

/** Whether a path is one of these image routes, which take the content route's strict header set instead of the app's. */
export const isChatImageRequest = (method: string, path: string) => (method === "GET" || method === "HEAD")
  && (path === "/api/agents/image-proxy" || /^\/api\/chats\/[^/]+\/tool-images\/[^/]+$/.test(path));

// --- The proxy's per-person limits ---

const inFlight = new Map<string, number>();
type Row = { window_start: number; count: number; previous_count: number };

/** Checks and charges one image for the person (a sliding minute). Returns 0 when admitted, else the seconds to wait. */
export function chargeImageLoad(userId: string, nowMs = Date.now()): number {
  return db.transaction(() => {
    const windowMs = 60_000;
    const bucket = `image_minute:${userId}`;
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const row = db.query("SELECT window_start, count, previous_count FROM agent_rate_limits WHERE bucket = ?").get(bucket) as Row | null;
    const count = row && row.window_start === windowStart ? row.count : 0;
    const previous = row && row.window_start === windowStart ? row.previous_count : row && row.window_start === windowStart - windowMs ? row.count : 0;
    const estimate = previous * (1 - (nowMs - windowStart) / windowMs) + count;
    if (estimate + 1 > IMAGE_PROXY_LIMITS.perMinute) return Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000));
    db.query(`INSERT INTO agent_rate_limits (bucket, window_start, count, previous_count) VALUES (?, ?, ?, ?)
      ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = excluded.count, previous_count = excluded.previous_count`)
      .run(bucket, windowStart, count + 1, previous);
    return 0;
  })();
}

/** Test hook: the proxy requests in flight per person. */
export const imageLoadsInFlight = (userId: string) => inFlight.get(userId) ?? 0;

const EGRESS_STATUS: Record<string, { status: number; code: string; message: string }> = {
  URL_REFUSED: { status: 400, code: "URL_REFUSED", message: "Nook does not load images from that address" },
  PRIVATE_ADDRESS: { status: 403, code: "PRIVATE_ADDRESS", message: "The image is on a private or local address" },
  REDIRECT_REFUSED: { status: 502, code: "REDIRECT_REFUSED", message: "The image's host answered with a redirect, which is not followed" },
  DNS_FAILED: { status: 502, code: "DNS_FAILED", message: "The image's host could not be found" },
  TOO_LARGE: { status: 413, code: "IMAGE_TOO_LARGE", message: "The image is larger than allowed" },
  TIMEOUT: { status: 504, code: "TIMEOUT", message: "The image's host did not answer in time" },
  NETWORK: { status: 502, code: "NETWORK", message: "The image's host could not be reached" }
};

const asAgentError = (error: EgressError) => {
  const mapped = EGRESS_STATUS[error.code] ?? EGRESS_STATUS.NETWORK!;
  return new AgentError(mapped.status, mapped.code, mapped.message, error.code === "TOO_LARGE" ? { limitBytes: IMAGE_PROXY_LIMITS.maxBytes } : {});
};

/** `GET /api/agents/image-proxy?url=…` (see the module comment). */
export async function proxyImage(c: Context<AppEnv>): Promise<Response> {
  const userId = c.get("user").id;
  if (c.req.header(IMAGE_PROXY_HEADER) !== "1") throw new AgentError(400, "INVALID", "Images load through the chat only");
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin") throw new AgentError(403, "FORBIDDEN", "Images load through the chat only");
  const raw = c.req.query("url") ?? "";
  if (!raw || raw.length > IMAGE_PROXY_LIMITS.urlChars) throw new AgentError(400, "INVALID", "The image address is missing or too long");
  let url: URL;
  try {
    url = checkEgressUrl(raw);
  } catch (error) {
    throw error instanceof EgressError ? asAgentError(error) : error;
  }
  if (/\.svgz?$/i.test(url.pathname)) throw new AgentError(415, "NOT_AN_IMAGE", "SVG images are never loaded");
  if ((inFlight.get(userId) ?? 0) >= IMAGE_PROXY_LIMITS.concurrent) throw new AgentError(429, "RATE_LIMITED", "Too many images are loading; wait a moment", { retryAfterSeconds: 2 });
  const wait = chargeImageLoad(userId);
  if (wait > 0) throw new AgentError(429, "RATE_LIMITED", "Too many images loaded; wait a minute", { retryAfterSeconds: wait });
  inFlight.set(userId, (inFlight.get(userId) ?? 0) + 1);
  try {
    const response = await egressFetch(url.toString(), { method: "GET", headers: { Accept: "image/png,image/jpeg,image/gif,image/webp" } }, IMAGE_PROXY_LIMITS);
    if (response.status !== 200) {
      response.cancel();
      throw new AgentError(502, "IMAGE_UNAVAILABLE", "The image's host did not return it");
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > IMAGE_PROXY_LIMITS.maxBytes) {
      response.cancel();
      throw new AgentError(413, "IMAGE_TOO_LARGE", "The image is larger than allowed", { limitBytes: IMAGE_PROXY_LIMITS.maxBytes });
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    let checked = false;
    for await (const chunk of response.body) {
      chunks.push(chunk);
      size += chunk.byteLength;
      // Decided on the first bytes: an HTML page or an SVG is dropped before the rest is downloaded.
      if (!checked && size >= 16) {
        checked = true;
        if (!imageTypeOf(Buffer.concat(chunks))) {
          response.cancel();
          throw new AgentError(415, "NOT_AN_IMAGE", "That address is not a PNG, JPEG, GIF, or WebP image");
        }
      }
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    const mimeType = imageTypeOf(bytes);
    if (!mimeType) throw new AgentError(415, "NOT_AN_IMAGE", "That address is not a PNG, JPEG, GIF, or WebP image");
    return imageResponse(bytes, mimeType);
  } catch (error) {
    if (error instanceof EgressError) throw asAgentError(error);
    throw error;
  } finally {
    const left = (inFlight.get(userId) ?? 1) - 1;
    if (left <= 0) inFlight.delete(userId);
    else inFlight.set(userId, left);
  }
}

// --- Tool images ---

/** Stores a call's images with the chat, within what is left of the run's `TOOL_IMAGE_BOUNDS.perRun`. */
export function storeToolImages(chatId: string, messageId: string, images: readonly McpImage[], alreadyInRun: number): ToolImageRef[] {
  const room = Math.max(0, TOOL_IMAGE_BOUNDS.perRun - alreadyInRun);
  const kept = images.slice(0, Math.min(room, TOOL_IMAGE_BOUNDS.perCall)).filter((image) => image.bytes.byteLength > 0 && image.bytes.byteLength <= TOOL_IMAGE_BOUNDS.bytes && imageTypeOf(image.bytes) === image.mimeType);
  if (kept.length === 0) return [];
  const refs: ToolImageRef[] = [];
  const insert = db.query("INSERT INTO chat_tool_images (chat_id, id, message_id, mime_type, size_bytes, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const image of kept) {
      const id = randomUUID();
      insert.run(chatId, id, messageId, image.mimeType, image.bytes.byteLength, image.bytes, now());
      refs.push({ id, mimeType: image.mimeType, bytes: image.bytes.byteLength });
    }
  })();
  return refs;
}

/** A continued copy keeps the tool images of the messages it copied: the same ids, under the new chat. */
export function copyToolImages(fromChatId: string, toChatId: string, messageIds: readonly string[]) {
  const copy = db.query(`INSERT OR IGNORE INTO chat_tool_images (chat_id, id, message_id, mime_type, size_bytes, bytes, created_at)
    SELECT ?, id, message_id, mime_type, size_bytes, bytes, created_at FROM chat_tool_images WHERE chat_id = ? AND message_id = ?`);
  for (const messageId of messageIds) copy.run(toChatId, fromChatId, messageId);
}

/** `GET /api/chats/:chatId/tool-images/:imageId`: the caller has already been checked to read the chat. */
export function toolImageResponse(chatId: string, imageId: string): Response {
  const row = db.query("SELECT mime_type, bytes FROM chat_tool_images WHERE chat_id = ? AND id = ?").get(chatId, imageId) as { mime_type: string; bytes: Uint8Array } | null;
  if (!row) throw new AgentError(404, "NOT_FOUND", "Not found");
  const bytes = new Uint8Array(row.bytes);
  const mimeType = imageTypeOf(bytes);
  if (!mimeType || mimeType !== row.mime_type) throw new AgentError(404, "NOT_FOUND", "Not found");
  return imageResponse(bytes, mimeType);
}
