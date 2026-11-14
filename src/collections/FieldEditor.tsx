import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { errorCode, errorMessage, saveSchema, type CollectionDetail, type FieldType } from "./collectionsApi";
import { draftKey, fromDrafts, moveDraft, newFieldDraft, toDrafts, typeChoices, validateDrafts, type FieldDraft } from "./fieldDrafts";
import { FieldIcon } from "./icons";
import { FIELD_TYPE_LABELS, OPTION_COLORS } from "./values";
import { Select } from "../ui/Select";

const colorOptions = OPTION_COLORS.map((color) => ({ value: color, label: color[0]!.toUpperCase() + color.slice(1), swatch: color }));

type FieldEditorProps = {
  collection: CollectionDetail;
  onSaved: (collection: CollectionDetail) => void;
  onReload: () => void;
  onClose: () => void;
};

const ALL_TYPES = Object.keys(FIELD_TYPE_LABELS) as FieldType[];

// Owner-only field editor: rename, retype (text ↔ link, select → multi-select), reorder, add, and
// remove fields, and edit options. Saves with the schema version (CAS). Removing a field hides its
// values at once; rows drop them on their next change.
export function FieldEditor({ collection, onSaved, onReload, onClose }: FieldEditorProps) {
  const [drafts, setDrafts] = useState<FieldDraft[]>(() => toDrafts(collection.fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const problem = validateDrafts(drafts);

  const update = (key: string, change: Partial<FieldDraft>) => setDrafts((items) => items.map((item) => item.key === key ? { ...item, ...change } : item));

  async function save() {
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { collection: saved } = await saveSchema(collection.id, fromDrafts(drafts), collection.schema_version);
      onSaved(saved);
    } catch (reason) {
      if (errorCode(reason) === "SCHEMA_CHANGED") setStale(true);
      setError(errorMessage(reason, "Could not save the fields"));
      setBusy(false);
    }
  }

  return <ModalDialog title="Fields" eyebrow={collection.name} onClose={onClose} variant="sheet" busy={busy}>
    <div className="field-editor">
      <p className="file-dialog-hint">The first field is each row's title. Removing a field hides its values; they are cleared from a row the next time it changes.</p>
      <ol className="field-editor-list">
        {drafts.map((draft, index) => <li key={draft.key} className="field-editor-item">
          <div className="field-editor-row">
            <FieldIcon type={draft.type} />
            <input aria-label={`Field ${index + 1} name`} value={draft.name} maxLength={60} placeholder="Field name" onChange={(event) => update(draft.key, { name: event.target.value })} disabled={busy} />
            <Select<FieldType> label={`Field ${index + 1} type`} value={draft.type} onChange={(type) => update(draft.key, { type })} disabled={busy || typeChoices(draft, ALL_TYPES).length === 1}
              options={typeChoices(draft, ALL_TYPES).map((type) => ({ value: type, label: FIELD_TYPE_LABELS[type] }))} />
            <span className="field-editor-controls">
              <button type="button" className="icon-button" onClick={() => setDrafts((items) => moveDraft(items, index, -1))} disabled={busy || index === 0} aria-label={`Move ${draft.name || "field"} up`}><ArrowUp /></button>
              <button type="button" className="icon-button" onClick={() => setDrafts((items) => moveDraft(items, index, 1))} disabled={busy || index === drafts.length - 1} aria-label={`Move ${draft.name || "field"} down`}><ArrowDown /></button>
              <button type="button" className="icon-button" onClick={() => setDrafts((items) => items.filter((item) => item.key !== draft.key))} disabled={busy || drafts.length === 1} aria-label={`Remove ${draft.name || "field"}`}><Trash2 /></button>
            </span>
          </div>
          <div className="field-editor-details">
            {draft.type !== "file" && <label className="field-editor-check"><input type="checkbox" checked={draft.required} onChange={(event) => update(draft.key, { required: event.target.checked })} disabled={busy} />Required</label>}
            {draft.type === "person" && <span className="field-editor-hint">One team member per row</span>}
            {draft.type === "contact" && <span className="field-editor-hint">One contact per row; people who can't read its contact book see “A contact”</span>}
            {draft.type === "number" && <>
              <label>Decimals <input type="number" min={0} max={6} value={draft.decimals} onChange={(event) => update(draft.key, { decimals: Number(event.target.value) || 0 })} disabled={busy} /></label>
              <label>Unit <input value={draft.unit} maxLength={8} placeholder="kg, €, min" onChange={(event) => update(draft.key, { unit: event.target.value })} disabled={busy} /></label>
            </>}
          </div>
          {(draft.type === "select" || draft.type === "multi_select") && <div className="field-editor-options" role="group" aria-label={`Options of ${draft.name || "this field"}`}>
            {draft.options.map((option) => <div key={option.key} className="field-editor-option">
              <Select variant="compact" label={`Color of ${option.label || "option"}`} value={option.color} options={colorOptions} disabled={busy}
                onChange={(color) => update(draft.key, { options: draft.options.map((item) => item.key === option.key ? { ...item, color } : item) })} />
              <input aria-label="Option label" value={option.label} maxLength={60} placeholder="Option" onChange={(event) => update(draft.key, { options: draft.options.map((item) => item.key === option.key ? { ...item, label: event.target.value } : item) })} disabled={busy} />
              <button type="button" className="icon-button" onClick={() => update(draft.key, { options: draft.options.filter((item) => item.key !== option.key) })} disabled={busy} aria-label={`Remove option ${option.label}`}><X /></button>
            </div>)}
            <button type="button" className="field-editor-add-option" onClick={() => update(draft.key, { options: [...draft.options, { key: draftKey(), label: "", color: "gray" }] })} disabled={busy || draft.options.length >= 100}><Plus />Add option</button>
          </div>}
        </li>)}
      </ol>
      <button type="button" className="field-editor-add" onClick={() => setDrafts((items) => [...items, newFieldDraft()])} disabled={busy || drafts.length >= 50}><Plus />Add field</button>
    </div>
    {(error || problem) && <p className="file-dialog-error field-editor-error" role={error ? "alert" : undefined}>{error ?? problem}</p>}
    <footer className="file-dialog-actions">
      <button className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
      {stale
        ? <button className="primary-button" onClick={onReload}>Reload fields</button>
        : <button className="primary-button" onClick={() => { void save(); }} disabled={busy || problem !== null}>{busy ? "Saving…" : "Save fields"}</button>}
    </footer>
  </ModalDialog>;
}
