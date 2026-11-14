import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Handshake, KanbanSquare, Loader2, Rows3, Trophy, UserRound, XCircle } from "lucide-react";
import { KanbanBoard, type KanbanColumn, type KanbanMove } from "../ui/kanban/KanbanBoard";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Select";
import { notify } from "../ui/notify";
import type { CrmBoard, CrmBook, CrmDeal, CrmPipeline } from "../../shared/crm";
import { errorMessage, listDeals, listPipelines, pipelineBoard, updateDeal } from "./crmApi";
import { LostReasonSheet } from "./Sheets";
import { isPast, money, shortDate } from "./format";
import { Avatar } from "../ui/Avatar";

/**
 * Deals (§D.5 "Deal board", C16): the shared KanbanBoard with one column per stage (count, total,
 * weighted total in the header), pointer drag and Alt+arrows between stages, a reason asked when a
 * deal is dropped on a lost stage; cards show value, company, contacts, owner, the next step date
 * (red when past), and a rotting dot. A table view lists the same deals; phones show one stage at a
 * time under the stage strip.
 */
export function DealsView({ book, q, pipelineId, layout, canWrite, onPipeline, onLayout, onOpen, onNew, refreshKey }: {
  book: CrmBook; q: string; pipelineId: string | null; layout: "board" | "table"; canWrite: boolean;
  onPipeline: (id: string) => void; onLayout: (layout: "board" | "table") => void; onOpen: (href: string) => void; onNew: (stageId?: string) => void; refreshKey: number;
}) {
  const [pipelines, setPipelines] = useState<CrmPipeline[] | null>(null);
  const [board, setBoard] = useState<CrmBoard | null>(null);
  const [table, setTable] = useState<CrmDeal[] | null>(null);
  const [mine, setMine] = useState(false);
  const [status, setStatus] = useState<"" | "open" | "won" | "lost">("");
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState<{ deal: CrmDeal; move: KanbanMove } | null>(null);

  useEffect(() => { setPipelines(null); listPipelines(book.id).then(({ pipelines: list }) => setPipelines(list), (reason) => setError(errorMessage(reason, "Could not load pipelines"))); }, [book.id, refreshKey]);
  const pipeline = pipelines?.find((item) => item.id === pipelineId) ?? pipelines?.[0] ?? null;

  const load = useCallback(async () => {
    if (!pipeline) return;
    try {
      if (layout === "board") setBoard((await pipelineBoard(pipeline.id, { owner: mine ? "me" : null, q })).board);
      else setTable((await listDeals({ book: book.id, pipeline: pipeline.id, owner: mine ? "me" : null, status: status || null, q, limit: 200, sort: { field: "updated", dir: "desc" } })).items);
      setError(null);
    } catch (reason) { setError(errorMessage(reason, "Could not load deals")); }
  }, [book.id, layout, mine, pipeline, q, status]);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, q ? 200 : 0); return () => window.clearTimeout(timer); }, [load, q, refreshKey]);

  const currency = board?.currency ?? pipeline?.currency ?? book.settings.currency ?? "USD";
  const columns: KanbanColumn[] = useMemo(() => (board?.columns ?? []).map((column) => ({
    id: column.stage.id, title: column.stage.name, count: column.count,
    total: <span title={`Weighted at ${column.stage.probability}%: ${money(column.weighted, currency)}`}>{money(column.sum, currency, true)}{column.stage.kind === "open" && <small className="crm-weighted"> · {money(column.weighted, currency, true)} wtd</small>}</span>,
    marker: column.stage.kind === "won" ? <Trophy className="crm-stage-icon won" aria-label="Won stage" /> : column.stage.kind === "lost" ? <XCircle className="crm-stage-icon lost" aria-label="Lost stage" /> : <span className="crm-stage-prob" aria-label={`${column.stage.probability}% probability`}>{column.stage.probability}%</span>
  })), [board, currency]);
  const items = useMemo(() => (board?.columns ?? []).flatMap((column) => column.deals.map((deal) => ({ ...deal, columnId: column.stage.id }))), [board]);

  const applyMove = async (move: KanbanMove, lostReason?: string) => {
    if (!board) return;
    // Optimistic: move the card in place, then reload the totals from the server.
    const deal = items.find((item) => item.id === move.itemId);
    if (!deal) return;
    // The board may be filtered (Mine, search): name the visible neighbours of the drop, not an index
    // among the cards shown, so the server places it among all the stage's deals (D1167).
    const visible = (board.columns.find((column) => column.stage.id === move.toColumnId)?.deals ?? []).filter((item) => item.id !== move.itemId);
    const afterId = visible[move.toIndex - 1]?.id ?? null;
    const beforeId = visible[move.toIndex]?.id ?? null;
    setBoard({ ...board, columns: board.columns.map((column) => {
      const rest = column.deals.filter((item) => item.id !== move.itemId);
      if (column.stage.id !== move.toColumnId) return { ...column, deals: rest };
      const moved = { ...deal, stageId: move.toColumnId, stageName: column.stage.name };
      return { ...column, deals: [...rest.slice(0, move.toIndex), moved, ...rest.slice(move.toIndex)] };
    }) });
    try {
      await updateDeal(move.itemId, { stageId: move.toColumnId, afterId, beforeId, ...(lostReason !== undefined ? { lostReason: lostReason || null } : {}) });
      const stage = board.columns.find((column) => column.stage.id === move.toColumnId)?.stage;
      if (stage && stage.kind !== "open" && deal.stageId !== stage.id) notify.success(`“${deal.title}” ${stage.kind === "won" ? "won" : "marked lost"}`);
    } catch (reason) { notify.error(errorMessage(reason, "Could not move the deal")); }
    void load();
  };
  const onMove = (move: KanbanMove) => {
    const stage = board?.columns.find((column) => column.stage.id === move.toColumnId)?.stage;
    const deal = items.find((item) => item.id === move.itemId);
    if (stage?.kind === "lost" && deal && deal.stageId !== stage.id) { setLost({ deal, move }); return; }
    void applyMove(move);
  };

  if (pipelines && !pipelines.length) return <EmptyState icon={Handshake} title="No pipelines in this book" action={canWrite ? { label: "New deal", onClick: () => onNew() } : undefined}>Add a pipeline in Settings, or add a deal to start one.</EmptyState>;

  return <div className="crm-deals">
    <div className="crm-toolbar" role="toolbar" aria-label="Deals view">
      {pipelines && pipelines.length > 1 && <Select variant="chip" label="Pipeline" value={pipeline?.id ?? null} options={pipelines.map((item) => ({ value: item.id, label: item.name }))} onChange={onPipeline} />}
      <div className="ui-segmented" role="group" aria-label="Layout">
        <button type="button" aria-pressed={layout === "board"} onClick={() => onLayout("board")}><KanbanSquare aria-hidden="true" className="crm-seg-icon" />Board</button>
        <button type="button" aria-pressed={layout === "table"} onClick={() => onLayout("table")}><Rows3 aria-hidden="true" className="crm-seg-icon" />Table</button>
      </div>
      <button type="button" className="ui-filter-chip" aria-pressed={mine} onClick={() => setMine((value) => !value)}><UserRound aria-hidden="true" />Mine</button>
      {layout === "table" && <Select variant="chip" label="Status" value={status} options={[{ value: "", label: "Any status" }, { value: "open", label: "Open" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }]} onChange={setStatus} />}
      {board && layout === "board" && <span className="crm-board-totals" aria-label="Open pipeline">
        <span><small>Open</small> <strong className="ui-tabular">{money(board.totals.sum, currency)}</strong></span>
        <span><small>Weighted</small> <strong className="ui-tabular">{money(board.totals.weighted, currency)}</strong></span>
      </span>}
    </div>
    {error && <p className="ui-field-error" role="alert">{error}</p>}
    {layout === "board" ? (!board ? <p className="ui-panel-loading" role="status"><Loader2 className="spin" aria-hidden="true" /> Loading the board…</p>
      : items.length === 0 && !q && !mine ? <EmptyState icon={Handshake} title="No deals in this pipeline" action={canWrite ? { label: "New deal", onClick: () => onNew() } : undefined}>Add a deal, then drag it from stage to stage as it moves.</EmptyState>
      : <KanbanBoard label={`${pipeline?.name ?? "Deals"} by stage`} columns={columns} items={items} canMove={canWrite} onMove={onMove} onOpen={(deal) => onOpen(deal.href)} emptyColumn="No deals"
        itemLabel={(deal) => [deal.title, deal.value ? money(deal.value.amount, deal.value.currency) : null, deal.nextStepOn ? `next step ${shortDate(deal.nextStepOn)}` : null, deal.rotting ? "no recent activity" : null].filter(Boolean).join(", ")}
        renderCard={(deal) => <DealCard deal={deal} />} />)
      : !table ? <p className="ui-panel-loading" role="status"><Loader2 className="spin" aria-hidden="true" /> Loading deals…</p>
      : table.length === 0 ? <EmptyState icon={Handshake} title="No deals match" action={canWrite ? { label: "New deal", onClick: () => onNew() } : undefined}>Change the filters or add a deal.</EmptyState>
      : <div className="crm-table-wrap"><table className="crm-table">
        <thead><tr><th scope="col">Deal</th><th scope="col">Stage</th><th scope="col" className="number">Value</th><th scope="col">Company</th><th scope="col">Owner</th><th scope="col">Expected close</th><th scope="col">Next step</th></tr></thead>
        <tbody>{table.map((deal) => <tr key={deal.id}>
          <th scope="row"><a href={deal.href} className="crm-name" onClick={(event) => { event.preventDefault(); onOpen(deal.href); }}>{deal.rotting && <span className="crm-rot" title="No activity for a while" aria-label="Rotting" />}<span>{deal.title}</span></a></th>
          <td><span className="ui-tone crm-stage-chip" data-tone={deal.status === "won" ? "success" : deal.status === "lost" ? "danger" : "info"}>{deal.stageName}</span></td>
          <td className="number ui-tabular">{deal.value ? money(deal.value.amount, deal.value.currency) : "—"}</td>
          <td>{deal.companyName ?? "—"}</td><td>{deal.owner?.name ?? "—"}</td><td>{shortDate(deal.expectedCloseOn)}</td>
          <td className={isPast(deal.nextStepOn) && deal.status === "open" ? "crm-overdue" : undefined}>{deal.nextStep ?? (deal.nextStepOn ? "" : "—")}{deal.nextStepOn ? ` · ${shortDate(deal.nextStepOn)}` : ""}</td>
        </tr>)}</tbody>
      </table></div>}
    {lost && <LostReasonSheet title={lost.deal.title} onClose={() => setLost(null)} onSave={(reason) => { const move = lost.move; setLost(null); void applyMove(move, reason); }} />}
  </div>;
}

export function DealCard({ deal }: { deal: CrmDeal }) {
  const overdue = deal.status === "open" && isPast(deal.nextStepOn);
  return <div className="crm-deal-card">
    <div className="crm-deal-title">{deal.rotting && <span className="crm-rot" title="No activity for this stage's rotting days" aria-hidden="true" />}<strong>{deal.title}</strong></div>
    <div className="crm-deal-meta">
      <span className="crm-deal-value ui-tabular">{deal.value ? money(deal.value.amount, deal.value.currency) : "No value"}</span>
      {deal.companyName && <span className="crm-deal-company">{deal.companyName}</span>}
    </div>
    {(deal.contacts.length > 0 || deal.nextStepOn || deal.owner) && <div className="crm-deal-foot">
      {deal.contacts[0] && <span className="crm-deal-contact">{deal.contacts[0].name}{deal.contacts.length > 1 ? ` +${deal.contacts.length - 1}` : ""}</span>}
      {deal.nextStepOn && <span className={`crm-deal-next${overdue ? " overdue" : ""}`} title={deal.nextStep ?? "Next step"}><CalendarClock aria-hidden="true" />{shortDate(deal.nextStepOn)}</span>}
      {deal.owner && <span className="crm-deal-owner" title={`Owner: ${deal.owner.name}`} aria-label={`Owner ${deal.owner.name}`}><Avatar className="crm-avatar small" name={deal.owner.name} url={null} /></span>}
    </div>}
  </div>;
}
