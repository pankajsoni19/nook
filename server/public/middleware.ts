import type { Context, Hono, Next } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../auth";
import { clientIp } from "../clientAddress";
import { config } from "../config";
import { distRoot, serveStaticFile } from "../staticFiles";
import { publicLimit } from "./limits";
import { PUBLIC_BODY_MAX_BYTES, PUBLIC_NOT_FOUND } from "../../shared/publicPages";

/**
 * The public surface of the workspace modules (docs/plan/WORKSPACE_MODULES.md §B.8, D810, T500,
 * T506, T507): pages under `/p/…`, JSON under `/api/public/…`, generalized from the chat share links
 * (server/agents/publicRoutes.ts).
 *
 * - Strict headers on every response: a CSP that allows only Nook's own files (pages) or nothing
 *   (JSON), `form-action 'self'`, `frame-ancestors 'none'`, `no-store`, `noindex`, `no-referrer`.
 * - No session: these routes are registered before the session middleware and never read or set the
 *   session cookie (any Set-Cookie is stripped). CSRF protection for submissions is the signed,
 *   single-use render nonce (server/public/limits.ts), not the session's token.
 * - One uniform 404 (PUBLIC_NOT_FOUND) for unknown, revoked, expired, policy-off, binned, closed.
 * - Pages: 120 requests a minute per address; submissions: their own limits (checkSubmission).
 * - Bodies over 64 KiB are refused before they are parsed (readPublicJson).
 */

export const PUBLIC_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
export const PUBLIC_API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const isPage = (path: string) => path.startsWith("/p/");

function strict(headers: Headers, page: boolean) {
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Content-Security-Policy", page ? PUBLIC_PAGE_CSP : PUBLIC_API_CSP);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.delete("Set-Cookie");
}

/** Registered for `/p/*` and `/api/public/*` (except the chat shares, which keep their own) before the global headers. */
export async function publicPageHeaders(c: Context<AppEnv>, next: Next) {
  if (c.req.path.startsWith("/api/public/chat-shares/")) return next();
  const page = isPage(c.req.path);
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    const wait = publicLimit("page", clientIp(c));
    if (wait > 0) {
      const response = page
        ? new Response("Too many requests", { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(wait) } })
        : Response.json({ error: "Too many requests. Try again in a minute.", code: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": String(wait) } });
      strict(response.headers, page);
      return response;
    }
  } else if (c.req.method === "POST" || c.req.method === "PUT") {
    const length = Number(c.req.header("Content-Length") ?? "0");
    if (Number.isFinite(length) && length > PUBLIC_BODY_MAX_BYTES) {
      const response = Response.json({ error: "The request is too large", code: "TOO_LARGE" }, { status: 413 });
      strict(response.headers, false);
      return response;
    }
  }
  await next();
  // Responses may be immutable (static files); copy them so the headers can be set.
  try {
    strict(c.res.headers, page);
  } catch {
    c.res = new Response(c.res.body, c.res);
    strict(c.res.headers, page);
  }
}

/** Reads a public JSON body (at most 64 KiB, `application/json`), validated; null when it is not. */
export async function readPublicJson<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.infer<S> | null> {
  if (!(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return null;
  const reader = c.req.raw.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PUBLIC_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const publicNotFound = (c: Context<AppEnv>) => c.json(PUBLIC_NOT_FOUND, 404);

/** The app shell for a public page (the client routes `/p/*` to src/public/PublicApp.tsx), with 200 or the uniform 404. */
export async function publicShell(c: Context<AppEnv>, opens: boolean) {
  let response: Response | null = null;
  if (config.isProduction) response = await serveStaticFile(new Request(new URL("/", c.req.url), { method: "GET", headers: c.req.raw.headers }), "/", distRoot(), config.appName);
  response ??= new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${config.appName.replace(/[<>&"]/g, "")}</title></head><body><div id="root"></div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
  return new Response(response.body, { status: opens ? 200 : 404, headers: response.headers });
}

/** Mounts the headers middleware on the public paths (server/index.ts, before the global headers). */
export function mountPublicMiddleware(app: Hono<AppEnv>) {
  app.use("/p/*", publicPageHeaders);
  app.use("/api/public/*", publicPageHeaders);
}
