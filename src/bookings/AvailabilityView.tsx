import { useEffect, useMemo, useState } from "react";
import { CalendarSync, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import { AvailabilityEditor, OverridesEditor } from "../ui/schedule/AvailabilityEditor";
import { useUnitPreferences } from "../ui/units";
import { useConfirm } from "../ui/useConfirm";
import type { WeeklyRules } from "../../shared/bookings";
import { bookingsApi, zones, type Feed, type Profile, type Schedule } from "./api";

/**
 * Availability (§D.6 UI): the person's schedules (weekly hours in a zone, date overrides), the Nook
 * calendars that count as busy, and outside calendars (ICS secret addresses, §G.1 Q1) whose busy
 * times block slots. Addresses are write-only: after saving, only a hint shows.
 */

export function AvailabilityView({ flash, readOnly }: { flash: (message: string) => void; readOnly: boolean }) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; tz: string; weekly: WeeklyRules } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const units = useUnitPreferences();
  const zoneList = useMemo(zones, []);
  const { ask, confirmElement } = useConfirm();

  useEffect(() => { bookingsApi.schedules().then((result) => { setSchedules(result.schedules); setSelectedId((id) => id ?? result.schedules[0]?.id ?? null); }).catch(() => setError("Could not load your schedules")); }, []);
  const selected = schedules?.find((schedule) => schedule.id === selectedId) ?? null;
  useEffect(() => { if (selected) setDraft({ name: selected.name, tz: selected.tz, weekly: selected.weekly }); }, [selected?.id, selected?.updatedAt]);
  const replace = (schedule: Schedule) => setSchedules((list) => (list ?? []).map((item) => item.id === schedule.id ? schedule : schedule.isDefault ? { ...item, isDefault: false } : item));

  if (error) return <p className="bk-error" role="alert">{error}</p>;
  if (!schedules || !selected || !draft) return <p className="bk-muted" role="status">Loading availability…</p>;
  const dirty = draft.name !== selected.name || draft.tz !== selected.tz || JSON.stringify(draft.weekly) !== JSON.stringify(selected.weekly);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: draft.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const weekStart = (units?.weekStart ?? 1) as 0 | 1 | 6;

  const save = async () => {
    setSaving(true);
    try { replace((await bookingsApi.saveSchedule(selected.id, draft)).schedule); flash("Availability saved"); }
    catch (reason) { flash(reason instanceof Error ? reason.message : "Could not save"); }
    finally { setSaving(false); }
  };
  const create = async () => {
    try {
      const { schedule } = await bookingsApi.createSchedule({ name: "New schedule", tz: selected.tz, weekly: selected.weekly });
      setSchedules([...schedules, schedule]);
      setSelectedId(schedule.id);
    } catch (reason) { flash(reason instanceof Error ? reason.message : "Could not add a schedule"); }
  };
  const remove = async () => {
    if (!await ask({ title: `Delete ${selected.name}?`, message: "Booking types using it switch to your default schedule.", confirmLabel: "Delete", danger: true })) return;
    try { await bookingsApi.deleteSchedule(selected.id); const rest = schedules.filter((item) => item.id !== selected.id); setSchedules(rest); setSelectedId(rest[0]?.id ?? null); }
    catch (reason) { flash(reason instanceof Error ? reason.message : "Could not delete it"); }
  };

  return <div className="bk-stack">
    <section className="bk-panel" aria-labelledby="bk-hours">
      <div className="bk-panel-head bk-panel-head-row">
        <div><h2 id="bk-hours">Weekly hours</h2><p className="bk-muted">When people can book you. Booking types use your default schedule unless they pick another.</p></div>
        {!readOnly && <button type="button" className="secondary-button ui-small-button" onClick={() => void create()}><Plus aria-hidden="true" />New schedule</button>}
      </div>
      {schedules.length > 1 && <div className="bk-filter-row" role="tablist" aria-label="Schedules">
        {schedules.map((schedule) => <button key={schedule.id} type="button" role="tab" className="ui-filter-chip" aria-selected={schedule.id === selected.id} aria-pressed={schedule.id === selected.id} onClick={() => setSelectedId(schedule.id)}>
          {schedule.isDefault && <Star aria-label="Default" />}{schedule.name}</button>)}
      </div>}
      <div className="bk-grid">
        <label className="ui-field"><span>Name</span><input value={draft.name} maxLength={60} disabled={readOnly} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="ui-field"><span>Time zone</span><select className="bk-select" value={draft.tz} disabled={readOnly} onChange={(event) => setDraft({ ...draft, tz: event.target.value })}>
          {(zoneList.includes(draft.tz) ? zoneList : [draft.tz, ...zoneList]).map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, " ")}</option>)}</select></label>
      </div>
      <AvailabilityEditor weekly={draft.weekly} onChange={(weekly) => setDraft({ ...draft, weekly })} weekStart={weekStart} disabled={readOnly} />
      {!readOnly && <div className="bk-save-row">
        <button type="button" className="action-button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save hours"}</button>
        {!dirty && <span className="bk-muted">Saved</span>}
        {!selected.isDefault && <button type="button" className="secondary-button ui-small-button" onClick={() => void bookingsApi.saveSchedule(selected.id, { isDefault: true }).then((result) => replace(result.schedule))}><Star aria-hidden="true" />Make default</button>}
        {!selected.isDefault && <button type="button" className="secondary-button ui-small-button" onClick={() => void remove()}><Trash2 aria-hidden="true" />Delete schedule</button>}
      </div>}
    </section>
    <section className="bk-panel" aria-labelledby="bk-overrides">
      <div className="bk-panel-head"><h2 id="bk-overrides">Date overrides</h2><p className="bk-muted">Days off and different hours for one date, in {draft.tz.replace(/_/g, " ")}.</p></div>
      <OverridesEditor overrides={selected.overrides} today={today} disabled={readOnly}
        onPut={async (row) => { try { replace((await bookingsApi.putOverride(selected.id, row)).schedule); } catch (reason) { flash(reason instanceof Error ? reason.message : "Could not save the override"); } }}
        onRemove={async (date) => { replace((await bookingsApi.deleteOverride(selected.id, date)).schedule); }} />
    </section>
    <BusySources flash={flash} readOnly={readOnly} />
    {confirmElement}
  </div>;
}

function BusySources({ flash, readOnly }: { flash: (message: string) => void; readOnly: boolean }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [calendars, setCalendars] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    bookingsApi.profile().then((result) => { setProfile(result.profile); setFeeds(result.feeds); }).catch(() => undefined);
    bookingsApi.calendars().then((result) => setCalendars(result.calendars.filter((calendar) => calendar.role === "owner"))).catch(() => undefined);
  }, []);
  if (!profile) return null;
  const chosen = profile.busyCalendarIds.length ? profile.busyCalendarIds : calendars.map((calendar) => calendar.id);
  const toggleCalendar = async (id: string, on: boolean) => {
    const next = on ? [...new Set([...chosen, id])] : chosen.filter((item) => item !== id);
    if (!next.length) { flash("Keep at least one calendar"); return; }
    try { setProfile((await bookingsApi.saveProfile({ busyCalendarIds: next })).profile); } catch (reason) { flash(reason instanceof Error ? reason.message : "Could not save"); }
  };
  const add = async () => {
    setAdding(true);
    setError(null);
    try { const { feed } = await bookingsApi.addFeed({ label, url }); setFeeds([...feeds, feed]); setLabel(""); setUrl(""); flash(feed.status === "ok" ? `Added: ${feed.busyCount} busy times found` : "Added, but it could not be read yet"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not add it"); }
    finally { setAdding(false); }
  };
  return <section className="bk-panel" aria-labelledby="bk-busy">
    <div className="bk-panel-head"><h2 id="bk-busy">Busy times</h2><p className="bk-muted">Events on these calendars block bookings. Only the times are used, never titles.</p></div>
    {calendars.length > 0 && <fieldset className="bk-checks"><legend>Nook calendars</legend>
      {calendars.map((calendar) => <label key={calendar.id} className="bk-check"><input type="checkbox" checked={chosen.includes(calendar.id)} disabled={readOnly} onChange={(event) => void toggleCalendar(calendar.id, event.target.checked)} /><span>{calendar.name}</span></label>)}
    </fieldset>}
    <h3 className="bk-h3">Outside calendars</h3>
    {feeds.length === 0 ? <p className="bk-muted">Add the secret ICS address of a Google or Outlook calendar so its busy times block bookings too.</p>
      : <ul className="bk-feeds">{feeds.map((feed) => <li key={feed.id}>
        <CalendarSync aria-hidden="true" />
        <span className="bk-feed-main"><strong>{feed.label}</strong><code>{feed.hint}</code></span>
        <span className={`bk-feed-status ${feed.status}`}>{feed.status === "ok" ? `${feed.busyCount} busy · ${feed.lastFetchedAt ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(feed.lastFetchedAt)) : ""}` : feed.status === "error" ? feed.error ?? "Could not read it" : "Not read yet"}</span>
        {!readOnly && <button type="button" className="icon-button" aria-label={`Refresh ${feed.label}`} title="Refresh now" onClick={() => void bookingsApi.refreshFeed(feed.id).then((result) => setFeeds(feeds.map((item) => item.id === feed.id ? result.feed : item)))}><RefreshCw /></button>}
        {!readOnly && <button type="button" className="icon-button" aria-label={`Remove ${feed.label}`} onClick={() => void bookingsApi.removeFeed(feed.id).then(() => setFeeds(feeds.filter((item) => item.id !== feed.id)))}><Trash2 /></button>}
      </li>)}</ul>}
    {!readOnly && <form className="bk-feed-form" onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <label className="ui-field"><span>Name</span><input value={label} maxLength={80} placeholder="Work Google" onChange={(event) => setLabel(event.target.value)} /></label>
      <label className="ui-field bk-grow"><span>Secret address (ICS)</span><input value={url} type="url" required autoComplete="off" spellCheck={false} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" onChange={(event) => setUrl(event.target.value)} /></label>
      <button type="submit" className="secondary-button ui-small-button bk-form-button" disabled={adding || url.length < 8}><Plus aria-hidden="true" />{adding ? "Checking…" : "Add calendar"}</button>
      {error && <p className="ui-field-error" role="alert">{error}</p>}
      <p className="ui-field-hint bk-wide">The address is stored encrypted and never shown again. Busy times refresh every 30 minutes and before people pick a time.</p>
    </form>}
  </section>;
}
