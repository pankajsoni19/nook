import { useEffect, useState } from "react";
import { ModalDialog } from "../../files/Dialog";
import { sheetMoveAnchor } from "../boardOrder";
import { MoveCardSheet } from "../MoveCardSheet";
import { columnFullMessage } from "../taskActions";
import { getBoard, moveCard, taskErrorCode, taskErrorMessage, type BoardDetail, type CardSummary } from "../tasksApi";
import { columnState, type QueriedCard, type StatefulColumn } from "./homeApi";
import { STATE_LABELS } from "./homeResults";

type ResultMoveSheetProps = {
  card: QueriedCard;
  onMoved: (change: Partial<QueriedCard>, message: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
};

/**
 * "Move to…" for a card in cross-board results (Q9, D143: no drag between state lanes). It loads
 * the card's board for its columns, then moves with the board's own move call and WIP rules.
 */
/** "Moved to Review (In progress)"; "Moved to Done" when the column is named for its state (QA 0.9.0). */
export const movedMessage = (columnName: string, stateLabel: string) =>
  columnName.trim().toLowerCase() === stateLabel.toLowerCase() ? `Moved to ${columnName}` : `Moved to ${columnName} (${stateLabel})`;

export function ResultMoveSheet({ card, onMoved, onCancel, onError }: ResultMoveSheetProps) {
  const [board, setBoard] = useState<BoardDetail | null>(null);
  useEffect(() => {
    let active = true;
    getBoard(card.board_id).then((detail) => { if (active) setBoard(detail); }, (reason) => {
      if (active) onError(taskErrorMessage(reason, "Could not load the card’s board"));
    });
    return () => { active = false; };
  }, [card.board_id, onError]);

  if (!board) return <ModalDialog title={`Move “${card.title}”`} eyebrow={card.board_name} onClose={onCancel}><p className="file-dialog-copy" role="status">Loading the board…</p></ModalDialog>;
  const summary = board.cards.find((item) => item.id === card.id) ?? (card as unknown as CardSummary);
  return <MoveCardSheet card={summary} columns={[...board.columns].sort((a, b) => a.position - b.position)} cards={board.cards} onCancel={onCancel} onMove={async (columnId, place) => {
    try {
      await moveCard(card.id, columnId, sheetMoveAnchor(board.cards, card.id, columnId, place));
      const column = board.columns.find((item) => item.id === columnId) as StatefulColumn | undefined;
      const state = column ? columnState(column) : card.column_state;
      onMoved({ column_id: columnId, column_name: column?.name ?? card.column_name, column_state: state, is_done: state === "done" ? 1 : 0 }, movedMessage(column?.name ?? "the column", STATE_LABELS[state]));
    } catch (reason) {
      const column = board.columns.find((item) => item.id === columnId);
      // The sheet stays open and shows why.
      throw new Error(taskErrorCode(reason) === "COLUMN_FULL" ? columnFullMessage(column?.name ?? "This column", column?.wip_limit) : taskErrorMessage(reason, "Could not move the card"));
    }
  }} />;
}
