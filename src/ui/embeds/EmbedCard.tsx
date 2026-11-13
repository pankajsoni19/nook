import type { ReactNode } from "react";
import { Lock, type LucideIcon } from "lucide-react";
import "../workspace.css";

/**
 * The frame of every live embed in a note or a card description (§B.4.4, §E.3, D835): the kind's icon,
 * the item's current title (as the reader may see it), a short line, one action ("Vote", "Respond",
 * "Open", "Book"), and the module's live body (a poll's options, a goal's progress). A reader who
 * cannot open the item sees "<Word> unavailable" and nothing about it (T513). Module renderers wrap
 * their content in it; the editor only knows the registry.
 */
export function EmbedCard({ icon: Icon, word, title, subtitle, action, unavailable = false, loading = false, children }: {
  icon: LucideIcon;
  /** The kind's neutral word ("Poll"). */
  word: string;
  title?: string;
  subtitle?: string;
  action?: { label: string; onClick: () => void; primary?: boolean };
  unavailable?: boolean;
  loading?: boolean;
  children?: ReactNode;
}) {
  if (unavailable) return <div className="ui-embed" role="group" aria-label={`${word} unavailable`}>
    <div className="ui-embed-head">
      <span className="ui-embed-icon unavailable" aria-hidden="true"><Lock /></span>
      <span className="ui-embed-copy"><strong>{word} unavailable</strong><small>It was deleted, or it is not shared with you.</small></span>
    </div>
  </div>;
  if (loading) return <div className="ui-embed" role="status" aria-label={`Loading ${word.toLowerCase()}`}>
    <div className="ui-embed-head"><span className="ui-embed-icon" aria-hidden="true"><Icon /></span><span className="ui-embed-copy"><strong>Loading {word.toLowerCase()}…</strong></span></div>
  </div>;
  return <div className="ui-embed" role="group" aria-label={title ? `${word}: ${title}` : word}>
    <div className="ui-embed-head">
      <span className="ui-embed-icon" aria-hidden="true"><Icon /></span>
      <span className="ui-embed-copy"><strong title={title}>{title ?? word}</strong><small>{subtitle ?? word}</small></span>
      {action && <button type="button" className={action.primary ? "action-button" : "secondary-button"} onClick={action.onClick} onMouseDown={(event) => event.preventDefault()}>{action.label}</button>}
    </div>
    {children}
  </div>;
}
