import { useEffect, useId, useState, type FormEvent } from "react";
import "../files/files.css";
import { Check, Folder as FolderIcon, Inbox } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { REPORT_LIMITS, type ReportDuplicate, type ReportFolder } from "../../shared/reports";
import { duplicateReport, listFolders, messageOf } from "./reportsApi";
import { orderedFolders } from "./reportFolderTree";

const UNFILED = "__unfiled__";

/** "Copy of …", cut with … to the 200-character title (as the server does). */
export const copyTitle = (title: string) => {
  const text = `Copy of ${title}`;
  return text.length <= REPORT_LIMITS.title ? text : `${text.slice(0, REPORT_LIMITS.title - 1)}…`;
};

/** What a copy carries and leaves behind, in the dialog (D575): an owner's keeps the docs they can read; a reader's none. */
export const duplicateHint = (owner: boolean) => owner
  ? "Copies the charts, queries, filters, latest results, model, and the docs you can read. Sharing, owners, schedule, changes, and versions stay with this report."
  : "Copies the charts, queries, filters, latest results, and model. The report's docs, sharing, schedule, changes, and versions stay with it.";

/**
 * Duplicate (D575): anyone who can read a report makes their own copy, titled "Copy of …", in Unfiled or
 * a folder they pick. The Move sheet's look (a dialog on desktop, a full-screen sheet on phones). Back or
 * Escape closes it; Forward reopens it (layer `reports.duplicate`).
 */
export function DuplicateSheet({ report, onCancel, onDuplicated, reopen }: { report: { id: string; title: string; isOwner: boolean }; onCancel: () => void; onDuplicated: (result: ReportDuplicate) => void; reopen?: () => void }) {
  const [title, setTitle] = useState(() => copyTitle(report.title));
  const [folders, setFolders] = useState<ReportFolder[] | null>(null);
  const [chosen, setChosen] = useState(UNFILED);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const placeId = useId();
  useHistoryDialogGuard(true, onCancel, { blocked: busy, reopen, layerKey: "reports.duplicate" });
  useEffect(() => {
    let live = true;
    listFolders().then((tree) => { if (live) setFolders(tree.folders); }).catch(() => { if (live) setFolders([]); });
    return () => { live = false; };
  }, []);
  const targets = [{ id: UNFILED, name: "Unfiled", depth: 1 }, ...orderedFolders(folders ?? []).map(({ folder, depth }) => ({ id: folder.id, name: folder.name, depth }))];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return setError("Enter a title.");
    setBusy(true);
    setError(null);
    try {
      onDuplicated(await duplicateReport(report.id, { title: title.trim(), folderId: chosen === UNFILED ? null : chosen }));
    } catch (reason) {
      setError(messageOf(reason, "Could not duplicate the report"));
      setBusy(false);
    }
  }

  return <ModalDialog title={`Duplicate “${report.title}”`} eyebrow="Reports" onClose={onCancel} variant="sheet" busy={busy} className="reports-dialog report-duplicate-sheet">
    <form className="file-dialog-form report-duplicate-form" onSubmit={submit} noValidate>
      <label htmlFor={titleId}>Title</label>
      <input id={titleId} value={title} maxLength={REPORT_LIMITS.title} autoFocus autoComplete="off" onChange={(event) => setTitle(event.target.value)} disabled={busy} />
      <span id={placeId} className="reports-label">Put it in</span>
      <div className="move-list report-duplicate-places" role="radiogroup" aria-labelledby={placeId}>
        {targets.map((target) => <button
          key={target.id}
          type="button"
          role="radio"
          aria-checked={chosen === target.id}
          className={`move-option${chosen === target.id ? " active" : ""}`}
          style={{ paddingLeft: `${12 + (target.depth - 1) * 20}px` }}
          disabled={busy}
          onClick={() => setChosen(target.id)}
        >
          {target.id === UNFILED ? <Inbox aria-hidden="true" /> : <FolderIcon aria-hidden="true" />}
          <span>{target.name}</span>
          {chosen === target.id && <Check aria-hidden="true" />}
        </button>)}
        {folders === null && <p className="file-dialog-hint" role="status">Loading folders…</p>}
      </div>
      <p className="file-dialog-hint">{duplicateHint(report.isOwner)}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !title.trim()}>{busy ? "Duplicating…" : "Duplicate"}</button>
      </footer>
    </form>
  </ModalDialog>;
}

/** The toasts after a copy: where it went, then what it left out (docs the owner cannot read, the model). */
export function duplicateMessages(result: ReportDuplicate): { done: string; notes: string[] } {
  const { duplicate } = result;
  const notes: string[] = [];
  if (duplicate.docsLeftOut.length) {
    const names = duplicate.docsLeftOut.map((doc) => `“${doc.title}”`);
    notes.push(`Left out ${names.length === 1 ? "1 doc" : `${names.length} docs`} you cannot read: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`);
  }
  if (duplicate.model === "not_allowed") notes.push("The copy uses the default model: your role cannot choose the model that writes reports");
  return { done: `Duplicated as “${result.report.title}”`, notes };
}
