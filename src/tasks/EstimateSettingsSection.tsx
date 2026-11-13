import { useState } from "react";
import { Gauge } from "lucide-react";
import { Select } from "../ui/Select";
import { FormError } from "../ui/FormError";
import type { Notifier } from "../ui/notify";
import { ESTIMATE_KIND_LABELS, ESTIMATE_KINDS, ESTIMATE_SCALE_LABELS, ESTIMATE_SCALES, estimateSettingsOf, type EstimateKind, type EstimateScale, type EstimateSettings } from "../../shared/estimates";
import { setBoardEstimates, taskErrorMessage, type BoardSummary } from "./tasksApi";

const KIND_DESCRIPTIONS: Record<EstimateKind, string> = {
  none: "No estimate field on cards",
  points: "Relative size, summed per column and sprint",
  hours: "Expected hours, like 3 or 1.5"
};
const SCALE_DESCRIPTIONS: Record<EstimateScale, string> = {
  fibonacci: "Pick from chips; the gaps grow with the size",
  free: "Type any number from 0 to 999"
};

/** One line on what the settings mean, for everyone who cannot change them. */
export function estimateSummary(settings: EstimateSettings) {
  if (settings.kind === "none") return "Cards have no estimates on this board.";
  if (settings.kind === "hours") return "Cards are estimated in hours. Columns and sprints show the totals.";
  return `Cards are estimated in story points (${settings.scale === "fibonacci" ? "Fibonacci: 0, 1, 2, 3, 5, 8, 13, 21" : "any number"}). Columns and sprints show the totals.`;
}

/**
 * What changing from `saved` to `draft` does to the values cards already have (D752): never
 * rewritten, but hidden, shown again, reinterpreted (points ↔ hours), or left off a new scale.
 */
export function estimateChangeNotes(saved: EstimateSettings, draft: EstimateSettings) {
  const notes: string[] = [];
  if (draft.kind === "none" && saved.kind !== "none") notes.push("Estimates already on cards are hidden, not deleted: turning estimates back on shows them again.");
  if (saved.kind !== "none" && draft.kind !== "none" && saved.kind !== draft.kind) {
    notes.push(`Values are not converted: a card estimated at 5 ${saved.kind === "points" ? "points" : "hours"} will show 5 ${draft.kind === "points" ? "points" : "hours"}.`);
  }
  if (draft.kind === "points" && draft.scale === "fibonacci" && (saved.kind !== "points" || saved.scale !== "fibonacci")) {
    notes.push("Values off the Fibonacci scale stay as they are until someone picks a new one.");
  }
  return notes;
}

type EstimateSettingsSectionProps = {
  board: BoardSummary;
  /** The owner or a manager (D273), as for the board's other settings. */
  owner: boolean;
  notify: Notifier;
  /** Saved: the board summary as the server returned it. */
  onSaved?: (board: BoardSummary) => void;
};

/**
 * Board settings → Estimates (lane ESTIMATES, D750–D752): the owner or a manager chooses what a
 * card's estimate means here (Off, Story points, or Hours) and, for points, the scale (Fibonacci or
 * any number). Saved on its own, like Done cards. Changing the kind warns what happens to the
 * values cards already hold; everyone else reads a one-line summary.
 */
export function EstimateSettingsSection({ board, owner, notify, onSaved }: EstimateSettingsSectionProps) {
  const saved = estimateSettingsOf(board);
  const [draft, setDraft] = useState<EstimateSettings>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft.kind !== saved.kind || (draft.kind === "points" && draft.scale !== saved.scale);
  const notes = dirty ? estimateChangeNotes(saved, draft) : [];
  // An older server sends no estimate fields: it cannot store them.
  if (board.estimate_kind === undefined) return null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { board: updated } = await setBoardEstimates(board.id, { estimateKind: draft.kind, ...(draft.kind === "points" ? { estimateScale: draft.scale } : {}) });
      onSaved?.(updated);
      const next = estimateSettingsOf(updated);
      setDraft(next);
      notify.success(next.kind === "none" ? "Estimates are off" : next.kind === "hours" ? "Cards are estimated in hours" : "Cards are estimated in story points");
    } catch (reason) {
      setError(taskErrorMessage(reason, "Could not save the estimates"));
    } finally {
      setBusy(false);
    }
  }

  return <section className="task-settings-section" aria-labelledby={`estimates-${board.id}`}>
    <h3 id={`estimates-${board.id}`}><Gauge aria-hidden="true" />Estimates</h3>
    {!owner && <p className="task-settings-note">{estimateSummary(saved)} Only the owner or a manager changes this.</p>}
    {owner && <>
      <div className="task-card-field">
        <label id={`estimates-${board.id}-kind`}>Estimate cards in</label>
        <Select<EstimateKind> labelledBy={`estimates-${board.id}-kind`} label="Estimate cards in" value={draft.kind} disabled={busy} searchable={false}
          options={ESTIMATE_KINDS.map((kind) => ({ value: kind, label: ESTIMATE_KIND_LABELS[kind], description: KIND_DESCRIPTIONS[kind] }))}
          onChange={(kind) => { setDraft({ ...draft, kind }); setError(null); }} />
      </div>
      {draft.kind === "points" && <div className="task-card-field">
        <label id={`estimates-${board.id}-scale`}>Points scale</label>
        <Select<EstimateScale> labelledBy={`estimates-${board.id}-scale`} label="Points scale" value={draft.scale} disabled={busy} searchable={false}
          options={ESTIMATE_SCALES.map((scale) => ({ value: scale, label: ESTIMATE_SCALE_LABELS[scale], description: SCALE_DESCRIPTIONS[scale] }))}
          onChange={(scale) => { setDraft({ ...draft, scale }); setError(null); }} />
      </div>}
      {notes.map((note) => <p key={note} className="task-settings-note task-estimate-warning" role="note">{note}</p>)}
      <FormError message={error} className="file-dialog-error" />
      {dirty && <span className="task-settings-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setDraft(saved); setError(null); }}>Reset</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => { void save(); }}>{busy ? "Saving…" : "Save"}</button>
      </span>}
    </>}
  </section>;
}
