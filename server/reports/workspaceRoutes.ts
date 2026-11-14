import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson } from "../validation";
import { REPORT_LIMITS } from "../../shared/reports";
import type { WorkspaceCatalog } from "../../shared/reportsWorkspace";
import { readableReport } from "./access";
import { ReportError } from "./errors";
import { reportTimeZone, reportToday } from "./paramZone";
import { resolveSet } from "./params";
import { handle, id } from "./routes";
import { limited } from "./runner";
import { parseSpec } from "./service";
import { isWorkspaceReport, runWorkspaceQuery, workspaceDatasets } from "./workspaceSource";

/**
 * The widget editor's routes for reports on This workspace (W3-REPORTS, D1067):
 *
 * - `GET /api/reports/workspace/datasets`: the datasets the caller's role can query (what `GET
 *   /api/datasets` lists), with the report zone's today so the editor can show what a preset covers.
 * - `POST /api/reports/:id/workspace/preview {query, values?}`: one structured query (the JSON a widget
 *   saves) run once with the caller's access and the report's parameters bound (the filters on screen),
 *   at most 1000 rows; nothing is stored. Readers of the report may preview (it is their own data).
 */

const PREVIEWS_PER_MINUTE = 60;
const recent = new Map<string, number[]>();
function rateLimit(userId: string, nowMs = Date.now()) {
  const kept = (recent.get(userId) ?? []).filter((at) => nowMs - at < 60_000);
  if (kept.length >= PREVIEWS_PER_MINUTE) throw new ReportError(429, "BUSY", "Too many previews in a minute; wait a moment and try again");
  kept.push(nowMs);
  recent.set(userId, kept);
}

const previewSchema = z.object({ query: z.string().min(2).max(REPORT_LIMITS.sqlChars), values: z.record(z.string(), z.unknown()).nullish() }).strict();

export function registerWorkspaceReportRoutes(app: Hono<AppEnv>) {
  app.get("/api/reports/workspace/datasets", handle((c): WorkspaceCatalog => ({ datasets: workspaceDatasets(c.get("user").id) })));
  app.post("/api/reports/:reportId/workspace/preview", handle(async (c) => {
    const reportId = id(c, "reportId");
    const userId = c.get("user").id;
    const report = readableReport(reportId, userId);
    if (!isWorkspaceReport(report)) throw new ReportError(409, "INVALID", "This report is not on This workspace");
    const input = await parseJson(c.req.raw, previewSchema);
    const spec = parseSpec(report.spec_json);
    const set = resolveSet(spec, input.values ?? null, reportToday(reportId));
    rateLimit(userId);
    const outcome = await limited(userId, async () => runWorkspaceQuery(input.query, { userId, maxRows: REPORT_LIMITS.consoleRows, params: set.bound, timeZone: reportTimeZone(reportId) }));
    return { outcome, today: reportToday(reportId) };
  }));
}
