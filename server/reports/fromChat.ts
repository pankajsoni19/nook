import { audit, db, now } from "../db";
import { REPORT_LIMITS, baseType } from "../../shared/reports";
import type { PatchBlock, PatchOp } from "../../shared/reportsEdit";
import { pathTo, readableChat } from "../agents/chats";
import { readSqlResult } from "../agents/dataSources";
import { AgentError } from "../agents/status";
import { ReportError } from "./errors";
import { manualEdit } from "./manualEdit";
import { createReport, reportDetail } from "./service";
import { adviseShape } from "./shapeAdvisor";
import type { ReportDetail } from "../../shared/reports";

/**
 * "Turn into a report" from a chat's query result (lane AGENTSQL, D598 as amended): a new report on the
 * result's data source holding the query, a table block of it, and a chart when the data plainly fits
 * one (a time column and a measure: a line; a text column and a measure, at most 30 rows: a bar). The
 * blocks go in through the owner's manual edit (patch.ts, then the full validation: the guard, a run,
 * the columns, the design rules), so the report renders at once with the same checks as any manual edit.
 * A chart the checks refuse is left out and the table alone is tried; when even that fails the empty
 * report is removed again and the reason answered. The caller must be able to read the chat and use the
 * data source through agents now (D595), and create reports on it (the data source enabled).
 */

const QUERY_KEY = "chat_query";
const TIME = /^(Date|Date32|DateTime|DateTime64)/;
const NUMBER = /^(U?Int|Float|Decimal)/;

/** The chart the data plainly fits, or null (the shape advisor's line or bar, with its columns). */
export function chartFor(columns: ReadonlyArray<{ name: string; type: string }>, rows: readonly (readonly unknown[])[], title: string): PatchBlock | null {
  if (rows.length < 2) return null;
  const fits = adviseShape(columns as never, rows as never).fits;
  const time = columns.find((column) => TIME.test(baseType(column.type)));
  const text = columns.find((column) => baseType(column.type) === "String");
  const measures = columns.filter((column) => NUMBER.test(baseType(column.type)) && column !== time).slice(0, REPORT_LIMITS.chartSeries).map((column) => column.name);
  if (!measures.length) return null;
  if (time && fits.includes("line")) return { id: "chart", type: "chart", title, intent: "trend", width: "full", queryKey: QUERY_KEY, kind: "line", x: time.name, y: measures.slice(0, 3), format: "number" };
  if (text && rows.length <= 30 && (fits.includes("bar") || fits.includes("horizontal_bar"))) return { id: "chart", type: "chart", title, intent: "compare", width: "full", queryKey: QUERY_KEY, kind: "bar", x: text.name, y: measures.slice(0, 1), format: "number" };
  return null;
}

export async function reportFromChatResult(actor: { userId: string }, input: { chatId: string; resultId: string; title: string; folderId?: string | null }, signal?: AbortSignal): Promise<{ report: ReportDetail; chart: boolean }> {
  let result;
  try {
    const chat = readableChat(input.chatId, actor.userId);
    const visible = chat.owner_id === actor.userId ? null : new Set(pathTo(input.chatId, chat.active_leaf_id).map((row) => row.id));
    result = readSqlResult(input.chatId, input.resultId, actor.userId, visible);
  } catch (error) {
    if (error instanceof AgentError) {
      if (error.status === 403) throw new ReportError(403, error.code, error.message);
      if (error.status === 410) throw new ReportError(409, error.code, error.message);
      throw new ReportError(404, "NOT_FOUND", "Not found");
    }
    throw error;
  }
  if (result.error) throw new ReportError(400, "INVALID", "That query failed, so it cannot become a report; ask the agent for a query that works");
  const title = input.title.trim().slice(0, REPORT_LIMITS.title) || "Query from a chat";
  const created = createReport(actor.userId, { title, datasourceId: result.datasource.id, folderId: input.folderId ?? null });
  const chart = chartFor(result.columns, result.rows, title);
  const tableTitle = chart ? "All rows" : title;
  const table: PatchBlock = { id: "result", type: "table", title: tableTitle, intent: "detail", width: "full", queryKey: QUERY_KEY };
  const opsWith = (blocks: PatchBlock[]): PatchOp[] => [
    { op: "add_query", query: { key: QUERY_KEY, sql: result.sql, purpose: "The query from the chat" } },
    ...blocks.map((block, index): PatchOp => ({ op: "add_block", block, after: index === 0 ? null : blocks[index - 1]!.id }))
  ];
  const attempt = (blocks: PatchBlock[]) => manualEdit(actor.userId, created.id, { patch: { ops: opsWith(blocks), summary: "From a chat's query" }, expectedRevision: created.revision }, { signal });
  let withChart = false;
  try {
    if (chart) {
      try {
        await attempt([chart, table]);
        withChart = true;
      } catch (error) {
        if (!(error instanceof ReportError) || error.code !== "INVALID") throw error;
        await attempt([{ ...table, title }]);
      }
    } else {
      await attempt([table]);
    }
  } catch (error) {
    // Nothing of the new report is kept when its query cannot be saved.
    db.transaction(() => {
      // As the Bin's purge does it (marked first, then deleted; its children cascade).
      db.query("UPDATE reports SET deleted_at = COALESCE(deleted_at, ?), purge_started_at = COALESCE(purge_started_at, ?) WHERE id = ?").run(now(), now(), created.id);
      db.query("DELETE FROM reports WHERE id = ?").run(created.id);
    })();
    audit(actor.userId, null, "reports.report.from_chat_failed", { reportId: created.id, chatId: input.chatId, datasourceId: result.datasource.id, code: error instanceof ReportError ? error.code : "INTERNAL" });
    throw error;
  }
  audit(actor.userId, null, "reports.report.from_chat", { reportId: created.id, chatId: input.chatId, resultId: input.resultId, datasourceId: result.datasource.id, chart: withChart });
  return { report: reportDetail(created.id, actor.userId), chart: withChart };
}
