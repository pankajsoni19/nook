import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ModalDialog } from "../files/Dialog";
import { appName } from "../appName";
import { notify } from "../ui/notify";
import { useConfirm } from "../ui/useConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { REPORT_DOC_LIMITS, type DocServerChoice, type DocState, type ReportDocView } from "../../shared/reportsGenerate";
import { BrowseToolsPicker } from "./BrowseToolsPicker";
import { DocAdder, DocList, type DocListItem, type PickedDoc } from "./DocList";
import { generateErrorText } from "./NewReportSheet";
import { addReportDoc, docServers, getDocState, messageOf, removeReportDoc, reorderReportDocs, saveBrowseTools } from "./reportsApi";
import "./generate.css";

/** How a doc joined the report, as its row says it (D515). */
export function docRowMeta(doc: Pick<ReportDocView, "addedVia" | "addedByName">): string | null {
  if (doc.addedVia === "change") return `added by ${doc.addedByName ? `${doc.addedByName}'s` : "a"} change`;
  if (doc.addedVia === "settings") return `added in Doc settings${doc.addedByName ? ` by ${doc.addedByName}` : ""}`;
  return null;
}

/** A report doc as a list row: its title, where it is read from, and whether it changed or is new since the last generation. */
export const docRowItem = (doc: ReportDocView): DocListItem => ({
  key: doc.id, title: doc.title, ref: doc.ref, nook: doc.serverId === "nook",
  source: doc.serverId === "nook" ? appName() : `via ${doc.serverName ?? "a removed tool server"}${doc.tool ? ` (${doc.tool})` : ""}`,
  tag: doc.added ? "New" : doc.changed ? "Changed" : null, meta: docRowMeta(doc)
});

/**
 * ⋯ → Doc settings (B3, D515): the report's docs (up to 8, in the order the AI reads them: reorder,
 * remove, add one from this Nook or a doc system), and the tools the AI may use to read more docs on
 * its next generation or edit (they follow the first doc's source). The owner's only; a sheet that
 * Back closes. Adding, moving, and removing a doc save at once; the tools save with Save.
 */
export function DocSettingsSheet({ reportId, onClose, onSaved, reopen }: { reportId: string; onClose: () => void; onSaved?: (doc: DocState) => void; reopen?: () => void }) {
  useHistoryDialogGuard(true, onClose, { reopen });
  const [state, setState] = useState<DocState | null>(null);
  const [servers, setServers] = useState<DocServerChoice[] | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    let live = true;
    Promise.all([getDocState(reportId), docServers()]).then(([{ doc }, { servers: list }]) => {
      if (!live) return;
      setState(doc);
      setTicked(doc.doc?.browseTools ?? []);
      setServers(list);
    }).catch((reason: unknown) => { if (live) setError(messageOf(reason, "Could not load the doc settings")); });
    return () => { live = false; };
  }, [reportId]);

  const server = useMemo(() => servers?.find((item) => item.id === state?.doc?.serverId) ?? null, [servers, state?.doc?.serverId]);

  /** A doc change saves at once; the state that comes back is the sheet's (and the page's). */
  async function change(work: () => Promise<{ doc: DocState }>, done: string, failed: string) {
    setWorking(true);
    setError(null);
    try {
      const { doc } = await work();
      setState(doc);
      if (doc.doc?.serverId !== state?.doc?.serverId) setTicked(doc.doc?.browseTools ?? []);
      onSaved?.(doc);
      notify.success(done);
    } catch (reason) {
      setError(generateErrorText(reason, failed));
    } finally {
      setWorking(false);
    }
  }

  const docs = state?.docs ?? [];
  const move = (index: number, by: -1 | 1) => {
    const ids = docs.map((doc) => doc.id);
    const to = index + by;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to]!, ids[index]!];
    void change(() => reorderReportDocs(reportId, ids), "Order saved: the AI reads the docs in this order", "Could not reorder the docs");
  };
  const remove = async (index: number) => {
    const doc = docs[index];
    if (!doc) return;
    if (!await confirm.ask({ title: `Remove “${doc.title ?? "this doc"}”?`, message: "The report keeps its charts until you regenerate; the next generation and edits no longer read it.", confirmLabel: "Remove", danger: true })) return;
    void change(() => removeReportDoc(reportId, doc.id), "Doc removed", "Could not remove the doc");
  };
  const add = (pick: PickedDoc) => change(() => addReportDoc(reportId, { docRef: pick.docRef, serverId: pick.serverId, tool: pick.tool ?? null, arg: pick.arg ?? null }), "Doc added: Regenerate to use it", "Could not add the doc");

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { doc } = await saveBrowseTools(reportId, ticked);
      notify.success(doc.doc?.browseTools.length ? "The AI may read linked docs with the tools you ticked" : "The AI reads only the report's docs");
      onSaved?.(doc);
      onClose();
    } catch (reason) {
      setError(messageOf(reason, "Could not save the doc settings"));
      setBusy(false);
    }
  }

  return <ModalDialog title="Doc settings" eyebrow="Report" onClose={onClose} busy={busy} variant="sheet" className="reports-dialog new-report-sheet report-doc-settings">
    <form className="file-dialog-form" onSubmit={(event) => { void save(event); }} noValidate>
      {!state && !error && <p className="file-dialog-hint" role="status">Loading…</p>}
      {state && <>
        <span className="reports-label">Docs ({docs.length} of {REPORT_DOC_LIMITS.docs}), read in this order</span>
        {docs.length ? <DocList items={docs.map(docRowItem)} disabled={working || busy} onMove={move} onRemove={docs.length > 1 ? (index) => { void remove(index); } : undefined} />
          : <p className="file-dialog-hint">This report has no doc yet.</p>}
        {docs.length === 1 && <p className="file-dialog-hint">A report keeps at least one doc: add another before removing this one.</p>}
        <DocAdder servers={servers} defaultServerId={state.doc?.serverId ?? null} onAdd={add} busy={working} disabled={busy} full={docs.length >= REPORT_DOC_LIMITS.docs} label="Add a doc" />
      </>}
      {state && !server && state.doc && <p className="file-dialog-hint">The first doc's tool server is not available to you any more, so its tools cannot be changed here.</p>}
      {server && <BrowseToolsPicker server={server} value={ticked} onChange={setTicked} disabled={busy} />}
      {state && <p className="file-dialog-hint">Docs you add or remove here count from the next Regenerate. The tools follow the first doc's source; every edit uses them, and Check doc also reads the linked pages the last generation read.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Close</button>
        <button type="submit" className="primary-button" disabled={busy || working || !server}>{busy ? "Saving…" : "Save tools"}</button>
      </footer>
    </form>
    {confirm.confirmElement}
  </ModalDialog>;
}
