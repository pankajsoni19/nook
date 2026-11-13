import { useId, useState } from "react";
import { FileUp, Undo2 } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { commitImport, errorMessage, previewImport, remapImport, undoImport } from "./crmApi";
import { IMPORT_FIELDS, IMPORT_LIMITS, type CrmBook, type ImportPreview, type ImportResult } from "../../shared/crm";
import "./crmPanels.css";

/**
 * CSV import (§D.5, D966): choose a file → map columns (auto-matched by header) → see how many rows
 * are new, match an existing record, repeat within the file, or have a problem → choose what
 * duplicates do → import → the result, with Undo for 24 hours. A full-screen sheet on phones.
 */
export function ImportSheet({ book, entity, onClose, onDone, flash }: { book: CrmBook; entity: "contact" | "company"; onClose: () => void; onDone: (result: ImportResult) => void; flash: (message: string) => void }) {
  const id = useId();
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Array<string | null>>([]);
  const [duplicates, setDuplicates] = useState<"update" | "skip">("update");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [undone, setUndone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plural = entity === "contact" ? "contacts" : "companies";
  const targets = [
    ...IMPORT_FIELDS[entity].map((field) => ({ value: field.id, label: field.label })),
    ...book.fields[entity].filter((field) => field.type !== "person" && field.type !== "contact").map((field) => ({ value: `custom:${field.id}`, label: field.name }))
  ];

  const accept = (next: ImportPreview) => {
    setPreview(next);
    setMapping(next.header.map((_, index) => next.mapping[String(index)] || null));
  };
  const choose = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > IMPORT_LIMITS.bytes) { setError("A CSV import is at most 5 MB"); return; }
    setBusy(true); setError(null);
    try {
      const csv = await file.text();
      setFileName(file.name);
      accept((await previewImport({ bookId: book.id, entity, csv })).preview);
    } catch (reason) { setPreview(null); setError(errorMessage(reason, "Could not read the CSV")); }
    finally { setBusy(false); }
  };
  const remap = async (index: number, value: string) => {
    if (!preview) return;
    const next = [...mapping];
    next[index] = value || null;
    setMapping(next);
    setBusy(true); setError(null);
    try { accept((await remapImport(preview.jobId, next)).preview); }
    catch (reason) { setError(errorMessage(reason, "Could not check the mapping")); }
    finally { setBusy(false); }
  };
  const run = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const body = await commitImport(preview.jobId, { duplicates, mapping });
      setResult(body.result);
      flash(`Imported ${body.result.created + body.result.updated} ${plural}`);
    } catch (reason) { setError(errorMessage(reason, "Could not import")); }
    finally { setBusy(false); }
  };
  const revert = async () => {
    if (!result) return;
    setBusy(true); setError(null);
    try {
      const body = await undoImport(result.jobId);
      setUndone(true);
      flash(`Import undone: ${body.deleted} removed, ${body.restored} put back`);
    } catch (reason) { setError(errorMessage(reason, "Could not undo the import")); }
    finally { setBusy(false); }
  };

  const ready = preview && preview.total - preview.invalid > 0 && mapping.some(Boolean);
  const shownColumns = preview ? preview.header.map((name, index) => ({ name, field: mapping[index] })).filter((column) => column.field).slice(0, 3) : [];

  return <ModalDialog title={`Import ${plural}`} eyebrow={book.name} onClose={() => { if (result && !undone) onDone(result); else onClose(); }} variant="sheet" busy={busy} className="crm-import">
    <div className="crm-import-body">
      {result ? <div className="crm-import-result" role="status">
        <h3>{undone ? "Import undone" : "Import finished"}</h3>
        {undone ? <p>Everything this import created was removed and what it changed was put back.</p>
          : <p>Created {result.created}, updated {result.updated}, skipped {result.skipped}{result.invalid ? `, ${result.invalid} ${result.invalid === 1 ? "problem" : "problems"}` : ""}.</p>}
        {!undone && <p className="crm-panel-help">You can undo this import for 24 hours.</p>}
      </div> : <>
        <label className="secondary-button crm-import-choose">
          <FileUp aria-hidden="true" />{fileName ? `Chosen: ${fileName}` : "Choose a CSV file"}
          <input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        <p className="crm-panel-help">The first row names the columns. Up to 10,000 rows and 5 MB. {entity === "contact" ? "Rows match existing contacts by email." : "Rows match existing companies by domain, then name."}</p>
        {preview && <>
          <h3 id={`${id}-map`}>Columns</h3>
          <div className="crm-import-mapping" role="group" aria-labelledby={`${id}-map`}>
            {preview.header.map((name, index) => <div key={index} className="crm-import-mapping-row">
              <span id={`${id}-col-${index}`} title={name}>{name || `Column ${index + 1}`}</span>
              <Select labelledBy={`${id}-col-${index}`} value={mapping[index] ?? ""} disabled={busy} onChange={(value) => { void remap(index, value); }}
                options={[{ value: "", label: "Skip" }, ...targets.map((target) => ({ ...target, disabled: target.value !== mapping[index] && mapping.includes(target.value) }))]} />
            </div>)}
          </div>
          <dl className="crm-import-counts" aria-live="polite">
            <div><dt>Rows</dt><dd>{preview.total}</dd></div>
            <div><dt>New</dt><dd>{preview.creates}</dd></div>
            <div><dt>Match existing</dt><dd>{preview.duplicates}</dd></div>
            <div><dt>Repeated in file</dt><dd>{preview.duplicatesInFile}</dd></div>
            <div><dt>Problems</dt><dd>{preview.invalid}</dd></div>
          </dl>
          {preview.sample.length > 0 && <div className="crm-import-sample"><table>
            <caption className="ui-visually-hidden">Sample rows</caption>
            <thead><tr><th scope="col">Row</th>{shownColumns.map((column) => <th key={column.name} scope="col">{column.name}</th>)}<th scope="col">Result</th></tr></thead>
            <tbody>{preview.sample.slice(0, 12).map((row) => <tr key={row.row}>
              <td className="ui-tabular">{row.row}</td>
              {shownColumns.map((column) => <td key={column.name}>{row.values[column.field!] ?? ""}</td>)}
              <td className={row.problem ? "crm-import-problem" : undefined}>{row.problem ?? (row.match ? `Matches ${row.match.name}` : "New")}</td>
            </tr>)}</tbody>
          </table></div>}
          {(preview.duplicates > 0 || preview.duplicatesInFile > 0) && <fieldset className="crm-radios">
            <legend>Duplicates</legend>
            <label><input type="radio" name={`${id}-dup`} checked={duplicates === "update"} onChange={() => setDuplicates("update")} />Update the existing record</label>
            <label><input type="radio" name={`${id}-dup`} checked={duplicates === "skip"} onChange={() => setDuplicates("skip")} />Skip them</label>
          </fieldset>}
        </>}
      </>}
    </div>
    {error && <p className="file-dialog-error" role="alert">{error}</p>}
    <footer className="file-dialog-actions">
      {result ? <>
        {!undone && <button type="button" className="secondary-button" onClick={() => { void revert(); }} disabled={busy}><Undo2 aria-hidden="true" />Undo import</button>}
        <button type="button" className="primary-button" onClick={() => undone ? onClose() : onDone(result)} disabled={busy}>Done</button>
      </> : <>
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => { void run(); }} disabled={busy || !ready}>
          {busy ? "Working…" : preview ? `Import ${preview.total - preview.invalid} ${preview.total - preview.invalid === 1 ? "row" : "rows"}` : "Import"}
        </button>
      </>}
    </footer>
  </ModalDialog>;
}
