import { useEffect, useState } from "react";
import { listTeam, type TeamMember } from "./teamApi";

// The blocked-account count on the hub's Team → Members entry (Wave 38 review L1; the top bar's Team
// button carried it before). Same shape as the Bin's count: a lazy look when the hub opens for a
// role that manages the team, and Members itself reports the count of the list it loaded while it
// is on screen, so opening Members asks the server once and a block or unblock there is counted
// from the refreshed list.

const BLOCKED_COUNTED = "nook:team-blocked-counted";
let sectionsReporting = 0;

/** The blocked accounts in a team list. */
export const blockedCountOf = (users: readonly Pick<TeamMember, "status">[]) => users.filter((user) => user.status === "blocked").length;

/** Members on screen reports the count itself; the hook loads nothing beside it. Returns the release function. */
export function claimBlockedCount() {
  sectionsReporting += 1;
  return () => { sectionsReporting = Math.max(0, sectionsReporting - 1); };
}

export const blockedCountClaimed = () => sectionsReporting > 0;

export function reportBlockedCount(count: number) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(BLOCKED_COUNTED, { detail: count }));
}

export function onBlockedCount(listener: (count: number) => void) {
  const handler = (event: Event) => { const count = (event as CustomEvent<unknown>).detail; if (typeof count === "number") listener(count); };
  window.addEventListener(BLOCKED_COUNTED, handler);
  return () => window.removeEventListener(BLOCKED_COUNTED, handler);
}

/**
 * The count for the Members entry's badge: one look on mount unless Members reports it, then every
 * report. A failure leaves no count. `enabled` false (a role that cannot manage the team, or
 * two-factor setup still required) skips the request.
 */
export function useBlockedCount(enabled: boolean) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let looked = false;
    if (!blockedCountClaimed()) {
      looked = true;
      listTeam().then(({ users }) => { if (live && looked) setCount(blockedCountOf(users)); }, () => undefined);
    }
    const stop = onBlockedCount((reported) => { looked = false; if (live) setCount(reported); });
    return () => { live = false; stop(); };
  }, [enabled]);
  return count;
}
