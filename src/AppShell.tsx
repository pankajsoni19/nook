import { createContext, useContext, useEffect, useState } from "react";
import { Avatar } from "./ui/Avatar";
import { useSelfAvatar } from "./ui/selfAvatar";
import { Inbox, LogOut, Settings } from "lucide-react";
import "./appShell.css";
import { binCountClaimed, listBin, onBinChanged, onBinCount } from "./bin/binApi";
import { INBOX_CHANGED, pendingCount } from "./inbox/inboxApi";
import { useModuleEnabled } from "./modules";
import { NotificationBell } from "./notifications/NotificationBell";
import { NOTIFICATIONS_POLLED } from "./notifications/notificationsApi";
import type { Role } from "./team/teamRoles";

/**
 * The Inbox button in the account row, next to the bell (agent inbox D157), provided once by App.
 * Hidden for guests (they have no inbox), when the Inbox module is off, and on the Inbox itself.
 */
export type InboxNav = { role: Role | undefined; openInbox: () => void; onInbox: boolean };
export const InboxNavContext = createContext<InboxNav | null>(null);

/**
 * The pending badge: a bounded count (at most 100, T51), fetched on mount, after inbox changes, and
 * whenever the bell refreshes (its poll and focus), so a new proposal shows without a reload.
 */
export function useInboxCount(enabled: boolean) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const refresh = () => { pendingCount().then(({ pending }) => { if (live) setCount(pending); }, () => undefined); };
    refresh();
    for (const name of INBOX_COUNT_SIGNALS) window.addEventListener(name, refresh);
    return () => {
      live = false;
      for (const name of INBOX_COUNT_SIGNALS) window.removeEventListener(name, refresh);
    };
  }, [enabled]);
  return count;
}

/** Window events that refresh the Inbox badge: inbox changes, the bell's refresh, and focus. */
export const INBOX_COUNT_SIGNALS = [INBOX_CHANGED, NOTIFICATIONS_POLLED, "focus"] as const;

function InboxButton({ nav }: { nav: InboxNav }) {
  const count = useInboxCount(true);
  const label = count > 0 ? `Inbox, ${count >= 100 ? "100 or more" : count} pending` : "Inbox";
  return <button className="app-account-button app-account-inbox" onClick={nav.openInbox} aria-label={label} title="Inbox"><Inbox /><span className="app-account-label">Inbox</span>{count > 0 && <span className="app-account-badge" aria-hidden="true">{count > 99 ? "99+" : count}</span>}</button>;
}

/**
 * The Inbox row of a sidebar account footer (Notes, review L2): Notes renders its own shell, so on
 * a phone this row is its way into the Inbox. Same rules as the header button: hidden for guests
 * and when the Inbox module is off; the badge is the same bounded pending count.
 */
export function SidebarInboxRow({ nav }: { nav: Pick<InboxNav, "role" | "openInbox"> }) {
  const enabled = useModuleEnabled("inbox");
  const shown = enabled && nav.role !== undefined && nav.role !== "guest";
  const count = useInboxCount(shown);
  if (!shown) return null;
  const label = count > 0 ? `Inbox, ${count >= 100 ? "100 or more" : count} pending` : "Inbox";
  return <button className="footer-bin footer-inbox" onClick={nav.openInbox} aria-label={label}><Inbox />Inbox{count > 0 && <span className="footer-badge" aria-hidden="true">{count > 99 ? "99+" : count}</span>}</button>;
}

type AccountProps = {
  displayName: string;
  /** Opens the Settings page; absent on the Settings page itself, which leaves the button out. */
  onSettings?: () => void;
  onSignOut: () => void;
};

/**
 * The account row of every app header. Wave 38 order, left to right: Settings · Inbox · the bell ·
 * the signed-in person (picture and name) · Sign out, so Sign out is always the rightmost action.
 * The Bin and Team live in Settings (its nav), so the row has no Bin or Team button. Phones keep the
 * same order with icon-only buttons (the name is hidden, the picture stays).
 */
export function AccountActions({ displayName, onSettings, onSignOut }: AccountProps) {
  const inbox = useContext(InboxNavContext);
  const inboxEnabled = useModuleEnabled("inbox");
  // Wave 35 (QA U4): the signed-in person's own picture beside their name (the letter without one).
  const selfAvatar = useSelfAvatar();
  return <div className="app-account" role="group" aria-label="Account">
    {onSettings && <button className="app-account-button" onClick={onSettings} aria-label={`Open settings for ${displayName}`} title="Settings"><Settings /><span className="app-account-label">Settings</span></button>}
    {inbox && inboxEnabled && inbox.role !== "guest" && !inbox.onInbox && <InboxButton nav={inbox} />}
    {/* The bell renders only inside the signed-in shell. */}
    <NotificationBell />
    <span className="app-home-user"><Avatar className="app-user-avatar" name={displayName} url={selfAvatar} /><span className="app-home-user-name">{displayName}</span></span>
    <button className="app-account-button app-account-signout" onClick={onSignOut} title="Sign out"><LogOut /><span className="app-account-label">Sign out</span></button>
  </div>;
}

/**
 * The Bin's item count for its Settings nav entry (Wave 38; the top bar's Bin badge before): a lazy
 * look on mount (no polling), and again whenever the app restores or deletes from the Bin
 * (notifyBinChanged: Restore all in a key's Review, a deleted note); a failure leaves no count.
 * While Settings → Bin itself is on screen it reports the count of the items it loaded instead
 * (claimBinCount, review L3), so opening the Bin asks the server once, and a restore or delete there
 * is counted from the list, not fetched again. `enabled` false skips the request (the Bin entry
 * hidden: the module off or a guest, or two-factor setup still required).
 */
export function useBinCount(enabled = true) {
  const [binCount, setBinCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let request = 0;
    const count = () => {
      if (binCountClaimed()) return;
      const current = ++request;
      listBin().then(({ items }) => { if (live && current === request) setBinCount(items.length); }, () => undefined);
    };
    count();
    const stop = onBinChanged(count);
    // A reported count wins over a look still in flight.
    const stopReports = onBinCount((reported) => { request += 1; if (live) setBinCount(reported); });
    return () => { live = false; stop(); stopReports(); };
  }, [enabled]);
  return binCount;
}

/**
 * The page name shown on phones, where the header's brand name is visually hidden to fit the
 * account buttons (F2). A compact eyebrow on its own header line; decorative, since the header's
 * brand text (or each page's h1) already names the app for assistive tech.
 */
export function AppPageName({ name }: { name: string }) {
  return <span className="app-page-name" aria-hidden="true">{name}</span>;
}

/**
 * The Inbox button for headers that do not use AccountActions (Files), with the same rules: hidden
 * for guests, when the Inbox module is off, and on the Inbox itself (QA note 3).
 */
export function HeaderInboxButton() {
  const inbox = useContext(InboxNavContext);
  const inboxEnabled = useModuleEnabled("inbox");
  if (!inbox || !inboxEnabled || inbox.role === "guest" || inbox.onInbox) return null;
  return <InboxButton nav={inbox} />;
}
