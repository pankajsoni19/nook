import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson } from "../validation";
import { DatasetError, listDatasets, runDatasetQuery } from "./registry";
import { DATASET_MEASURES, DATASET_ROW_LIMIT, FILTER_OPS, TIME_BUCKETS } from "../../shared/datasets";
import "./tasks";

export { registerDataset, runDatasetQuery, listDatasets, datasetDef, DatasetError, type DatasetDef } from "./registry";

/** The structured query, validated (§B.10): words only from fixed lists; values are bound, never spliced. */
export const structuredQuerySchema = z.object({
  dataset: z.string().max(64),
  measures: z.array(z.object({ fn: z.enum(DATASET_MEASURES), column: z.string().max(40).optional(), as: z.string().max(40).optional() }).strict()).min(1).max(10),
  dimensions: z.array(z.string().max(40)).max(5).optional(),
  filters: z.array(z.object({ column: z.string().max(40), op: z.enum(FILTER_OPS), value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.union([z.string().max(500), z.number()])).max(100)]).optional() }).strict()).max(20).optional(),
  timeRange: z.object({ from: z.string().max(40).optional(), to: z.string().max(40).optional() }).strict().optional(),
  timeBucket: z.enum(TIME_BUCKETS).optional(),
  sort: z.array(z.object({ column: z.string().max(40), dir: z.enum(["asc", "desc"]) }).strict()).max(5).optional(),
  limit: z.number().int().min(1).max(DATASET_ROW_LIMIT).optional(),
  tz: z.string().max(64).optional()
}).strict();

export function registerDatasetRoutes(app: Hono<AppEnv>) {
  app.get("/api/datasets", (c) => c.json({ datasets: listDatasets(c.get("user").role) }));
  app.post("/api/datasets/query", async (c) => {
    const query = await parseJson(c.req.raw, structuredQuerySchema);
    try {
      return c.json(runDatasetQuery(query, { userId: c.get("user").id, role: c.get("user").role }));
    } catch (error) {
      if (error instanceof DatasetError) return c.json({ error: error.message, code: "INVALID" }, 400);
      throw error;
    }
  });
}
