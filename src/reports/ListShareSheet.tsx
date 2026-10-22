import { useEffect, useId, useMemo, useState } from "react";
import { Trash2, Users } from "lucide-react";
import { listPeople, listPickerGroups, type PickerGroup, type PickerPerson } from "../access/accessApi";
import { PrincipalPicker } from "../access/PrincipalPicker";
import { ModalDialog } from "../files/Dialog";
import { notify } from "../ui/notify";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { ReportListShare, ReportListVisibility } from "../../shared/reports";
import { getListSharing, messageOf, saveListSharing } from "./reportsApi";
import "./reportEdit.css";

type Level = ReportListShare["level"];

const AUDIENCES: Array<{ value: ReportListVisibility; label: string; hint: string }> = [
  { value: "private", label: "Only me", hint: "Nobody else sees this list." },
  { value: "selected", label: "Chosen people and groups", hint: "They see the list; with “Can edit” they can also add, remove, and reorder its reports." },
  { value: "all_users", label: "Everyone on the team", hint: "Every member and viewer sees the list (never guests)." }
];

/**
 * Sharing a report list (phase 3, D551): the report Share sheet's look and audiences, with the list's own
 * levels: "Can view" sees the list, "Can edit" also curates it. Sharing a list never shares a report in it
 * (D487): each person sees only the reports they can open. Only the list's owner opens this sheet. Back or
 * Escape closes it (D18); Forward reopens it (`reports.listShare:<id>`).
 */
export function ListShareSheet({ listId, name: listName, onClose, reopen, onSaved }: { listId: string; name: string; onClose: () => void; reopen?: () => void; onSaved?: () => void }) {
  const [visibility, setVisibility] = useState<ReportListVisibility>("private");
  const [shares, setShares] = useState<ReportListShare[]>([]);
  const [people, setPeople] = useState<PickerPerson[]>([]);
  const [groups, setGroups] = useState<PickerGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const radio = useId();
  useHistoryDialogGuard(true, onClose, { blocked: busy, reopen, layerKey: `reports.listShare:${listId}` });

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [sharing, directory, groupList] = await Promise.all([getListSharing(listId), listPeople().catch(() => ({ users: [] as PickerPerson[] })), listPickerGroups().catch(() => ({ groups: [] as PickerGroup[] }))]);
        if (!alive) return;
        setVisibility(sharing.sharing.visibility);
        setShares(sharing.sharing.shares);
        setPeople(directory.users.filter((person) => person.kind !== "service" && person.role !== "guest"));
        setGroups(groupList.groups);
        setLoaded(true);
      } catch (reason) {
        if (alive) setError(messageOf(reason, "Could not load the sharing"));
      }
    })();
    return () => { alive = false; };
  }, [listId]);

  const options = useMemo(() => {
    const taken = new Set(shares.map((share) => `${share.kind}:${share.id}`));
    return [
      ...groups.filter((group) => !taken.has(`group:${group.id}`)).map((group) => ({ value: `group:${group.id}`, label: group.name, description: `${group.memberCount} ${group.memberCount === 1 ? "member" : "members"}`, group: "Groups" })),
      ...people.filter((person) => !taken.has(`user:${person.id}`)).map((person) => ({ value: `user:${person.id}`, label: person.displayName, description: person.role ?? undefined, group: "People" }))
    ];
  }, [groups, people, shares]);

  const pick = (value: string) => {
    const [kind, id] = value.split(":") as ["user" | "group", string];
    const label = kind === "group" ? groups.find((group) => group.id === id)?.name : people.find((person) => person.id === id)?.displayName;
    setShares((current) => [...current, { kind, id, name: label ?? "Unknown", level: "view" }]);
  };
  const setLevel = (share: ReportListShare, level: Level) => setShares((current) => current.map((item) => item.kind === share.kind && item.id === share.id ? { ...item, level } : item));
  const remove = (share: ReportListShare) => setShares((current) => current.filter((item) => !(item.kind === share.kind && item.id === share.id)));

  async function save() {
    setBusy(true);
    try {
      await saveListSharing(listId, { visibility, shares: visibility === "selected" ? shares.map(({ kind, id, level }) => ({ kind, id, level })) : [] });
      notify.success(visibility === "private" ? "Only you can see this list" : "Sharing saved");
      onSaved?.();
      onClose();
    } catch (reason) {
      setError(messageOf(reason, "Could not save the sharing"));
      setBusy(false);
    }
  }

  return <ModalDialog title="Share list" eyebrow={listName} onClose={onClose} busy={busy} variant="sheet" className="reports-dialog report-edit-sheet report-share">
    <div className="report-edit-sheet-body">
      {!loaded && !error && <p className="reports-loading" role="status">Loading…</p>}
      {loaded && <>
        <p className="file-dialog-hint">A list never shares its reports: each person sees only the reports in it they can already open.</p>
        <fieldset className="report-share-audience">
          <legend>Who can see it</legend>
          {AUDIENCES.map((audience) => <label key={audience.value} className="report-share-option">
            <input type="radio" name={radio} value={audience.value} checked={visibility === audience.value} onChange={() => setVisibility(audience.value)} />
            <span><strong>{audience.label}</strong><small>{audience.hint}</small></span>
          </label>)}
        </fieldset>
        {visibility === "selected" && <>
          <PrincipalPicker options={options} onPick={pick} />
          {!shares.length && <p className="file-dialog-hint">Add people or groups to share with.</p>}
          <ul className="report-share-list">
            {shares.map((share) => <li key={`${share.kind}:${share.id}`}>
              <span className="report-share-name">{share.kind === "group" && <Users aria-hidden="true" />}{share.name}</span>
              <Select<Level> label={`${share.name}'s access`} value={share.level} onChange={(next) => setLevel(share, next)}
                options={[{ value: "view", label: "Can view" }, { value: "edit", label: "Can edit" }]} />
              <button type="button" className="icon-button" aria-label={`Remove ${share.name}`} onClick={() => remove(share)}><Trash2 /></button>
            </li>)}
          </ul>
        </>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <footer className="file-dialog-actions report-edit-sheet-actions">
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="primary-button" onClick={() => { void save(); }} disabled={busy || !loaded}>{busy ? "Saving…" : "Save sharing"}</button>
    </footer>
  </ModalDialog>;
}
