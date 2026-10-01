import { useEffect } from "react";
import { Bookmark, KanbanSquare, UserCheck } from "lucide-react";
import { appName } from "../../appName";

export type HomeSegment = "boards" | "my" | "views";

const SEGMENTS: Array<{ id: HomeSegment; label: string; icon: typeof Bookmark }> = [
  { id: "boards", label: "Boards", icon: KanbanSquare },
  { id: "my", label: "My work", icon: UserCheck },
  { id: "views", label: "Views", icon: Bookmark }
];

/**
 * Boards · My work · Views (§9.2, the Calendar Agenda/Month idiom). Each segment is a route, so a
 * tap pushes an entry and Back returns to the previous segment (§9.5).
 */
export function HomeSegments({ active, onSelect }: { active: HomeSegment; onSelect: (segment: HomeSegment) => void }) {
  return <nav className="task-home-segments" aria-label="Tasks sections">
    {SEGMENTS.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={id === active ? "active" : undefined} aria-current={id === active ? "page" : undefined}
      onClick={() => { if (id !== active) onSelect(id); }}><Icon aria-hidden="true" />{label}</button>)}
  </nav>;
}

/**
 * The document title for a Tasks home route ("My work · Tasks · Nook"). App sets "Tasks · Nook"
 * when the app opens, in an effect that runs after this one, so this one writes again on the next
 * task. Leaving (a board or a card from a view) puts back the app's "Tasks · Nook".
 */
export function useTasksTitle(title: string | null) {
  useEffect(() => {
    if (title === null) return undefined;
    const text = `${title} · ${appName()}`;
    document.title = text;
    const timer = window.setTimeout(() => { document.title = text; }, 0);
    return () => {
      window.clearTimeout(timer);
      if (document.title === text) document.title = `Tasks · ${appName()}`;
    };
  }, [title]);
}
