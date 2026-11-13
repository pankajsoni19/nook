import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson } from "../validation";
import { createLink, deleteLink, LinkError, linksOf, refFrom, resolveRef, resolveRefs } from "./service";
import { workKindAdapter } from "./adapters";
import { isWorkKind, LINK_RELATIONS, workRefKey } from "../../shared/workRefs";

/**
 * Work link routes (docs/plan/WORKSPACE_MODULES.md §D.0 HTTP):
 * `GET /api/links?kind=&id=`, `POST /api/links`, `DELETE /api/links/:linkId`, `GET /api/refs/resolve?ref=`,
 * and `POST /api/refs/summaries` (many refs at once, for chips). `GET /api/links/:kind/:ref` stays the
 * friendly-URL resolver (server/friendlyLinks.ts, D775).
 */

const refInput = z.union([
  z.object({ kind: z.string().max(32), id: z.string().max(64) }).strict(),
  z.object({ ref: z.string().min(1).max(2048) }).strict()
]);
const createSchema = z.object({ a: refInput, b: refInput, relation: z.enum(LINK_RELATIONS) }).strict();

function respond(c: Context<AppEnv>, error: unknown) {
  if (error instanceof LinkError) return c.json({ error: error.message, code: error.code }, error.status);
  throw error;
}

export function registerWorkLinkRoutes(app: Hono<AppEnv>) {
  app.get("/api/links", (c) => {
    const kind = c.req.query("kind");
    const id = c.req.query("id");
    if (!isWorkKind(kind) || !id || !workKindAdapter(kind)) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    const viewer = { userId: c.get("user").id };
    try {
      return c.json({ links: linksOf(refFrom({ kind, id }, viewer), viewer) });
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post("/api/links", async (c) => {
    const body = await parseJson(c.req.raw, createSchema);
    const userId = c.get("user").id;
    try {
      const a = refFrom(body.a, { userId });
      const b = refFrom(body.b, { userId });
      return c.json({ link: createLink({ a, b, relation: body.relation, actorId: userId }) }, 201);
    } catch (error) {
      return respond(c, error);
    }
  });
  app.delete("/api/links/:linkId", (c) => {
    try {
      deleteLink(c.req.param("linkId"), c.get("user").id);
      return c.body(null, 204);
    } catch (error) {
      return respond(c, error);
    }
  });
  app.get("/api/refs/resolve", (c) => {
    const ref = c.req.query("ref") ?? "";
    const resolved = ref.length <= 2048 ? resolveRef(ref, { userId: c.get("user").id }) : null;
    return resolved ? c.json({ summary: resolved.summary }) : c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
  });
  app.post("/api/refs/summaries", async (c) => {
    const body = await parseJson(c.req.raw, z.object({ refs: z.array(z.object({ kind: z.string().max(32), id: z.string().max(64) }).strict()).max(200) }).strict());
    const refs = body.refs.filter((ref) => isWorkKind(ref.kind)).map((ref) => ({ kind: ref.kind as never, id: ref.id.toLowerCase() }));
    const summaries = resolveRefs(refs, { userId: c.get("user").id });
    return c.json({ summaries: refs.map((ref) => summaries.get(workRefKey(ref)) ?? { kind: ref.kind, hidden: true }) });
  });
}
