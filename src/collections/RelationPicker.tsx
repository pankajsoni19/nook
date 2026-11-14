import { useState } from "react";
import { ModalDialog } from "../files/Dialog";
import { PersonPicker } from "../ui/people/People";
import { FormError } from "../ui/FormError";
import type { PersonSummary } from "../../shared/people";
import type { FieldDefinition } from "./collectionsApi";

type RelationPickerProps = {
  field: FieldDefinition;
  /** The chip the row shows now (a hidden contact reads "A contact"). */
  selected: PersonSummary | null;
  onSave: (id: string | null) => Promise<boolean>;
  onClose: () => void;
};

/**
 * Chooses the one team member (person field) or contact (contact field) a row names (D1200). The
 * search offers members the share picker offers and contacts in books the caller can read; the
 * server checks again on save (T641). Choosing saves and closes; Clear empties the field.
 */
export function RelationPicker({ field, selected, onSave, onClose }: RelationPickerProps) {
  const [value, setValue] = useState<PersonSummary[]>(selected ? [selected] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contact = field.type === "contact";

  async function save(id: string | null) {
    setBusy(true);
    setError(null);
    if (await onSave(id)) onClose();
    else {
      setBusy(false);
      setError(contact ? "Could not link this contact" : "Could not set this team member");
    }
  }

  return <ModalDialog title={field.name} eyebrow={contact ? "Link a contact" : "Choose a team member"} onClose={onClose} variant="sheet" busy={busy}>
    <div className="file-dialog-form relation-picker">
      <PersonPicker label={contact ? "Contact" : "Team member"} value={value} allow={[contact ? "contact" : "user"]} multiple={false} disabled={busy}
        placeholder={contact ? "Search contacts by name or email" : "Search the team by name"}
        onChange={(people) => {
          setValue(people);
          const chosen = people[0];
          if (chosen && "id" in chosen && chosen.id !== (selected && "id" in selected ? selected.id : null)) void save(chosen.id);
        }} />
      <p className="file-dialog-hint">{contact
        ? "People who can't read this contact's book see “A contact” instead of the name."
        : "Anyone who can see this collection sees who is chosen."}</p>
    </div>
    <FormError message={error} className="file-dialog-error" />
    <footer className="file-dialog-actions">
      {selected && <button className="secondary-button" onClick={() => { void save(null); }} disabled={busy}>Clear</button>}
      <button className="secondary-button" onClick={onClose} disabled={busy}>{selected ? "Done" : "Cancel"}</button>
    </footer>
  </ModalDialog>;
}
