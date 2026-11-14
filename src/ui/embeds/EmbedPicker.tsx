import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ModalDialog } from "../../files/Dialog";
import { EmptyState } from "../EmptyState";

/**
 * A small "pick one of yours" dialog for the editor's `/` items that embed an existing item (W3-WIRE,
 * D1059): a booking link, a goal, a townhall session. Mounted on its own root (the editor knows only
 * the slash registry), filtered as you type, closed on pick or Escape. The caller inserts the embed
 * with the neutral word (T513); this dialog only shows the picker's own items to their owner.
 */
export type PickItem = { id: string; title: string; meta?: string; path: string };

export function EmbedPickerDialog({ title, eyebrow, icon: Icon, emptyTitle, emptyText, load, onClose, onPick }: {
  title: string; eyebrow: string; icon: LucideIcon; emptyTitle: string; emptyText: string;
  load: () => Promise<PickItem[]>; onClose: () => void; onPick: (item: PickItem) => void;
}) {
  const [items, setItems] = useState<PickItem[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    let live = true;
    load().then((list) => { if (live) setItems(list); }, () => { if (live) setItems([]); });
    return () => { live = false; };
  }, [load]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((item) => !needle || item.title.toLowerCase().includes(needle)).slice(0, 50);
  }, [items, q]);
  return <ModalDialog title={title} eyebrow={eyebrow} onClose={onClose} variant="sheet" className="ui-pick-sheet">
    <div className="file-dialog-body ui-pick-body">
      <label className="ui-field"><span>Search</span><input autoFocus type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Title" /></label>
      {items === null ? <p className="ui-panel-loading" role="status">Loading…</p> : shown.length === 0
        ? <EmptyState icon={Icon} title={emptyTitle} compact>{emptyText}</EmptyState>
        : <ul className="ui-pick-list">{shown.map((item) => <li key={item.id}>
          <button type="button" onClick={() => onPick(item)}><Icon aria-hidden="true" /><span>{item.title}</span>{item.meta && <small>{item.meta}</small>}</button>
        </li>)}</ul>}
    </div>
  </ModalDialog>;
}

export default EmbedPickerDialog;
