import type { Context, Handler, Hono } from "hono";
import type { AppEnv } from "../auth";
import { DynamicRoutes } from "../dynamicRoutes";
import { applyExternalStop } from "../notify/external";
import { publicShell } from "./middleware";

/**
 * Public routes of the workspace modules (§B.8, T500): a module registers them with
 * `registerPublicRoutes`, through a router that only accepts `/p/…` pages and `/api/public/…` JSON
 * routes. They are served by one dispatcher mounted before the session middleware (server/index.ts),
 * behind the strict public headers (server/public/middleware.ts), so nothing a module adds here can
 * read a session, and nothing it adds elsewhere can skip the session guards.
 */

export type PublicRouter = {
  /** A page: the app shell with 200 when `opens` says the item opens now, else the same shell with 404. */
  page: (path: `/p/${string}`, opens: (c: Context<AppEnv>) => boolean | Promise<boolean>) => void;
  get: (path: `/api/public/${string}`, handler: Handler<AppEnv>) => void;
  post: (path: `/api/public/${string}`, handler: Handler<AppEnv>) => void;
};

export const publicRoutes = new DynamicRoutes("public");
/** Every public path registered, with its owner, for tests (T500). */
export const publicRoutePaths: Array<{ owner: string; method: "GET" | "POST"; path: string }> = [];

const RESERVED = ["/api/public/chat-shares/", "/api/public/mail-stop/"];

function routerFor(owner: string): PublicRouter {
  const check = (path: string, prefix: "/p/" | "/api/public/") => {
    if (!path.startsWith(prefix) || path.includes("..") || RESERVED.some((reserved) => path.startsWith(reserved))) throw new Error(`Public route ${path} of ${owner} must be under ${prefix}`);
  };
  return {
    page: (path, opens) => {
      check(path, "/p/");
      publicRoutePaths.push({ owner, method: "GET", path });
      publicRoutes.add("GET", path, async (c) => publicShell(c, await opens(c)));
    },
    get: (path, handler) => {
      check(path, "/api/public/");
      publicRoutePaths.push({ owner, method: "GET", path });
      publicRoutes.add("GET", path, handler);
    },
    post: (path, handler) => {
      check(path, "/api/public/");
      publicRoutePaths.push({ owner, method: "POST", path });
      publicRoutes.add("POST", path, handler);
    }
  };
}

/** Registers a module's public routes (they may be added before or after the server starts). */
export function registerPublicRoutes(owner: string, mount: (router: PublicRouter) => void) {
  mount(routerFor(owner));
}

// "Stop emails about this" from outside mail (§B.7, T508): a sealed token; the answer is the same whether or not it matched.
publicRoutes.add("GET", "/api/public/mail-stop/:token", (c) => {
  applyExternalStop(c.req.param("token") ?? "");
  return c.html("<!doctype html><meta charset=utf-8><title>Emails stopped</title><p>You will not get more emails about this.</p>");
});
publicRoutePaths.push({ owner: "core", method: "GET", path: "/api/public/mail-stop/:token" });

/** Mounts the public dispatcher (server/index.ts, before the session guards and after the public headers). */
export function mountPublicRoutes(app: Hono<AppEnv>) {
  app.use("/p/*", publicRoutes.middleware());
  app.use("/api/public/*", publicRoutes.middleware());
}
