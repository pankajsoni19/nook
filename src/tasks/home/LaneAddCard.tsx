import { useEffect, useState } from "react";
import { KanbanSquare } from "lucide-react";
import type { QueryLane } from "../../../shared/taskLanes";
import { ModalDialog } from "../../files/Dialog";
import { useHistoryDialogGuard } from "../../ui/useHistoryDialogGuard";
import { CardComposer, type ComposerMode } from "../CardComposer";
import { structureOf } from "../hierarchyModel";
import { applyTagChange } from "../cardTags";
import type { TaskNotify } from "../taskActions";
import { getBoard, taskErrorMessage, type BoardDetail, type CardDetail } from "../tasksApi";
import type { LaneAddTarget } from "./laneModel";

type LaneAddCardProps = {
  lane: QueryLane;
  /** The boards this lane can take a new card on (laneAddTargets), at least one. */
  targets: LaneAddTarget[];
  userId: string;
  notify: TaskNotify;
  onClose: () => void;
  onCreated: (card: CardDetail, board: BoardDetail, mode: ComposerMode) => void;
};

/**
 * Add a card on a cross-board lane (lane VIEWS2, D654): with more than one board that can take it,
 * a sheet asks which; then that board's composer opens on the lane's column, or with the lane's
 * person, tag, or sprint already filled in. The composer is the board's own (same fields, WIP and
 * card-cap refusals, Back asks before dropping a draft).
 */
export function LaneAddCard({ lane, targets, userId, notify, onClose, onCreated }: LaneAddCardProps) {
  const [chosen, setChosen] = useState<LaneAddTarget | null>(targets.length === 1 ? targets[0]! : null);
  const [board, setBoard] = useState<BoardDetail | null>(null);
  // The board picker is a guarded dialog: Back closes it (the composer guards itself).
  useHistoryDialogGuard(!board, onClose);

  useEffect(() => {
    if (!chosen) return;
    let active = true;
    getBoard(chosen.board.id).then((detail) => { if (active) setBoard(detail); }, (reason) => {
      if (!active) return;
      notify.error(taskErrorMessage(reason, "Could not open that board"));
      onClose();
    });
    return () => { active = false; };
  }, [chosen, notify, onClose]);

  if (!chosen) {
    return <ModalDialog title={`Add a card to ${lane.label}`} eyebrow="Choose a board" onClose={onClose}>
      <div className="move-list task-menu task-lane-add-boards">
        {targets.map((target, index) => <button key={target.board.id} type="button" className="move-option" autoFocus={index === 0} onClick={() => setChosen(target)}>
          <KanbanSquare aria-hidden="true" /><span>{target.board.name}</span>
        </button>)}
      </div>
    </ModalDialog>;
  }
  if (!board) return <ModalDialog title={`Add a card to ${lane.label}`} eyebrow={chosen.board.name} onClose={onClose}><p className="file-dialog-copy" role="status">Loading the board…</p></ModalDialog>;

  const structure = structureOf(board.board);
  const columns = [...board.columns].sort((a, b) => a.position - b.position);
  const activeSprint = structure.sprints ? board.sprints?.find((sprint) => sprint.state === "active")?.id ?? null : null;
  return <CardComposer
    boardId={board.board.id}
    boardName={board.board.name}
    userId={userId}
    columns={columns}
    cards={board.cards}
    initialColumnId={chosen.columnId}
    onClose={onClose}
    onCreated={(card, mode) => onCreated(card, board, mode)}
    notify={notify}
    tags={board.tags ?? []}
    owner={board.board.is_owner === 1}
    onTagsChange={(change) => setBoard((current) => current ? applyTagChange(current, change) : current)}
    structure={structure}
    parentCards={board.cards}
    sprints={structure.sprints ? board.sprints : undefined}
    initialSprintId={chosen.sprintId !== undefined ? chosen.sprintId : activeSprint}
    prefill={{
      ...(chosen.assignee ? { assignees: [{ ...chosen.assignee, can_read: 1 as const }] } : {}),
      ...(chosen.tagId ? { tagIds: [chosen.tagId] } : {})
    }}
  />;
}
