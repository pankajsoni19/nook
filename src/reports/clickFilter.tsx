import { useState } from "react";
import { Check, ListFilter, MousePointerClick, X } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { blockKeys, CLICKABLE_KINDS, type ChartBlock, type ClickFilter, type ReportDetail, type ReportResult, type TableBlock } from "../../shared/reports";
import { PARAM_LIMITS, readsOf, type ReportParameter } from "../../shared/reportParams";
import { cellLabel } from "./chartOption";
import { editSpec } from "./reportEditApi";
import { codeOf, messageOf } from "./reportsApi";

/**
 * Click to filter (lane FILTERS, D536; docs/plan/REPORT_FILTERS.md F4). A chart or table with a
 * `clickFilter` sets that select or multi-select when a reader clicks a bar, slice, point, or row: a
 * multi-select toggles the value, a select takes it; the URL gains an entry, so Back undoes the click.
 * The clicked block never filters itself: it greys what was not picked. On a touch screen a tap only
 * shows the tooltip and a **Filter by …** button (PickBar); the keyboard has focusable table rows and
 * "Filter by…" in the block's menu (FilterBySheet). The owner chooses what a click filters by from the
 * block's menu (ClickFilterSheet, a `set_click_filter` edit).
 */

/** A block's click filter as the viewer wires it: the parameter, the column, what is picked now, and the action. */
export type ClickState = { param: ReportParameter; column: string; picked: readonly string[]; onPick: (value: string) => void };

export type ClickableBlock = ChartBlock | TableBlock;
export const isClickable = (block: { type: string }): block is ClickableBlock => block.type === "chart" || block.type === "table";

/** The values a parameter holds as a click filter shows them (a select at its default holds none). */
export function pickedValues(param: ReportParameter, value: unknown): string[] {
  if (param.type === "multi_select") return Array.isArray(value) ? value.map(String) : [];
  if (param.type === "select") return typeof value === "string" && value !== param.default ? [value] : [];
  return [];
}

/** The next value after a click: a multi-select toggles (at most 50), a select takes it (or goes back to its default). */
export function clickedValue(param: ReportParameter, current: unknown, value: string): string | string[] | null {
  if (param.type === "multi_select") {
    const list = Array.isArray(current) ? current.map(String) : [];
    if (list.includes(value)) return list.filter((item) => item !== value);
    return list.length >= PARAM_LIMITS.selected ? null : [...list, value];
  }
  if (param.type === "select") return current === value ? param.default : value;
  return null;
}

/** The phone's "Filter by …" under a tapped chart or table row: a tap alone never filters. */
export function PickBar({ label, value, picked, onApply, onClose }: { label: string; value: string; picked: boolean; onApply: () => void; onClose: () => void }) {
  return <div className="report-pick-bar" role="group" aria-label={`${label}: ${value || "(blank)"}`}>
    <button type="button" className="secondary-button report-pick-apply" onClick={onApply}>
      <ListFilter aria-hidden="true" />{picked ? `Clear ${label}: ${value || "(blank)"}` : `Filter by ${label}: ${value || "(blank)"}`}
    </button>
    <button type="button" className="icon-button report-pick-close" onClick={onClose} aria-label="Close"><X /></button>
  </div>;
}

/** The distinct values of a column in a result, in their order (the keyboard's Filter by… list). */
export function columnValues(result: Pick<ReportResult, "columns" | "rows">, column: string, limit = 200): string[] {
  const at = result.columns.findIndex((item) => item.name === column);
  if (at < 0) return [];
  const seen = new Set<string>();
  for (const row of result.rows) {
    if (row[at] === null || row[at] === undefined) continue;
    seen.add(cellLabel(row[at]));
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/** Block menu → Filter by… (D536, the keyboard's way): the block's values as toggles; each one is a click. */
export function FilterBySheet({ title, click, values, onClose }: { title: string; click: ClickState; values: readonly string[]; onClose: () => void }) {
  useHistoryDialogGuard(true, onClose);
  return <ModalDialog title={`Filter by ${click.param.label}`} eyebrow={title} onClose={onClose} variant="sheet" className="reports-dialog report-params-sheet report-filter-by">
    <div className="report-params-fields">
      <div className="report-filter-by-list" role="group" aria-label={`${click.param.label} values`}>
        {values.map((value) => {
          const on = click.picked.includes(value);
          return <button key={value} type="button" className={`report-filter-by-value${on ? " picked" : ""}`} aria-pressed={on} onClick={() => { click.onPick(value); onClose(); }}>
            {on ? <Check aria-hidden="true" /> : <span className="report-filter-by-dot" aria-hidden="true" />}{value || "(blank)"}
          </button>;
        })}
        {!values.length && <p className="report-param-problem">This block has no values to filter by yet.</p>}
      </div>
    </div>
  </ModalDialog>;
}

/** The parameters a block may filter by on a click: selects and multi-selects its own queries never read. */
export function clickChoices(report: Pick<ReportDetail, "spec">, block: ClickableBlock): Array<{ param: ReportParameter; columns: string[] }> {
  const own = report.spec.queries.filter((query) => blockKeys(block).includes(query.key));
  const columns = block.type === "chart" ? [block.x, block.series].filter((item): item is string => Boolean(item)) : block.columns?.length ? block.columns : [];
  if (block.type === "chart" && (!CLICKABLE_KINDS.includes(block.kind) || block.facet)) return [];
  return (report.spec.parameters ?? [])
    .filter((param) => (param.type === "select" || param.type === "multi_select") && !own.some((query) => readsOf(query.sql, [param]).length))
    .map((param) => ({ param, columns }));
}

/**
 * Block menu → Clicking filters by… (the owner, D536): none, or one parameter and the column whose
 * value a click takes. Saved as a manual edit (`set_click_filter`); the column must be in the result.
 */
export function ClickFilterSheet({ report, block, resultColumns, onClose, onSaved }: { report: ReportDetail; block: ClickableBlock; resultColumns: readonly string[]; onClose: () => void; onSaved: () => void }) {
  const choices = clickChoices(report, block);
  const current = block.clickFilter ?? null;
  const key = (choice: ClickFilter | null) => choice ? `${choice.param}\u0000${choice.column}` : "";
  const [picked, setPicked] = useState<string>(key(current));
  const [busy, setBusy] = useState(false);
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  const options: Array<{ key: string; label: string; detail: string; value: ClickFilter | null }> = [
    { key: "", label: "Nothing", detail: "Clicks show the tooltip only", value: null },
    ...choices.flatMap(({ param, columns }) => (columns.length ? columns : resultColumns).map((column) => ({ key: key({ param: param.id, column }), label: param.label, detail: `Takes the clicked ${column}`, value: { param: param.id, column } })))
  ];
  async function save() {
    const chosen = options.find((option) => option.key === picked)?.value ?? null;
    setBusy(true);
    try {
      await editSpec(report.id, [{ op: "set_click_filter", id: block.id, clickFilter: chosen }], report.revision);
      notify.success(chosen ? "Clicking this block now filters the report" : "Clicking this block no longer filters");
      onSaved();
    } catch (reason) {
      notify.error(codeOf(reason).code === "REVISION_CONFLICT" ? "The report changed; reopen it and try again." : messageOf(reason, "Could not save"));
      setBusy(false);
    }
  }
  return <ModalDialog title="Clicking filters by" eyebrow={block.title ?? block.queryKey} onClose={onClose} busy={busy} variant="sheet" className="reports-dialog report-params-sheet report-click-filter">
    <div className="report-params-fields">
      {choices.length === 0 && <p className="report-param-problem">No filter fits: a click sets a select or multi-select this block's own query does not read.</p>}
      <div className="report-click-filter-options" role="radiogroup" aria-label="Clicking filters by">
        {options.map((option) => <label key={option.key} className="report-param-check">
          <input type="radio" name="click-filter" checked={picked === option.key} onChange={() => setPicked(option.key)} />
          <span><strong>{option.label}</strong> <small>{option.detail}</small></span>
        </label>)}
      </div>
    </div>
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="primary-button" onClick={() => { void save(); }} disabled={busy || picked === key(current)}><MousePointerClick aria-hidden="true" />{busy ? "Saving…" : "Save"}</button>
    </footer>
  </ModalDialog>;
}
