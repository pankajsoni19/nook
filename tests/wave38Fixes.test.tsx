import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute, type Route } from "../src/router";
import { readHistoryDepth, withHistoryDepth } from "../src/appShellNavigation";
import { dialogPopDirection } from "../src/historyDialogs";
import { hiddenEntryStep, recordPopDepth } from "../src/modules";
import { binEntryShown, HUB_PUSHED_OVER_KEY, hubBackAction, hubEntries, hubEntryOf, hubPopRoute, isHubRoute, settingsRoute } from "../src/settings/hubModel";
import { SettingsHubShell } from "../src/settings/SettingsHub";
import { binCountClaimed, claimBinCount, onBinCount, reportBinCount } from "../src/bin/binApi";
import { blockedCountClaimed, blockedCountOf, claimBlockedCount, onBlockedCount, reportBlockedCount } from "../src/team/blockedCount";

/**
 * Wave 38 review fixes: Forward onto a hidden Bin entry (M1), the blocked-account badge on Members
 * (L1), one Bin load when the section opens (L3), and no Bin entry for guests.
 */
const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** A browser history as App writes it: a depth per entry and the URL it was pushed over. */
function browser(start: string) {
  const entries: Array<{ url: string; state: Record<string, unknown> | null }> = [{ url: start, state: null }];
  let index = 0;
  return {
    get url() { return entries[index]!.url; },
    get state() { return entries[index]!.state; },
    get urls() { return entries.map((entry) => entry.url); },
    push(route: Route) {
      const below = entries[index]!;
      entries.splice(index + 1);
      entries.push({ url: formatRoute(route), state: withHistoryDepth({ [HUB_PUSHED_OVER_KEY]: below.url }, readHistoryDepth(below.state) + 1) });
      index += 1;
    },
    replace(route: Route) { entries[index] = { url: formatRoute(route), state: entries[index]!.state }; },
    back() { index = Math.max(0, index - 1); },
    forward() { index = Math.min(entries.length - 1, index + 1); }
  };
}

const screen = (route: Route) => !isHubRoute(route) ? `app:${route.app}` : route.app === "settings" && route.section === null ? "list" : hubEntryOf(route)!;

/**
 * The two popstate listeners of a hub screen, in registration order: the hub's (hubPopRoute, keeping
 * the screen for a hidden Bin entry) and App's route gate (D92: Forward onto a hidden entry is undone,
 * Back steps on past it, an entry with no known direction is replaced with Security). The gate's
 * own moves pop again; an undo's popstate is one the dialog layer consumes, and the hub re-reads the
 * URL once it settled.
 */
function hubWindow(history: ReturnType<typeof browser>, options: { binShown: boolean }) {
  const sim = { binShown: options.binShown, ref: { current: readHistoryDepth(history.state) }, hub: screen(parseRoute(history.url)), ignoring: 0, undone: 0, skipped: 0, replaced: 0 };
  const follow = () => {
    const next = hubPopRoute(parseRoute(history.url), true, sim.binShown);
    if (next) sim.hub = screen(next);
  };
  const pop = (move: () => void) => {
    move();
    const popped = readHistoryDepth(history.state);
    const previous = recordPopDepth(sim.ref, popped);
    if (sim.ignoring > 0) { sim.ignoring -= 1; follow(); return; }
    follow();
    const route = parseRoute(history.url);
    if (route.app !== "bin" || sim.binShown) return;
    const step = hiddenEntryStep(dialogPopDirection(previous, popped), popped);
    if (step === "undo") { sim.undone += 1; sim.ref.current = previous; sim.ignoring += 1; pop(() => history.back()); }
    else if (step === "back") { sim.skipped += 1; pop(() => history.back()); }
    else { sim.replaced += 1; history.replace(settingsRoute("security")); follow(); }
  };
  return {
    sim,
    navigate(route: Route) { history.push(route); sim.ref.current = readHistoryDepth(history.state); sim.hub = screen(route); },
    back: () => pop(() => history.back()),
    forward: () => pop(() => history.forward()),
    /** The phone's back arrow: Back when the section was pushed over the list. */
    arrow() { expect(hubBackAction(history.state)).toBe("history"); pop(() => history.back()); }
  };
}

describe("M1: Forward onto a hidden Bin entry after a page-load entry", () => {
  test("a computer: /settings/modules (page load) → Bin → Security → Modules → Bin off → Back → Back → Forward is undone, never a dead end", () => {
    // Startup on a /settings/modules deep link: Home replaced the landing entry, the section was pushed over it.
    const history = browser("/");
    history.push(settingsRoute("modules"));
    const page = hubWindow(history, { binShown: true });
    page.navigate({ app: "bin" });
    page.navigate(settingsRoute("security"));
    page.navigate(settingsRoute("modules"));
    expect(readHistoryDepth(history.state)).toBe(4);
    page.sim.binShown = false;
    page.back();
    expect([history.url, page.sim.hub]).toEqual(["/settings/security", "security"]);
    page.back();
    // The hidden Bin entry is stepped past to Modules (depth 1), and the depth on record follows.
    expect([history.url, page.sim.hub, page.sim.ref.current, page.sim.skipped]).toEqual(["/settings/modules", "modules", 1, 1]);
    page.forward();
    // The finding: the URL read /settings/bin over the Modules screen. Now Forward is undone.
    expect([history.url, page.sim.hub, page.sim.ref.current, page.sim.undone]).toEqual(["/settings/modules", "modules", 1, 1]);
    page.forward();
    expect([history.url, page.sim.hub, page.sim.undone]).toEqual(["/settings/modules", "modules", 2]);
    expect(page.sim.replaced).toBe(0);
    // A phone window that walked the same chain (resized after) gets the same skip and undo: the gate is width-independent.
  });

  test("why: the gate's listener missed the skip's landing, so the next Forward had no direction", () => {
    // With the skip's popstate missed, the depth on record stayed at the Bin entry's (2); Forward onto
    // it then read the same depth: no direction, and "replace" never undoes the move.
    expect(hiddenEntryStep(dialogPopDirection(2, 2), 2)).toBe("replace");
    expect(hiddenEntryStep(dialogPopDirection(1, 2), 2)).toBe("undo");
    const app = read("src/App.tsx");
    // The listener is registered once and dispatches to the newest handler (a listener re-registered
    // per render is dropped mid-dispatch when an earlier listener's state change renders App).
    expect(app).toContain("const listen = (event: PopStateEvent) => popStateRef.current(event);");
    expect(app).toContain("popStateRef.current = onPopState;");
    expect(app).not.toContain('window.addEventListener("popstate", onPopState);\n    return () => window.removeEventListener("popstate", onPopState);\n  });');
    // A hidden Bin entry the gate cannot skip is replaced with Security in place (the hub's rule), not Home.
    expect(app).toContain('if (hiddenRoute === "bin") {');
    expect(app).toContain('navigate(settingsRoute("security"), { replace: true });\n      return;');
    // The hub re-reads the URL on a tick after a popped hidden Bin entry, so the screen follows the gate's move.
    expect(app).toContain('if (routeFromLocation(window.location).app === "bin" && !binShownRef.current) later = setTimeout(() => { later = null; cancel = whenHistorySettled(follow); }, 0);');
  });

  test("an entry with no known direction is replaced with Security in place", () => {
    const history = browser("/");
    history.push({ app: "bin" });
    const page = hubWindow(history, { binShown: false });
    // The depth on record equals the popped entry's (a reload of the entry): no direction.
    page.sim.ref.current = 1;
    page.forward();
    expect([history.url, page.sim.hub, page.sim.replaced]).toEqual(["/settings/security", "security", 1]);
  });

  test("a phone: the same sequence never keeps a Bin entry ahead (a section is pushed over the list), and Back/Forward walk Home, the list, Modules", () => {
    // Startup on a phone: Home, the list, then the section.
    const history = browser("/");
    history.push(settingsRoute(null));
    history.push(settingsRoute("modules"));
    const page = hubWindow(history, { binShown: true });
    page.arrow();
    page.navigate({ app: "bin" });
    page.arrow();
    page.navigate(settingsRoute("security"));
    page.arrow();
    page.navigate(settingsRoute("modules"));
    expect(history.urls).toEqual(["/", "/settings", "/settings/modules"]);
    page.sim.binShown = false;
    page.back();
    expect([history.url, page.sim.hub]).toEqual(["/settings", "list"]);
    page.back();
    expect(history.url).toBe("/");
    page.forward();
    expect([history.url, page.sim.hub]).toEqual(["/settings", "list"]);
    page.forward();
    expect([history.url, page.sim.hub, page.sim.undone, page.sim.skipped, page.sim.replaced]).toEqual(["/settings/modules", "modules", 0, 0, 0]);
  });
});

describe("L1: the blocked-account count on Team → Members", () => {
  test("admins get the count as a badge on Members; other roles and zero get none", () => {
    const entries = hubEntries("admin", { teamModuleEnabled: true, blockedCount: 2 });
    expect(entries.find((entry) => entry.id === "team-members")).toMatchObject({ badge: 2, badgeNoun: "blocked account" });
    expect(entries.filter((entry) => entry.badge).map((entry) => entry.id)).toEqual(["team-members"]);
    expect(hubEntries("admin", { teamModuleEnabled: true, blockedCount: 0 }).find((entry) => entry.id === "team-members")?.badge).toBeUndefined();
    expect(hubEntries("member", { teamModuleEnabled: true, blockedCount: 2 }).find((entry) => entry.id === "team-members")?.badge).toBeUndefined();
    // Both badges at once: the Bin's items and Members' blocked accounts, each named for assistive tech.
    const shell = (blocked: number) => renderToStaticMarkup(<SettingsHubShell displayName="Ada" role="admin" entries={hubEntries("admin", { teamModuleEnabled: true, binCount: 3, blockedCount: blocked })} selected="security" listScreen={false} title="Security" showBack={false} onBack={() => undefined} onSelect={() => undefined} account={null}>{null}</SettingsHubShell>);
    expect(shell(2)).toContain('aria-label="Members, 2 blocked accounts"');
    expect(shell(2)).toContain('aria-label="Bin, 3 items"');
    expect(shell(1)).toContain('aria-label="Members, 1 blocked account"');
    expect(shell(0)).not.toContain('aria-label="Members');
  });

  test("the count is lazy for roles that manage the team, and Members reports its own list while on screen", () => {
    expect(blockedCountOf([{ status: "blocked" }, { status: "active" }, { status: "blocked" }])).toBe(2);
    expect(read("src/App.tsx")).toContain("const blockedCount = useBlockedCount(canManageTeam(session.user.role) && !setupRequired);");
    expect(read("src/App.tsx")).toContain("binCount, blockedCount })");
    const team = read("src/team/TeamApp.tsx");
    expect(team).toContain("useEffect(() => admin ? claimBlockedCount() : undefined, [admin]);");
    expect(team).toContain("useEffect(() => { if (admin && members) reportBlockedCount(blockedCountOf(members)); }, [admin, members]);");
    const hook = read("src/team/blockedCount.ts");
    expect(hook).toContain("if (!blockedCountClaimed()) {");
    // The removed top-bar count stays out of the shell (the review's leftovers probe).
    expect(read("src/AppShell.tsx")).not.toContain("listTeam");
  });

  test("claim and report reach the hook", () => {
    const holder = globalThis as { window?: unknown };
    const previous = holder.window;
    holder.window = new EventTarget();
    try {
      expect(blockedCountClaimed()).toBe(false);
      const release = claimBlockedCount();
      expect(blockedCountClaimed()).toBe(true);
      const heard: number[] = [];
      const stop = onBlockedCount((count) => heard.push(count));
      reportBlockedCount(2);
      reportBlockedCount(1);
      stop();
      reportBlockedCount(5);
      expect(heard).toEqual([2, 1]);
      release();
      release();
      expect(blockedCountClaimed()).toBe(false);
    } finally {
      holder.window = previous;
    }
  });
});

describe("L3: one Bin load when Settings → Bin opens", () => {
  test("the section claims the count while mounted and reports its items; the hook loads only when no section does", () => {
    const section = read("src/bin/BinSection.tsx");
    expect(section).toContain("useEffect(() => claimBinCount(), []);");
    expect(section).toContain("useEffect(() => { if (items) reportBinCount(items.length); }, [items]);");
    const shell = read("src/AppShell.tsx");
    expect(shell).toContain("if (binCountClaimed()) return;");
    expect(shell).toContain("const stop = onBinChanged(count);");
    expect(shell).toContain("const stopReports = onBinCount((reported) => { request += 1; if (live) setBinCount(reported); });");
  });

  test("claim and report (binApi)", () => {
    const holder = globalThis as { window?: unknown };
    const previous = holder.window;
    holder.window = new EventTarget();
    try {
      expect(binCountClaimed()).toBe(false);
      const release = claimBinCount();
      const again = claimBinCount();
      expect(binCountClaimed()).toBe(true);
      const heard: number[] = [];
      const stop = onBinCount((count) => heard.push(count));
      reportBinCount(4);
      (holder.window as EventTarget).dispatchEvent(new CustomEvent("nook:bin-counted", { detail: "not a number" }));
      stop();
      reportBinCount(1);
      expect(heard).toEqual([4]);
      release();
      expect(binCountClaimed()).toBe(true);
      again();
      expect(binCountClaimed()).toBe(false);
    } finally {
      holder.window = previous;
    }
  });
});

describe("guests have no Bin entry", () => {
  test("binEntryShown: the module on and not a guest; the hub and the gate treat a guest's Bin like the module off", () => {
    expect(binEntryShown("guest", true)).toBe(false);
    for (const role of ["admin", "member", "viewer", undefined] as const) expect(binEntryShown(role, true)).toBe(true);
    for (const role of ["admin", "member", "viewer", "guest", undefined] as const) expect(binEntryShown(role, false)).toBe(false);
    expect(hubEntries("guest", { teamModuleEnabled: true, binCount: 3 }).some((entry) => entry.group === "workspace")).toBe(false);
    expect(hubPopRoute({ app: "bin" }, true, binEntryShown("guest", true))).toBeNull();
    const app = read("src/App.tsx");
    expect(app).toContain("const binShown = binEntryShown(session.user.role, binModuleEnabled);");
    expect(app).toContain('const binHidden = route.app === "bin" && !binShown;');
    expect(app).toContain('route.app === "bin" && !binEntryShown(session.user.role, binEnabled) ? "bin"');
  });

  // The Docker verify stage has no docs/: check the guide only where it exists.
  test.skipIf(!existsSync(join(root, "docs/USING.md")))("USING.md says the Bin is for everyone except guests", () => {
    expect(read("docs/USING.md")).toContain("for everyone except guests");
  });
});
