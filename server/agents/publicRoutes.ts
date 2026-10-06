import type { Context, Hono, Next } from "hono";
import type { AppEnv } from "../auth";
import { clientAddress } from "../clientAddress";
import { PUBLIC_API_CSP, PUBLIC_PAGE_CSP, PUBLIC_TOKEN, publicShareLimited, readPublicShare } from "./publicShares";

/**
 * The two doors of a public chat link (Wave 43, AC-D, D362, T316), both without a session:
 *
 * - `GET /share/c/:token`, the page: the SPA shell (src/chat/PublicChat.tsx renders it without the
 *   app's session), answered 404 when the link does not open a snapshot now, so a revoked link, an
 *   unknown one, or any link while the policy is off is a 404 at the page too.
 * - `GET /api/public/chat-shares/:token`, the snapshot as JSON.
 *
 * Both: 60 requests a minute per address (429 with Retry-After), `Cache-Control: no-store`,
 * `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, and a strict CSP (the page: only Nook's
 * own scripts, styles, and images; the API: nothing at all). The token is checked against its hash
 * only and never logged.
 */

const strict = (headers: Headers, csp: string) => {
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Content-Security-Policy", csp);
  headers.set("Referrer-Policy", "no-referrer");
};

const isPage = (path: string) => path.startsWith("/share/c/");

/**
 * Registered before the global security headers (secureHeaders writes after `next`, so the header
 * set written here, after it, is the one that stays). The page also gets its rate limit and its 404.
 */
export async function publicShareHeaders(c: Context<AppEnv>, next: Next) {
  const page = isPage(c.req.path);
  if (page && (c.req.method === "GET" || c.req.method === "HEAD")) {
    const wait = publicShareLimited("page", clientAddress(c));
    if (wait > 0) {
      const response = new Response("Too many requests", { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(wait) } });
      strict(response.headers, PUBLIC_API_CSP);
      return response;
    }
    const token = c.req.path.slice("/share/c/".length);
    const opens = PUBLIC_TOKEN.test(token) && readPublicShare(token) !== null;
    await next();
    // The shell still loads and says "This link is not available", with the status crawlers respect.
    if (!opens && c.res.status === 200) c.res = new Response(c.res.body, { status: 404, headers: c.res.headers });
  } else {
    await next();
  }
  strict(c.res.headers, page ? PUBLIC_PAGE_CSP : PUBLIC_API_CSP);
}

export function registerPublicChatShareApi(app: Hono<AppEnv>) {
  app.get("/api/public/chat-shares/:token", (c) => {
    const wait = publicShareLimited("api", clientAddress(c));
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "Too many requests. Try again in a minute.", code: "RATE_LIMITED" }, 429);
    }
    const token = c.req.param("token");
    const snapshot = PUBLIC_TOKEN.test(token) ? readPublicShare(token) : null;
    if (!snapshot) return c.json({ error: "This link is not available", code: "NOT_FOUND" }, 404);
    return c.json({ snapshot });
  });
}
