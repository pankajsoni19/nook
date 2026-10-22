import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson } from "../validation";
import { BLOCK_ID, QUERY_KEY, REPORT_LIMITS } from "../../shared/reports";
import { QUERY_EDIT_LIMITS } from "../../shared/reportsQueryEdit";
import { ReportError } from "./errors";
import { previewQueryEdit, suggestQueryEdit } from "./querySuggest";
import { handle, id } from "./routes";

/**
 * Lane EDIT (D525–D531; docs/plan/API_CONTRACTS.md § Analytics reports, "Edit a query"): Run preview
 * and Suggest from Inspect → Query. The owner's Save stays `POST …/spec/edit` (`update_query`).
 * A session, CSRF, and a writing role (admin or member) for both; the comment level or an owner.
 */

const sql = z.string().min(1).max(REPORT_LIMITS.sqlChars);
const previewSchema = z.object({ sql, values: z.record(z.string().max(40), z.unknown()).nullish() }).strict();
const suggestSchema = z.object({
  sql,
  note: z.string().max(QUERY_EDIT_LIMITS.note).nullish(),
  blockId: z.string().regex(BLOCK_ID).nullish(),
  expectedRevision: z.number().int().min(1).optional()
}).strict();

function queryKey(c: Context<AppEnv>) {
  const key = c.req.param("queryKey") ?? "";
  if (!QUERY_KEY.test(key)) throw new ReportError(404, "NOT_FOUND", "That query is not in the report");
  return key;
}

export function registerQueryEditRoutes(app: Hono<AppEnv>) {
  app.post("/api/reports/:reportId/queries/:queryKey/preview", handle(async (c) => {
    const user = c.get("user");
    const reportId = id(c, "reportId");
    const key = queryKey(c);
    const body = await parseJson(c.req.raw, previewSchema);
    return { preview: await previewQueryEdit({ userId: user.id, role: user.role }, reportId, { queryKey: key, sql: body.sql, values: body.values ?? null }, c.req.raw.signal) };
  }));
  app.post("/api/reports/:reportId/queries/:queryKey/suggest", handle(async (c) => {
    const user = c.get("user");
    const reportId = id(c, "reportId");
    const key = queryKey(c);
    const body = await parseJson(c.req.raw, suggestSchema);
    const result = await suggestQueryEdit({ userId: user.id, role: user.role }, reportId, {
      queryKey: key, sql: body.sql, note: body.note ?? null, blockId: body.blockId ?? null, ...(body.expectedRevision !== undefined ? { expectedRevision: body.expectedRevision } : {})
    }, c.req.raw.signal);
    return c.json(result, 201);
  }));
}
