import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, ArrowDownToLine, ArrowUpToLine, Check, ChevronLeft, KanbanSquare, Layers, Link as LinkIcon, ArrowRightLeft } from "lucide-react";
import { ColumnStatusIcon, ColumnStatusText, columnStatuses, columnStatusId } from "./ColumnStatusIcon";
import { ModalDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { canEnterColumn } from "./taskActions";
import { getBoard, listBoards, type BoardColumn, type BoardSummary, type CardSummary } from "./tasksApi";
import { levelAtLeast } from "../access/accessLevels";
import { FormError } from "../ui/FormError";

export type MovePlace = "top" | "bottom";

type MoveCardSheetProps = {
  card: CardSummary;
  columns: BoardColumn[];
  /** The board's cards, to tell which columns are full (D108). */
  cards?: readonly CardSummary[];
  onMove: (columnId: string, place: MovePlace) => Promise<void>;
  onCancel: () => void;
  /** Hierarchy (17A, D128): "Set parent…", the path to reparent without drag (phones, keyboard). */
  parentPicker?: {
    label: string;
    /** "No epic"; left out when the card needs a parent (a subtask, operator QA 0.9.1). */
    noneLabel?: string;
    currentParentId: string | null;
    options: Array<{ id: string; title: string; disabled?: boolean }>;
    onPick: (parentId: string | null) => Promise<void>;
  };
  /** The card's ⋯ menu: "Copy link" copies its permalink without opening the card, then closes the sheet. */
  onCopyLink?: () => void;
  /**
   * The caller may not change this card (below Can edit on the board, or a read-only Team role):
   * the ⋯ menu offers Copy link only, never Move (which the server would refuse, READ_ONLY).
   */
  readOnly?: boolean;
  /** Archive or unarchive the card (D610), for people who can edit it; the sheet closes first. */
  onArchive?: () => void;
  /**
   * "Move to another board…" (lane KEYS, D716): the boards the person can edit cards on, then a
   * column there; the sheet calls this with the choice and stays open (busy) until it settles.
   */
  onMoveToBoard?: (board: BoardSummary, columnId: string) => Promise<void>;
  /** Test seams: the person's boards, and a board's columns. */
  loadBoards?: () => Promise<BoardSummary[]>;
  loadColumns?: (boardId: string) => Promise<BoardColumn[]>;
};

const defaultLoadBoards = () => listBoards().then((result) => result.boards);
const defaultLoadColumns = (boardId: string) => getBoard(boardId).then((detail) => [...detail.columns].sort((a, b) => a.position - b.position));

/** The boards a card can move to (D716): every other board where the person edits cards. */
export function moveTargets(boards: readonly BoardSummary[], fromBoardId: string) {
  return boards.filter((board) => board.id !== fromBoardId && levelAtLeast(board.level, "edit"));
}

/** The column a move lands in unless another is picked (D716): the first that is not done, else the first. */
export function defaultTargetColumn(columns: readonly BoardColumn[]) {
  const sorted = [...columns].sort((a, b) => a.position - b.position);
  return sorted.find((column) => column.is_done !== 1) ?? sorted[0] ?? null;
}

/**
 * The second step of Move to… (D716): pick a board, then a column there, and move. What changes is
 * said up front: tags without a namesake on that board are dropped, the sprint and parent are
 * cleared, and the card gets that board's next key (its old key still finds it). A card with
 * sub-cards cannot move (they stay on their board).
 */
function MoveToBoardSheet({ card, onMoveToBoard, onBack, onCancel, loadBoards, loadColumns }: {
  card: CardSummary; onMoveToBoard: (board: BoardSummary, columnId: string) => Promise<void>; onBack: () => void; onCancel: () => void;
  loadBoards: () => Promise<BoardSummary[]>; loadColumns: (boardId: string) => Promise<BoardColumn[]>;
}) {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [target, setTarget] = useState<BoardSummary | null>(null);
  const [columns, setColumns] = useState<BoardColumn[] | null>(null);
  const [columnId, setColumnId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasChildren = (card.child_count ?? 0) > 0;
  useEffect(() => {
    let live = true;
    loadBoards().then((list) => { if (live) setBoards(moveTargets(list, card.board_id)); }, (reason) => { if (live) setError(reason instanceof Error ? reason.message : "Could not load your boards"); });
    return () => { live = false; };
  }, [card.board_id, loadBoards]);
  useEffect(() => {
    if (!target) return;
    let live = true;
    setColumns(null);
    loadColumns(target.id).then((list) => {
      if (!live) return;
      setColumns(list);
      setColumnId(defaultTargetColumn(list)?.id ?? null);
    }, (reason) => { if (live) setError(reason instanceof Error ? reason.message : "Could not load that board"); });
    return () => { live = false; };
  }, [target, loadColumns]);

  async function confirm() {
    if (!target || !columnId) return;
    setBusy(true);
    setError(null);
    try {
      await onMoveToBoard(target, columnId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not move the card");
      setBusy(false);
    }
  }

  const chosenColumn = columns?.find((column) => column.id === columnId) ?? null;
  const targetStatuses = columnStatuses(columns ?? []);
  return <ModalDialog title={`Move “${card.title}” to another board`} eyebrow="Move to" onClose={onCancel} variant="sheet" busy={busy}>
    <div className="move-list" role={target ? undefined : "radiogroup"} aria-label={target ? undefined : "Board"}>
      <button className="move-option" onClick={target ? () => { setTarget(null); setColumns(null); setError(null); } : onBack} disabled={busy}>
        <ChevronLeft aria-hidden="true" /><span>{target ? "Back to boards" : "Back to columns"}</span>
      </button>
      {hasChildren && <p className="task-comment-empty" role="note">This card has sub-cards. Move them off it or to the Bin first: sub-cards stay on their board.</p>}
      {!target && !hasChildren && boards === null && !error && <p className="bin-loading" role="status">Loading your boards…</p>}
      {!target && !hasChildren && boards?.length === 0 && <p className="task-comment-empty">There is no other board where you can edit cards.</p>}
      {!target && !hasChildren && boards?.map((board, index) => <button key={board.id} role="radio" aria-checked={false} className="move-option" autoFocus={index === 0} disabled={busy} onClick={() => setTarget(board)}>
        <KanbanSquare aria-hidden="true" />
        <span>{board.name}<small>{[board.code, board.is_owner === 1 ? null : board.owner_name].filter(Boolean).join(" · ")}</small></span>
      </button>)}
    </div>
    {target && <>
      {columns === null && !error && <p className="bin-loading" role="status">Loading {target.name}…</p>}
      {columns && <div className="move-list" role="radiogroup" aria-label={`Column on ${target.name}`}>
        {columns.map((column) => {
          const status = targetStatuses.get(column.id);
          return <button key={column.id} role="radio" aria-checked={columnId === column.id} className={`move-option${columnId === column.id ? " active" : ""}`} disabled={busy} onClick={() => setColumnId(column.id)}>
            {status ? <ColumnStatusIcon status={status} /> : <Layers aria-hidden="true" />}
            <span>{column.name}{column.is_done === 1 && <small>Done column</small>}</span>
            {columnId === column.id && <Check aria-hidden="true" />}
          </button>;
        })}
      </div>}
      <p className="file-dialog-copy">It goes to the bottom of the column with its comments, files, people, and links, and gets a new key{target.code ? ` (${target.code}-…)` : ""}; its old key still opens it. Tags that {target.name} has no tag of the same name for are dropped, and its sprint and parent are cleared.</p>
    </>}
    <FormError message={error} className="file-dialog-error" />
    <footer className="file-dialog-actions">
      <button className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button className="primary-button" onClick={() => { void confirm(); }} disabled={!target || !chosenColumn || busy || hasChildren}>{busy ? "Moving…" : target && chosenColumn ? `Move to ${target.name} › ${chosenColumn.name}` : "Move"}</button>
    </footer>
  </ModalDialog>;
}

// "Move to…": a dialog on desktop, a full-screen sheet on phones. Lists the board's columns and
// Top or Bottom; the current column is allowed, so a card can jump to the top or bottom of its own.
// A column at its WIP limit is listed but disabled.
// "Move to another board…" (D716) opens the board picker in place, which Back closes the same way.
export function MoveCardSheet({ card, columns, cards = [], onMove, onCancel, parentPicker, onCopyLink, readOnly = false, onArchive, onMoveToBoard, loadBoards = defaultLoadBoards, loadColumns = defaultLoadColumns }: MoveCardSheetProps) {
  const [picking, setPicking] = useState(false);
  // Back on the "Set epic…" list returns to Move to… (as its Back to columns button does), not the board.
  useHistoryDialogGuard(picking, () => setPicking(false));
  const [otherBoard, setOtherBoard] = useState(false);
  useHistoryDialogGuard(otherBoard, () => setOtherBoard(false));
  const [chosen, setChosen] = useState<string | null>(null);
  const [place, setPlace] = useState<MovePlace>("bottom");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = columns.find((column) => column.id === chosen) ?? null;
  const full = (column: BoardColumn) => !canEnterColumn(cards, column, card.id);
  const firstOpen = columns.findIndex((column) => !full(column));
  const statuses = columnStatuses(columns);

  async function confirmAction() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await onMove(target.id, place);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not move the card");
      setBusy(false);
    }
  }

  async function pickParent(parentId: string | null) {
    if (!parentPicker) return;
    setBusy(true);
    await parentPicker.onPick(parentId);
    onCancel();
  }

  if (readOnly) {
    return <ModalDialog title={card.title} eyebrow="Card" onClose={onCancel}>
      {onCopyLink && <div className="move-list task-move-parent">
        <button className="move-option" autoFocus onClick={() => { onCopyLink(); onCancel(); }}><LinkIcon aria-hidden="true" /><span>Copy link<small>A link to this card</small></span></button>
      </div>}
      <p className="file-dialog-copy">You can read this card here but not move or change it.</p>
      <footer className="file-dialog-actions">
        <button className="secondary-button" onClick={onCancel}>Close</button>
      </footer>
    </ModalDialog>;
  }

  if (picking && parentPicker) {
    return <ModalDialog title={`${parentPicker.label.replace(/…$/, "")} for “${card.title}”`} eyebrow="Parent" onClose={onCancel} variant="sheet" busy={busy}>
      <div className="move-list" role="radiogroup" aria-label="Parent">
        <button className="move-option" onClick={() => setPicking(false)} disabled={busy}><ChevronLeft aria-hidden="true" /><span>Back to columns</span></button>
        {[...(parentPicker.noneLabel ? [{ id: null as string | null, title: parentPicker.noneLabel, disabled: false }] : []), ...parentPicker.options].map((option, index) => {
          const current = option.id === parentPicker.currentParentId;
          return <button key={option.id ?? "none"} role="radio" aria-checked={current} className={`move-option${current ? " active" : ""}`} autoFocus={index === 0}
            disabled={busy || option.disabled || current} onClick={() => { void pickParent(option.id); }}>
            <Layers aria-hidden="true" /><span>{option.title}{current ? <small>Current</small> : option.disabled && <small>Full (100 children)</small>}</span>
            {current && <Check aria-hidden="true" />}
          </button>;
        })}
        {!parentPicker.options.length && <p className="task-comment-empty">No cards one level up on this board yet.</p>}
      </div>
    </ModalDialog>;
  }

  if (otherBoard && onMoveToBoard) {
    return <MoveToBoardSheet card={card} onMoveToBoard={onMoveToBoard} onBack={() => setOtherBoard(false)} onCancel={onCancel} loadBoards={loadBoards} loadColumns={loadColumns} />;
  }

  return <ModalDialog title={`Move “${card.title}”`} eyebrow="Move to" onClose={onCancel} variant="sheet" busy={busy}>
    {(onCopyLink || onArchive) && <div className="move-list task-move-parent">
      {onCopyLink && <button className="move-option" onClick={() => { onCopyLink(); onCancel(); }} disabled={busy}><LinkIcon aria-hidden="true" /><span>Copy link<small>A link to this card</small></span></button>}
      {onArchive && <button className="move-option" onClick={() => { onCancel(); onArchive(); }} disabled={busy}>
        {card.archived_at ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
        <span>{card.archived_at ? "Unarchive" : "Archive"}<small>{card.archived_at ? "Put it back on the board" : "Hide it from the board; nothing is deleted"}</small></span>
      </button>}
    </div>}
    {parentPicker && <div className="move-list task-move-parent">
      <button className="move-option" onClick={() => setPicking(true)} disabled={busy}><Layers aria-hidden="true" /><span>{parentPicker.label}<small>{parentPicker.currentParentId ? `Now: ${parentPicker.options.find((option) => option.id === parentPicker.currentParentId)?.title ?? "its parent"}` : "It has none now"}</small></span></button>
    </div>}
    {onMoveToBoard && <div className="move-list task-move-parent">
      <button className="move-option" onClick={() => setOtherBoard(true)} disabled={busy}><ArrowRightLeft aria-hidden="true" /><span>Move to another board…<small>It gets that board's next key; its old key still finds it</small></span></button>
    </div>}
    <div className="move-list" role="radiogroup" aria-label="Column">
      {columns.map((column, index) => {
        const current = column.id === card.column_id;
        const refused = full(column);
        // The column's status icon (D629) in place of a generic column icon; its words describe the option.
        const status = statuses.get(column.id)!;
        const statusId = columnStatusId(column.id, "move");
        return <button key={column.id} role="radio" aria-checked={chosen === column.id} className={`move-option${chosen === column.id ? " active" : ""}`} disabled={busy || refused} autoFocus={index === firstOpen} onClick={() => setChosen(column.id)}
          aria-describedby={statusId}>
          <ColumnStatusIcon status={status} /><ColumnStatusText id={statusId} status={status} />
          <span>{column.name}{current ? <small>Current column</small> : refused && <small>Full (limit {column.wip_limit})</small>}</span>
          {chosen === column.id && <Check aria-hidden="true" />}
        </button>;
      })}
    </div>
    <div className="task-move-place" role="radiogroup" aria-label="Position">
      <button role="radio" aria-checked={place === "top"} className={place === "top" ? "active" : ""} onClick={() => setPlace("top")} disabled={busy}><ArrowUpToLine aria-hidden="true" />Top</button>
      <button role="radio" aria-checked={place === "bottom"} className={place === "bottom" ? "active" : ""} onClick={() => setPlace("bottom")} disabled={busy}><ArrowDownToLine aria-hidden="true" />Bottom</button>
    </div>
    <FormError message={error} className="file-dialog-error" />
    <footer className="file-dialog-actions">
      <button className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button className="primary-button" onClick={() => { void confirmAction(); }} disabled={!target || busy}>{busy ? "Moving…" : target ? `Move to ${place === "top" ? "top" : "bottom"} of ${target.name}` : "Move"}</button>
    </footer>
  </ModalDialog>;
}
