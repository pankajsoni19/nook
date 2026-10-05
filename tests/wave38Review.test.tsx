import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, parseRoute } from "../src/router";
import { hubEntries, hubListGoesUnder, hubPopRoute, isHubRoute, settingsRoute } from "../src/settings/hubModel";
import { SettingsHubShell } from "../src/settings/SettingsHub";
import { hiddenModuleForApp, isAppEnabled, MODULES, type ModuleId } from "../src/modules";
import { TODAY_SECTIONS, viewAllRoute } from "../src/today/todaySections";
import type { AppSection } from "../src/appShellNavigation";

/**
 * Wave 38 review probes (Bin in Settings, slimmer top bar): the alias edges, the route gate for every
 * other module with `hubGatesItself`, the Today links, and the leftovers of the Bin and Team buttons.
 */
const src = join(import.meta.dir, "..", "src");
const read = (path: string) => readFileSync(join(src, path), "utf8");

describe("the /bin alias edges", () => {
  test("/bin with a trailing slash and /settings/bin are the same route; /settings/bin/extra falls back to the list", () => {
    expect(parseRoute("/bin/")).toEqual({ app: "bin" });
    expect(formatRoute(parseRoute("/bin/"))).toBe("/settings/bin");
    expect(parseRoute("/settings/bin/extra")).toEqual({ app: "settings", section: null });
    // Rewriting is idempotent: the canonical URL formats to itself (no replace loop).
    expect(formatRoute(parseRoute(formatRoute({ app: "bin" })))).toBe("/settings/bin");
  });

  test("Today's Leaving the Bin soon links (the server's /bin href) land on /settings/bin", () => {
    expect(formatRoute(viewAllRoute("/bin"))).toBe("/settings/bin");
    const row = TODAY_SECTIONS.binSoon!.row!({ id: "x", type: "note", title: "T", purge_after: new Date().toISOString() } as never);
    expect(formatRoute(row.route)).toBe("/settings/bin");
  });

  test("a /bin deep link on a phone gets the list under it, as /settings/bin does", () => {
    expect(hubListGoesUnder(parseRoute("/bin"), { app: "home" }, true)).toBe(true);
    expect(hubListGoesUnder(parseRoute("/bin"), { app: "home" }, false)).toBe(false);
    expect(isHubRoute(parseRoute("/bin"))).toBe(true);
  });
});

describe("the route gate with hubGatesItself", () => {
  const apps: AppSection[] = ["home", "notes", "files", "tasks", "collections", "calendar", "notifications", "bin", "team", "inbox", "whiteboards", "vault", "settings"];
  test("every module still gates its own apps when off; only bin (and admin Team) are left to the hub", () => {
    for (const module of MODULES) {
      for (const app of module.routeApps) {
        expect({ module: module.id, app, hidden: hiddenModuleForApp([module.id], app) }).toEqual({ module: module.id, app, hidden: module.id });
        expect(isAppEnabled([module.id], app)).toBe(false);
      }
    }
    // With every module off, Home and Settings are never gated; everything else is.
    const all = MODULES.map((module) => module.id) as ModuleId[];
    for (const app of apps) expect({ app, hidden: hiddenModuleForApp(all, app) !== null }).toEqual({ app, hidden: app !== "home" && app !== "settings" });
    // The hub exemption is exactly the bin app (plus the pre-existing admin Team gate), nothing wider.
    const source = read("App.tsx");
    expect(source).toContain('const hubGatesItself = teamGateOpen || activeApp === "bin";');
    expect(source.match(/hubGatesItself/g)?.length).toBe(3);
    // Back/Forward onto a hidden Bin entry still go through the generic skip (onPopState keeps the Team-only exemption).
    // (wave38-fixes: a guest's Bin entry is skipped like one with the module off.)
    expect(source).toContain('const hiddenRoute = route.app === "team" && canManageTeam(session.user.role) ? null : route.app === "bin" && !binEntryShown(session.user.role, binEnabled) ? "bin" : hiddenModuleForApp(disabledModules, route.app);');
  });

  test("the hub keeps the screen when a popped Bin entry is hidden, and the Bin entry disappears for every role", () => {
    expect(hubPopRoute(parseRoute("/bin"), true, false)).toBeNull();
    for (const role of ["admin", "member", "viewer", "guest"] as const) {
      expect(hubEntries(role, { teamModuleEnabled: false, binModuleEnabled: false }).some((entry) => entry.id === "bin")).toBe(false);
      // wave38-fixes: guests never get the entry (they can delete nothing).
      expect(hubEntries(role, { teamModuleEnabled: false, binModuleEnabled: true }).filter((entry) => entry.group === "workspace").map((entry) => entry.id)).toEqual(role === "guest" ? [] : ["bin"]);
    }
    // The Workspace group renders between Account and Team for an admin with Team off too.
    const markup = renderToStaticMarkup(<SettingsHubShell displayName="A" role="admin" entries={hubEntries("admin", { teamModuleEnabled: false, binCount: 2 })} selected="bin" listScreen={false} title="Bin" showBack={false} onBack={() => undefined} onSelect={() => undefined} account={null}>{null}</SettingsHubShell>);
    expect(markup.indexOf("settings-hub-group-account")).toBeLessThan(markup.indexOf("settings-hub-group-workspace"));
    expect(markup.indexOf("settings-hub-group-workspace")).toBeLessThan(markup.indexOf("settings-hub-group-team"));
    expect(markup).toContain('aria-current="page"');
  });
});

describe("leftovers of the Bin and Team buttons", () => {
  test("no source, style, or test refers to the removed chrome", () => {
    const shell = read("AppShell.tsx");
    expect(shell).not.toContain("listTeam");
    expect(shell).not.toContain("useBlockedCount");
    expect(shell).not.toContain("Trash2");
    expect(shell).not.toContain("Users");
    for (const css of ["appShell.css", "bin/bin.css", "styles.css"]) {
      expect({ css, stale: /app-account-bin|bin-app\b/.test(read(css)) }).toEqual({ css, stale: false });
    }
    // BinSection renders no header of its own: the hub's header names it.
    const bin = read("bin/BinSection.tsx");
    expect(bin).not.toContain("app-page-header");
    expect(bin).not.toContain("AccountActions");
    expect(bin).toContain('aria-labelledby="settings-hub-title"');
    // The sheet's old ad-hoc popstate listener is gone (the history guard owns Back now).
    expect(bin).not.toContain('addEventListener("popstate"');
    expect(bin).not.toContain("useDialogSentinel");
  });

  test("the settings route helper still names the list for the hub's fallbacks", () => {
    expect(settingsRoute()).toEqual({ app: "settings", section: null });
    expect(formatRoute(settingsRoute("security"))).toBe("/settings/security");
  });
});
