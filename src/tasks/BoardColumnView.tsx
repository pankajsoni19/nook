import { useRef, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeftRight, ChevronsRightLeft, Ellipsis, Plus } from "lucide-react";
import { CARD_DRAG_TYPE, isCardDrag, isMoveKey, type MoveKey } from "./boardOrder";
import { CardFace, cardFaceLabel } from "./CardFace";
import { columnBadge, localDateString } from "./taskActions";
import type { BoardColumn, BoardTag, CardSummary } from "./tasksApi";
import type { ColumnNesting } from "./useBoardHierarchy";

type BoardColumnViewProps = {
  column: BoardColumn;
  cards: CardSummary[];
  /** The board's tags, to name and colour the cards' tag chips. */
  tags?: BoardTag[];
  owner: boolean;
  isFirst: boolean;
  isLast: boolean;
  draggingId: string | null;
  /** Insertion index shown while a card is dragged over this column (cards without the dragged one). */
  dropIndex: number | null;
  /** A card from another column is being dragged and this column is full: the drop is refused (D108). */
  refuseDrop?: boolean;
  onDragStart: (card: CardSummary) => void;
  onDragEnd: () => void;
  onDragOverIndex: (index: number | null) => void;
  onDropAt: (cardId: string | null, index: number) => void;
  onKeyMove: (card: CardSummary, key: MoveKey) => void;
  onCardMenu: (card: CardSummary, trigger: HTMLElement) => void;
  onOpenCard: (card: CardSummary) => void;
  onColumnMenu: (trigger: HTMLElement) => void;
  onMoveColumn: (direction: -1 | 1) => void;
  /** Opens the card composer on this column (§4.3; it replaced the inline quick add, §11 Q4). */
  onAddCard: () => void;
  /** With filters, a sprint, or hidden levels, `cards` are the ones shown and this is the column's real count (for WIP). */
  totalCount?: number;
  /** Cards above the work level that the column hides ("1 epic not shown"), with the switch that shows them. */
  hiddenNote?: { text: string; onShowAll: () => void };
  /** Shown when the column has cards but none are listed (filters, or hierarchy levels that are hidden). */
  emptyText?: string;
  /** Hierarchy (17A): parent and subtask chips, and nesting by drag onto a card one level up (D128). */
  nesting?: ColumnNesting;
  /**
   * Below Can edit on this board, or a read-only Team role (Wave 32, from the board's `level`): no
   * drag, no Alt+Arrow moves, and no Add a card. The ⋯ menu stays (Copy link).
   */
  readOnly?: boolean;
  /**
   * The viewer collapsed this column (D602): on desktop a narrow strip with the name, the count,
   * and Expand, that still takes a dropped card (at its top); on phones the page keeps its header
   * and says the cards are hidden. Collapse and expand are for every reader (their own view).
   */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Phones lay the columns out as pages (one per screen), so a collapsed one stays a page. */
  phone?: boolean;
};

const cardsWord = (count: number) => count === 1 ? "1 card" : `${count} cards`;

/** Which slot a pointer at `clientY` points to among the column's card elements (the dragged one excluded). */
function dropIndexFor(list: HTMLElement, clientY: number, draggingId: string | null) {
  const items = Array.from(list.querySelectorAll<HTMLElement>("[data-card-id]")).filter((element) => element.dataset.cardId !== draggingId);
  const index = items.findIndex((element) => {
    const box = element.getBoundingClientRect();
    return clientY < box.top + box.height / 2;
  });
  return index < 0 ? items.length : index;
}

export function BoardColumnView(props: BoardColumnViewProps) {
  const { column, cards, owner, isFirst, isLast, draggingId, dropIndex, readOnly = false } = props;
  const listRef = useRef<HTMLUListElement>(null);
  const others = cards.filter((card) => card.id !== draggingId);
  const today = localDateString();

  /** The card under the pointer when the dragged card can become its child, else null. */
  function nestTargetOf(event: ReactDragEvent<HTMLElement>) {
    const nesting = props.nesting;
    if (!nesting || !draggingId) return null;
    const target = (event.target as Element | null)?.closest?.("[data-card-id]") as HTMLElement | null;
    const targetId = target?.dataset.cardId;
    return targetId && nesting.canNest(draggingId, targetId) ? targetId : null;
  }

  function dragOver(event: ReactDragEvent<HTMLElement>) {
    if (readOnly) return;
    if (!isCardDrag(event.dataTransfer.types) || !listRef.current) return;
    const nestTarget = nestTargetOf(event);
    props.nesting?.onNestOver(nestTarget);
    if (nestTarget) {
      // Onto a card one level up: it becomes the parent, whatever the column's WIP (nothing moves).
      event.preventDefault();
      event.dataTransfer.dropEffect = "link";
      props.onDragOverIndex(null);
      return;
    }
    if (props.refuseDrop) {
      // Not calling preventDefault leaves the drop disallowed; the hint says why.
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    props.onDragOverIndex(dropIndexFor(listRef.current, event.clientY, draggingId));
  }

  function drop(event: ReactDragEvent<HTMLElement>) {
    if (readOnly) return;
    if (!isCardDrag(event.dataTransfer.types) || !listRef.current) return;
    const nestTarget = nestTargetOf(event);
    if (nestTarget && draggingId) {
      event.preventDefault();
      props.onDragEnd();
      props.nesting!.onNestDrop(draggingId, nestTarget);
      return;
    }
    props.nesting?.onNestOver(null);
    if (props.refuseDrop) return;
    event.preventDefault();
    const index = dropIndexFor(listRef.current, event.clientY, draggingId);
    props.onDropAt(event.dataTransfer.getData(CARD_DRAG_TYPE), index);
  }

  function cardKeyDown(event: ReactKeyboardEvent<HTMLElement>, card: CardSummary) {
    if (readOnly || !event.altKey || event.ctrlKey || event.metaKey || !isMoveKey(event.key)) return;
    event.preventDefault();
    props.onKeyMove(card, event.key);
  }

  const indicator = (index: number) => dropIndex === index ? <li className="task-drop-indicator" aria-hidden="true" /> : null;

  const count = props.totalCount ?? cards.length;
  const badge = columnBadge(cards.length, count, column.wip_limit);
  const collapsed = props.collapsed === true;
  const toggle = props.onToggleCollapsed;

  if (collapsed && !props.phone) {
    // The strip (D602): one button expands it; a card dropped on it goes to the column's top. The
    // name is read once, from the button; the count is the same badge as the open column's.
    return <section className={`task-column collapsed${dropIndex !== null ? " drop-active" : ""}${props.refuseDrop ? " drop-refused" : ""}`} aria-labelledby={`column-${column.id}`} data-column-id={column.id}
      onDragOver={stripDragOver} onDragEnter={stripDragOver} onDrop={stripDrop}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onDragOverIndex(null); }}>
      <button type="button" className="task-column-strip" aria-expanded="false" onClick={toggle}
        aria-label={`Expand ${column.name}, ${badge.label}`} title={`Expand ${column.name}`}>
        <ChevronsLeftRight aria-hidden="true" />
        <b className={badge.wip ? `task-wip ${badge.wip}` : undefined} aria-hidden="true">{badge.text}</b>
        <span id={`column-${column.id}`} className="task-column-strip-name">{column.name}</span>
      </button>
    </section>;
  }

  function stripDragOver(event: ReactDragEvent<HTMLElement>) {
    if (readOnly || !isCardDrag(event.dataTransfer.types)) return;
    if (props.refuseDrop) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    props.onDragOverIndex(0);
  }

  function stripDrop(event: ReactDragEvent<HTMLElement>) {
    if (readOnly || !isCardDrag(event.dataTransfer.types) || props.refuseDrop) return;
    event.preventDefault();
    // The top of the column: the strip shows no cards to aim between (D602).
    props.onDropAt(event.dataTransfer.getData(CARD_DRAG_TYPE), 0);
  }

  const collapseButton = toggle && <button className="icon-button task-column-collapse" onClick={toggle} aria-expanded={!collapsed}
    aria-label={collapsed ? `Expand ${column.name}` : `Collapse ${column.name}`} title={collapsed ? "Expand column" : "Collapse column"}>
    {collapsed ? <ChevronsLeftRight /> : <ChevronsRightLeft />}
  </button>;

  return <section className={`task-column${dropIndex !== null ? " drop-active" : ""}${props.refuseDrop ? " drop-refused" : ""}`} aria-labelledby={`column-${column.id}`} data-column-id={column.id}
    onDragOver={dragOver} onDragEnter={dragOver} onDrop={drop}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onDragOverIndex(null); }}>
    <header className="task-column-header">
      <h2 id={`column-${column.id}`} title={column.name}>{column.name}</h2>
      <b className={badge.wip ? `task-wip ${badge.wip}` : undefined} aria-label={badge.label} title={badge.wip ? `WIP limit ${column.wip_limit}` : undefined}>
        {badge.text}
      </b>
      {(owner || collapseButton) && <span className="task-column-controls">
        {collapseButton}
        {owner && <>
          <button className="icon-button desktop-only" onClick={() => props.onMoveColumn(-1)} disabled={isFirst} aria-label={`Move ${column.name} left`} title="Move column left"><ChevronLeft /></button>
          <button className="icon-button desktop-only" onClick={() => props.onMoveColumn(1)} disabled={isLast} aria-label={`Move ${column.name} right`} title="Move column right"><ChevronRight /></button>
          <button className="icon-button" onClick={(event) => props.onColumnMenu(event.currentTarget)} aria-haspopup="dialog" aria-label={`Column actions for ${column.name}`} title="Column actions"><Ellipsis /></button>
        </>}
      </span>}
    </header>
    {collapsed && <p className="task-column-hidden task-column-collapsed-note">
      <span>Collapsed{count ? `, ${cardsWord(count)} hidden` : ""}</span>
      <button type="button" className="task-column-show-all" onClick={toggle}>Expand</button>
    </p>}
    {!collapsed && <>
    {props.refuseDrop && <p className="task-column-full-hint" role="status">Full: it takes at most {column.wip_limit} {column.wip_limit === 1 ? "card" : "cards"}.</p>}
    {props.hiddenNote && <p className="task-column-hidden">
      <span>{props.hiddenNote.text}</span>
      <button type="button" className="task-column-show-all" onClick={props.hiddenNote.onShowAll}>Show all levels</button>
    </p>}
    <ul ref={listRef} className="task-card-list" aria-label={`${column.name} cards`}>
      {cards.map((card) => {
        // The dragged card stays rendered (removing it would cancel the drag); slots count the others.
        const slot = others.indexOf(card);
        const parent = props.nesting?.parentOf(card) ?? null;
        const rollup = props.nesting?.rollupOf(card) ?? null;
        const face = { card, tags: props.tags ?? [], done: column.is_done === 1, today, parentTitle: parent?.title ?? null, rollup, childLabel: props.nesting?.childLabel(card) };
        const archived = Boolean(card.archived_at);
        const nesting = props.nesting?.nestTarget === card.id;
        const excerptId = `task-card-excerpt-${card.id}`;
        return <li key={card.id} className="task-card-item">
        {slot >= 0 && indicator(slot)}
        <div
          className={`task-card${draggingId === card.id ? " dragging" : ""}${nesting ? " nest-target" : ""}${archived ? " archived" : ""}`}
          data-nest-label={nesting ? props.nesting!.nestLabel(card.id) : undefined}
          tabIndex={0}
          data-card-id={card.id}
          draggable={!readOnly}
          role="group"
          aria-label={cardFaceLabel(face)}
          aria-roledescription={readOnly ? "Card" : "Draggable card"}
          aria-keyshortcuts={readOnly ? undefined : "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"}
          aria-describedby={readOnly ? card.description_excerpt?.trim() ? excerptId : undefined : card.description_excerpt?.trim() ? `${excerptId} task-card-keys` : "task-card-keys"}
          onDragStart={(event) => {
            if (readOnly) { event.preventDefault(); return; }
            event.dataTransfer.setData(CARD_DRAG_TYPE, card.id);
            event.dataTransfer.effectAllowed = "move";
            props.onDragStart(card);
          }}
          onDragEnd={() => { props.nesting?.onNestOver(null); props.onDragEnd(); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.target === event.currentTarget) {
              event.preventDefault();
              props.onOpenCard(card);
              return;
            }
            cardKeyDown(event, card);
          }}
          onClick={(event) => { if (!(event.target as Element).closest("button")) props.onOpenCard(card); }}
        >
          {parent && <button className="task-parent-chip" draggable={false} onClick={() => props.nesting!.onOpenCardId(parent.id)}
            aria-label={`Open ${parent.levelName.toLowerCase()} “${parent.title}”`} title={`${parent.levelName}: ${parent.title}`}>
            <ChevronRight aria-hidden="true" /><span>{parent.title}</span>
          </button>}
          <CardFace {...face} excerptId={excerptId} />
          <button className="icon-button task-card-more" onClick={(event) => props.onCardMenu(card, event.currentTarget)} aria-haspopup="dialog" aria-label={`More actions for “${card.title}”`} title="More actions" draggable={false}><Ellipsis /></button>
        </div>
      </li>;
      })}
      {dropIndex !== null && dropIndex >= others.length && <li className="task-drop-indicator" aria-hidden="true" />}
      {!cards.length && dropIndex === null && <li className="task-column-empty">{count > 0 ? props.emptyText ?? "No matching cards" : "No cards yet"}</li>}
    </ul>
    {!readOnly && <footer className="task-column-footer">
      <button className="task-add-card" onClick={props.onAddCard} aria-haspopup="dialog" aria-label={`Add a card to ${column.name}`}><Plus />Add a card</button>
    </footer>}
    </>}
  </section>;
}
