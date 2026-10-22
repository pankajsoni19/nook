import { audit, db, now } from "../db";
import { canonicalValues, defaultValues, resolveValues, type ParamValues, type ReportParameter } from "../../shared/reportParams";
import { VIEW_LIMITS, type ParamViewsView, type ParamView } from "../../shared/reportsView";
import { isReportOwner, readableReport, type ReportRow } from "./access";
import { ReportError } from "./errors";
import { parseSpec } from "./service";

/**
 * Saved views (lane FILT2, D565, D566; docs/plan/REPORT_FILTERS.md "Later" 3): a reader's named sets of
 * parameter values for one report, and at most one "my default view" that opens when the report's
 * URL names no values. Personal: anyone who can read the report keeps their own (`report_param_views`,
 * migration 069), nobody else sees them, and they never change the report. A view's values are checked
 * against the report's parameters when saved; when the spec changes later, values that no longer fit
 * read as their defaults (the client resolves them like a URL). Only the owner's "Save as report
 * default" changes the spec, through the manual edit (a version), never here.
 */

type ViewRow = { id: string; report_id: string; user_id: string; name: string; values_json: string; is_default: number; created_at: string; updated_at: string };

const cleanName = (name: string) => name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, VIEW_LIMITS.name);

function parseValues(json: string): ParamValues {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as ParamValues : {};
  } catch {
    return {};
  }
}

const viewOf = (row: ViewRow): ParamView => ({ id: row.id, name: row.name, values: parseValues(row.values_json), isDefault: row.is_default === 1, createdAt: row.created_at, updatedAt: row.updated_at });

/** The values as stored: only the ones that differ from the report's defaults (a view keeps what the reader chose), each checked. */
function storedValues(params: readonly ReportParameter[], given: Record<string, unknown>): ParamValues {
  const { values, problems } = resolveValues(params, given);
  if (problems.length) throw new ReportError(400, "INVALID", `Parameter values refused: ${problems.slice(0, 3).join("; ")}`, { problems: problems.slice(0, 10) });
  const defaults = defaultValues(params);
  const out: ParamValues = {};
  for (const param of params) if (canonicalValues([param], { [param.id]: values[param.id]! }) !== canonicalValues([param], { [param.id]: defaults[param.id]! })) out[param.id] = values[param.id]!;
  const json = JSON.stringify(out);
  if (json.length > VIEW_LIMITS.valuesBytes) throw new ReportError(400, "INVALID", "These values are too long to save as a view");
  return out;
}

function readable(reportId: string, userId: string): { report: ReportRow; params: readonly ReportParameter[] } {
  const report = readableReport(reportId, userId);
  const params = parseSpec(report.spec_json).parameters;
  if (!params.length) throw new ReportError(400, "INVALID", "This report has no filters to save");
  return { report, params };
}

const rowsOf = (reportId: string, userId: string) => db.query("SELECT * FROM report_param_views WHERE report_id = ? AND user_id = ? ORDER BY name COLLATE NOCASE, id").all(reportId, userId) as ViewRow[];

/** GET …/views: the caller's views of the report (read access), and whether they may save values as the report's defaults. */
export function listViews(reportId: string, userId: string, role: string): ParamViewsView {
  const report = readableReport(reportId, userId);
  return { views: rowsOf(report.id, userId).map(viewOf), canSaveDefault: isReportOwner(report.id, userId) && role !== "viewer" && role !== "guest" };
}

/**
 * POST …/views: saves the values under a name (read access). A name the caller already uses
 * (regardless of case) is overwritten. `isDefault` makes it the caller's default view (the one before
 * stops being it). At most VIEW_LIMITS.perReport views per person and report.
 */
export function saveView(reportId: string, userId: string, input: { name: string; values: Record<string, unknown>; isDefault?: boolean }): ParamView {
  const { report, params } = readable(reportId, userId);
  const name = cleanName(input.name);
  if (!name) throw new ReportError(400, "INVALID", "Name the view");
  const values = storedValues(params, input.values);
  const at = now();
  const saved = db.transaction(() => {
    const same = db.query("SELECT * FROM report_param_views WHERE report_id = ? AND user_id = ? AND name = ? COLLATE NOCASE").get(report.id, userId, name) as ViewRow | null;
    if (!same && (db.query("SELECT count(*) AS n FROM report_param_views WHERE report_id = ? AND user_id = ?").get(report.id, userId) as { n: number }).n >= VIEW_LIMITS.perReport) {
      throw new ReportError(409, "LIMIT_REACHED", `You can keep at most ${VIEW_LIMITS.perReport} views of a report; remove one first`);
    }
    if (input.isDefault) db.query("UPDATE report_param_views SET is_default = 0, updated_at = ? WHERE report_id = ? AND user_id = ? AND is_default = 1").run(at, report.id, userId);
    const id = same?.id ?? crypto.randomUUID();
    if (same) db.query("UPDATE report_param_views SET name = ?, values_json = ?, is_default = CASE WHEN ? THEN 1 ELSE is_default END, updated_at = ? WHERE id = ?").run(name, JSON.stringify(values), input.isDefault ? 1 : 0, at, id);
    else db.query("INSERT INTO report_param_views (id, report_id, user_id, name, values_json, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, report.id, userId, name, JSON.stringify(values), input.isDefault ? 1 : 0, at, at);
    return db.query("SELECT * FROM report_param_views WHERE id = ?").get(id) as ViewRow;
  })();
  audit(userId, null, "reports.view.save", { reportId: report.id, viewId: saved.id, isDefault: saved.is_default === 1 });
  return viewOf(saved);
}

function ownView(reportId: string, userId: string, viewId: string): ViewRow {
  const report = readableReport(reportId, userId);
  const row = db.query("SELECT * FROM report_param_views WHERE id = ? AND report_id = ? AND user_id = ?").get(viewId, report.id, userId) as ViewRow | null;
  if (!row) throw new ReportError(404, "NOT_FOUND", "No such view");
  return row;
}

/** PATCH …/views/:viewId: renames it, or makes it (or stops it being) the caller's default view. */
export function updateView(reportId: string, userId: string, viewId: string, input: { name?: string; isDefault?: boolean }): ParamView {
  const row = ownView(reportId, userId, viewId);
  const at = now();
  const name = input.name === undefined ? row.name : cleanName(input.name);
  if (!name) throw new ReportError(400, "INVALID", "Name the view");
  db.transaction(() => {
    const clash = db.query("SELECT id FROM report_param_views WHERE report_id = ? AND user_id = ? AND name = ? COLLATE NOCASE AND id != ?").get(row.report_id, userId, name, row.id);
    if (clash) throw new ReportError(409, "INVALID", "You already have a view with that name");
    if (input.isDefault) db.query("UPDATE report_param_views SET is_default = 0, updated_at = ? WHERE report_id = ? AND user_id = ? AND is_default = 1 AND id != ?").run(at, row.report_id, userId, row.id);
    db.query("UPDATE report_param_views SET name = ?, is_default = ?, updated_at = ? WHERE id = ?").run(name, input.isDefault === undefined ? row.is_default : input.isDefault ? 1 : 0, at, row.id);
  })();
  return viewOf(db.query("SELECT * FROM report_param_views WHERE id = ?").get(row.id) as ViewRow);
}

/** DELETE …/views/:viewId: removes one of the caller's own views (in the app only; nothing over MCP, D180). */
export function removeView(reportId: string, userId: string, viewId: string): void {
  const row = ownView(reportId, userId, viewId);
  db.query("DELETE FROM report_param_views WHERE id = ?").run(row.id);
  audit(userId, null, "reports.view.remove", { reportId: row.report_id, viewId: row.id });
}
