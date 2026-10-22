import { useContext, useId, useMemo, useRef, useState } from "react";
import { CircleCheck, LoaderCircle, Play, Send, TriangleAlert } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { REPORT_LIMITS, type ReportDetail, type ReportQuery } from "../../shared/reports";
import { valueLabel, valuesFromSearch } from "../../shared/reportParams";
import { QUERY_EDIT_LIMITS, type QueryEditPreview } from "../../shared/reportsQueryEdit";
import { ReportParamsContext } from "./ReportParamsBar";
import { ResultTable } from "./ResultTable";
import { editSpec, previewQuery, suggestQuery } from "./reportEditApi";
import { undoToBefore } from "./reportBlockEdit";
import { codeOf, countLabel, messageOf } from "./reportsApi";

export type QueryEditMode = "save" | "suggest";

type Props = {
  report: Pick<ReportDetail, "id" | "revision" | "spec">;
  /** The block it was opened from (named in the eyebrow; a suggestion is about it). */
  blockId: string;
  blockTitle: string;
  query: ReportQuery;
  /** The owner saves; the comment level suggests to the owner. */
  mode: QueryEditMode;
  /** The columns the block maps (highlighted in the preview's table). */
  highlight: Record<string, string>;
  /** The SQL typed so far (kept by the Inspect sheet, so Forward after Back shows it again). */
  draft: string | null;
  onDraft: (sql: string | null) => void;
  onClose: () => void;
  reopen?: () => void;
  layerKey?: string;
  /** The report changed (a save, an Undo). */
  onChanged: () => void;
  /** Opens Changes at the block (after a suggestion). */
  openChanges?: (blockId: string | null) => void;
};

type Failure = { message: string; details: string[] };
const failureOf = (reason: unknown, fallback: string): Failure => {
  const payload = reason && typeof reason === "object" && "payload" in reason ? (reason as { payload?: { details?: unknown; hint?: unknown } }).payload : undefined;
  const details = Array.isArray(payload?.details) ? payload.details.filter((item): item is string => typeof item === "string") : [];
  const hint = typeof payload?.hint === "string" ? [`Hint: ${payload.hint}`] : [];
  const { code } = codeOf(reason);
  const message = code === "REVISION_CONFLICT" ? "The report changed since you opened this; close it and try again."
    : code === "RUN_IN_PROGRESS" ? "The report is running; try when it finishes."
      : messageOf(reason, fallback);
  return { message, details: details.length > 1 || (details[0] && details[0] !== message) ? details : hint };
};

/**
 * Inspect → Query → Edit SQL (the owner) or Suggest an edit (the comment level), lane EDIT (D527–D529):
 * the SQL console's editor, Run preview (guarded, with the filters on screen; the rows and whether the
 * blocks still find their columns), then Check and save (a new version, with Undo) or Suggest to the
 * owner (a proposal in Changes). A wide panel at the right, full screen on a phone; Back closes it.
 */
export function QueryEditSheet({ report, blockId, blockTitle, query, mode, highlight, draft, onDraft, onClose, reopen, layerKey, onChanged, openChanges }: Props) {
  const [sql, setSqlState] = useState(draft ?? query.sql);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [preview, setPreview] = useState<{ sql: string; result: QueryEditPreview } | null>(null);
  const [previewError, setPreviewError] = useState<Failure | null>(null);
  const [saveError, setSaveError] = useState<Failure | null>(null);
  const abort = useRef<AbortController | null>(null);
  const sqlId = useId();
  const noteId = useId();
  useHistoryDialogGuard(true, () => { abort.current?.abort(); onClose(); }, { blocked: busy === "save", reopen, layerKey });

  // The filters on screen (the report page's URL), as the preview runs with them.
  const paramsContext = useContext(ReportParamsContext);
  const parameters = report.spec.parameters ?? [];
  const values = useMemo(() => valuesFromSearch(parameters, paramsContext?.search), [parameters, paramsContext?.search]);
  const filters = parameters.map((param) => `${param.label}: ${valueLabel(param, values[param.id] ?? param.default)}`);

  const setSql = (next: string) => {
    setSqlState(next);
    onDraft(next === query.sql ? null : next);
    setSaveError(null);
  };
  const changed = sql.trim() !== query.sql.trim() && sql.trim().length > 0;
  const previewCurrent = preview !== null && preview.sql === sql;

  async function runPreview() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy("preview");
    setPreviewError(null);
    try {
      const { preview: result } = await previewQuery(report.id, query.key, sql, parameters.length ? values : null, controller.signal);
      setPreview({ sql, result });
    } catch (reason) {
      if (controller.signal.aborted) return;
      setPreview(null);
      setPreviewError(failureOf(reason, "The preview did not run"));
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(null);
    }
  }

  async function submit() {
    setBusy("save");
    setSaveError(null);
    try {
      if (mode === "save") {
        const saved = await editSpec(report.id, [{ op: "update_query", key: query.key, sql }], report.revision);
        onDraft(null);
        onChanged();
        notify.success(`Saved ${query.key} (version ${saved.version})`, {
          id: `report-query-saved:${report.id}`,
          action: { label: "Undo", onClick: () => { void undoToBefore(report.id, saved.version).then((outcome) => { if (outcome === "moved_on") notify.warning("The report changed since; restore a version from Versions"); onChanged(); }, (reason: unknown) => notify.error(messageOf(reason, "Could not undo the change"))); } }
        });
        if (saved.warnings?.length) notify.warning(`Saved, but Nook's checks noticed: ${saved.warnings.slice(0, 2).join("; ")}`);
      } else {
        await suggestQuery(report.id, query.key, { sql, note: note.trim() || null, blockId, expectedRevision: report.revision });
        onDraft(null);
        notify.success("Sent to the owner: it waits in Changes until they apply or reject it", openChanges ? { action: { label: "Open Changes", onClick: () => openChanges(blockId) } } : undefined);
      }
      setBusy(null);
      onClose();
    } catch (reason) {
      setSaveError(failureOf(reason, mode === "save" ? "Could not save the query" : "Could not send the suggestion"));
      setBusy(null);
    }
  }

  const result = preview?.result ?? null;
  const missing = result?.blocks.filter((item) => item.missing.length) ?? [];
  return <ModalDialog title={mode === "save" ? "Edit SQL" : "Suggest an edit"} eyebrow={`${blockTitle} · ${query.key}`} onClose={onClose} busy={busy === "save"} variant="sheet" className="reports-dialog report-edit-sheet report-query-edit">
    <div className="report-edit-sheet-body">
      <p className="file-dialog-hint report-query-edit-lead">{mode === "save"
        ? "Nook checks the new SQL before saving it: the guard, a run of every query, and the columns each block maps. The save is a new version."
        : "Try it with Run preview, then send it to the report's owner, who applies or rejects it in Changes. Nothing changes until they do."}</p>
      <label htmlFor={sqlId} className="sr-only">SQL of {query.key}</label>
      <textarea id={sqlId} className="report-sql" value={sql} rows={10} maxLength={REPORT_LIMITS.sqlChars} spellCheck={false} autoCapitalize="off" autoCorrect="off"
        onChange={(event) => setSql(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && busy === null && sql.trim()) { event.preventDefault(); void runPreview(); } }} />
      <div className="report-query-edit-run">
        <button type="button" className="secondary-button" onClick={() => { void runPreview(); }} disabled={busy !== null || !sql.trim()} aria-busy={busy === "preview" || undefined}>
          {busy === "preview" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}{busy === "preview" ? "Running…" : "Run preview"}
        </button>
        <p className="file-dialog-hint">{filters.length ? `Runs with the filters on screen: ${filters.join(" · ")}.` : "One guarded SELECT, read-only."} At most {REPORT_LIMITS.consoleRows.toLocaleString()} rows; nothing is saved.</p>
      </div>
      {previewError && <div className="form-error report-query-edit-error" role="alert"><p>{previewError.message}</p>{previewError.details.length > 0 && <ul>{previewError.details.map((line) => <li key={line}>{line}</li>)}</ul>}</div>}
      {result && <section className={`report-query-preview${previewCurrent ? "" : " report-query-preview-old"}`} aria-label="Preview">
        <p className="report-inspect-facts" role="status">
          <span>{countLabel(result.outcome.rows.length)}{result.outcome.truncated ? " (more were cut off)" : ""}</span>
          <span>{result.outcome.ms.toLocaleString()} ms</span>
          {!previewCurrent && <span>The SQL changed since this preview</span>}
        </p>
        <ul className="report-query-checks" aria-label="The blocks that read this query">
          {result.blocks.map((item) => <li key={item.blockId} className={item.missing.length ? "report-query-check-bad" : "report-query-check-ok"}>
            {item.missing.length ? <TriangleAlert aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
            <span><strong>{item.title}</strong> {item.missing.length ? <>is missing {item.missing.map((name, index) => <span key={name}>{index ? ", " : ""}<code>{name}</code></span>)}</> : "finds every column it maps"}</span>
          </li>)}
        </ul>
        {missing.length === 0 && result.problems.length > 0 && <ul className="form-error">{result.problems.map((line) => <li key={line}>{line}</li>)}</ul>}
        {result.outcome.columns.length > 0 && <ResultTable columns={result.outcome.columns} rows={result.outcome.rows} highlight={highlight} raw label={`Preview of ${query.key}`} />}
      </section>}
      {mode === "suggest" && <div className="report-query-edit-note">
        <label htmlFor={noteId}>Note for the owner <small>(optional)</small></label>
        <textarea id={noteId} value={note} rows={2} maxLength={QUERY_EDIT_LIMITS.note} onChange={(event) => setNote(event.target.value)} placeholder="Why this change" />
      </div>}
      {saveError && <div className="form-error report-query-edit-error" role="alert"><p>{saveError.message}</p>{saveError.details.length > 0 && <ul>{saveError.details.map((line) => <li key={line}>{line}</li>)}</ul>}</div>}
    </div>
    <footer className="file-dialog-actions report-edit-sheet-actions">
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy === "save"}>Cancel</button>
      <button type="button" className="primary-button" onClick={() => { void submit(); }} disabled={busy !== null || !changed} aria-busy={busy === "save" || undefined}>
        {busy === "save" ? <LoaderCircle className="spin" aria-hidden="true" /> : mode === "suggest" ? <Send aria-hidden="true" /> : null}
        {busy === "save" ? "Checking…" : mode === "save" ? "Check and save" : "Suggest to the owner"}
      </button>
    </footer>
  </ModalDialog>;
}
