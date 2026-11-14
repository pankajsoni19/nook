import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import "./workspace.css";

export type EmptyStateAction = { label: string; onClick: () => void; icon?: LucideIcon; disabled?: boolean };

/**
 * The one empty state (§E.1.3, D830): the module's icon, one sentence, and at most one action —
 * "No goals in Q1 2027." + **New goal**. `compact` drops the frame (inside a card or a side panel).
 * The heading level is the caller's (`as`), so it sits correctly in each page's outline.
 */
export function EmptyState({ icon: Icon, title, children, action, compact = false, as: Heading = "h2" }: {
  icon: LucideIcon;
  title: string;
  /** One sentence of help under the title (optional). */
  children?: ReactNode;
  action?: EmptyStateAction;
  compact?: boolean;
  as?: "h2" | "h3" | "h4";
}) {
  const ActionIcon = action?.icon;
  return <div className={`ui-empty${compact ? " compact" : ""}`} role="status">
    <span className="ui-empty-icon" aria-hidden="true"><Icon /></span>
    <Heading className="ui-empty-title">{title}</Heading>
    {children && <p className="ui-empty-text">{children}</p>}
    {action && <button type="button" className="action-button" onClick={action.onClick} disabled={action.disabled}>{ActionIcon && <ActionIcon aria-hidden="true" />}{action.label}</button>}
  </div>;
}
