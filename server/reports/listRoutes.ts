import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson, uuid } from "../validation";
import { REPORT_LIST_NAME_MAX, REPORT_LIST_SHARES_MAX } from "../../shared/reports";
import { addToList, binList, createList, getListSharing, listChoices, listReportLists, moveInList, removeFromList, renameList, reportListSummary, setListSharing } from "./lists";
import { handle, id } from "./routes";
import "./listBin";

/**
 * docs/plan/API_CONTRACTS.md § Analytics reports, report lists (phase 3, migration 068, D550–D559). A list
 * never grants access: every count and page goes through readableReportSql. Any member creates a list;
 * its owner renames, shares, and deletes it (to their Bin); its curators (the owner and people at `edit`)
 * add, remove, and reorder. Same rules as routes.ts: a session, CSRF and a writing role for mutations
 * (viewers read shared lists only), 404 for guests. Registered before `/api/reports/:reportId`.
 *
 * - GET    /api/reports/lists                               the lists the caller can see, with per-viewer counts
 * - POST   /api/reports/lists                               { name }
 * - GET    /api/reports/lists/:listId                       one list (its reports: GET /api/reports?list=:listId)
 * - PATCH  /api/reports/lists/:listId                       { name } (the owner)
 * - DELETE /api/reports/lists/:listId                       to the owner's Bin
 * - GET    /api/reports/lists/:listId/sharing               (the owner)
 * - PUT    /api/reports/lists/:listId/sharing               { visibility, shares: [{ kind, id, level: view|edit }] }
 * - PUT    /api/reports/lists/:listId/items/:reportId       add a report the caller can open (curators)
 * - PATCH  /api/reports/lists/:listId/items/:reportId       { beforeId } or { afterId } or {} (the end): reorder (curators)
 * - DELETE /api/reports/lists/:listId/items/:reportId       remove (curators)
 * - GET    /api/reports/:reportId/lists                     the add-to-list picker: the lists the caller curates, and which hold it
 */

const listName = z.string().trim().min(1).max(REPORT_LIST_NAME_MAX).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must be one line of text");
const listCreate = z.object({ name: listName }).strict();
const listPatch = z.object({ name: listName }).strict();
const listMove = z.object({ beforeId: uuid.nullish(), afterId: uuid.nullish() }).strict().refine((place) => !(place.beforeId && place.afterId), "give beforeId or afterId, not both");
const listSharing = z.object({
  visibility: z.enum(["private", "selected", "all_users"]),
  shares: z.array(z.object({ kind: z.enum(["user", "group"]), id: uuid, level: z.enum(["view", "edit"]) }).strict()).max(REPORT_LIST_SHARES_MAX)
}).strict();
const emptySchema = z.object({}).strict();

export function registerReportListRoutes(app: Hono<AppEnv>) {
  app.get("/api/reports/lists", handle((c) => ({ lists: listReportLists(c.get("user").id) })));
  app.post("/api/reports/lists", handle(async (c) => {
    const { name } = await parseJson(c.req.raw, listCreate);
    return c.json({ list: createList(c.get("user").id, name) }, 201);
  }));
  app.get("/api/reports/lists/:listId", handle((c) => ({ list: reportListSummary(c.get("user").id, id(c, "listId")) })));
  app.patch("/api/reports/lists/:listId", handle(async (c) => {
    const listId = id(c, "listId");
    const { name } = await parseJson(c.req.raw, listPatch);
    return { list: renameList(c.get("user").id, listId, name) };
  }));
  app.delete("/api/reports/lists/:listId", handle((c) => binList(c.get("user").id, id(c, "listId"))));
  app.get("/api/reports/lists/:listId/sharing", handle((c) => ({ sharing: getListSharing(c.get("user").id, id(c, "listId")) })));
  app.put("/api/reports/lists/:listId/sharing", handle(async (c) => {
    const listId = id(c, "listId");
    const input = await parseJson(c.req.raw, listSharing);
    return { sharing: setListSharing(c.get("user").id, listId, { visibility: input.visibility, shares: input.shares.map((share) => ({ ...share, id: share.id.toLowerCase() })) }) };
  }));
  app.put("/api/reports/lists/:listId/items/:reportId", handle(async (c) => {
    const listId = id(c, "listId");
    const reportId = id(c, "reportId");
    await parseJson(c.req.raw, emptySchema);
    return addToList(c.get("user").id, listId, reportId);
  }));
  app.patch("/api/reports/lists/:listId/items/:reportId", handle(async (c) => {
    const listId = id(c, "listId");
    const reportId = id(c, "reportId");
    const place = await parseJson(c.req.raw, listMove);
    return moveInList(c.get("user").id, listId, reportId, { beforeId: place.beforeId?.toLowerCase() ?? null, afterId: place.afterId?.toLowerCase() ?? null });
  }));
  app.delete("/api/reports/lists/:listId/items/:reportId", handle((c) => removeFromList(c.get("user").id, id(c, "listId"), id(c, "reportId"))));
  app.get("/api/reports/:reportId/lists", handle((c) => ({ lists: listChoices(c.get("user").id, id(c, "reportId")) })));
}
