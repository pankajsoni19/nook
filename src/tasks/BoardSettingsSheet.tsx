import type { Notifier } from "../ui/notify";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Archive, Check, Columns3, Layers, Mail, Minus, Pencil, Plus, Share2, Trash2, X } from "lucide-react";
import { MuteEmailsToggle } from "../notifications/emailMutes";
import { trapTabKey, useDialogFocus } from "../files/Dialog";
import { Select } from "../ui/Select";
import {
  LEVEL_NAME_MAX,
  MAX_LEVELS,
  PRESETS,
  presetOf,
  STRUCTURE_PRESETS,
  structureLabel,
  validateStructure,
  type BoardStructure,
  type StructurePreset
} from "../../shared/boardStructure";
import { structureOf } from "./hierarchyModel";
import { setAutoArchiveDays, taskErrorMessage, updateBoardStructure, type BoardSummary } from "./tasksApi";
import { FormError } from "../ui/FormError";

type BoardSettingsSheetProps = {
  board: BoardSummary;
  /** The owner or a manager (Wave 32, D273): rename, structure, columns, sharing. */
  owner: boolean;
  /** The owner alone: deleting the board. Defaults to `owner`. */
  isOwner?: boolean;
  /** Per viewer (D126): show epics and nested subtasks as board cards. */
  showAllLevels: boolean;
  onShowAllLevels: (value: boolean) => void;
  /** Per viewer, saved to their own view of the board (D606): list auto-archived cards, marked. */
  showArchived?: boolean;
  onShowArchived?: (value: boolean) => void;
  /** Auto-archive saved (D604): the board summary as the server returned it. */
  onBoardSaved?: (board: BoardSummary) => void;
  onClose: () => void;
  /** A dialog is open over the sheet (Complete sprint): it handles Escape, and the sheet waits. */
  suspended?: boolean;
  /** The owner's actions that open their own dialogs. */
  onRename: () => void;
  onShare: () => void;
  onDelete: () => void;
  onAddColumn: () => void;
  onStructureSaved: (board: BoardSummary) => void;
  /** Board settings → Sprint defaults (17B), shown when the saved structure has sprints on. The sprint list is the Sprints sheet. */
  sprintsSection?: ReactNode;
  notify: Notifier;
};

/** The structure without its sprint defaults: what Save structure compares and sends. */
const levelsOnly = ({ levels, workLevel, sprints }: BoardStructure): BoardStructure => ({ levels, workLevel, sprints });

/** "Columns show Stories. Subtasks appear inside their story." */
export function structurePreview(structure: BoardStructure) {
  const work = structure.levels[structure.workLevel]!;
  const parts = [`Columns show ${work.plural}.`];
  const below = structure.levels[structure.workLevel + 1];
  if (below) parts.push(`${below.plural} appear inside their ${work.name.toLowerCase()}.`);
  const above = structure.levels[structure.workLevel - 1];
  if (above) parts.push(`${above.plural} show as a chip on each ${work.name.toLowerCase()}.`);
  if (structure.sprints) parts.push(below ? `${work.plural} are planned in sprints; their ${below.plural.toLowerCase()} follow them.` : `${work.plural} are planned in sprints.`);
  return parts.join(" ");
}

/**
 * Board settings (research 2026-09-26 §7.1, §9): General, Structure, Display, Columns, Sharing, and
 * Delete in one sheet that replaced the owner icons in the board header. A full-height sheet at
 * 390 px and a right-hand panel on desktop; the board's dialog guard closes it on Back (D69). Only
 * the owner edits; everyone sees the structure and the per-viewer display option.
 */
export function BoardSettingsSheet({ board, owner, isOwner = owner, showAllLevels, onShowAllLevels, showArchived = false, onShowArchived, onBoardSaved, onClose, onRename, onShare, onDelete, onAddColumn, onStructureSaved, notify, sprintsSection, suspended = false }: BoardSettingsSheetProps) {
  const saved = structureOf(board);
  const [draft, setDraft] = useState<BoardStructure>(saved);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  // Take focus on open (QA 0.9.0): the gear kept it and Tab walked the board behind the sheet.
  const panelRef = useRef<HTMLElement>(null);
  useDialogFocus(panelRef);
  const preset = presetOf(draft);
  // Sprint defaults are saved on their own (Sprint defaults below); a structure save leaves them be.
  const dirty = JSON.stringify(levelsOnly(draft)) !== JSON.stringify(levelsOnly(saved));
  const check = validateStructure(draft);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || suspended) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, suspended]);

  const update = (next: BoardStructure) => {
    setDraft(next);
    setError(null);
  };
  const choosePreset = (id: StructurePreset | "custom") => {
    if (id === "custom") {
      // Custom is any names you type: start with the first level's name.
      window.document.getElementById(`${titleId}-level-0`)?.focus();
      return;
    }
    update(PRESETS[id].structure);
  };
  const setLevel = (index: number, field: "name" | "plural", value: string) =>
    update({ ...draft, levels: draft.levels.map((level, at) => at === index ? { ...level, [field]: value } : level) });

  async function save() {
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    try {
      // Without `sprintDefaults` the server keeps the stored ones.
      const { board: next } = await updateBoardStructure(board.id, levelsOnly(check.structure));
      onStructureSaved(next);
      setDraft(structureOf(next));
      notify.success(`Structure saved: ${structureLabel(structureOf(next))}`);
    } catch (reason) {
      // LEVEL_IN_USE and SPRINTS_IN_USE explain themselves (T120).
      setError(taskErrorMessage(reason, "Could not save the structure"));
    } finally {
      setBusy(false);
    }
  }

  const workOptions = draft.levels.map((level, index) => ({ value: String(index), label: level.name || `Level ${index + 1}` }));

  return <>
    <button className="panel-scrim" onClick={onClose} aria-label="Close board settings" tabIndex={-1} />
    <aside ref={panelRef} tabIndex={-1} className="side-panel task-settings-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trapTabKey}>
      <header>
        <div><span className="eyebrow">{board.name}</span><h2 id={titleId}>Board settings</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close board settings"><X /></button>
      </header>
      <div className="task-settings-body">
        <section className="task-settings-section" aria-labelledby={`${titleId}-general`}>
          <h3 id={`${titleId}-general`}>General</h3>
          <div className="task-settings-row">
            <span><strong title={board.name}>{board.name}</strong><small>{isOwner ? "You own this board" : owner ? `${board.owner_name}’s board · you manage it` : `${board.owner_name}’s board`}</small></span>
            {owner && <button className="secondary-button task-small-button" onClick={onRename}><Pencil />Rename</button>}
          </div>
        </section>

        <section className="task-settings-section" aria-labelledby={`${titleId}-structure`}>
          <h3 id={`${titleId}-structure`}><Layers aria-hidden="true" />Structure</h3>
          {!owner && <p className="task-settings-note">{structureLabel(saved)}. {structurePreview(saved)} Only the owner or a manager changes the structure.</p>}
          {owner && <>
            <div className="task-preset-grid" role="radiogroup" aria-label="Structure preset">
              {[...STRUCTURE_PRESETS, "custom" as const].map((id) => {
                const checked = preset === id;
                const levels = id === "custom" ? null : PRESETS[id].structure;
                return <button key={id} type="button" role="radio" aria-checked={checked} className={`task-preset${checked ? " active" : ""}`} disabled={busy}
                  onClick={() => choosePreset(id)}>
                  <span className="task-preset-diagram" aria-hidden="true">
                    {(levels ? [...(levels.sprints ? ["Sprint"] : []), ...levels.levels.map((level) => level.name)] : ["…"]).map((name, index) =>
                      <span key={`${name}-${index}`} style={{ marginLeft: `${index * 8}px` }}>{name}</span>)}
                  </span>
                  <span className="task-preset-copy"><strong>{id === "custom" ? "Custom" : PRESETS[id].label}</strong><small>{id === "custom" ? "Your own level names below." : PRESETS[id].description}</small></span>
                  {checked && <Check className="task-preset-check" aria-hidden="true" />}
                </button>;
              })}
            </div>
            <fieldset className="task-level-names" disabled={busy}>
              <legend>Level names</legend>
              {draft.levels.map((level, index) => <div key={index} className="task-level-row">
                <span className="task-level-index" aria-hidden="true">{index + 1}</span>
                <input id={`${titleId}-level-${index}`} value={level.name} maxLength={LEVEL_NAME_MAX} aria-label={`Level ${index + 1} name`} placeholder="Name" onChange={(event) => setLevel(index, "name", event.target.value)} />
                <input value={level.plural} maxLength={LEVEL_NAME_MAX} aria-label={`Level ${index + 1} plural`} placeholder="Plural" onChange={(event) => setLevel(index, "plural", event.target.value)} />
              </div>)}
              <span className="task-level-buttons">
                {draft.levels.length < MAX_LEVELS && <button type="button" className="secondary-button task-small-button"
                  onClick={() => update({ ...draft, levels: [...draft.levels, { name: "Subtask", plural: "Subtasks" }] })}><Plus />Add a level below</button>}
                {draft.levels.length > 1 && <button type="button" className="secondary-button task-small-button"
                  onClick={() => update({ ...draft, levels: draft.levels.slice(0, -1), workLevel: Math.min(draft.workLevel, draft.levels.length - 2) })}><Minus />Remove the last level</button>}
              </span>
            </fieldset>
            {draft.levels.length > 1 && <div className="task-card-field">
              <label id={`${titleId}-work`}>New cards are created as</label>
              <Select labelledBy={`${titleId}-work`} label="New cards are created as" value={String(draft.workLevel)} options={workOptions} disabled={busy}
                onChange={(value) => update({ ...draft, workLevel: Number(value) })} />
            </div>}
            <label className="task-settings-toggle">
              <input type="checkbox" checked={draft.sprints} disabled={busy} onChange={(event) => update({ ...draft, sprints: event.target.checked })} />
              <span>Plan in sprints<small>“Sprint ›” groups the work in time boxes. After saving, set the sprint defaults below; add and start sprints from the header’s sprint switcher.</small></span>
            </label>
            <p className="task-settings-note" aria-live="polite">{check.ok ? structurePreview(check.structure) : check.error}</p>
            <FormError message={error} className="file-dialog-error" />
            <span className="task-settings-actions">
              {dirty && <button type="button" className="secondary-button" disabled={busy} onClick={() => update(saved)}>Reset</button>}
              <button type="button" className="primary-button" disabled={busy || !dirty || !check.ok} onClick={() => { void save(); }}>{busy ? "Saving…" : "Save structure"}</button>
            </span>
          </>}
        </section>

        {saved.sprints && sprintsSection}

        <AutoArchiveSection board={board} owner={owner} notify={notify} onSaved={onBoardSaved} titleId={titleId} />

        {(saved.levels.length > 1 || onShowArchived) && <section className="task-settings-section" aria-labelledby={`${titleId}-display`}>
          <h3 id={`${titleId}-display`}>Display</h3>
          {saved.levels.length > 1 && <label className="task-settings-toggle">
            <input type="checkbox" checked={showAllLevels} onChange={(event) => onShowAllLevels(event.target.checked)} />
            <span>Show all levels on the board<small>Only for you, on this device. Off: columns show {saved.levels[saved.workLevel]!.plural.toLowerCase()} only.</small></span>
          </label>}
          {onShowArchived && <label className="task-settings-toggle">
            <input type="checkbox" checked={showArchived} onChange={(event) => onShowArchived(event.target.checked)} />
            <span>Show archived cards<small>Only for you. They come back marked Archived; open one to restore it.{board.archived_count ? ` ${board.archived_count === 1 ? "1 card is" : `${board.archived_count} cards are`} archived on this board.` : ""}</small></span>
          </label>}
        </section>}

        <section className="task-settings-section" aria-labelledby={`${titleId}-email`}>
          <h3 id={`${titleId}-email`}><Mail aria-hidden="true" />Email</h3>
          <MuteEmailsToggle type="board" id={board.id} name={board.name} />
        </section>

        {owner && <section className="task-settings-section" aria-labelledby={`${titleId}-columns`}>
          <h3 id={`${titleId}-columns`}><Columns3 aria-hidden="true" />Columns</h3>
          <p className="task-settings-note">Each column’s ⋯ menu renames it, sets its state (To do, In progress, or Done), moves it, or sets a WIP limit.</p>
          <button className="secondary-button task-small-button" onClick={onAddColumn}><Plus />Add column</button>
        </section>}

        {owner && <section className="task-settings-section" aria-labelledby={`${titleId}-sharing`}>
          <h3 id={`${titleId}-sharing`}><Share2 aria-hidden="true" />Sharing</h3>
          <button className="secondary-button task-small-button" onClick={onShare}><Share2 />Share board…</button>
        </section>}

        {isOwner && <section className="task-settings-section" aria-labelledby={`${titleId}-delete`}>
          <h3 id={`${titleId}-delete`}>Delete</h3>
          <button className="secondary-button task-small-button danger" onClick={onDelete}><Trash2 />Move board to the Bin</button>
        </section>}
      </div>
    </aside>
  </>;
}

/**
 * Board settings → Done cards (D604): the owner or a manager turns auto-archive on or off and sets
 * the days (1–365, 30 by default); everyone else reads the rule. Saved on its own, like Sprint defaults.
 */
function AutoArchiveSection({ board, owner, notify, onSaved, titleId }: { board: BoardSummary; owner: boolean; notify: Notifier; onSaved?: (board: BoardSummary) => void; titleId: string }) {
  const savedDays = board.auto_archive_days === undefined ? 30 : board.auto_archive_days;
  const [enabled, setEnabled] = useState(savedDays !== null);
  const [days, setDays] = useState(String(savedDays ?? 30));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = /^\d+$/.test(days.trim()) ? Number(days.trim()) : NaN;
  const valid = !enabled || (parsed >= 1 && parsed <= 365);
  const next = enabled ? parsed : null;
  const dirty = next !== savedDays;
  if (board.auto_archive_days === undefined) return null;

  async function save() {
    if (!valid) {
      setError("Use a whole number of days from 1 to 365.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { board: updated } = await setAutoArchiveDays(board.id, next);
      onSaved?.(updated);
      notify.success(next === null ? "Auto-archive is off" : `Done cards are archived after ${next === 1 ? "1 day" : `${next} days`}`);
    } catch (reason) {
      setError(taskErrorMessage(reason, "Could not save auto-archive"));
    } finally {
      setBusy(false);
    }
  }

  return <section className="task-settings-section" aria-labelledby={`${titleId}-archive`}>
    <h3 id={`${titleId}-archive`}><Archive aria-hidden="true" />Done cards</h3>
    {!owner && <p className="task-settings-note">{savedDays === null
      ? "Auto-archive is off: cards stay in done columns until someone moves them."
      : `Cards in a done column for ${savedDays === 1 ? "1 day" : `${savedDays} days`} are archived: hidden from the board, never deleted.`} Only the owner or a manager changes this.</p>}
    {owner && <>
      <label className="task-settings-toggle">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => { setEnabled(event.target.checked); setError(null); }} />
        <span>Auto-archive cards in done columns<small>Hidden from the board, never deleted. A card moved out of a done column, or restored, starts over.</small></span>
      </label>
      {enabled && <div className="task-card-field task-archive-days">
        <label htmlFor={`${titleId}-archive-days`}>Archive after (days)</label>
        <input id={`${titleId}-archive-days`} className="task-settings-input" type="number" inputMode="numeric" min={1} max={365} step={1} value={days} disabled={busy}
          aria-invalid={!valid || undefined} onChange={(event) => { setDays(event.target.value); setError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter" && dirty && valid) { event.preventDefault(); void save(); } }} />
      </div>}
      <FormError message={error ?? (valid ? null : "Use a whole number of days from 1 to 365.")} className="file-dialog-error" />
      {dirty && <span className="task-settings-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setEnabled(savedDays !== null); setDays(String(savedDays ?? 30)); setError(null); }}>Reset</button>
        <button type="button" className="primary-button" disabled={busy || !valid} onClick={() => { void save(); }}>{busy ? "Saving…" : "Save"}</button>
      </span>}
    </>}
  </section>;
}
