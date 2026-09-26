import { Timer } from "lucide-react";
import { levelName, type BoardStructure } from "../../shared/boardStructure";
import { Select } from "../ui/Select";
import { effectiveSprints, openSprints, sprintDateRange } from "./sprintModel";
import type { CardChange, CardDetail, CardSummary, SprintSummary } from "./tasksApi";

const BACKLOG = "backlog";

type SprintSelectProps = {
  sprints: readonly SprintSummary[];
  /** The stored sprint, or null for the backlog. */
  value: string | null;
  onChange: (sprintId: string | null) => void;
  idPrefix: string;
  disabled?: boolean;
};

/**
 * The Sprint field (research 2026-09-26 §7.2, 17B): a Select with Backlog, the active sprint
 * (marked), and planned sprints. A card in a completed sprint shows it, disabled, until moved.
 */
export function SprintSelect({ sprints, value, onChange, idPrefix, disabled = false }: SprintSelectProps) {
  const current = value ? sprints.find((sprint) => sprint.id === value) : undefined;
  const options = [
    { value: BACKLOG, label: "Backlog", description: "No sprint" },
    ...openSprints(sprints).map((sprint) => ({ value: sprint.id, label: sprint.name, description: [sprint.state === "active" ? "Active" : "Planned", sprintDateRange(sprint)].filter(Boolean).join(" · ") })),
    ...(current && current.state === "completed" ? [{ value: current.id, label: current.name, description: "Completed", disabled: true }] : [])
  ];
  return <div className="task-card-field">
    <label id={`${idPrefix}-sprint-label`}><Timer aria-hidden="true" />Sprint</label>
    <Select id={`${idPrefix}-sprint`} labelledBy={`${idPrefix}-sprint-label`} label="Sprint" value={value ?? BACKLOG} options={options} disabled={disabled} searchable="auto"
      onChange={(next) => onChange(next === BACKLOG ? null : next)} />
  </div>;
}

type CardSprintFieldProps = {
  card: CardDetail;
  structure: BoardStructure;
  /** The board's loaded cards, for the sprint a lower-level card inherits. */
  cards: readonly CardSummary[];
  sprints: readonly SprintSummary[];
  idPrefix: string;
  saving: boolean;
  onSave: (change: Pick<CardChange, "sprintId">, success: string) => Promise<boolean>;
  /** A read-only Team role: the sprint shows as text. */
  readOnly?: boolean;
};

/**
 * The card dialog's Sprint field (§7.2): editable on a work-level card of a board with sprints on;
 * below the work level, read-only "Sprint 12 (from its task)", since the sprint follows the parent
 * (D124); hidden above the work level and on boards without sprints.
 */
export function CardSprintField({ card, structure, cards, sprints, idPrefix, saving, onSave, readOnly = false }: CardSprintFieldProps) {
  if (!structure.sprints) return null;
  const level = card.level ?? 0;
  if (level < structure.workLevel) return null;
  if (level > structure.workLevel) {
    const inherited = effectiveSprints([...cards.filter((item) => item.id !== card.id), card], structure.workLevel).find((item) => item.id === card.id)?.sprint_id ?? null;
    const sprint = inherited ? sprints.find((item) => item.id === inherited) : undefined;
    const parent = levelName(structure, structure.workLevel).toLowerCase();
    return <div className="task-card-field">
      <label id={`${idPrefix}-sprint-label`}><Timer aria-hidden="true" />Sprint</label>
      <p className="task-sprint-inherited" aria-labelledby={`${idPrefix}-sprint-label`}>{sprint ? sprint.name : inherited ? "An older sprint" : "Backlog"} <small>(from its {parent})</small></p>
    </div>;
  }
  const value = card.sprint_id ?? null;
  if (readOnly) {
    const sprint = value ? sprints.find((item) => item.id === value) : undefined;
    return <div className="task-card-field">
      <label id={`${idPrefix}-sprint-label`}><Timer aria-hidden="true" />Sprint</label>
      <p className="task-sprint-inherited" aria-labelledby={`${idPrefix}-sprint-label`}>{sprint ? sprint.name : value ? "An older sprint" : "Backlog"}</p>
    </div>;
  }
  return <SprintSelect sprints={sprints} value={value} idPrefix={idPrefix} disabled={saving}
    onChange={(sprintId) => {
      if (sprintId === value) return;
      const name = sprintId ? sprints.find((sprint) => sprint.id === sprintId)?.name ?? "the sprint" : "the backlog";
      void onSave({ sprintId }, `Moved to ${name}`);
    }} />;
}
