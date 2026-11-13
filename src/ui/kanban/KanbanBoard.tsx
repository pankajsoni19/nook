import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowRightLeft } from "lucide-react";
import { Select } from "../Select";
import "../workspace.css";

/**
 * The shared board (§E.3, C16, D839): columns with header totals and pointer drag, for Contacts' deal
 * pipeline (and Goals' optional board). Same visual language as Tasks boards. Pointer drag starts
 * after a 6 px move (so a click still opens), shows the card under the pointer and a drop line,
 * and scrolls the board near its edges. Keys: Alt+←/→ moves the focused card to the next stage,
 * Alt+↑/↓ within its stage; Enter opens it. Phones show one stage at a time under a strip of stage
 * chips with counts (the one sideways strip §E.1.5 allows), and each card has a Move control.
 */
export type KanbanColumn = {
  id: string;
  title: string;
  /** Shown beside the title ("12"); defaults to the number of items in it. */
  count?: number;
  /** A header total ("$48,200"), tabular. */
  total?: ReactNode;
  /** A small marker before the title (a stage's color dot, a won/lost icon). */
  marker?: ReactNode;
};
export type KanbanItem = { id: string; columnId: string };
export type KanbanMove = { itemId: string; toColumnId: string; toIndex: number };

/** Where a drop lands: the column under the pointer, before the first card whose middle is below it. Pure (exported for tests). */
export function dropTarget(columns: ReadonlyArray<{ id: string; left: number; right: number; cards: ReadonlyArray<{ id: string; top: number; bottom: number }> }>, x: number, y: number, dragged: string): { columnId: string; index: number } | null {
  const column = columns.find((entry) => x >= entry.left && x <= entry.right) ?? null;
  if (!column) return null;
  const cards = column.cards.filter((card) => card.id !== dragged);
  const index = cards.findIndex((card) => y < (card.top + card.bottom) / 2);
  return { columnId: column.id, index: index < 0 ? cards.length : index };
}

/** The ordered items of each column. */
export const itemsByColumn = <T extends KanbanItem>(columns: readonly KanbanColumn[], items: readonly T[]) => new Map(columns.map((column) => [column.id, items.filter((item) => item.columnId === column.id)]));

const DRAG_THRESHOLD = 6;

export function KanbanBoard<T extends KanbanItem>({ columns, items, renderCard, itemLabel, onMove, onOpen, canMove = true, emptyColumn = "Nothing here", label, phone: forcePhone }: {
  columns: readonly KanbanColumn[];
  items: readonly T[];
  renderCard: (item: T) => ReactNode;
  /** The card's accessible name ("Acme renewal, $12,000, next step Friday"). */
  itemLabel: (item: T) => string;
  onMove: (move: KanbanMove) => void;
  onOpen: (item: T) => void;
  canMove?: boolean;
  emptyColumn?: string;
  /** The board's accessible name ("Deals by stage"). */
  label: string;
  /** Tests and the gallery: force the phone layout. */
  phone?: boolean;
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  const keysId = useId();
  // The click that ends a drag must not open the card.
  const suppressClick = useRef(false);
  const [isPhone, setIsPhone] = useState(() => forcePhone ?? (typeof window !== "undefined" && window.matchMedia?.("(max-width: 760px)").matches));
  const [phoneColumn, setPhoneColumn] = useState(columns[0]?.id ?? "");
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; dx: number; dy: number; width: number; target: { columnId: string; index: number } | null } | null>(null);
  const pending = useRef<{ id: string; startX: number; startY: number; pointerId: number; element: HTMLElement } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const grouped = itemsByColumn(columns, items);

  useEffect(() => {
    if (forcePhone !== undefined) { setIsPhone(forcePhone); return; }
    const query = window.matchMedia?.("(max-width: 760px)");
    if (!query) return;
    const onChange = () => setIsPhone(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [forcePhone]);
  useEffect(() => { if (!columns.some((column) => column.id === phoneColumn)) setPhoneColumn(columns[0]?.id ?? ""); }, [columns, phoneColumn]);

  const move = useCallback((item: T, toColumnId: string, toIndex: number) => {
    const column = columns.find((entry) => entry.id === toColumnId);
    onMove({ itemId: item.id, toColumnId, toIndex });
    setAnnouncement(`${itemLabel(item)} moved to ${column?.title ?? "another stage"}, position ${toIndex + 1}`);
  }, [columns, itemLabel, onMove]);

  const measure = () => Array.from(boardRef.current?.querySelectorAll<HTMLElement>("[data-kanban-column]") ?? []).map((element) => {
    const box = element.getBoundingClientRect();
    return { id: element.dataset.kanbanColumn!, left: box.left, right: box.right, cards: Array.from(element.querySelectorAll<HTMLElement>("[data-kanban-item]")).map((card) => { const rect = card.getBoundingClientRect(); return { id: card.dataset.kanbanItem!, top: rect.top, bottom: rect.bottom }; }) };
  });

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>, item: T) => {
    if (!canMove || isPhone || event.button !== 0 || (event.target as HTMLElement).closest("button, a, input, [role='combobox']")) return;
    pending.current = { id: item.id, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId, element: event.currentTarget };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = pending.current;
    if (!start || event.pointerId !== start.pointerId) return;
    if (!drag) {
      if (Math.hypot(event.clientX - start.startX, event.clientY - start.startY) < DRAG_THRESHOLD) return;
      const box = start.element.getBoundingClientRect();
      start.element.setPointerCapture?.(event.pointerId);
      setDrag({ id: start.id, x: event.clientX, y: event.clientY, dx: start.startX - box.left, dy: start.startY - box.top, width: box.width, target: null });
      return;
    }
    const target = dropTarget(measure(), event.clientX, event.clientY, drag.id);
    setDrag({ ...drag, x: event.clientX, y: event.clientY, target });
    // Scroll the board sideways near its edges.
    const board = boardRef.current;
    if (board) {
      const box = board.getBoundingClientRect();
      if (event.clientX > box.right - 48) board.scrollLeft += 16;
      else if (event.clientX < box.left + 48) board.scrollLeft -= 16;
    }
  };
  const finish = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const start = pending.current;
    pending.current = null;
    if (!start || event.pointerId !== start.pointerId) return;
    if (!drag) return;
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    const item = items.find((entry) => entry.id === drag.id);
    setDrag(null);
    if (cancelled || !item || !drag.target) return;
    const current = (grouped.get(item.columnId) ?? []).findIndex((entry) => entry.id === item.id);
    if (drag.target.columnId === item.columnId && drag.target.index === current) return;
    move(item, drag.target.columnId, drag.target.index);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>, item: T) => {
    if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); onOpen(item); return; }
    if (!canMove || !event.altKey) return;
    const columnIndex = columns.findIndex((column) => column.id === item.columnId);
    const siblings = grouped.get(item.columnId) ?? [];
    const index = siblings.findIndex((entry) => entry.id === item.id);
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const next = columns[columnIndex + (event.key === "ArrowRight" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      move(item, next.id, (grouped.get(next.id) ?? []).length);
      if (isPhone) setPhoneColumn(next.id);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const to = index + (event.key === "ArrowDown" ? 1 : -1);
      if (to < 0 || to >= siblings.length) return;
      event.preventDefault();
      move(item, item.columnId, to);
    }
  };
  // Keep focus on a card moved by keys (it re-renders in its new column).
  const focusAfterMove = useRef<string | null>(null);
  useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    focusAfterMove.current = null;
    boardRef.current?.querySelector<HTMLElement>(`[data-kanban-item="${CSS.escape(id)}"]`)?.focus();
  });

  const draggedItem = drag ? items.find((item) => item.id === drag.id) : undefined;
  const shown = isPhone ? columns.filter((column) => column.id === phoneColumn) : columns;

  return <div className={`ui-kanban${isPhone ? " phone" : ""}${drag ? " dragging" : ""}`}>
    {isPhone && <div className="ui-kanban-strip" role="tablist" aria-label={`${label}: stages`}>
      {columns.map((column) => <button key={column.id} type="button" role="tab" aria-selected={column.id === phoneColumn} className="ui-kanban-stage" onClick={() => setPhoneColumn(column.id)}>
        {column.marker}<span>{column.title}</span><span className="ui-kanban-count ui-tabular">{column.count ?? grouped.get(column.id)?.length ?? 0}</span>
      </button>)}
    </div>}
    <div ref={boardRef} className="ui-kanban-columns" role="group" aria-label={label} aria-describedby={canMove ? keysId : undefined}>
      {shown.map((column) => {
        const list = grouped.get(column.id) ?? [];
        const target = drag?.target?.columnId === column.id ? drag.target.index : null;
        let shownIndex = 0;
        return <section key={column.id} className={`ui-kanban-column${target !== null ? " drop" : ""}`} data-kanban-column={column.id} aria-label={column.title}>
          <header className="ui-kanban-column-header">
            {column.marker}<h3>{column.title}</h3><span className="ui-kanban-count ui-tabular">{column.count ?? list.length}</span>
            {column.total !== undefined && <span className="ui-kanban-total ui-tabular">{column.total}</span>}
          </header>
          <ol className="ui-kanban-list">
            {list.map((item) => {
              const isDragged = drag?.id === item.id;
              const before = target !== null && !isDragged && target === shownIndex;
              if (!isDragged) shownIndex += 1;
              return <li key={item.id} className="ui-kanban-slot">
                {before && <span className="ui-kanban-drop-line" aria-hidden="true" />}
                <article className={`ui-kanban-card${isDragged ? " placeholder" : ""}`} data-kanban-item={item.id} tabIndex={0} aria-label={itemLabel(item)}
                  aria-keyshortcuts={canMove ? "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown Enter" : "Enter"}
                  onClick={(event) => { if (!suppressClick.current && !(event.target as HTMLElement).closest("button, a, [role='combobox']")) onOpen(item); }}
                  onPointerDown={(event) => onPointerDown(event, item)} onPointerMove={onPointerMove} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)}
                  onKeyDown={(event) => { if (event.altKey) focusAfterMove.current = item.id; onKeyDown(event, item); }}>
                  {renderCard(item)}
                  {isPhone && canMove && <span className="ui-kanban-move">
                    <Select variant="compact" iconOnly icon={<ArrowRightLeft aria-hidden="true" />} label={`Move ${itemLabel(item)} to`} value={item.columnId}
                      options={columns.map((column) => ({ value: column.id, label: column.title }))}
                      onChange={(toColumnId) => { if (toColumnId !== item.columnId) { move(item, toColumnId, (grouped.get(toColumnId) ?? []).length); setPhoneColumn(toColumnId); } }} />
                  </span>}
                </article>
              </li>;
            })}
            {target !== null && target >= shownIndex && <li className="ui-kanban-slot" aria-hidden="true"><span className="ui-kanban-drop-line" /></li>}
            {list.length === 0 && target === null && <li className="ui-kanban-empty">{emptyColumn}</li>}
          </ol>
        </section>;
      })}
    </div>
    {drag && draggedItem && <div className="ui-kanban-ghost" aria-hidden="true" style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.width }}>
      <article className="ui-kanban-card">{renderCard(draggedItem)}</article>
    </div>}
    {canMove && <p id={keysId} className="ui-visually-hidden">Alt and the arrow keys move a card between stages and within its stage.</p>}
    <p className="ui-visually-hidden" role="status" aria-live="polite">{announcement}</p>
  </div>;
}
