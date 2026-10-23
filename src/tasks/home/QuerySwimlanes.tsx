import { useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronsLeftRight, ChevronsRightLeft, Ellipsis, Plus } from "lucide-react";
import type { QueryLane } from "../../../shared/taskLanes";
import { buildSwimlanes, NONE_ROW, swimlaneChange, type Swimlane } from "../../../shared/swimlanes";
import { CARD_DRAG_TYPE, isCardDrag, readCardDragPayload } from "../boardOrder";
import { KeyboardMoveHint } from "../boardViewParts";
import { CardFace, cardFaceLabel } from "../CardFace";
import { cardCountLabel } from "../taskActions";
import { useRole } from "../../team/roleAccess";
import { canChangeCard, type QueriedCard, type QueryLanes as QueryLaneLayout } from "./homeApi";
import { cardsByLane, faceOf, isDropAllowed, laneDrop, lanesAcceptDrops, laneStatuses } from "./laneModel";
import type { RowChange } from "./HomeResultsPane";

export type QuerySwimMode = "assignee" | "board";

type QuerySwimlanesProps = {
  mode: QuerySwimMode;
  cards: QueriedCard[];
  layout: QueryLaneLayout;
  today: string;
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (key: string) => void;
  collapsedRows: ReadonlySet<string>;
  onToggleRow: (row: Swimlane) => void;
  onOpenCard: (card: QueriedCard) => void;
  onMoveCard: (card: QueriedCard, trigger: HTMLElement, fromKey: string) => void;
  onDropCard: (card: QueriedCard, lane: QueryLane | null, fromKey: string, row?: RowChange) => void;
  onRefused: (message: string) => void;
  onAddCard?: (lane: QueryLane, trigger: HTMLElement) => void;
  canAddCard?: (lane: QueryLane) => boolean;
  /** The lane's mark (status icon, person, tag colour…), as QueryLanes draws it. */
  mark: (lane: QueryLane, index: number) => ReactNode;
};

type Verdict = { ok: true; lane: QueryLane | null; row?: RowChange } | { ok: false; message: string | null };

/**
 * Swimlanes in a cross-board view (lane VIEWS2, D665): the lanes (merged columns, states, or a
 * field) split into rows by person or by board. Rows come from the loaded cards (a card with two
 * people is in both rows). A drop in another lane changes the lane's column or field as a lane drop
 * does; in another person's row it swaps the source row's person for the target's (No assignee
 * clears them), both at once. Board rows only show: a card stays on its board. Rows and lanes fold
 * away. `Alt` + ← / → moves to the next lane in the row, `Alt` + ↑ / ↓ to the next row in the lane.
 * Phones use QueryLanes' pager with the rows inside each page.
 */
export function QuerySwimlanes(props: QuerySwimlanesProps) {
  const { mode, cards, layout, today, collapsed, collapsedRows } = props;
  const { readOnly: roleReadOnly } = useRole();
  const lanes = layout.columns;
  const byLane = cardsByLane(layout, cards, today);
  const rows = buildSwimlanes(mode, cards);
  const statuses = laneStatuses(lanes);
  const droppable = lanesAcceptDrops(layout) || mode === "assignee";
  const [dragging, setDragging] = useState<{ card: QueriedCard; fromKey: string; fromRow: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const canMove = (card: QueriedCard) => canChangeCard(card, roleReadOnly);
  const cellOf = (lane: QueryLane, row: Swimlane) => (byLane.get(lane.key) ?? []).filter((card) => row.cardIds.includes(card.id));

  /** What a drop from (fromKey, fromRow) into (lane, row) does, or why it cannot. */
  function verdict(card: QueriedCard, fromKey: string, fromRow: string, lane: QueryLane, row: Swimlane): Verdict {
    const rowChange = swimlaneChange(mode, fromRow, row, card);
    if (rowChange && "refused" in rowChange) return { ok: false, message: "A card stays on its board" };
    const laneChanged = lane.key !== fromKey;
    if (!laneChanged && !rowChange) return { ok: false, message: null };
    if (!canMove(card)) return { ok: false, message: `You can't change cards on ${card.board_name}` };
    const people = rowChange && "assigneeIds" in rowChange
      ? { assigneeIds: rowChange.assigneeIds, message: row.key === NONE_ROW.assignee ? "Took everyone off the card" : `Assigned to ${row.label}` } : undefined;
    if (!laneChanged) return { ok: true, lane: null, ...(people ? { row: people } : {}) };
    const drop = laneDrop(layout, lane, card, true, fromKey);
    if (!isDropAllowed(drop)) return drop.refusal === "SAME_LANE" && people ? { ok: true, lane: null, row: people } : { ok: false, message: drop.refusal === "SAME_LANE" ? null : drop.message };
    return { ok: true, lane, ...(people ? { row: people } : {}) };
  }

  function dragOver(event: ReactDragEvent<HTMLElement>, lane: QueryLane, row: Swimlane) {
    if (!dragging || !isCardDrag(event.dataTransfer.types)) return;
    const result = verdict(dragging.card, dragging.fromKey, dragging.fromRow, lane, row);
    if (!result.ok) { event.dataTransfer.dropEffect = "none"; return; }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const key = `${row.key}|${lane.key}`;
    if (over !== key) setOver(key);
  }

  function drop(event: ReactDragEvent<HTMLElement>, lane: QueryLane, row: Swimlane) {
    const id = readCardDragPayload(event.dataTransfer.getData(CARD_DRAG_TYPE)) ?? dragging?.card.id;
    const current = dragging;
    setDragging(null);
    setOver(null);
    if (!current || current.card.id !== id) return;
    const result = verdict(current.card, current.fromKey, current.fromRow, lane, row);
    if (!result.ok) return;
    event.preventDefault();
    props.onDropCard(current.card, result.lane, current.fromKey, result.row);
  }

  function keyMove(event: ReactKeyboardEvent<HTMLElement>, card: QueriedCard, laneIndex: number, rowIndex: number) {
    if (!event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const from = lanes[laneIndex]!;
    const fromRow = rows[rowIndex]!;
    // The next lane (in this row) or row (in this lane) that takes the card.
    for (let index = (horizontal ? laneIndex : rowIndex) + step; horizontal ? index >= 0 && index < lanes.length : index >= 0 && index < rows.length; index += step) {
      const lane = horizontal ? lanes[index]! : from;
      const row = horizontal ? fromRow : rows[index]!;
      const result = verdict(card, from.key, fromRow.key, lane, row);
      if (result.ok) {
        props.onDropCard(card, result.lane, from.key, result.row);
        window.setTimeout(() => document.querySelector<HTMLElement>(`[data-row-key="${row.key}"] [data-lane-key="${CSS.escape(lane.key)}"] [data-card-id="${card.id}"]`)?.focus(), 400);
        return;
      }
    }
    props.onRefused(horizontal ? "No lane that way takes this card" : mode === "board" ? "A card stays on its board" : "No row that way");
  }

  const cardItem = (card: QueriedCard, lane: QueryLane, laneIndex: number, row: Swimlane, rowIndex: number) => {
    const face = faceOf(card);
    const movable = droppable && canMove(card);
    const label = cardFaceLabel({ card: face.card, tags: face.tags, done: card.is_done === 1, today });
    const showColumn = layout.lanes !== "columns";
    return <li key={card.id} className="task-card-item">
      <div className={`task-card${dragging?.card.id === card.id && dragging.fromKey === lane.key && dragging.fromRow === row.key ? " dragging" : ""}${card.archived_at ? " archived" : ""}`} tabIndex={0}
        data-card-id={card.id} draggable={movable} role="group" aria-label={`${label}, on ${card.board_name}${showColumn ? `, ${card.column_name}` : ""}`}
        aria-roledescription={movable ? "Draggable card" : "Card"} aria-keyshortcuts={movable ? "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown" : undefined}
        aria-describedby={movable ? "task-swim-keys" : undefined}
        onDragStart={(event) => {
          if (!movable) { event.preventDefault(); return; }
          event.dataTransfer.setData(CARD_DRAG_TYPE, card.id);
          event.dataTransfer.effectAllowed = "move";
          setDragging({ card, fromKey: lane.key, fromRow: row.key });
        }}
        onDragEnd={() => { setDragging(null); setOver(null); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); props.onOpenCard(card); return; }
          if (movable) keyMove(event, card, laneIndex, rowIndex);
        }}
        onClick={(event) => { if (!(event.target as Element).closest("button")) props.onOpenCard(card); }}>
        <span className="task-lane-board" aria-hidden="true">{card.board_name}{showColumn ? ` › ${card.column_name}` : ""}</span>
        <CardFace card={face.card} tags={face.tags} done={card.is_done === 1} today={today} excerptId={`task-swim-excerpt-${rowIndex}-${laneIndex}-${card.id}`} />
        {canMove(card) && <button className="icon-button task-card-more" onClick={(event) => props.onMoveCard(card, event.currentTarget, lane.key)} aria-haspopup="dialog"
          aria-label={`Move “${card.title}”`} title="Move to…" draggable={false}><Ellipsis /></button>}
      </div>
    </li>;
  };

  return <div className="task-query-lanes task-query-swim">
    {droppable && <KeyboardMoveHint id="task-swim-keys">Press Alt with an arrow key to move a card to the next lane or row that takes it.</KeyboardMoveHint>}
    {layout.lanesFallback && <p className="task-lanes-notice" role="status">These results have more than 20 different lanes, so the lanes show states.</p>}
    <div className="task-swimlanes" role="region" aria-label={`Swimlanes by ${mode}`}>
      <div className="task-swim-head">
        {lanes.map((lane, index) => {
          const count = layout.laneCounts[lane.key] ?? 0;
          if (collapsed.has(lane.key)) {
            return <div key={lane.key} className="task-swim-colhead collapsed" data-lane-key={lane.key}>
              <button type="button" className="icon-button task-column-collapse" aria-expanded="false" onClick={() => props.onToggleCollapsed(lane.key)}
                aria-label={`Expand ${lane.label}, ${cardCountLabel(count)}`} title={`Expand ${lane.label}`}><ChevronsLeftRight /></button>
            </div>;
          }
          const addable = props.onAddCard && props.canAddCard?.(lane);
          return <div key={lane.key} className="task-swim-colhead" data-lane-key={lane.key}>
            {props.mark(lane, index)}
            <h2 title={lane.label}>{lane.label}</h2>
            <b aria-label={cardCountLabel(count)}>{count}</b>
            {addable && <button type="button" className="icon-button" onClick={(event) => props.onAddCard!(lane, event.currentTarget)} aria-haspopup="dialog"
              aria-label={`Add a card to ${lane.label}`} title="Add a card"><Plus /></button>}
            <button type="button" className="icon-button task-column-collapse" aria-expanded="true" onClick={() => props.onToggleCollapsed(lane.key)}
              aria-label={`Collapse ${lane.label}`} title="Collapse lane"><ChevronsRightLeft /></button>
          </div>;
        })}
      </div>
      {rows.map((row, rowIndex) => {
        const folded = collapsedRows.has(row.key);
        const count = row.cardIds.length;
        return <section key={row.key} className={`task-swim-row${folded ? " collapsed" : ""}`} aria-label={`${row.label}, ${count} loaded`} data-row-key={row.key}>
          <h3 className="task-swim-row-header">
            <button type="button" aria-expanded={!folded} onClick={() => props.onToggleRow(row)} title={folded ? "Expand row" : "Collapse row"}>
              {folded ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              <span className={row.key === NONE_ROW.assignee ? "task-swim-none" : undefined}>{row.label}</span>
              <b aria-label={`${count} loaded`}>{count}</b>
            </button>
          </h3>
          {!folded && <div className="task-swim-cells">
            {lanes.map((lane, laneIndex) => {
              const items = cellOf(lane, row);
              const foldedLane = collapsed.has(lane.key);
              const key = `${row.key}|${lane.key}`;
              const result = dragging ? verdict(dragging.card, dragging.fromKey, dragging.fromRow, lane, row) : null;
              const refused = result && !result.ok && result.message ? result.message : null;
              return <div key={lane.key} className={`task-swim-cell${foldedLane ? " collapsed" : ""}${over === key ? " drop-active" : ""}${refused ? " drop-refused" : ""}`}
                data-lane-key={lane.key} title={refused ?? undefined}
                onDragOver={(event) => dragOver(event, lane, row)} onDragEnter={(event) => dragOver(event, lane, row)} onDrop={(event) => drop(event, lane, row)}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && over === key) setOver(null); }}>
                {foldedLane
                  ? <span className="task-swim-cell-count" title={`${lane.label}: ${cardCountLabel(items.length)}`}>{items.length || ""}</span>
                  : <ul className="task-card-list" aria-label={`${row.label} in ${lane.label}`}>{items.map((card) => cardItem(card, lane, laneIndex, row, rowIndex))}</ul>}
              </div>;
            })}
          </div>}
        </section>;
      })}
      {!rows.length && <p className="task-column-empty">No cards</p>}
    </div>
  </div>;
}
