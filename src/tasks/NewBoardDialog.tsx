import { useEffect, useId, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { BOARD_TEMPLATES, structureLabel, TEMPLATES, type BoardTemplateId } from "../../shared/boardStructure";
import { BOARD_CODE_MAX, boardCodeMessage, normalizeBoardCode, suggestBoardCode } from "../../shared/boardKeys";
import { validateBoardName } from "./taskActions";
import { suggestBoardCode as fetchCodeSuggestion, taskErrorCode } from "./tasksApi";
import { ApiError } from "../api";
import { FormError } from "../ui/FormError";

type NewBoardDialogProps = {
  onSubmit: (name: string, template: BoardTemplateId, code: string) => Promise<void>;
  onCancel: () => void;
  /** Test seam: the server's free-code suggestion for a name (D711). */
  suggest?: (name: string, signal: AbortSignal) => Promise<string>;
};

const serverSuggestion = (name: string, signal: AbortSignal) => fetchCodeSuggestion(name, signal).then((result) => result.code);

/**
 * "New board" (research 2026-09-26 §7.4, D136): a name, a code, and a template. Each template shows
 * its columns and structure in one line; everything can be changed later in Board settings. A dialog
 * on desktop and a full-screen sheet on phones; the list's dialog guard closes it on Back.
 *
 * The code (lane KEYS, D711) follows the name ("My tasks" → MYT, made free by the server: MYT2 when
 * MYT is taken) until the person types their own; a taken code comes back with a free suggestion.
 */
export function NewBoardDialog({ onSubmit, onCancel, suggest = serverSuggestion }: NewBoardDialogProps) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<BoardTemplateId>("kanban");
  const [touched, setTouched] = useState(false);
  const [code, setCode] = useState("");
  const [codeEdited, setCodeEdited] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const check = validateBoardName(name);
  const shown = error ?? (touched && !check.ok ? check.error : null);

  // The code follows the name until edited: the local suggestion at once, the server's free one soon after.
  useEffect(() => {
    if (codeEdited) return;
    const trimmed = name.trim();
    setCode(trimmed ? suggestBoardCode(trimmed) : "");
    if (!trimmed) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      suggest(trimmed, controller.signal).then((free) => { if (!controller.signal.aborted) setCode(free); }, () => undefined);
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [name, codeEdited, suggest]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!check.ok) return;
    const normalized = normalizeBoardCode(code || suggestBoardCode(check.name));
    if (!normalized) {
      setCodeError(boardCodeMessage);
      return;
    }
    setBusy(true);
    setError(null);
    setCodeError(null);
    try {
      await onSubmit(check.name, template, normalized);
    } catch (reason) {
      if (taskErrorCode(reason) === "CODE_TAKEN" || taskErrorCode(reason) === "CODE_INVALID") {
        const suggestion = reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as { suggestion?: unknown }).suggestion : undefined;
        setCodeError(typeof suggestion === "string" ? `${reason instanceof Error ? reason.message : "That code is taken"}. ${suggestion} is free.` : reason instanceof Error ? reason.message : boardCodeMessage);
        if (typeof suggestion === "string") setCode(suggestion);
        setCodeEdited(true);
      } else {
        setError(reason instanceof Error ? reason.message : "Could not create the board");
      }
      setBusy(false);
    }
  }

  return <ModalDialog title="New board" eyebrow="Tasks" onClose={onCancel} busy={busy} variant="sheet">
    <form className="file-dialog-form task-new-board" onSubmit={submit} noValidate>
      <label htmlFor={inputId}>Board name</label>
      <input id={inputId} value={name} autoFocus autoComplete="off" maxLength={200} aria-invalid={shown ? true : undefined}
        onChange={(event) => { setName(event.target.value); setTouched(true); setError(null); }} />
      <FormError message={shown} className="file-dialog-error" />
      <label htmlFor={`${inputId}-code`}>Code</label>
      <input id={`${inputId}-code`} className="task-board-code-input" value={code} autoComplete="off" spellCheck={false} maxLength={BOARD_CODE_MAX}
        aria-describedby={`${inputId}-code-hint`} aria-invalid={codeError ? true : undefined} disabled={busy}
        onChange={(event) => { setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")); setCodeEdited(true); setCodeError(null); }} />
      <small id={`${inputId}-code-hint`} className="task-settings-note">Card keys start with it: {normalizeBoardCode(code) ?? "MYT"}-1, {normalizeBoardCode(code) ?? "MYT"}-2. {BOARD_CODE_MAX} letters or digits at most.</small>
      <FormError message={codeError} className="file-dialog-error" />
      <span className="task-template-label" id={`${inputId}-templates`}>Start from</span>
      <div className="task-template-grid" role="radiogroup" aria-labelledby={`${inputId}-templates`}>
        {BOARD_TEMPLATES.map((id) => {
          const item = TEMPLATES[id];
          const checked = template === id;
          return <button key={id} type="button" role="radio" aria-checked={checked} className={`task-preset task-template${checked ? " active" : ""}`} disabled={busy} onClick={() => setTemplate(id)}>
            <span className="task-preset-copy">
              <strong>{item.label}</strong>
              <small>{item.description}</small>
              <small className="task-template-columns">{item.columns.map((column) => column.name).join(" · ")}{item.structure.levels.length > 1 || item.structure.sprints ? ` — ${structureLabel(item.structure)}` : ""}</small>
            </span>
            {checked && <Check className="task-preset-check" aria-hidden="true" />}
          </button>;
        })}
      </div>
      <p className="task-settings-note">Templates set columns and levels only; they add no cards. Change anything later in Board settings.</p>
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Creating…" : "Create board"}</button>
      </footer>
    </form>
  </ModalDialog>;
}
