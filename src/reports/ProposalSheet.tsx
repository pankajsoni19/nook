import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, CircleCheck, TriangleAlert, X } from "lucide-react";
import { Markdown, type RenderContext } from "../chat/markdown/render";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ReportBlock, ReportDetail } from "../../shared/reports";
import type { BlockChange, ProposalFilterView, ProposalView, ReportInstruction } from "../../shared/reportsEdit";
import type { QueryResultView } from "../../shared/reportsView";
import { DATE_PRESET_LABELS, type DatePreset } from "../../shared/reportParams";
import { applyProposal, getProposal, rejectProposal } from "./reportEditApi";
import { codeOf, messageOf } from "./reportsApi";
import { DataBlockCard, useChartPalette } from "./ReportView";
import { reportCssVariables } from "../../shared/reportTheme";
import type { ResultLookup } from "./KpiTile";
import type { ChartPalette } from "./chartOption";

const countText = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** What the instruction's author (not the owner) sees of a pending proposal (review M1): its status and size only. */
export const proposalWaitingText = (redacted: { blocks: number; queries: number }) =>
  `Ready, waiting for the owner. It changes ${countText(redacted.blocks, "block")} and ${countText(redacted.queries, "query", "queries")}; you see the new version once the owner applies it.`;
const CHANGE_TEXT: Record<BlockChange["change"], string> = { added: "Added", updated: "Changed", removed: "Removed", moved: "Moved" };
const noop = () => undefined;
const markdownContext: RenderContext = { onExternalLink: noop, onNookLink: noop, images: { mode: "public" } };

/** One side of a block's diff, drawn by the viewer's own block card (read-only: its buttons are hidden). */
export function BlockPreview({ block, results, palette, lookup }: { block: ReportBlock; results: ReadonlyMap<string, QueryResultView>; palette: ChartPalette; lookup: ResultLookup }) {
  if (block.type === "markdown") {
    return <article className="report-block report-block-markdown">
      {block.title && <h3 className="report-block-title">{block.title}</h3>}
      <div className="report-markdown"><Markdown text={block.markdown} context={markdownContext} /></div>
    </article>;
  }
  return <DataBlockCard block={block} view={results.get(block.queryKey)} hasQuery={results.has(block.queryKey)} palette={palette} running={null} loaded lookup={lookup} onInspect={noop} onMenu={noop} />;
}

/** A block's name in a one-line context ("After “Top countries”"). */
const blockName = (block: ReportBlock | undefined) => !block ? "the last block" : ("title" in block && block.title) || (block.type === "markdown" ? "the text block" : block.id);

/**
 * D516: a proposed new section shown where it goes: after the chosen block (or at the end), the new
 * section's title and its blocks drawn from the proposal's results, then the section that follows it.
 */
export function NewSectionInPlace({ report, proposal, afterBlockId, results, palette, lookup }: { report: ReportDetail; proposal: ProposalView; afterBlockId: string | null; results: ReadonlyMap<string, QueryResultView>; palette: ChartPalette; lookup: ResultLookup }) {
  const oldSections = new Set((report.spec.sections ?? []).map((section) => section.id));
  const sections = proposal.spec.sections ?? [];
  const added = sections.filter((section) => !oldSections.has(section.id));
  const addedBlocks = proposal.blocks.filter((change) => change.change === "added" && change.after).map((change) => change.after!);
  const anchor = afterBlockId ? report.spec.blocks.find((block) => block.id === afterBlockId) : report.spec.blocks.at(-1);
  const lastAdded = added.length ? sections.findIndex((section) => section.id === added.at(-1)!.id) : -1;
  const next = lastAdded >= 0 ? sections.slice(lastAdded + 1).find((section) => oldSections.has(section.id)) : undefined;
  const loose = addedBlocks.filter((block) => !block.section || !added.some((section) => section.id === block.section));
  return <section className="report-diff-inplace" aria-label="The new section in place">
    <p className="report-diff-context">{afterBlockId && anchor ? <>After “{blockName(anchor)}”</> : <>At the end of the report{anchor ? <>, after “{blockName(anchor)}”</> : null}</>}</p>
    {added.map((section) => <div key={section.id} className="report-diff-new-section">
      <span className="report-diff-label">New section</span>
      <h2 className="report-section-title">{section.title}</h2>
      {section.summary && <p className="report-section-summary">{section.summary}</p>}
      <div className="report-diff-new-blocks">
        {addedBlocks.filter((block) => block.section === section.id).map((block) => <BlockPreview key={block.id} block={block} results={results} palette={palette} lookup={lookup} />)}
      </div>
    </div>)}
    {loose.length > 0 && <div className="report-diff-new-section">
      <span className="report-diff-label">New blocks</span>
      <div className="report-diff-new-blocks">{loose.map((block) => <BlockPreview key={block.id} block={block} results={results} palette={palette} lookup={lookup} />)}</div>
    </div>}
    {next && <p className="report-diff-context">Then “{next.title}”</p>}
  </section>;
}

/** "Filters 1 of 2 blocks" and so on (the bar's own words). */
const blocksText = (reach: ProposalFilterView["reach"]) => reach.blocks === reach.total ? `Filters all ${countText(reach.total, "block")}` : `Filters ${reach.blocks} of ${countText(reach.total, "block")}`;

/** D568–D570: where a new filter starts. */
function startsAt(request: Extract<ProposalFilterView["request"], { kind: "add_filter" }>): string {
  if (request.type === "date_range") return `it starts at ${DATE_PRESET_LABELS[(request.preset ?? "30d") as DatePreset] ?? request.preset}`;
  if (request.type === "text") return "it starts empty (every row)";
  if (request.type === "number_range") return "it starts at Any (every row)";
  return request.exclude ? "it starts at All; readers may also leave values out" : "it starts at All";
}
function otherText(request: ProposalFilterView["request"], value: string): string {
  if (request.kind === "add_filter" && request.type === "date_range") return DATE_PRESET_LABELS[value as DatePreset] ?? value;
  // D671: the check's other run of a number range starts at the column's median.
  if (request.kind === "add_filter" && request.type === "number_range") return `≥ ${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return value || "(blank)";
}
/** D570, D670: why a proposal is reviewed by hand. */
const byHandText = (request: ProposalFilterView["request"]) => request.kind === "remove_filter"
  ? "Without the date range every block it reached shows all its days again. Nook compared nothing: check each changed query in the SQL below before you apply."
  : "The default results change to this window. Nook compared nothing: check each changed query in the SQL below before you apply.";

/**
 * D534, D535: what a filter request's proposal did and what Nook checked: the filter (its column),
 * how many blocks it reaches, each changed query with "Default results unchanged ✓" and the value it
 * also ran with, and the queries left as they are with the reason.
 */
export function FilterFacts({ filter }: { filter: ProposalFilterView }) {
  const request = filter.request;
  return <section className="report-proposal-filter" aria-label="The filter">
    <h3><span className="reports-status">{request.kind === "add_filter" ? "New filter" : "Filter removed"}</span>{request.label}{request.kind === "add_filter" && <code>{request.table}.{request.column}</code>}</h3>
    {request.kind === "add_filter" && <p className="report-proposal-filter-reach">{blocksText(filter.reach)}; {startsAt(request)}.</p>}
    {/* D570: a date range changes the default results, so nothing was compared. */}
    {filter.reviewByHand && <p className="report-proposal-filter-review" role="note"><TriangleAlert aria-hidden="true" />{byHandText(request)}</p>}
    <p className="report-proposal-filter-sub">{request.kind === "add_filter" ? "Queries that take the filter" : "Queries it is taken out of"}</p>
    <ul>{filter.checked.map((item) => <li key={item.key}>
      <code>{item.key}</code>
      {filter.reviewByHand ? <span className="report-proposal-filter-note">{`Runs: ${countText(item.rows, "row")} ${request.kind === "remove_filter" ? "without the filter" : "with the default"}`}</span>
        : <span className="report-proposal-filter-ok"><CircleCheck aria-hidden="true" />Default results unchanged</span>}
      {item.otherValue !== null && <span className="report-proposal-filter-note">{`Ran with ${request.label}${request.kind === "add_filter" && request.type === "number_range" ? " " : " = "}${otherText(request, item.otherValue)}: ${countText(item.otherRows ?? 0, "row")}`}</span>}
    </li>)}</ul>
    {filter.untouched.length > 0 && <>
      <p className="report-proposal-filter-sub">Not filtered</p>
      <ul>{filter.untouched.map((item) => <li key={item.key}><code>{item.key}</code><span className="report-proposal-filter-note">{item.reason}</span></li>)}</ul>
    </>}
  </section>;
}

type Props = {
  report: ReportDetail;
  instructionId: string;
  instruction: ReportInstruction | null;
  canApply: boolean;
  onClose: () => void;
  reopen: () => void;
  onDecided: (applied: boolean) => void;
};

/**
 * A proposal under review (plan wave 48): what the instruction asked, the agent's summary, every
 * changed block before and after (new charts drawn from the proposal's own results, beside the current
 * ones), and the changed SQL. Apply (the owner) makes it a new version; Reject keeps the report as is.
 */
export function ProposalSheet({ report, instructionId, instruction, canApply, onClose, reopen, onDecided }: Props) {
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"apply" | "reject" | null>(null);
  const palette = useChartPalette();
  const cssVars = useMemo(() => reportCssVariables(palette.mode) as React.CSSProperties, [palette.mode]);
  useHistoryDialogGuard(true, onClose, { blocked: busy !== null, reopen, layerKey: `reports.changes-proposal:${instructionId}` });
  useEffect(() => {
    let alive = true;
    getProposal(report.id, instructionId).then(({ proposal: next }) => { if (alive) setProposal(next); }).catch((reason) => { if (alive) setError(messageOf(reason, "Could not load the proposal")); });
    return () => { alive = false; };
  }, [report.id, instructionId]);

  const after = useMemo(() => new Map((proposal?.results ?? []).map((item) => [item.queryKey, item])), [proposal]);
  const before = useMemo(() => new Map((proposal?.currentResults ?? []).map((item) => [item.queryKey, item])), [proposal]);
  // KPI comparisons and sparklines read other queries' results: the proposal's own first, then the current ones.
  const lookupAfter = useCallback<ResultLookup>((key) => after.get(key)?.result ?? before.get(key)?.result ?? null, [after, before]);
  const lookupBefore = useCallback<ResultLookup>((key) => before.get(key)?.result ?? null, [before]);

  async function decide(kind: "apply" | "reject") {
    setBusy(kind);
    try {
      if (kind === "apply") await applyProposal(report.id, instructionId);
      else await rejectProposal(report.id, instructionId);
      notify.success(kind === "apply" ? "Applied: a new version of the report" : "Rejected; the report is unchanged");
      onDecided(kind === "apply");
    } catch (reason) {
      const { code } = codeOf(reason);
      notify.error(code === "REVISION_CONFLICT" ? "The report changed since this was proposed; reject it and ask again." : code === "RUN_IN_PROGRESS" ? "The report is running; apply when it finishes." : messageOf(reason, "Could not save the decision"));
      setBusy(null);
    }
  }

  const mayReject = canApply || Boolean(instruction?.isMine);
  return <ModalDialog title="Review the change" eyebrow={report.title} onClose={onClose} busy={busy !== null} variant="sheet" className="reports-dialog report-edit-sheet report-proposal">
    <div className={`report-edit-sheet-body report-view report-theme-${palette.mode} report-diff`} style={cssVars}>
      {instruction && <blockquote className="report-proposal-ask">{instruction.kind === "add" && <span className="report-proposal-kind">Add a new section · </span>}{instruction.text}</blockquote>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!proposal && !error && <p className="reports-loading" role="status">Loading the proposal…</p>}
      {proposal && <>
        {proposal.redacted && <p className="report-proposal-waiting" role="status">{proposalWaitingText(proposal.redacted)}</p>}
        {proposal.summary && <p className="report-proposal-summary">{proposal.summary}</p>}
        {proposal.outOfDate && <p className="report-proposal-stale" role="note"><TriangleAlert aria-hidden="true" />{proposal.staleReason ?? "The report changed since this was proposed"}. It is rejected when the queue moves on; ask again.</p>}
        {instruction?.kind === "add" && !proposal.redacted && <NewSectionInPlace report={report} proposal={proposal} afterBlockId={instruction.afterBlockId} results={after} palette={palette} lookup={lookupAfter} />}
        {proposal.filter && <FilterFacts filter={proposal.filter} />}
        {/* D535: a filter's blocks draw the same as now at All (checked), so only its facts and SQL show. */}
        {(proposal.filter ? [] : instruction?.kind === "add" ? proposal.blocks.filter((change) => change.change !== "added") : proposal.blocks).map((change) => <section key={change.blockId} className={`report-diff-block report-diff-${change.change}`} aria-label={`${CHANGE_TEXT[change.change]}: ${change.after?.title ?? change.before?.title ?? change.blockId}`}>
          <h3><span className="reports-status">{CHANGE_TEXT[change.change]}</span>{change.after?.title ?? change.before?.title ?? change.blockId}</h3>
          <div className={`report-diff-sides${change.before && change.after && change.change !== "moved" ? " report-diff-two" : ""}`}>
            {change.before && change.change !== "moved" && <div className="report-diff-side"><span className="report-diff-label">Before</span><BlockPreview block={change.before} results={before} palette={palette} lookup={lookupBefore} /></div>}
            {change.after && <div className="report-diff-side"><span className="report-diff-label">{change.change === "added" ? "New" : change.change === "moved" ? "Here now" : "After"}</span>
              {change.textHidden ? <p className="report-diff-hidden">The new text is shown to the report's owner, who reviews it; you see it once it is applied.</p> : <BlockPreview block={change.after} results={after} palette={palette} lookup={lookupAfter} />}</div>}
          </div>
        </section>)}
        {proposal.queries.length > 0 && <section className="report-diff-block" aria-label="Queries">
          <h3>Queries</h3>
          {proposal.queries.map((query) => <div key={query.key} className="report-diff-query">
            <p><span className="reports-status">{query.change === "added" ? "Added" : query.change === "removed" ? "Removed" : "Changed"}</span><code>{query.key}</code></p>
            {query.before && query.change !== "added" && <pre className="report-code report-diff-sql-before"><code>{query.before}</code></pre>}
            {query.after && <pre className="report-code"><code>{query.after}</code></pre>}
          </div>)}
        </section>}
      </>}
    </div>
    <footer className="file-dialog-actions report-edit-sheet-actions">
      {mayReject && <button type="button" className="secondary-button" onClick={() => { void decide("reject"); }} disabled={busy !== null || !proposal}><X />{busy === "reject" ? "Rejecting…" : "Reject"}</button>}
      {canApply && <button type="button" className="primary-button" onClick={() => { void decide("apply"); }} disabled={busy !== null || !proposal || proposal.outOfDate}><Check />{busy === "apply" ? "Applying…" : "Apply"}</button>}
      {!canApply && !mayReject && <button type="button" className="secondary-button" onClick={onClose}>Close</button>}
    </footer>
  </ModalDialog>;
}
