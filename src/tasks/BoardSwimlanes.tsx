import { useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { ChevronDown, ChevronRight, ChevronsLeftRight, ChevronsRightLeft, Ellipsis } from "lucide-react";
import { buildSwimlanes, NONE_ROW, type Swimlane, type SwimlaneMode } from "../../shared/swimlanes";
import { CARD_DRAG_TYPE, columnCards, isCardDrag, isMoveKey, readCardDragPayload, type MoveKey } from "./boardOrder";
import { CardFace, cardFaceLabel } from "./CardFace";
import { ColumnStatusIcon, type ColumnStatus } from "./ColumnStatusIcon";
import { cardCountLabel, columnBadge } from "./taskActions";
import type { BoardColumn, BoardTag, CardSummary } from "./tasksApi";

type BoardSwimlanesProps = {
  mode: SwimlaneMode;
  /** The board's columns, left to right. */
  columns: BoardColumn[];
  statuses: ReadonlyMap<string, ColumnStatus>;
  /** The cards on screen (filters, sprint, and levels applied). */
  cards: CardSummary[];
  /** Every loaded card: parents for row names, and the columns' real counts for WIP. */
  allCards: CardSummary[];
  tags: BoardTag[];
  today: string;
  /** "No epic" for parent rows (the level above's name). */
  noneLabel: string;
  collapsedColumns: ReadonlySet<string>;
  onToggleColumn: (columnId: string) => void;
  collapsedRows: ReadonlySet<string>;
  onToggleRow: (row: Swimlane) => void;
  readOnly: boolean;
  phone: boolean;
  /** The phone pager's track (the board's own, so Back and Forward keep the column). */
  trackRef: RefObject<HTMLDivElement | null>;
  onTrackScroll: () => void;
  /** Whether a card may come into a column (its WIP limit, D108). */
  canEnter: (cardId: string, columnId: string) => boolean;
  /** A drop in row `row` and column `columnId` at `index` among the cell's other cards (D656). */
  onDrop: (cardId: string, fromRow: string, row: Swimlane, columnId: string, cellCardIds: string[], index: number) => void;
  onKeyMove: (card: CardSummary, key: MoveKey) => void;
  onOpenCard: (card: CardSummary) => void;
  onCardMenu: (card: CardSummary, trigger: HTMLElement) => void;
};

/** Which slot a pointer at `clientY` points to among a cell's cards (the dragged one excluded). */
function dropIndexFor(list: HTMLElement, clientY: number, draggingId: string | null) {
  const items = Array.from(list.querySelectorAll<HTMLElement>("[data-card-id]")).filter((element) => element.dataset.cardId !== draggingId);
  const index = items.findIndex((element) => {
    const box = element.getBoundingClientRect();
    return clientY < box.top + box.height / 2;
  });
  return index < 0 ? items.length : index;
}

/**
 * The board split into swimlanes (lane VIEWS2, D655, D656): one row per person (a card with two
 * people is in both rows) or per parent, then "No assignee" / "No <parent>", across the board's
 * columns. A card dragged into another row changes that field (the row's person replaces the source
 * row's; a parent row sets the parent), and into another column moves it, both at once. Rows and
 * columns collapse per person. On phones the board's column pager stays, with the rows inside each
 * page, and drag is off (the card's own fields change the row).
 */
export function BoardSwimlanes(props: BoardSwimlanesProps) {
  const { mode, columns, cards, allCards, tags, today, collapsedColumns, collapsedRows, readOnly, phone } = props;
  const parents = new Map(allCards.map((card) => [card.id, { id: card.id, title: card.title, column_id: card.column_id, position: card.position }]));
  const rows = buildSwimlanes(mode, cards, { columnOrder: columns.map((column) => column.id), parents, noneLabel: props.noneLabel });
  const byId = new Map(cards.map((card) => [card.id, card]));
  const [dragging, setDragging] = useState<{ cardId: string; fromRow: string } | null>(null);
  const [target, setTarget] = useState<{ row: string; columnId: string; index: number } | null>(null);
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;

  const cellCards = (row: Swimlane, columnId: string) => columnCards(row.cardIds.map((id) => byId.get(id)!).filter(Boolean), columnId);

  function dragOver(event: ReactDragEvent<HTMLElement>, row: Swimlane, columnId: string, list: HTMLElement | null) {
    const current = draggingRef.current;
    if (readOnly || !current || !isCardDrag(event.dataTransfer.types)) return;
    if (!props.canEnter(current.cardId, columnId)) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const index = list ? dropIndexFor(list, event.clientY, current.cardId) : 0;
    if (target?.row !== row.key || target.columnId !== columnId || target.index !== index) setTarget({ row: row.key, columnId, index });
  }

  function drop(event: ReactDragEvent<HTMLElement>, row: Swimlane, columnId: string, list: HTMLElement | null) {
    const current = draggingRef.current;
    const cardId = readCardDragPayload(event.dataTransfer.getData(CARD_DRAG_TYPE)) ?? current?.cardId;
    setDragging(null);
    setTarget(null);
    if (readOnly || !cardId || !byId.has(cardId) || !props.canEnter(cardId, columnId)) return;
    event.preventDefault();
    const fromRow = current?.cardId === cardId ? current.fromRow : row.key;
    const others = cellCards(row, columnId).filter((card) => card.id !== cardId).map((card) => card.id);
    props.onDrop(cardId, fromRow, row, columnId, others, list ? dropIndexFor(list, event.clientY, cardId) : 0);
  }

  function cardKeyDown(event: ReactKeyboardEvent<HTMLElement>, card: CardSummary) {
    if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); props.onOpenCard(card); return; }
    if (readOnly || !event.altKey || event.ctrlKey || event.metaKey || !isMoveKey(event.key)) return;
    event.preventDefault();
    props.onKeyMove(card, event.key);
  }

  const cardItem = (card: CardSummary, row: Swimlane, columnId: string, slot: number, indicator: boolean) => {
    const column = columns.find((item) => item.id === columnId);
    const face = { card, tags, done: column?.is_done === 1, today };
    const excerptId = `task-swim-excerpt-${row.key.replace(/[^a-z0-9]/gi, "")}-${card.id}`;
    return <li key={card.id} className="task-card-item">
      {indicator && target?.index === slot && <span className="task-drop-indicator" aria-hidden="true" />}
      <div className={`task-card${dragging?.cardId === card.id && dragging.fromRow === row.key ? " dragging" : ""}${card.archived_at ? " archived" : ""}`} tabIndex={0} data-card-id={card.id}
        draggable={!readOnly && !phone} role="group" aria-label={cardFaceLabel(face)} aria-roledescription={readOnly || phone ? "Card" : "Draggable card"}
        aria-keyshortcuts={readOnly ? undefined : "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"}
        aria-describedby={card.description_excerpt?.trim() ? excerptId : undefined}
        onDragStart={(event) => {
          if (readOnly || phone) { event.preventDefault(); return; }
          event.dataTransfer.setData(CARD_DRAG_TYPE, card.id);
          event.dataTransfer.effectAllowed = "move";
          setDragging({ cardId: card.id, fromRow: row.key });
        }}
        onDragEnd={() => { setDragging(null); setTarget(null); }}
        onKeyDown={(event) => cardKeyDown(event, card)}
        onClick={(event) => { if (!(event.target as Element).closest("button")) props.onOpenCard(card); }}>
        <CardFace {...face} excerptId={excerptId} />
        <button className="icon-button task-card-more" onClick={(event) => props.onCardMenu(card, event.currentTarget)} aria-haspopup="dialog" aria-label={`More actions for “${card.title}”`} title="More actions" draggable={false}><Ellipsis /></button>
      </div>
    </li>;
  };

  const rowHeader = (row: Swimlane, count: number) => {
    const folded = collapsedRows.has(row.key);
    return <h3 className="task-swim-row-header">
      <button type="button" aria-expanded={!folded} onClick={() => props.onToggleRow(row)} title={folded ? "Expand row" : "Collapse row"}>
        {folded ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        <span className={row.key === NONE_ROW.assignee || row.key === NONE_ROW.parent ? "task-swim-none" : undefined}>{row.label}</span>
        <b aria-label={cardCountLabel(count)}>{count}</b>
      </button>
    </h3>;
  };

  if (phone) {
    return <div className="task-columns task-swim-pages" ref={props.trackRef} onScroll={props.onTrackScroll}>
      {columns.map((column) => {
        const all = columnCards(allCards, column.id).length;
        const shown = cards.filter((card) => card.column_id === column.id).length;
        const badge = columnBadge(shown, all, column.wip_limit);
        const folded = collapsedColumns.has(column.id);
        const status = props.statuses.get(column.id);
        return <section key={column.id} className="task-column task-swim-page" aria-labelledby={`swim-column-${column.id}`} data-column-id={column.id}>
          <header className="task-column-header">
            {status && <ColumnStatusIcon status={status} />}
            <h2 id={`swim-column-${column.id}`}>{column.name}</h2>
            <b className={badge.wip ? `task-wip ${badge.wip}` : undefined} aria-label={badge.label}>{badge.text}</b>
          </header>
          {folded ? <p className="task-column-hidden task-column-collapsed-note">
            <span>Collapsed{all ? `, ${cardCountLabel(all)} hidden` : ""}</span>
            <button type="button" className="task-column-show-all" onClick={() => props.onToggleColumn(column.id)}>Expand</button>
          </p> : <div className="task-swim-page-rows">
            {rows.map((row) => {
              const items = cellCards(row, column.id);
              if (!items.length) return null;
              return <div key={row.key} className="task-swim-page-row">
                {rowHeader(row, items.length)}
                {!collapsedRows.has(row.key) && <ul className="task-card-list" aria-label={`${row.label} in ${column.name}`}>{items.map((card, slot) => cardItem(card, row, column.id, slot, false))}</ul>}
              </div>;
            })}
            {!cards.some((card) => card.column_id === column.id) && <p className="task-column-empty">{all ? "No matching cards" : "No cards yet"}</p>}
          </div>}
        </section>;
      })}
    </div>;
  }

  return <div className="task-swimlanes" role="region" aria-label={`Swimlanes by ${mode === "assignee" ? "assignee" : "parent"}`}>
    <div className="task-swim-head">
      <span className="task-swim-corner" aria-hidden="true" />
      {columns.map((column) => {
        const folded = collapsedColumns.has(column.id);
        const all = columnCards(allCards, column.id).length;
        const shown = cards.filter((card) => card.column_id === column.id).length;
        const badge = columnBadge(shown, all, column.wip_limit);
        const status = props.statuses.get(column.id);
        if (folded) {
          return <div key={column.id} className="task-swim-colhead collapsed" data-column-id={column.id}>
            <button type="button" className="icon-button task-column-collapse" aria-expanded="false" onClick={() => props.onToggleColumn(column.id)}
              aria-label={`Expand ${column.name}, ${badge.label}`} title={`Expand ${column.name}`}><ChevronsLeftRight /></button>
          </div>;
        }
        return <div key={column.id} className="task-swim-colhead" data-column-id={column.id}>
          {status && <ColumnStatusIcon status={status} />}
          <h2 title={column.name}>{column.name}</h2>
          <b className={badge.wip ? `task-wip ${badge.wip}` : undefined} aria-label={badge.label}>{badge.text}</b>
          <button type="button" className="icon-button task-column-collapse" aria-expanded="true" onClick={() => props.onToggleColumn(column.id)}
            aria-label={`Collapse ${column.name}`} title="Collapse column"><ChevronsRightLeft /></button>
        </div>;
      })}
    </div>
    {rows.map((row) => {
      const folded = collapsedRows.has(row.key);
      const count = row.cardIds.length;
      return <section key={row.key} className={`task-swim-row${folded ? " collapsed" : ""}`} aria-label={`${row.label}, ${cardCountLabel(count)}`} data-row-key={row.key}>
        {rowHeader(row, count)}
        {!folded && <div className="task-swim-cells">
          <span className="task-swim-corner" aria-hidden="true" />
          {columns.map((column) => {
            const items = cellCards(row, column.id);
            const foldedColumn = collapsedColumns.has(column.id);
            const active = target?.row === row.key && target.columnId === column.id;
            const refused = dragging !== null && !props.canEnter(dragging.cardId, column.id);
            let list: HTMLUListElement | null = null;
            const others = items.filter((card) => card.id !== dragging?.cardId);
            return <div key={column.id} className={`task-swim-cell${foldedColumn ? " collapsed" : ""}${active ? " drop-active" : ""}${refused ? " drop-refused" : ""}`}
              data-column-id={column.id} data-row-key={row.key}
              onDragOver={(event) => dragOver(event, row, column.id, foldedColumn ? null : list)} onDragEnter={(event) => dragOver(event, row, column.id, foldedColumn ? null : list)}
              onDrop={(event) => drop(event, row, column.id, foldedColumn ? null : list)}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && active) setTarget(null); }}>
              {foldedColumn
                ? <span className="task-swim-cell-count" title={`${column.name}: ${cardCountLabel(items.length)}`}>{items.length || ""}</span>
                : <ul ref={(element) => { list = element; }} className="task-card-list" aria-label={`${row.label} in ${column.name}`}>
                  {items.map((card) => cardItem(card, row, column.id, others.indexOf(card), active))}
                  {active && target!.index >= others.length && <li className="task-drop-indicator" aria-hidden="true" />}
                </ul>}
            </div>;
          })}
        </div>}
      </section>;
    })}
  </div>;
}
