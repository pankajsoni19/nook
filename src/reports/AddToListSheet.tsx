import { useEffect, useState, type FormEvent } from "react";
import "../files/files.css";
import { Check, ListPlus, ListOrdered } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { FormError } from "../ui/FormError";
import { errorText, notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { REPORT_LIST_NAME_MAX, type ReportListChoice } from "../../shared/reports";
import { addToList, createList, listChoices, messageOf, removeFromList } from "./reportsApi";

/**
 * Add to list (phase 3, D550, D558): the lists the caller curates (theirs, and ones shared with them at
 * edit), each a toggle that adds the report to the end of the list or takes it out, at once. A new list
 * can be made here and gets the report. The Move sheet's look (a dialog on desktop, a full-screen sheet on
 * phones). A list never grants access: adding a report to a shared list shares nothing. Back or Escape
 * closes it (D18); Forward reopens it (`reports.addToList:<reportId>`).
 */
export function AddToListSheet({ reportId, title, canCreate, onClose, onReopen, onChanged }: {
  reportId: string; title: string; canCreate: boolean; onClose: () => void; onReopen?: () => void;
  /** A list gained or lost the report (the caller reloads its counts). */ onChanged?: () => void;
}) {
  const [choices, setChoices] = useState<ReportListChoice[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useHistoryDialogGuard(true, onClose, { reopen: onReopen ?? null, layerKey: `reports.addToList:${reportId}` });

  useEffect(() => {
    let alive = true;
    listChoices(reportId).then((result) => { if (alive) setChoices(result.lists); }, (reason) => { if (alive) setError(messageOf(reason, "Could not load your lists")); });
    return () => { alive = false; };
  }, [reportId]);

  async function toggle(choice: ReportListChoice) {
    setBusy(choice.id);
    setError(null);
    const next = !choice.contains;
    setChoices((list) => list?.map((item) => item.id === choice.id ? { ...item, contains: next } : item) ?? list);
    try {
      if (next) await addToList(choice.id, reportId);
      else await removeFromList(choice.id, reportId);
      onChanged?.();
    } catch (reason) {
      setChoices((list) => list?.map((item) => item.id === choice.id ? { ...item, contains: !next } : item) ?? list);
      notify.error(errorText(reason, next ? `Could not add it to ${choice.name}` : `Could not take it out of ${choice.name}`));
    } finally {
      setBusy(null);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy("new");
    setError(null);
    try {
      const { list } = await createList(trimmed);
      await addToList(list.id, reportId);
      setChoices((current) => [{ id: list.id, name: list.name, contains: true, ownerName: list.ownerName, isOwner: true }, ...(current ?? [])]);
      setName("");
      notify.success(`Added to the new list ${list.name}`);
      onChanged?.();
    } catch (reason) {
      setError(messageOf(reason, "Could not create the list"));
    } finally {
      setBusy(null);
    }
  }

  return <ModalDialog title="Add to list" eyebrow={title} onClose={onClose} variant="sheet" busy={busy === "new"} className="reports-dialog report-move-sheet report-list-sheet">
    <div className="move-list" role="group" aria-label="Your lists">
      {!choices && !error && <p className="reports-loading" role="status">Loading…</p>}
      {choices?.map((choice) => <button key={choice.id} type="button" role="checkbox" aria-checked={choice.contains} className={`move-option${choice.contains ? " active" : ""}`}
        disabled={busy === "new"} aria-busy={busy === choice.id || undefined} onClick={() => { if (busy === null) void toggle(choice); }}>
        <ListOrdered aria-hidden="true" />
        <span>{choice.name}{!choice.isOwner && <small>{choice.ownerName}’s list</small>}</span>
        {choice.contains && <Check aria-hidden="true" />}
      </button>)}
      {choices && !choices.length && <p className="file-dialog-copy">{canCreate ? "You have no lists yet. Name one below to start." : "No list you can change yet."}</p>}
    </div>
    {canCreate && <form className="report-list-new" noValidate onSubmit={(event) => { void create(event); }}>
      <label className="sr-only" htmlFor={`new-list-${reportId}`}>New list name</label>
      <input id={`new-list-${reportId}`} value={name} maxLength={REPORT_LIST_NAME_MAX} placeholder="New list name" onChange={(event) => setName(event.target.value)} disabled={busy !== null} />
      <button type="submit" className="secondary-button" disabled={!name.trim() || busy !== null}><ListPlus aria-hidden="true" />Create</button>
    </form>}
    <FormError message={error} className="file-dialog-error" />
    <footer className="file-dialog-actions">
      <button type="button" className="primary-button" onClick={onClose}>Done</button>
    </footer>
  </ModalDialog>;
}
