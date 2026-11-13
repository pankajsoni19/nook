import type { Context, Handler, Hono } from "hono";
import type { AppEnv } from "../auth";
import { applyExternalStop } from "../notify/external";
import { publicShell } from "./middleware";

/**
 * Public routes of the workspace modules (§B.8, T500): a module registers them with
 * `registerPublicRoutes`, through a router that only accepts `/p/…` pages and `/api/public/…` JSON
 * routes, so nothing a module adds can land outside the public prefixes or skip the session guards
 * of the rest of `/api` (tests/workspaceRegistry.test.ts enumerates them). They are mounted before
 * the session middleware (server/index.ts), with the strict headers of server/public/middleware.ts.
 */

export type PublicRouter = {
  /** A page: the app shell with 200 when `opens` says the item opens now, else the same shell with 404. */
  page: (path: `/p/${string}`, opens: (c: Context<AppEnv>) => boolean | Promise<boolean>) => void;
  get: (path: `/api/public/${string}`, handler: Handler<AppEnv>) => void;
  post: (path: `/api/public/${string}`, handler: Handler<AppEnv>) => void;
};

type Registration = { owner: string; mount: (router: PublicRouter) => void };
const registrations: Registration[] = [];
/** Every public path registered, for tests (T500). */
export const publicRoutePaths: Array<{ owner: string; method: "GET" | "POST"; path: string }> = [];

export function registerPublicRoutes(owner: string, mount: (router: PublicRouter) => void) {
  registrations.push({ owner, mount });
  if (mountedApp) mountOne(mountedApp, { owner, mount });
}

const RESERVED = ["/api/public/chat-shares/", "/api/public/mail-stop/"];

function routerFor(app: Hono<AppEnv>, owner: string): PublicRouter {
  const check = (path: string, prefix: "/p/" | "/api/public/") => {
    if (!path.startsWith(prefix) || path.includes("..") || RESERVED.some((reserved) => path.startsWith(reserved))) throw new Error(`Public route ${path} of ${owner} must be under ${prefix}`);
  };
  return {
    page: (path, opens) => {
      check(path, "/p/");
      publicRoutePaths.push({ owner, method: "GET", path });
      app.get(path, async (c) => publicShell(c, await opens(c)));
    },
    get: (path, handler) => {
      check(path, "/api/public/");
      publicRoutePaths.push({ owner, method: "GET", path });
      app.get(path, handler);
    },
    post: (path, handler) => {
      check(path, "/api/public/");
      publicRoutePaths.push({ owner, method: "POST", path });
      app.post(path, handler);
    }
  };
}

let mountedApp: Hono<AppEnv> | null = null;

function mountOne(app: Hono<AppEnv>, registration: Registration) {
  registration.mount(routerFor(app, registration.owner));
}

/** Mounts every registered module's public routes, and the foundation's own (server/index.ts, before the session guards). */
export function mountPublicRoutes(app: Hono<AppEnv>) {
  if (mountedApp) return;
  mountedApp = app;
  // "Stop emails about this" from outside mail (§B.7, T508): a sealed token; the answer is the same whether or not it matched.
  app.get("/api/public/mail-stop/:token", (c) => {
    applyExternalStop(c.req.param("token"));
    return c.html("<!doctype html><meta charset=utf-8><title>Emails stopped</title><p>You will not get more emails about this.</p>");
  });
  publicRoutePaths.push({ owner: "core", method: "GET", path: "/api/public/mail-stop/:token" });
  for (const registration of registrations) mountOne(app, registration);
}
