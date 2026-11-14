import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bot, Ellipsis, Eye, RotateCcw, Undo2, X } from "lucide-react";
import { ApiError } from "../api";
import { relativeTime } from "../files/format";
import { errorMessage, getRow, type CollectionDetail, type CollectionRow, type FieldDefinition, type FieldValue } from "./collectionsApi";
import { CellEditor, checkboxInputId, relationChip } from "./cells";
import { openLayerCount, useDialogLayer } from "./dialogLayers";
import { FieldIcon } from "./icons";
import { NotePicker } from "./NotePicker";
import { OptionPicker } from "./OptionPicker";
import { RelationPicker } from "./RelationPicker";
import { rowTitle } from "./values";

type RowPanelProps = {
  collection: CollectionDetail;
  rowId: string;
  editable: boolean;
  /** The row as the loaded page has it, if it is there. */
  listed: CollectionRow | null;
  conflict: CollectionRow | null;
  save: (rowId: string, values: Record<string, FieldValue | null>, known?: () => CollectionRow | null) => Promise<CollectionRow | null>;
  onAcceptConflict: () => void;
  onActions: (row: CollectionRow) => void;
  /** Undo the last change (offered next to "Changed by <key>" after an MCP edit, T73). */
  onUndo?: (row: CollectionRow) => void;
  onClose: () => void;
  onMissing: () => void;
  /** Attachments editor for file fields (stage C). */
  renderFiles?: (row: CollectionRow, field: FieldDefinition, replace: (row: CollectionRow) => void) => ReactNode;
};

type Picker = { kind: "options" | "note" | "relation"; fieldId: string };

/** "Changed by <key>": the last change came through an MCP key (its name, while the key exists). */
export function changedByKeyText(row: Pick<CollectionRow, "updated_via_key_name">) {
  return `Changed by ${row.updated_via_key_name ? `the MCP key “${row.updated_via_key_name}”` : "an MCP key"}`;
}

/**
 * One row: a side pane on desktop, a full-screen panel on phones, with one ≥ 44 px editor per field.
 * The panel is a route (/collections/:c/row/:r); its pickers are dialog layers, so Back closes an
 * open picker first and leaves the row on the next Back.
 */
export function RowPanel({ collection, rowId, editable, listed, conflict, save, onAcceptConflict, onActions, onUndo, onClose, onMissing, renderFiles }: RowPanelProps) {
  const [row, setRow] = useState<CollectionRow | null>(listed);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const rowRef = useRef(row);
  rowRef.current = row;

  useEffect(() => {
    let active = true;
    getRow(rowId).then((result) => { if (active) setRow(result.row); }).catch((reason) => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 404) onMissing();
      else setLoadError(errorMessage(reason, "Could not open this row"));
    });
    return () => { active = false; };
  }, [onMissing, rowId]);

  // Follow saves made elsewhere (the table, an undo) while the panel is open.
  useEffect(() => {
    if (listed && (!rowRef.current || listed.revision >= rowRef.current.revision)) setRow(listed);
  }, [listed]);

  const closePicker = useCallback(() => setPicker(null), []);
  useDialogLayer(picker !== null, closePicker);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A picker or sheet on top handles its own Escape.
      if (event.key !== "Escape" || openLayerCount() > 0 || event.defaultPrevented) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const saveValues = useCallback(async (values: Record<string, FieldValue | null>) => {
    const saved = await save(rowId, values, () => rowRef.current);
    if (saved) setRow(saved);
    return saved !== null;
  }, [rowId, save]);

  const pickerField = picker ? collection.fields.find((field) => field.id === picker.fieldId) ?? null : null;
  const title = row ? rowTitle(row) : "Row";

  return <aside className="row-panel" role="region" aria-labelledby="row-panel-title">
    <header className="row-panel-header">
      <button className="icon-button row-panel-back" onClick={onClose} aria-label={`Back to ${collection.name}`}><ArrowLeft /></button>
      <div className="row-panel-heading">
        <span className="eyebrow">{collection.name}</span>
        <h2 id="row-panel-title" title={title}>{title}</h2>
      </div>
      {!editable && <span className="collection-role role-viewer"><Eye aria-hidden="true" />View only</span>}
      {row && <button className="icon-button" onClick={() => onActions(row)} aria-haspopup="dialog" aria-label="Row actions"><Ellipsis /></button>}
      <button className="icon-button row-panel-close" onClick={onClose} aria-label="Close row"><X /></button>
    </header>
    {conflict && <div className="row-panel-conflict" role="alert">
      <span>Someone else changed this row.</span>
      <button className="secondary-button" onClick={() => { setRow(conflict); onAcceptConflict(); }}><RotateCcw />Reload</button>
    </div>}
    {loadError && <p className="file-dialog-error row-panel-state" role="alert">{loadError}</p>}
    {!row && !loadError && <p className="bin-loading row-panel-state" role="status">Opening row…</p>}
    {row?.updated_via_key_id && <div className="row-panel-agent" role="status">
      <span><Bot aria-hidden="true" />{changedByKeyText(row)}</span>
      {editable && row.can_undo && onUndo && !conflict && <button className="secondary-button" onClick={() => onUndo(row)}><Undo2 />Undo</button>}
    </div>}
    {row && <div className="row-panel-body">
      {collection.fields.map((field) => {
        const labelId = `row-field-${field.id}`;
        return <div key={field.id} className={`row-field row-field-${field.type}`}>
          {field.type === "checkbox" && editable && !conflict
            ? <label className="row-field-label" id={labelId} htmlFor={checkboxInputId(labelId)}><FieldIcon type={field.type} />{field.name}{field.required && <span className="row-field-required" aria-label="required">*</span>}</label>
            : <span className="row-field-label" id={labelId}><FieldIcon type={field.type} />{field.name}{field.required && <span className="row-field-required" aria-label="required">*</span>}</span>}
          {field.type === "file" && renderFiles
            ? renderFiles(row, field, setRow)
            : <CellEditor field={field} row={row} editable={editable && !conflict} variant="panel" labelId={labelId} onSave={saveValues}
              onOpenPicker={(target) => { if (target.type !== "file") setPicker({ kind: target.type === "note" ? "note" : target.type === "person" || target.type === "contact" ? "relation" : "options", fieldId: target.id }); }} />}
        </div>;
      })}
      <p className="row-panel-meta">
        {row.updated_by_name ? `Changed by ${row.updated_by_name} ` : "Changed "}{relativeTime(row.updated_at)}
        {row.created_by_name && ` · Added by ${row.created_by_name}`}
      </p>
    </div>}
    {picker?.kind === "options" && pickerField && row && <OptionPicker field={pickerField} selected={Array.isArray(row.values[pickerField.id]) ? row.values[pickerField.id] as string[] : []}
      onClose={closePicker} onSave={(ids) => saveValues({ [pickerField.id]: ids.length ? ids : null })} />}
    {picker?.kind === "note" && pickerField && row && <NotePicker field={pickerField} selected={typeof row.values[pickerField.id] === "string" ? row.values[pickerField.id] as string : null}
      onClose={closePicker} onSave={(noteId) => saveValues({ [pickerField.id]: noteId })} />}
    {picker?.kind === "relation" && pickerField && row && <RelationPicker field={pickerField} selected={relationChip(pickerField, row)}
      onClose={closePicker} onSave={(id) => saveValues({ [pickerField.id]: id })} />}
  </aside>;
}
