import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { CalendarDays, ChartGantt, Columns3, List, Table2 } from "lucide-react";
import type { BoardViewId } from "./boardUrl";

type ViewChoice = { id: BoardViewId; label: string; icon: ReactNode };

export const VIEW_CHOICES: ViewChoice[] = [
  { id: "board", label: "Columns", icon: <Columns3 /> },
  { id: "table", label: "Table", icon: <Table2 /> },
  { id: "list", label: "List", icon: <List /> },
  { id: "calendar", label: "Calendar", icon: <CalendarDays /> },
  { id: "timeline", label: "Timeline", icon: <ChartGantt /> }
];

type BoardViewSwitchProps = {
  value: BoardViewId;
  onChange: (view: BoardViewId) => void;
  views?: readonly BoardViewId[];
};

/**
 * The board header's view switch: a radio group of icon buttons (§4.5). Arrow keys move between
 * views with a roving tab stop, as radio groups do. Each switch pushes a history entry (the
 * caller decides), so Back returns to the previous view.
 */
export function BoardViewSwitch({ value, onChange, views = VIEW_CHOICES.map((choice) => choice.id) }: BoardViewSwitchProps) {
  const choices = VIEW_CHOICES.filter((choice) => views.includes(choice.id));
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    const target = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : step ? (index + step + choices.length) % choices.length : -1;
    if (target < 0) return;
    event.preventDefault();
    refs.current[target]?.focus();
    onChange(choices[target]!.id);
  }

  return <div className="task-view-switch" role="radiogroup" aria-label="View">
    {choices.map((choice, index) => {
      const checked = choice.id === value;
      return <button key={choice.id} ref={(element) => { refs.current[index] = element; }} type="button" role="radio" aria-checked={checked}
        tabIndex={checked ? 0 : -1} className={`icon-button${checked ? " active" : ""}`} aria-label={choice.label} title={`${choice.label} view`}
        onClick={() => { if (!checked) onChange(choice.id); }} onKeyDown={(event) => onKeyDown(event, index)}>
        {choice.icon}
      </button>;
    })}
  </div>;
}
