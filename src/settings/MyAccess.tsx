import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api";
import { FeedsAndRoutines } from "../access/FeedsAndRoutines";
import { useConfirm } from "../ui/useConfirm";
import { KeyRound, RotateCcw, ShieldCheck } from "lucide-react";
import { AccessOverview } from "../access/AccessOverview";
import { feedCalendarPhrase, getMyAccess, getMyAccessPage, revokeOwnFeed, setOwnRoutinePaused, type AccessKind, type AccessSummary, type FeedAccessRow, type RoutineAccessRow } from "../access/memberAccessApi";
import { ROLE_LABELS } from "../team/teamRoles";
import { HUB_TITLE_ID } from "./hubModel";
import "../team/team.css";

/**
 * Settings → My access at /settings/access (Wave 33, access plan §C.6): what you can open that
 * others own, per module, and through what (shared with you directly, through a group, or with
 * everyone), plus your groups and API keys. Read-only; every role but guest. Your calendar feed
 * links and routines (v0.32) have their owner actions here: Revoke a link (confirmed in the app's
 * dialog, D91), Pause or Resume a routine (members and admins; a viewer's routines stay paused).
 */
export function MyAccess() {
  const [summary, setSummary] = useState<AccessSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    getMyAccess().then(setSummary, (reason) => setError(reason instanceof Error ? reason.message : "Could not load your access"));
  }, []);
  useEffect(load, [load]);
  const loadPage = useCallback((kind: AccessKind, cursor?: string | null) => getMyAccessPage(kind, cursor), []);
  const { ask, confirmOpen, confirmElement } = useConfirm();
  const [acting, setActing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function act(operation: () => Promise<unknown>, message: string) {
    setActing(true);
    setNotice(null);
    try {
      await operation();
      setNotice(message);
    } catch (reason) {
      setNotice(reason instanceof ApiError && reason.status === 404 ? "That changed meanwhile. The page now shows the latest." : reason instanceof Error ? reason.message : "Something went wrong");
    } finally {
      setActing(false);
      getMyAccess().then(setSummary, () => undefined);
    }
  }
  async function revokeFeed(feed: FeedAccessRow) {
    if (!await ask({ title: "Revoke this feed link?", message: `The link ${feed.prefix}… for ${feedCalendarPhrase(feed)} stops working at once in every app subscribed to it. You can make a new one in Calendar.`, confirmLabel: "Revoke link", danger: true })) return;
    await act(() => revokeOwnFeed(feed.id), "The feed link was revoked");
  }
  const pauseRoutine = (routine: RoutineAccessRow) => void act(() => setOwnRoutinePaused(routine.id, true), `“${routine.name}” is paused`);
  const resumeRoutine = (routine: RoutineAccessRow) => void act(() => setOwnRoutinePaused(routine.id, false), `“${routine.name}” is running again`);
  const canWrite = summary?.member.role === "admin" || summary?.member.role === "member";

  return <section className="settings-content my-access" aria-labelledby={HUB_TITLE_ID}>
    <div className="settings-section-heading"><span className="settings-icon"><ShieldCheck /></span><div>
      <p>What others share with you, and through what. Owners change their own sharing; admins decide who is in a group.</p>
    </div></div>
    {error && <div className="team-state team-error" role="alert"><p>{error}</p><button className="secondary-button" onClick={load}><RotateCcw />Try again</button></div>}
    {!error && !summary && <p className="team-loading" role="status">Loading your access…</p>}
    {summary && <>
      <section className="team-card" aria-labelledby="my-access-groups">
        <h3 id="my-access-groups">Groups</h3>
        <p className="team-muted">Team role: {ROLE_LABELS[summary.member.role]}.</p>
        {summary.groups.length === 0 ? <p className="team-muted">You are not in any group.</p> : <ul className="ma-group-chips" aria-label="Your groups">
          {summary.groups.map((group) => <li key={group.id} className="ma-group-chip ma-group-chip-static">{group.name}</li>)}
        </ul>}
      </section>
      <section className="team-card" aria-labelledby="my-access-keys">
        <h3 id="my-access-keys">API keys</h3>
        {summary.keys.length === 0 ? <p className="team-muted">No live API keys.</p> : <ul className="ma-key-list" aria-label="Your API keys">
          {summary.keys.map((key) => <li key={key.id} className="ma-key-row"><span className="team-row-copy">
            <span className="team-row-title"><KeyRound aria-hidden="true" className="group-item-hidden" /><strong>{key.name}</strong></span>
            <span className="team-row-meta"><code>{key.prefix}…</code><span>{key.modules.join(", ") || "No modules"}</span><span>{key.expiresAt ? `Expires ${new Date(key.expiresAt).toLocaleDateString()}` : "No expiry"}</span></span>
          </span></li>)}
        </ul>}
        <p className="team-muted">Manage keys in Settings → API keys.</p>
      </section>
      <section className="team-card" aria-labelledby="my-access-feeds">
        <h3 id="my-access-feeds">Calendar feeds and routines</h3>
        {notice && <p className="ma-summary-line" role="status">{notice}</p>}
        <FeedsAndRoutines summary={summary} mode="self" canResume={canWrite} busy={acting || confirmOpen}
          onRevokeFeed={(feed) => { void revokeFeed(feed); }} onPauseRoutine={pauseRoutine} onResumeRoutine={resumeRoutine} />
      </section>
      <AccessOverview summary={summary} loadPage={loadPage} />
    </>}
    {confirmElement}
  </section>;
}
