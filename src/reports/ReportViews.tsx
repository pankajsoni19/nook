import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Bookmark, Check, LoaderCircle, Star, Trash2 } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { canonicalValues, defaultValues, isDefaultSet, resolveValues, valueLabel, type ParamValues, type ReportParameter } from "../../shared/reportParams";
import { VIEW_LIMITS, type ParamView } from "../../shared/reportsView";
import { listViews, removeView, saveView, updateView } from "./reportViewApi";
import { messageOf } from "./reportsApi";

/**
 * Saved views (lane FILT2, D565, D566): a reader's named filter values for one report and "my default
 * view", kept per person on the server (report_param_views) and applied through the URL like any
 * filter change (a Back step), except the default view on opening, which replaces the clean entry. Only
 * the owner's "Save as report default" changes the report (a version, through the manual edit).
 */

/** A view's values for the report as it is now: what no longer fits reads as its default. */
export const viewValues = (parameters: readonly ReportParameter[], view: Pick<ParamView, "values">): ParamValues => resolveValues(parameters, Object.fromEntries(Object.entries(view.values).filter(([id]) => parameters.some((param) => param.id === id) && resolveValues(parameters, { [id]: view.values[id] }).problems.length === 0))).values;

/** The view whose values are the ones on show, if any. */
export function activeView(parameters: readonly ReportParameter[], values: ParamValues, views: readonly ParamView[]): ParamView | null {
  const shown = canonicalValues(parameters, values);
  return views.find((view) => canonicalValues(parameters, viewValues(parameters, view)) === shown) ?? null;
}

/** The caller's views of a report (none until read; read again after a change). */
export function useReportViews(reportId: string, enabled: boolean) {
  const [state, setState] = useState<{ views: ParamView[]; canSaveDefault: boolean; loaded: boolean }>({ views: [], canSaveDefault: false, loaded: false });
  const reload = useCallback(async () => {
    try {
      const next = await listViews(reportId);
      setState({ views: next.views, canSaveDefault: next.canSaveDefault, loaded: true });
    } catch {
      setState((current) => ({ ...current, loaded: true }));
    }
  }, [reportId]);
  useEffect(() => { if (enabled) void reload(); }, [enabled, reload]);
  return { ...state, reload };
}

/** "Period: Last 7 days · Country: DE" (the values that differ from the defaults), or "The report's defaults". */
export function viewSummary(parameters: readonly ReportParameter[], values: ParamValues): string {
  const parts = parameters.filter((param) => !isDefaultSet([param], { [param.id]: values[param.id] ?? param.default })).map((param) => `${param.label}: ${valueLabel(param, values[param.id]!)}`);
  return parts.length ? parts.join(" · ") : "The report's defaults";
}

type SheetProps = {
  reportId: string;
  parameters: readonly ReportParameter[];
  values: ParamValues;
  views: readonly ParamView[];
  canSaveDefault: boolean;
  onApply: (values: ParamValues) => void;
  onChanged: () => Promise<void> | void;
  /** The owner: the values on show become the report's defaults (a new version). */
  onSaveDefault?: () => Promise<void>;
  onClose: () => void;
  reopen: () => void;
};

export function ViewsSheet({ reportId, parameters, values, views, canSaveDefault, onApply, onChanged, onSaveDefault, onClose, reopen }: SheetProps) {
  const active = activeView(parameters, values, views);
  const [name, setName] = useState("");
  const [asDefault, setAsDefault] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  useHistoryDialogGuard(true, onClose, { blocked: busy !== null, reopen, layerKey: "reports.views" });
  const atDefaults = isDefaultSet(parameters, values);

  async function run(key: string, work: () => Promise<unknown>, done?: string) {
    setBusy(key);
    setError(null);
    try {
      await work();
      await onChanged();
      if (done) notify.success(done);
    } catch (reason) {
      setError(messageOf(reason, "That did not work"));
    } finally {
      setBusy(null);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    void run("save", async () => { await saveView(reportId, { name: clean, values, ...(asDefault ? { isDefault: true } : {}) }); setName(""); setAsDefault(false); }, `View saved: ${clean.slice(0, VIEW_LIMITS.name)}`);
  }

  return <ModalDialog title="Views" eyebrow="Report" onClose={onClose} busy={busy !== null} variant="sheet" className="reports-dialog report-views-sheet">
    <div className="file-dialog-form report-views-body">
      {views.length ? <ul className="report-views-list" aria-label="Your views">
        {views.map((view) => {
          const on = active?.id === view.id;
          return <li key={view.id} className={`report-views-row${on ? " active" : ""}`}>
            <div className="report-views-main"><button type="button" className="report-views-apply" aria-current={on ? "true" : undefined} disabled={busy !== null} onClick={() => { onApply(viewValues(parameters, view)); onClose(); }}>
              <span className="report-views-name">{on && <Check aria-hidden="true" />}{view.name}</span>
            </button>
              <small>{viewSummary(parameters, viewValues(parameters, view))}</small></div>
            <button type="button" className={`icon-button report-views-star${view.isDefault ? " on" : ""}`} aria-pressed={view.isDefault} disabled={busy !== null}
              aria-label={view.isDefault ? `${view.name} is your default view; stop opening the report with it` : `Open the report with ${view.name}`} title={view.isDefault ? "Your default view" : "Make it your default view"}
              onClick={() => void run(`star:${view.id}`, () => updateView(reportId, view.id, { isDefault: !view.isDefault }), view.isDefault ? "The report opens with its defaults" : `The report opens with ${view.name}`)}>
              {busy === `star:${view.id}` ? <LoaderCircle className="spin" /> : <Star aria-hidden="true" />}
            </button>
            <button type="button" className="icon-button report-views-remove" aria-label={`Remove the view ${view.name}`} title="Remove" disabled={busy !== null}
              onClick={() => void run(`remove:${view.id}`, () => removeView(reportId, view.id), `View removed: ${view.name}`)}>
              {busy === `remove:${view.id}` ? <LoaderCircle className="spin" /> : <Trash2 aria-hidden="true" />}
            </button>
          </li>;
        })}
      </ul> : <p className="report-views-empty">No saved views yet. Save the filters you use often, and pick one to open the report with.</p>}
      <form className="report-views-save" onSubmit={submit} noValidate>
        <label htmlFor={nameId}>Save the filters on show</label>
        <p className="report-views-current">{viewSummary(parameters, values)}</p>
        <div className="report-views-save-row">
          <input id={nameId} value={name} maxLength={VIEW_LIMITS.name} placeholder="Name, e.g. Germany this month" autoComplete="off" onChange={(event) => setName(event.target.value)} />
          <button type="submit" className="primary-button" disabled={!name.trim() || busy !== null}>{busy === "save" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Bookmark aria-hidden="true" />}Save view</button>
        </div>
        <label className="report-views-check"><input type="checkbox" checked={asDefault} onChange={(event) => setAsDefault(event.target.checked)} />Open the report with this view</label>
      </form>
      {canSaveDefault && onSaveDefault && <section className="report-views-owner" aria-label="The report's defaults">
        <p>Everyone who opens the report sees its defaults first. As the owner you can make the filters on show the defaults; that saves a new version.</p>
        <button type="button" className="secondary-button" disabled={atDefaults || busy !== null} onClick={() => void run("defaults", onSaveDefault)}>
          {busy === "defaults" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}Save as report default
        </button>
      </section>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy !== null}>Close</button>
    </footer>
  </ModalDialog>;
}

/** The values the report's defaults would become (owner's Save as report default): one update_parameter op per changed parameter. */
export function defaultOps(parameters: readonly ReportParameter[], values: ParamValues) {
  const defaults = defaultValues(parameters);
  return parameters.filter((param) => canonicalValues([param], { [param.id]: values[param.id] ?? param.default }) !== canonicalValues([param], { [param.id]: defaults[param.id]! }))
    .map((param) => ({ op: "update_parameter" as const, id: param.id, set: { default: values[param.id] } }));
}
