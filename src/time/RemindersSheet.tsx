import { useEffect, useId, useState } from "react";
import { ModalDialog } from "../files/Dialog";
import { SchedulePicker, type ScheduleValue } from "../ui/schedule/SchedulePicker";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { Select } from "../ui/Select";
import { timeApi, viewerZone, type TimeSettings } from "./api";
import { errorText } from "./timerStore";

/**
 * Time reminders (§D.2 "Notifications", D888): "You have no time logged today" on the days and at
 * the time you choose (off by default), and the alert when a timer has run for N hours (8 by
 * default; 0 turns it off). Both arrive as Nook notifications (bell and push).
 */
export function RemindersSheet({ onClose }: { onClose: () => void }) {
  const formId = useId();
  const [settings, setSettings] = useState<TimeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  useEffect(() => { void timeApi.settings().then((body) => setSettings(body.settings), (reason) => setError(errorText(reason, "Could not load your reminders"))); }, []);

  const schedule: ScheduleValue | null = settings ? { weekdays: settings.reminderDays, at: settings.reminderAt, everyNWeeks: 1, zoneMode: "fixed", tz: viewerZone() } : null;
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    try {
      await timeApi.saveSettings({ ...settings, tz: viewerZone() });
      notify.success("Reminders saved");
      onClose();
    } catch (reason) {
      setError(errorText(reason, "Could not save your reminders"));
      setBusy(false);
    }
  };

  return <ModalDialog title="Time reminders" onClose={onClose} variant="sheet" busy={busy} className="time-sheet">
    <form id={formId} className="time-sheet-body" onSubmit={(event) => { void save(event); }}>
      {!settings && !error && <p className="time-loading" role="status">Loading…</p>}
      {settings && schedule && <>
        <button type="button" role="switch" className="ui-switch" aria-checked={settings.dailyReminder} onClick={() => setSettings({ ...settings, dailyReminder: !settings.dailyReminder })}>
          <span className="ui-switch-track"><span className="ui-switch-thumb" /></span><span>Remind me when I have logged no time</span>
        </button>
        {settings.dailyReminder && <SchedulePicker label="When" value={schedule} allowEachZone={false}
          onChange={(value) => setSettings({ ...settings, reminderDays: [...value.weekdays], reminderAt: value.at })} />}
        <div className="ui-field">
          <span>Alert me when a timer runs for</span>
          <Select label="Long timer alert" value={String(settings.longTimerHours)} onChange={(value) => setSettings({ ...settings, longTimerHours: Number(value) })}
            options={[{ value: "0", label: "Never" }, ...[4, 6, 8, 10, 12].map((hours) => ({ value: String(hours), label: `${hours} hours` }))]} />
        </div>
        <p className="time-note">Reminders use this device's time zone ({viewerZone()}).</p>
      </>}
      {error && <p className="ui-field-error" role="alert">{error}</p>}
    </form>
    <footer className="time-sheet-footer">
      <span className="time-sheet-spacer" />
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form={formId} className="action-button" disabled={busy || !settings}>Save</button>
    </footer>
  </ModalDialog>;
}
