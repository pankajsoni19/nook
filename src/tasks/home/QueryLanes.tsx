import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronsLeftRight, ChevronsRightLeft, Ellipsis } from "lucide-react";
import type { QueryLane } from "../../../shared/taskLanes";
import { CARD_DRAG_TYPE, columnIndexFromScroll, isCardDrag, readCardDragPayload } from "../boardOrder";
import { KeyboardMoveHint } from "../boardViewParts";
import { CardFace, cardFaceLabel } from "../CardFace";
import { ColumnStatusIcon, ColumnStatusText, columnStatusId } from "../ColumnStatusIcon";
import { cardCountLabel } from "../taskActions";
import { useRole } from "../../team/roleAccess";
import { canChangeCard, type QueriedCard, type QueryLanes as QueryLaneLayout } from "./homeApi";
import { cardLaneKey, cardsByLane, faceOf, laneDrop, laneStatuses, nextOpenLane } from "./laneModel";

type QueryLanesProps = {
  cards: QueriedCard[];
  layout: QueryLaneLayout;
  today: string;
  /** The viewer's collapsed lanes (D644). */
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (key: string) => void;
  onOpenCard: (card: QueriedCard) => void;
  /** "Move to…": the lanes (and the card's own board) in a sheet; on phones the only way to move (D646). */
  onMoveCard: (card: QueriedCard, trigger: HTMLElement) => void;
  /** A drop or Alt+←/→ that resolved to a column of the card's board (D641): the host moves it. */
  onDropCard: (card: QueriedCard, lane: QueryLane) => void;
  /** A refused drop or key move: the host says why. */
  onRefused: (message: string) => void;
  phone: boolean;
};

const LANE_INDEX_KEY = "mynotes.tasks.lane";

const laneIndexFromHistory = (count: number) => {
  const value = (window.history.state as Record<string, unknown> | null)?.[LANE_INDEX_KEY];
  return typeof value === "number" && value >= 0 && value < count ? value : 0;
};

/**
 * Cross-board results as board lanes (lane VIEWS, D640–D646): merged columns or states, each the
 * board's column look, with the true count in the header. Cards drag between lanes to their own
 * board's column (to the top), refused with a reason on a lane that cannot take them; there is no
 * reordering in a lane. A collapsed lane is the board's 44 px strip and still takes a drop. On
 * phones the lanes are pages with tabs, as on a board, and drag is off ("Move to…" instead).
 */
export function QueryLanes({ cards, layout, today, collapsed, onToggleCollapsed, onOpenCard, onMoveCard, onDropCard, onRefused, phone }: QueryLanesProps) {
  const { readOnly: roleReadOnly } = useRole();
  const lanes = layout.columns;
  const byLane = cardsByLane(layout, cards);
  // Each lane's status icon (COLICON's, D629): from its state and place, left to right.
  const statuses = laneStatuses(lanes);
  const [dragging, setDragging] = useState<QueriedCard | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [active, setActive] = useState(() => laneIndexFromHistory(lanes.length));
  const activeRef = useRef(active);
  const trackRef = useRef<HTMLDivElement>(null);
  const hintTimer = useRef<number | null>(null);
  const shown = Math.max(0, Math.min(active, lanes.length - 1));

  useEffect(() => {
    const track = trackRef.current;
    if (phone && track && activeRef.current > 0) track.scrollTo({ left: activeRef.current * track.clientWidth, behavior: "instant" as ScrollBehavior });
    // Only on mount and when the layout switches to the pager.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone]);
  useEffect(() => () => { if (hintTimer.current !== null) window.clearTimeout(hintTimer.current); }, []);

  /** Keeps the lane index on the current entry (no new entry), so Back and Forward land on the same lane. */
  function remember(index: number) {
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => {
      hintTimer.current = null;
      const state = window.history.state && typeof window.history.state === "object" ? window.history.state as Record<string, unknown> : {};
      window.history.replaceState({ ...state, [LANE_INDEX_KEY]: index }, "", `${window.location.pathname}${window.location.search}`);
    }, 150);
  }

  function showLane(index: number) {
    activeRef.current = index;
    setActive(index);
    remember(index);
    const track = trackRef.current;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    track?.scrollTo({ left: index * track.clientWidth, behavior: reduce ? "instant" as ScrollBehavior : "smooth" });
  }

  function onScroll() {
    const track = trackRef.current;
    if (!track || !phone) return;
    const index = columnIndexFromScroll(track.scrollLeft, track.clientWidth, lanes.length);
    if (index === activeRef.current) return;
    activeRef.current = index;
    setActive(index);
    remember(index);
    document.getElementById(`task-lane-tab-${index}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  const canMove = (card: QueriedCard) => canChangeCard(card, roleReadOnly);
  const verdict = (lane: QueryLane) => dragging ? laneDrop(lane, dragging, canMove(dragging)) : null;

  function dragOver(event: ReactDragEvent<HTMLElement>, lane: QueryLane) {
    if (!dragging || !isCardDrag(event.dataTransfer.types)) return;
    const drop = verdict(lane);
    if (!drop || !("columnId" in drop)) {
      // Not calling preventDefault leaves the drop disallowed; the lane says why.
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (over !== lane.key) setOver(lane.key);
  }

  function drop(event: ReactDragEvent<HTMLElement>, lane: QueryLane) {
    const id = readCardDragPayload(event.dataTransfer.getData(CARD_DRAG_TYPE)) ?? dragging?.id;
    const card = cards.find((item) => item.id === id);
    setDragging(null);
    setOver(null);
    if (!card) return;
    const result = laneDrop(lane, card, canMove(card));
    if (!("columnId" in result)) return;
    event.preventDefault();
    onDropCard(card, lane);
  }

  function keyMove(event: ReactKeyboardEvent<HTMLElement>, card: QueriedCard, laneIndex: number) {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      onRefused("Cards here keep the view's order; open the card's board to reorder it");
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const target = nextOpenLane(lanes, laneIndex, event.key === "ArrowLeft" ? -1 : 1, card, canMove(card));
    if (!target) {
      const neighbour = lanes[laneIndex + (event.key === "ArrowLeft" ? -1 : 1)];
      onRefused(neighbour ? (laneDrop(neighbour, card, canMove(card)) as { message: string }).message : "No lane that way");
      return;
    }
    onDropCard(card, lanes[target.index]!);
    window.setTimeout(() => document.querySelector<HTMLElement>(`.task-query-lanes [data-card-id="${card.id}"]`)?.focus(), 0);
  }

  return <div className="task-query-lanes">
    <KeyboardMoveHint id="task-lane-keys">Press Alt with the left or right arrow to move a card to the next lane that takes it.</KeyboardMoveHint>
    {layout.lanesFallback && <p className="task-lanes-notice" role="status">These boards have more than 20 different columns, so the lanes show states.</p>}
    {phone && <nav className="task-column-tabs" aria-label="Lanes">
      {lanes.map((lane, index) => {
        const folded = collapsed.has(lane.key);
        const count = layout.laneCounts[lane.key] ?? 0;
        const status = statuses[index]!;
        return <button key={lane.key} id={`task-lane-tab-${index}`} className={`${index === shown ? "active" : ""}${folded ? " collapsed" : ""}`} aria-current={index === shown ? "true" : undefined}
          aria-describedby={columnStatusId(String(index), "lane")} onClick={() => showLane(index)}>
          <ColumnStatusIcon status={status} /><span>{lane.label}</span><b aria-label={folded ? `${cardCountLabel(count)}, collapsed` : cardCountLabel(count)}>{count}</b>
        </button>;
      })}
    </nav>}
    <div className="task-columns" ref={trackRef} onScroll={onScroll}>
      {lanes.map((lane, laneIndex) => {
        const laneCards = byLane.get(lane.key) ?? [];
        const count = layout.laneCounts[lane.key] ?? laneCards.length;
        const result = verdict(lane);
        const refused = result && !("columnId" in result) && result.refusal !== "SAME_LANE" ? result.message : null;
        const folded = collapsed.has(lane.key);
        const headingId = `task-lane-${laneIndex}`;
        const status = statuses[laneIndex]!;
        const statusId = columnStatusId(String(laneIndex), "lane");
        const statusText = <ColumnStatusText id={statusId} status={status} />;
        const countLabel = laneCards.length < count ? `${laneCards.length} loaded of ${cardCountLabel(count)}` : cardCountLabel(count);
        const className = `task-column task-lane${folded && !phone ? " collapsed" : ""}${over === lane.key ? " drop-active" : ""}${refused ? " drop-refused" : ""}`;
        const dropProps = { onDragOver: (event: ReactDragEvent<HTMLElement>) => dragOver(event, lane), onDragEnter: (event: ReactDragEvent<HTMLElement>) => dragOver(event, lane),
          onDrop: (event: ReactDragEvent<HTMLElement>) => drop(event, lane),
          onDragLeave: (event: ReactDragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && over === lane.key) setOver(null); } };
        if (folded && !phone) {
          return <section key={lane.key} className={className} aria-labelledby={headingId} data-lane-key={lane.key} title={refused ?? undefined} {...dropProps}>
            <button type="button" className="task-column-strip" aria-expanded="false" onClick={() => onToggleCollapsed(lane.key)} aria-label={`Expand ${lane.label}, ${countLabel}`}
              aria-describedby={statusId} title={refused ?? `Expand ${lane.label}`}>
              <ChevronsLeftRight aria-hidden="true" />
              <b aria-hidden="true">{count}</b>
              <ColumnStatusIcon status={status} />
              <span id={headingId} className="task-column-strip-name">{lane.label}</span>
            </button>
            {statusText}
          </section>;
        }
        return <section key={lane.key} className={className} aria-labelledby={headingId} aria-describedby={statusId} data-lane-key={lane.key} {...dropProps}>
          <header className="task-column-header">
            <ColumnStatusIcon status={status} />
            {statusText}
            <h2 id={headingId} title={lane.label}>{lane.label}</h2>
            <b aria-label={countLabel} title={laneCards.length < count ? `${laneCards.length} of ${count} loaded` : undefined}>{laneCards.length < count ? `${laneCards.length} · ${count}` : count}</b>
            <span className="task-column-controls">
              <button className="icon-button task-column-collapse" onClick={() => onToggleCollapsed(lane.key)} aria-expanded={!folded}
                aria-label={folded ? `Expand ${lane.label}` : `Collapse ${lane.label}`} title={folded ? "Expand lane" : "Collapse lane"}>
                {folded ? <ChevronsLeftRight /> : <ChevronsRightLeft />}
              </button>
            </span>
          </header>
          {folded && <p className="task-column-hidden task-column-collapsed-note">
            <span>Collapsed{count ? `, ${cardCountLabel(count)} hidden` : ""}</span>
            <button type="button" className="task-column-show-all" onClick={() => onToggleCollapsed(lane.key)}>Expand</button>
          </p>}
          {!folded && <>
            {refused && <p className="task-column-full-hint" role="status">{refused}</p>}
            <ul className="task-card-list" aria-label={`${lane.label} cards`}>
              {laneCards.map((card) => {
                const face = faceOf(card);
                const movable = !phone && canMove(card);
                const label = cardFaceLabel({ card: face.card, tags: face.tags, done: card.is_done === 1, today });
                const excerptId = `task-lane-excerpt-${card.id}`;
                return <li key={card.id} className="task-card-item">
                  <div className={`task-card${dragging?.id === card.id ? " dragging" : ""}${card.archived_at ? " archived" : ""}`} tabIndex={0} data-card-id={card.id}
                    draggable={movable} role="group" aria-label={`${label}, on ${card.board_name}${cardLaneKey(layout, card) === lane.key && lane.key.startsWith("s:") ? `, ${card.column_name}` : ""}`}
                    aria-roledescription={movable ? "Draggable card" : "Card"}
                    aria-keyshortcuts={movable ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
                    aria-describedby={movable ? card.description_excerpt?.trim() ? `${excerptId} task-lane-keys` : "task-lane-keys" : card.description_excerpt?.trim() ? excerptId : undefined}
                    onDragStart={(event) => {
                      if (!movable) { event.preventDefault(); return; }
                      event.dataTransfer.setData(CARD_DRAG_TYPE, card.id);
                      event.dataTransfer.effectAllowed = "move";
                      setDragging(card);
                    }}
                    onDragEnd={() => { setDragging(null); setOver(null); }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); onOpenCard(card); return; }
                      if (movable) keyMove(event, card, laneIndex);
                    }}
                    onClick={(event) => { if (!(event.target as Element).closest("button")) onOpenCard(card); }}>
                    <span className="task-lane-board" aria-hidden="true">{card.board_name}{lane.key.startsWith("s:") ? ` › ${card.column_name}` : ""}</span>
                    <CardFace card={face.card} tags={face.tags} done={card.is_done === 1} today={today} excerptId={excerptId} />
                    {canMove(card) && <button className="icon-button task-card-more" onClick={(event) => onMoveCard(card, event.currentTarget)} aria-haspopup="dialog"
                      aria-label={`Move “${card.title}”`} title="Move to…" draggable={false}><Ellipsis /></button>}
                  </div>
                </li>;
              })}
              {!laneCards.length && <li className="task-column-empty">{count > 0 ? "Load more to see these cards" : "No cards"}</li>}
            </ul>
          </>}
        </section>;
      })}
    </div>
  </div>;
}
