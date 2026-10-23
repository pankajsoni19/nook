import { useState, type DragEvent as ReactDragEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical, Pin } from "lucide-react";
import { ModalDialog } from "../../files/Dialog";
import type { TaskView } from "../home/homeApi";

const PIN_DRAG_TYPE = "application/x-nook-pinned-view";

/** Where a pinned view goes after a move up or down (D667): the anchor it lands after, or null for first. */
export function pinStep(order: readonly string[], viewId: string, direction: -1 | 1): string | null | undefined {
  const index = order.indexOf(viewId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= order.length) return undefined;
  const rest = order.filter((id) => id !== viewId);
  return target === 0 ? null : rest[target - 1]!;
}

/** The anchor a view dropped before `beforeId` (or at the end, null) lands after. */
export function pinDropAnchor(order: readonly string[], viewId: string, beforeId: string | null): string | null | undefined {
  const rest = order.filter((id) => id !== viewId);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  if (at < 0) return undefined;
  const anchor = at === 0 ? null : rest[at - 1]!;
  const current = order.indexOf(viewId) === 0 ? null : order[order.indexOf(viewId) - 1]!;
  return anchor === current ? undefined : anchor;
}

/**
 * "Reorder pinned views" (lane VIEWS2, D667): the board's owner or a manager drags the pinned views
 * into the order the board's picker lists them, or uses Move up and Move down (also the keyboard and
 * phone way). Each move is saved at once.
 */
export function PinnedOrderSheet({ pinned, busy, onMove, onClose }: { pinned: TaskView[]; busy: boolean; onMove: (viewId: string, afterViewId: string | null) => void; onClose: () => void }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const order = pinned.map((view) => view.id);

  function drop(event: ReactDragEvent<HTMLElement>, beforeId: string | null) {
    const id = event.dataTransfer.getData(PIN_DRAG_TYPE) || dragging;
    setDragging(null);
    setOver(null);
    if (!id) return;
    event.preventDefault();
    const anchor = pinDropAnchor(order, id, beforeId);
    if (anchor !== undefined) onMove(id, anchor);
  }

  return <ModalDialog title="Reorder pinned views" eyebrow="Pinned for everyone" onClose={onClose}>
    <ol className="task-pin-order" aria-label="Pinned views, in the picker's order">
      {pinned.map((view, index) => <li key={view.id} className={`task-pin-row${dragging === view.id ? " dragging" : ""}${over === view.id ? " drop-active" : ""}`}
        draggable={!busy} onDragStart={(event) => { event.dataTransfer.setData(PIN_DRAG_TYPE, view.id); event.dataTransfer.effectAllowed = "move"; setDragging(view.id); }}
        onDragEnd={() => { setDragging(null); setOver(null); }}
        onDragOver={(event) => { if (!dragging) return; event.preventDefault(); if (over !== view.id) setOver(view.id); }}
        onDrop={(event) => drop(event, view.id)}>
        <GripVertical className="task-pin-grip" aria-hidden="true" />
        <Pin className="task-pin-icon" aria-hidden="true" />
        <span className="task-pin-name">{view.name}</span>
        <button type="button" className="icon-button" disabled={busy || index === 0} onClick={() => onMove(view.id, pinStep(order, view.id, -1)!)} aria-label={`Move ${view.name} up`} title="Move up"><ArrowUp /></button>
        <button type="button" className="icon-button" disabled={busy || index === pinned.length - 1} onClick={() => onMove(view.id, pinStep(order, view.id, 1)!)} aria-label={`Move ${view.name} down`} title="Move down"><ArrowDown /></button>
      </li>)}
      <li className={`task-pin-end${over === "end" ? " drop-active" : ""}`} aria-hidden="true"
        onDragOver={(event) => { if (!dragging) return; event.preventDefault(); if (over !== "end") setOver("end"); }} onDrop={(event) => drop(event, null)} />
    </ol>
  </ModalDialog>;
}
