import { Hono, type Context, type Handler, type MiddlewareHandler } from "hono";
import type { AppEnv } from "./auth";

/**
 * Routes that modules register after the main app is built (docs/plan/WORKSPACE_MODULES.md §B.1,
 * T500). Hono builds its matcher on the first request and refuses routes added later, and the main
 * app's middleware order is what puts a route behind (or before) the session guards. So each group of
 * registered routes lives in its own small Hono app, rebuilt when a route is added, and the main app
 * mounts one middleware at the right place that hands matching requests to it:
 *
 * - module routes: after every session, CSRF, two-factor, and role-write guard (`mountWorkspaceModules`);
 * - public routes: before them, behind the public headers (`/p/*`, `/api/public/*`).
 *
 * The request's context variables (the signed-in user, session, CSRF token) and the Bun server
 * (`c.env`, for client addresses) are carried into the sub-app, so handlers read them as usual.
 * A request no registered route matches continues down the main app untouched.
 */

const UNMATCHED = "x-nook-unmatched";
type Carried = Partial<AppEnv["Variables"]>;
const carried = new WeakMap<Request, Carried>();

export class DynamicRoutes {
  private readonly routes: Array<{ method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; handlers: Handler<AppEnv>[] }> = [];
  private built: Hono<AppEnv> | null = null;

  constructor(readonly name: string) {}

  add(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, ...handlers: Handler<AppEnv>[]) {
    if (!handlers.length) throw new Error(`Route ${method} ${path} needs a handler`);
    this.routes.push({ method, path, handlers });
    this.built = null;
  }

  /** Every registered route, for tests (T500). */
  list() {
    return this.routes.map(({ method, path }) => ({ method, path }));
  }

  private build() {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      const vars = carried.get(c.req.raw);
      if (vars?.user) c.set("user", vars.user);
      if (vars?.sessionId) c.set("sessionId", vars.sessionId);
      if (vars?.csrfToken) c.set("csrfToken", vars.csrfToken);
      await next();
    });
    for (const route of this.routes) app.on(route.method, route.path, ...(route.handlers as [Handler<AppEnv>]));
    app.notFound(() => new Response(null, { status: 404, headers: { [UNMATCHED]: "1" } }));
    // Errors go back to the main app's error handler (validation, JSON, and the rest).
    app.onError((error) => { throw error; });
    return app;
  }

  /** The middleware the main app mounts: a matching request is answered here; anything else goes on. */
  middleware(): MiddlewareHandler<AppEnv> {
    return async (c: Context<AppEnv>, next) => {
      if (!this.routes.length) return next();
      this.built ??= this.build();
      carried.set(c.req.raw, { user: safeGet(c, "user"), sessionId: safeGet(c, "sessionId"), csrfToken: safeGet(c, "csrfToken") });
      const response = await this.built.fetch(c.req.raw, c.env);
      if (response.headers.get(UNMATCHED)) return next();
      c.res = response;
      return response;
    };
  }
}

function safeGet<K extends keyof AppEnv["Variables"]>(c: Context<AppEnv>, key: K): AppEnv["Variables"][K] | undefined {
  try {
    return c.get(key);
  } catch {
    return undefined;
  }
}
