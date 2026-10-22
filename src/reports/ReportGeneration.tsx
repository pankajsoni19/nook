import { useCallback, useEffect, useState } from "react";
import { DocSettingsSheet } from "./DocSettingsSheet";
import { FileSearch, RefreshCw, Sparkles, TriangleAlert, Settings2 } from "lucide-react";
import { notify } from "../ui/notify";
import { useConfirm } from "../ui/useConfirm";
import type { ReportDetail } from "../../shared/reports";
import type { DocState, GenerationRun } from "../../shared/reportsGenerate";
import { GenerateProgress } from "./GenerateProgress";
import { generateErrorText } from "./NewReportSheet";
import { checkDoc, getDocState, latestGeneration, regenerateReport } from "./reportsApi";
import { ReportView } from "./ReportView";
import { useHeaderActions, useRegisterReportCommands } from "./reportCommands";
import "./generate.css";

/**
 * A report's generated part (Wave 46): the live progress of a running generation, why the last one
 * failed, the "Doc changed — regenerate?" banner, Check doc and Regenerate, and below them wave 47's
 * viewer (ReportView: charts, the inspect sheet, Refresh all, re-run, Schedule). ReportPage renders it
 * where the spec goes.
 */
/**
 * B3: the "Doc changed" banner's words: the main doc (with its title), a linked page by name, or both.
 */
export function docChangedText(doc: Pick<DocState, "mainChanged" | "pages" | "latest" | "metricsChanged"> & { docs?: DocState["docs"] }): string {
  // E4: the catalog metrics whose definitions changed, named after the doc's own words.
  const metrics = doc.metricsChanged ?? [];
  const named = metrics.length ? ` ${metrics.length === 1 ? "The definition of" : "The definitions of"} ${metrics.slice(0, 3).map((name) => `“${name}”`).join(metrics.length === 2 ? " and " : ", ")}${metrics.length > 3 ? ` and ${metrics.length - 3} more` : ""} changed.` : "";
  return `${docChangedBase(doc)}${named}`;
}

/** D515: names, quoted, as "“A”", "“A” and “B”", or "“A”, “B” and 2 more". */
const quoted = (names: readonly string[]) => names.length <= 2 ? names.map((name) => `“${name}”`).join(" and ") : `${names.slice(0, 2).map((name) => `“${name}”`).join(", ")} and ${names.length - 2} more`;

function docChangedBase(doc: Pick<DocState, "mainChanged" | "pages" | "latest"> & { docs?: DocState["docs"] }): string {
  // D515: a report with several docs names the ones that changed, and the ones added since.
  if (doc.docs && doc.docs.length > 1) {
    const name = (item: DocState["docs"][number]) => item.title ?? "Untitled doc";
    const changed = doc.docs.filter((item) => item.changed && !item.added).map(name);
    const added = doc.docs.filter((item) => item.added).map(name);
    const pages = doc.pages.filter((page) => page.changed && page.kind !== "search").map((page) => page.title ?? `a page read with ${page.tool}`);
    return [
      changed.length ? `${changed.length === 1 ? "The doc" : "The docs"} ${quoted(changed)} changed since this report was generated.` : "",
      added.length ? `${quoted(added)} ${added.length === 1 ? "was" : "were"} added to its docs since.` : "",
      pages.length ? `${pages.length === 1 ? "The linked page" : "The linked pages"} ${quoted(pages)} changed.` : "",
      searchesText(doc)
    ].filter(Boolean).join(" ");
  }
  const pages = doc.pages.filter((page) => page.changed && page.kind !== "search").map((page) => `“${page.title ?? `a page read with ${page.tool}`}”`);
  const linked = pages.length === 0 ? "" : pages.length === 1 ? `the linked page ${pages[0]}` : `the linked pages ${pages.slice(0, 2).join(" and ")}${pages.length > 2 ? ` and ${pages.length - 2} more` : ""}`;
  const main = doc.latest?.title ? `the doc (${doc.latest.title})` : "the doc";
  const changed = doc.mainChanged && linked ? `Both ${main} and ${linked} changed since this report was generated.`
    : linked ? `${linked[0]!.toUpperCase()}${linked.slice(1)} changed since this report was generated.`
    : doc.mainChanged || !searchesChanged(doc) ? `${main[0]!.toUpperCase()}${main.slice(1)} changed since this report was generated.` : "";
  return [changed, searchesText(doc)].filter(Boolean).join(" ");
}

const searchesChanged = (doc: Pick<DocState, "pages">) => doc.pages.some((page) => page.changed && page.kind === "search");
/** K3: a kept search or list whose result set changed: "The search for “X” now returns new or removed pages." */
function searchesText(doc: Pick<DocState, "pages">): string {
  const searches = doc.pages.filter((page) => page.changed && page.kind === "search").map((page) => page.title ? `the search for “${page.title}”` : `the list from ${page.tool}`);
  if (!searches.length) return "";
  const named = searches.length === 1 ? searches[0]! : `${searches.slice(0, 2).join(" and ")}${searches.length > 2 ? ` and ${searches.length - 2} more` : ""}`;
  return `${named[0]!.toUpperCase()}${named.slice(1)} now ${searches.length === 1 ? "returns" : "return"} new or removed pages.`;
}

/** Where the report comes from: "From Revenue metrics via Outline", or (D515) "From 3 docs: “A”, “B” and 1 more". */
export function docSourceLine(doc: Pick<DocState, "doc" | "latest"> & { docs?: DocState["docs"] }): string {
  if (doc.docs && doc.docs.length > 1) return `From ${doc.docs.length} docs: ${quoted(doc.docs.map((item) => item.title ?? "Untitled doc"))}`;
  return `From ${doc.latest?.title ?? "a doc"} via ${doc.doc?.serverName ?? "a doc source"}`;
}

export function ReportGeneration({ report, canWrite, onChanged }: { report: ReportDetail; canWrite: boolean; onChanged: () => void }) {
  const [run, setRun] = useState<GenerationRun | null>(null);
  const [doc, setDoc] = useState<DocState | null>(null);
  const [busy, setBusy] = useState<"check" | "regenerate" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const confirm = useConfirm();
  const hasDoc = report.doc !== null;
  const blocks = report.spec.blocks.length;

  const load = useCallback(async () => {
    const [generation, state] = await Promise.all([
      latestGeneration(report.id).catch(() => ({ run: null })),
      hasDoc ? getDocState(report.id).catch(() => null) : Promise.resolve(null)
    ]);
    setRun(generation.run);
    setDoc(state?.doc ?? null);
  }, [report.id, hasDoc]);
  useEffect(() => { void load(); }, [load, report.revision]);

  const running = run?.status === "running" && run.agentRunId !== null;

  async function check() {
    setBusy("check");
    try {
      const { doc: state } = await checkDoc(report.id);
      setDoc(state);
      const several = (state.docs?.length ?? 0) > 1;
      notify.success(state.changed ? (several ? "A doc changed since this report was generated" : "The doc changed since this report was generated") : several ? `None of the ${state.docs.length} docs has changed` : "The doc has not changed");
    } catch (reason) {
      notify.error(generateErrorText(reason, "Could not read the doc"));
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    const docsText = doc?.docs && doc.docs.length > 1 ? `all ${doc.docs.length} docs` : "the doc";
    if (blocks && !await confirm.ask({ title: "Regenerate this report?", message: `The AI reads ${docsText} again and builds a new spec; it replaces the current charts and queries when it succeeds. It uses your AI budget.`, confirmLabel: "Regenerate" })) return;
    setBusy("regenerate");
    try {
      const started = await regenerateReport(report.id);
      setRun({ id: started.run.id, agentRunId: started.run.agentRunId, status: "running", error: null, docSnapshotId: started.run.docSnapshotId, startedAt: new Date().toISOString(), finishedAt: null });
    } catch (reason) {
      notify.error(generateErrorText(reason, "Could not start generating"));
    } finally {
      setBusy(null);
    }
  }

  const finished = (_status: unknown, error: string | null) => {
    if (error) notify.error(error);
    void load();
    onChanged();
  };

  // On the report page, Check doc and Regenerate are in the header's overflow menu (reportCommands.tsx).
  const inHeader = useHeaderActions();
  const docActions = !running && canWrite && hasDoc;
  useRegisterReportCommands({
    checkDoc: docActions ? { run: () => { void check(); }, busy: busy === "check" } : null,
    regenerate: docActions ? { run: () => { void regenerate(); }, busy: busy === "regenerate" } : null,
    docSettings: docActions && report.isOwner ? { open: () => setSettingsOpen(true) } : null
  }, ["checkDoc", "regenerate", "docSettings"]);

  const failed = !running && run && (run.status === "failed" || run.status === "abandoned") ? run : null;
  return <div className="report-generation">
    {running && <GenerateProgress key={run!.agentRunId!} reportId={report.id} agentRunId={run!.agentRunId!} docTitle={doc?.latest?.title ?? null} onDone={finished} />}
    {!running && doc?.changed && <div className="report-doc-banner" role="status">
      <span className="report-doc-banner-icon" aria-hidden="true"><FileSearch /></span>
      <p><strong>Doc changed.</strong> {docChangedText(doc)} Regenerate?</p>
      {canWrite && <button type="button" className="primary-button" onClick={() => { void regenerate(); }} disabled={busy !== null}><Sparkles />Regenerate</button>}
    </div>}
    {failed && <p className="report-generation-failed" role="alert"><TriangleAlert aria-hidden="true" />The last generation {failed.status === "abandoned" ? "was interrupted" : "failed"}: {failed.error ?? "no report was saved"}</p>}
    {docActions && !inHeader && <div className="report-actions report-doc-actions">
      <button type="button" className="secondary-button" onClick={() => { void check(); }} disabled={busy !== null}><RefreshCw className={busy === "check" ? "spin" : undefined} />{busy === "check" ? "Checking…" : "Check doc"}</button>
      {!doc?.changed && <button type="button" className="secondary-button" onClick={() => { void regenerate(); }} disabled={busy !== null}><Sparkles />{busy === "regenerate" ? "Starting…" : "Regenerate"}</button>}
      {report.isOwner && <button type="button" className="secondary-button" onClick={() => setSettingsOpen(true)} disabled={busy !== null}><Settings2 />Doc settings</button>}
      {doc?.doc?.serverName && <span className="report-doc-source">{docSourceLine(doc)}</span>}
    </div>}
    {docActions && inHeader && busy === "check" && <p className="report-doc-source" role="status"><RefreshCw className="spin" aria-hidden="true" />Checking the doc…</p>}
    {docActions && inHeader && busy !== "check" && doc?.doc?.serverName && <p className="report-doc-source">{docSourceLine(doc)}</p>}
    {blocks > 0 ? <ReportView report={report} canWrite={canWrite} generating={running || busy === "regenerate"} />
      : !running && <div className="report-empty"><p>{hasDoc ? "No charts or tables yet. Regenerate from the doc, ask for a chart, or explore the data with the console below." : "No charts or tables yet. Generate them from a doc, ask for a chart, or explore the data with the console below."}</p></div>}
    {settingsOpen && <DocSettingsSheet reportId={report.id} onClose={() => setSettingsOpen(false)} reopen={() => setSettingsOpen(true)} onSaved={setDoc} />}
    {confirm.confirmElement}
  </div>;
}

