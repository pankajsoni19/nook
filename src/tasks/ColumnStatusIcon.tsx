import { columnState, type StatefulColumn } from "./home/homeApi";

/**
 * A column's status icon (D629–D631): a small circle left of the column's name that reads its state
 * and how far along the board it is, from the leftmost column to the rightmost.
 *
 * - `backlog`: the leftmost To do column, when the board has two or more (a dashed, muted circle);
 * - `todo`: any other To do column (an empty, muted circle);
 * - `doing`: an In progress column, a ring with a pie filled by its place among the In progress
 *   columns (1 of 3 → ¼, 2 of 3 → ½, 3 of 3 → ¾; one alone → ½), in the progress yellow;
 * - `done`: a Done column, a filled green circle with a check.
 *
 * It derives from each column's existing `state` and board order: no new data.
 */
export type ColumnStatusKind = "backlog" | "todo" | "doing" | "done";
export type ColumnStatus = { kind: ColumnStatusKind; step: number; steps: number; label: string };

/** Every column's status, by column id; `columns` in board order. */
export function columnStatuses(columns: readonly StatefulColumn[]): Map<string, ColumnStatus> {
  const states = columns.map((column) => columnState(column));
  const todo = states.filter((state) => state === "todo").length;
  const doing = states.filter((state) => state === "doing").length;
  const result = new Map<string, ColumnStatus>();
  let todoSeen = 0;
  let doingSeen = 0;
  columns.forEach((column, index) => {
    const state = states[index];
    if (state === "done") result.set(column.id, { kind: "done", step: 1, steps: 1, label: "Done" });
    else if (state === "todo") {
      todoSeen += 1;
      const backlog = todo > 1 && todoSeen === 1;
      result.set(column.id, { kind: backlog ? "backlog" : "todo", step: todoSeen, steps: todo, label: backlog ? "Backlog" : "To do" });
    } else {
      doingSeen += 1;
      result.set(column.id, { kind: "doing", step: doingSeen, steps: doing, label: doing > 1 ? `In progress, step ${doingSeen} of ${doing}` : "In progress" });
    }
  });
  return result;
}

/** The pie wedge for `fraction` (0–1) of a circle of radius `r` around (8, 8), from twelve o'clock clockwise. */
function wedge(fraction: number, r: number) {
  const angle = 2 * Math.PI * fraction;
  const x = (8 + r * Math.sin(angle)).toFixed(3);
  const y = (8 - r * Math.cos(angle)).toFixed(3);
  return `M8 8V${8 - r}A${r} ${r} 0 ${fraction > .5 ? 1 : 0} 1 ${x} ${y}Z`;
}

/** The id of the hidden text that describes a column's status (for `aria-describedby`). */
export const columnStatusId = (columnId: string, scope = "column") => `${scope}-status-${columnId}`;

/** The icon itself: decorative (`aria-hidden`); the status is read from `ColumnStatusText`, and shown as a tooltip. */
export function ColumnStatusIcon({ status }: { status: ColumnStatus }) {
  const { kind } = status;
  return <svg className={`task-column-status ${kind}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-status={kind}>
    <title>{status.label}</title>
    {kind === "backlog" && <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.6 2.31" />}
    {kind === "todo" && <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />}
    {kind === "doing" && <>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d={wedge(status.step / (status.steps + 1), 3.5)} fill="currentColor" />
    </>}
    {kind === "done" && <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M5 8.2 7.1 10.3 11 6.2" fill="none" stroke="var(--task-status-check, #121214)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>}
  </svg>;
}

/** The status in words, hidden on screen, for `aria-describedby` on the column, its strip, or its tab. */
export const ColumnStatusText = ({ id, status }: { id: string; status: ColumnStatus }) => <span id={id} hidden>{status.label}</span>;
