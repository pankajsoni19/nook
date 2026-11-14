import { useEffect, useRef, useState } from "react";
import { FileText, Pause, Play, Trash2 } from "lucide-react";
import { api } from "../api";
import { EmbedPickerDialog, type PickItem } from "../ui/embeds/EmbedPicker";
import { QuestionSetEditor, type SaveState } from "../ui/questions/QuestionSetEditor";
import { SchedulePicker, viewerZone, type ScheduleValue } from "../ui/schedule/SchedulePicker";
import { PersonPicker } from "../ui/people/People";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/useConfirm";
import type { CheckinDetail } from "../../shared/checkins";
import type { PersonSummary } from "../../shared/people";
import type { QuestionSet } from "../../shared/questions";
import type { WorkspaceAppProps } from "../workspaceModules/types";
import { WorkspaceAccess } from "../access/WorkspaceAccess";
import { deleteStandup, errorText, getStandup, publishStandupQuestions, readStandupQuestions, saveStandupQuestions, setMyStandup, setStandupParticipants, setStandupSubscription, updateStandup } from "./api";

/**
 * A standup's settings (§D.4 UI): your own (time zone, pause, summaries) for everyone taking part, and
 * for editors the details, schedule (SchedulePicker with the next fires), deadline and reminder,
 * participants (people and groups), questions (QuestionSetEditor with the Standups roles, autosaved
 * draft, Publish), who else can read it, summaries, and the Bin.
 */

const DEADLINES = [30, 60, 120, 240, 360, 480, 720, 1440, 2880, 4320, 10080];
const REMINDERS = [0, 15, 30, 60, 120, 240, 480];
const minutesText = (minutes: number) => minutes < 60 ? `${minutes} minutes` : minutes < 1440 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="ui-switch standup-switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
    <span>{label}</span><span className="ui-switch-track" aria-hidden="true"><span className="ui-switch-thumb" /></span>
  </button>;
}

type NoteRow = { id: string; title: string; is_owner: number; current_version: number; updated_at: string };
const loadMyNotes = (): Promise<PickItem[]> => api<{ notes: NoteRow[] }>("/notes").then((result) => result.notes.filter((note) => note.is_owner === 1)
  .map((note) => ({ id: note.id, title: note.title || "Untitled note", meta: note.current_version > 0 ? "Published" : "Draft only", path: `/notes/${note.id}` })));

/**
 * Post each closed round to a note (§C C23, D1044): the round's date, summary line, and (for named
 * standups whose answers are not private) everyone's answers are appended and published as the
 * standup's owner. Pick one of your notes; clearing it stops.
 */
function SummaryNote({ detail, save }: { detail: CheckinDetail; save: (body: Record<string, unknown>, message: string) => Promise<void> }) {
  const [picking, setPicking] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const noteId = detail.summary.noteId ?? null;
  useEffect(() => {
    if (!noteId) { setTitle(null); return; }
    let live = true;
    api<{ note: { title: string } }>(`/notes/${noteId}`).then((result) => { if (live) setTitle(result.note.title || "Untitled note"); }, () => { if (live) setTitle("A note you can't open"); });
    return () => { live = false; };
  }, [noteId]);
  return <div className="standup-summary-note">
    <p className="standup-muted"><FileText aria-hidden="true" />{noteId ? <>Each closed round is added to <a href={`/notes/${noteId}`}>{title ?? "the note"}</a> and published.</> : "Add each closed round to a note, published as a new version."}</p>
    <span className="standup-summary-note-actions">
      <button type="button" className="action-button secondary" onClick={() => setPicking(true)}>{noteId ? "Change note" : "Post rounds to a note"}</button>
      {noteId && <button type="button" className="action-button secondary" onClick={() => void save({ summary: { noteId: null } }, "Rounds stop going to the note")}>Stop</button>}
    </span>
    {picking && <EmbedPickerDialog title="Post rounds to a note" eyebrow="Standup summaries" icon={FileText} emptyTitle="No notes yet" emptyText="Create a note first, then choose it here."
      load={loadMyNotes} onClose={() => setPicking(false)} onPick={(item) => { setPicking(false); void save({ summary: { noteId: item.id } }, `Rounds go to ${item.title}`); }} />}
  </div>;
}

export function StandupSettings({ detail, canEdit, onChanged, onDeleted, flash, role }: WorkspaceAppProps & { detail: CheckinDetail; canEdit: boolean; onChanged: (next?: CheckinDetail) => void; onDeleted: () => void }) {
  const { ask: askToConfirm, confirmElement } = useConfirm();
  const save = async (body: Record<string, unknown>, message: string) => {
    try {
      const { checkin } = await updateStandup(detail.id, { ...body, expectedRevision: detail.revision });
      onChanged(checkin);
      flash(message);
    } catch (reason) {
      flash(errorText(reason, "Could not save"));
      onChanged();
    }
  };
  return <div className="standup-settings">
    {confirmElement}
    {detail.you && <YourSettings detail={detail} flash={flash} onChanged={onChanged} />}
    {canEdit ? <>
      <Details detail={detail} save={save} />
      <Schedule detail={detail} save={save} />
      <Participants detail={detail} flash={flash} onChanged={onChanged} />
      <Questions detail={detail} flash={flash} onChanged={onChanged} />
      <Audience detail={detail} flash={flash} save={save} />
      <section className="standup-panel" aria-labelledby="standup-summary-settings">
        <h3 id="standup-summary-settings">Round summaries</h3>
        <p className="standup-muted">When a round closes, a summary goes to the inbox of its owner{detail.summary.notifyParticipants ? " and participants" : ""}.</p>
        <Switch checked={detail.summary.notifyParticipants} label="Send summaries to participants" onChange={(value) => void save({ summary: { notifyParticipants: value } }, "Saved")} />
        <Switch checked={detail.summary.email} label="Also by email" onChange={(value) => void save({ summary: { email: value } }, "Saved")} />
        <SummaryNote detail={detail} save={save} />
      </section>
      {["owner", "manage"].includes(detail.level) && <section className="standup-panel standup-danger" aria-labelledby="standup-delete">
        <h3 id="standup-delete">Move to the Bin</h3>
        <p className="standup-muted">Rounds and answers go with it. You can restore it from the Bin for 30 days.</p>
        <button type="button" className="action-button secondary" onClick={async () => {
          if (!await askToConfirm({ title: `Move ${detail.name} to the Bin?`, message: "It stops running at once. Restore it from the Bin within 30 days.", confirmLabel: "Move to Bin", danger: true })) return;
          try { await deleteStandup(detail.id); flash(`${detail.name} moved to the Bin`); onDeleted(); } catch (reason) { flash(errorText(reason, "Could not delete")); }
        }}><Trash2 aria-hidden="true" />Move to Bin</button>
      </section>}
    </> : role !== "guest" && <p className="standup-muted">Only people who can edit this standup change its schedule, questions, and participants.</p>}
  </div>;
}

function YourSettings({ detail, flash, onChanged }: { detail: CheckinDetail; flash: (message: string) => void; onChanged: (next?: CheckinDetail) => void }) {
  const you = detail.you!;
  const participates = detail.youParticipate;
  const [pause, setPause] = useState(you.pausedUntil ?? "");
  const zone = you.tz ?? viewerZone();
  return <section className="standup-panel" aria-labelledby="standup-you">
    <h3 id="standup-you">Your settings</h3>
    {participates && <>
      <p className="standup-muted">{detail.schedule.zoneMode === "each" ? `Rounds open at ${detail.schedule.at} in your time zone: ${zone.replace(/_/g, " ")}.` : `Rounds open at ${detail.schedule.at} ${detail.schedule.tz.replace(/_/g, " ")} time.`}</p>
      <div className="standup-row-fields">
        <label className="ui-field"><span>Out of office until</span><input type="date" value={pause} onChange={(event) => setPause(event.target.value)} /></label>
        <button type="button" className="action-button secondary ui-small-action" onClick={() => {
          setMyStandup(detail.id, { pausedUntil: pause || null }).then(() => { flash(pause ? `You're out until ${pause}` : "You're back in"); onChanged(); }).catch((reason) => flash(errorText(reason, "Could not save")));
        }} disabled={!pause && !you.pausedUntil}>{pause ? "Pause me" : you.pausedUntil ? "Clear pause" : "Pause me"}</button>
      </div>
    </>}
    <Switch checked={you.summaries} label="Send me round summaries" onChange={(value) => { setStandupSubscription(detail.id, value).then(() => { flash(value ? "You'll get round summaries" : "No more round summaries"); onChanged(); }).catch((reason) => flash(errorText(reason, "Could not save"))); }} />
  </section>;
}

function Details({ detail, save }: { detail: CheckinDetail; save: (body: Record<string, unknown>, message: string) => Promise<void> }) {
  const [name, setName] = useState(detail.name);
  const [description, setDescription] = useState(detail.description);
  const dirty = name.trim() !== detail.name || description.trim() !== detail.description;
  return <section className="standup-panel" aria-labelledby="standup-details">
    <h3 id="standup-details">Details</h3>
    <label className="ui-field"><span>Name</span><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
    <label className="ui-field"><span>Description</span><textarea value={description} maxLength={4000} onChange={(event) => setDescription(event.target.value)} placeholder="What this standup is for (optional)" /></label>
    <div className="standup-actions"><button type="button" className="action-button ui-small-action" disabled={!dirty || !name.trim()} onClick={() => void save({ name, description }, "Details saved")}>Save details</button></div>
  </section>;
}

function Schedule({ detail, save }: { detail: CheckinDetail; save: (body: Record<string, unknown>, message: string) => Promise<void> }) {
  const [value, setValue] = useState<ScheduleValue>(detail.schedule);
  const [deadline, setDeadline] = useState(String(detail.deadlineMinutes));
  const [reminder, setReminder] = useState(String(detail.reminderMinutesBefore ?? 0));
  const dirty = JSON.stringify(value) !== JSON.stringify(detail.schedule) || Number(deadline) !== detail.deadlineMinutes || Number(reminder) !== (detail.reminderMinutesBefore ?? 0);
  const deadlines = [...new Set([...DEADLINES, detail.deadlineMinutes])].sort((a, b) => a - b);
  return <section className="standup-panel" aria-labelledby="standup-schedule">
    <div className="standup-panel-head"><h3 id="standup-schedule">Schedule</h3>
      <button type="button" className="action-button secondary ui-small-action" onClick={() => void save({ status: detail.status === "active" ? "paused" : "active" }, detail.status === "active" ? "Paused: no new rounds" : "Resumed")}>
        {detail.status === "active" ? <><Pause aria-hidden="true" />Pause</> : <><Play aria-hidden="true" />Resume</>}
      </button>
    </div>
    <SchedulePicker value={value} onChange={setValue} label="When rounds open" />
    <div className="standup-row-fields">
      <div className="ui-field"><span id="standup-deadline-label">Answers due after</span>
        <Select labelledBy="standup-deadline-label" value={deadline} onChange={setDeadline} options={deadlines.map((minutes) => ({ value: String(minutes), label: minutesText(minutes) }))} /></div>
      <div className="ui-field"><span id="standup-reminder-label">Reminder</span>
        <Select labelledBy="standup-reminder-label" value={reminder} onChange={setReminder} options={REMINDERS.filter((minutes) => minutes < Number(deadline)).map((minutes) => ({ value: String(minutes), label: minutes ? `${minutesText(minutes)} before the deadline` : "No reminder" }))} /></div>
    </div>
    <div className="standup-actions"><button type="button" className="action-button ui-small-action" disabled={!dirty} onClick={() => void save({ schedule: value, deadlineMinutes: Number(deadline), reminderMinutesBefore: Number(reminder) || null }, "Schedule saved")}>Save schedule</button></div>
  </section>;
}

function Participants({ detail, flash, onChanged }: { detail: CheckinDetail; flash: (message: string) => void; onChanged: (next?: CheckinDetail) => void }) {
  const initial: PersonSummary[] = [
    ...detail.groups.map((group) => ({ kind: "group" as const, id: group.id, name: group.name })),
    ...detail.people.filter((person) => !person.viaGroupId).map((person) => ({ kind: "user" as const, id: person.id, name: person.name, avatarUrl: person.avatarUrl }))
  ];
  const [value, setValue] = useState<PersonSummary[]>(initial);
  const [busy, setBusy] = useState(false);
  const key = (list: PersonSummary[]) => list.map((person) => `${person.kind}:${"id" in person ? person.id : ""}`).sort().join(",");
  const dirty = key(value) !== key(initial);
  const viaGroups = detail.people.filter((person) => person.viaGroupId).length;
  return <section className="standup-panel" aria-labelledby="standup-participants">
    <div className="standup-panel-head"><h3 id="standup-participants">Participants</h3><span className="standup-muted ui-tabular">{detail.participantCount}{viaGroups ? ` (${viaGroups} from groups)` : ""}</span></div>
    <PersonPicker label="People and groups who answer" value={value} onChange={setValue} allow={["user", "group"]} placeholder="Add people or groups" />
    <p className="standup-muted">Participants can read and comment on answers. Group members join and leave with the group.</p>
    <div className="standup-actions"><button type="button" className="action-button ui-small-action" disabled={!dirty || busy} onClick={async () => {
      setBusy(true);
      try {
        await setStandupParticipants(detail.id, value.flatMap((person) => person.kind === "user" ? [person.id] : []), value.flatMap((person) => person.kind === "group" ? [person.id] : []));
        const { checkin } = await getStandup(detail.id);
        onChanged(checkin);
        flash("Participants saved");
      } catch (reason) { flash(errorText(reason, "Could not save participants")); } finally { setBusy(false); }
    }}>Save participants</button></div>
  </section>;
}

function Questions({ detail, flash, onChanged }: { detail: CheckinDetail; flash: (message: string) => void; onChanged: (next?: CheckinDetail) => void }) {
  const [set, setSet] = useState<QuestionSet | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(null);
  const [publishing, setPublishing] = useState(false);
  const [hasDraft, setHasDraft] = useState(detail.hasDraft);
  const timer = useRef<number | null>(null);
  useEffect(() => { readStandupQuestions(detail.id).then((result) => setSet(result.draft ?? result.current)).catch(() => undefined); }, [detail.id]);
  if (!set) return <section className="standup-panel"><p className="standup-muted" role="status">Loading questions…</p></section>;
  const change = (next: QuestionSet) => {
    setSet(next);
    setSaveState("saving");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      saveStandupQuestions(detail.id, next).then(() => { setSaveState("saved"); setHasDraft(true); }).catch(() => setSaveState("error"));
    }, 600);
  };
  return <section className="standup-panel standup-questions" aria-labelledby="standup-questions">
    <h3 id="standup-questions" className="ui-visually-hidden">Questions</h3>
    {hasDraft && <p className="standup-notice">You have unpublished changes. People keep answering the published questions until you publish.</p>}
    <QuestionSetEditor set={set} onChange={change} roles={["done", "plan", "blockers", "mood", "goal_update"]} saveState={saveState} publishing={publishing}
      onPublish={hasDraft ? async () => {
        setPublishing(true);
        try { await publishStandupQuestions(detail.id); setHasDraft(false); flash("Questions published"); const { checkin } = await getStandup(detail.id); onChanged(checkin); }
        catch (reason) { flash(errorText(reason, "Could not publish")); } finally { setPublishing(false); }
      } : undefined} />
  </section>;
}

/** Who sees whose answers, in words (the switch's description and the panel's summary). */
export function answersAudienceText(detail: Pick<CheckinDetail, "anonymous" | "privateAnswers">): string {
  if (detail.anonymous) return "Anonymous answers are only ever shown without names, from 3 answers on.";
  return detail.privateAnswers
    ? "On: each person sees only their own answers. The owner and people who manage this standup see everyone's."
    : "Off: everyone who can read this standup, participants included, sees every answer, blockers, and mood.";
}

function Audience({ detail, flash, save }: { detail: CheckinDetail; flash: (message: string) => void; save: (body: Record<string, unknown>, message: string) => Promise<void> }) {
  const manage = ["owner", "manage"].includes(detail.level);
  if (!manage) return null;
  // Taking part is reading (D938): the shared Access sheet adds readers besides the participants (D1050).
  // Private answers (T550, D1191): only managers change it, since an editor who is not a manager reads
  // only their own answers while it is on.
  return <section className="standup-panel" aria-labelledby="standup-audience">
    <h3 id="standup-audience">Who can read it</h3>
    <WorkspaceAccess kind="checkin" id={detail.id} title={detail.name} canManage onSaved={() => flash("Access saved")} />
    {detail.anonymous
      ? <p className="standup-muted">{answersAudienceText(detail)}</p>
      : <>
        <Switch checked={detail.privateAnswers} label="Private answers" onChange={(value) => void save({ privateAnswers: value }, value ? "Answers are private: each person sees only their own" : "Everyone who reads the standup sees every answer")} />
        <p className="standup-muted" id="standup-private-help">{answersAudienceText(detail)}</p>
      </>}
  </section>;
}
