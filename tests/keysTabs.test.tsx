import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { formatRoute, keysTabRoute, parseRoute, settingsDocumentTitle, type Route } from "../src/router";
import { HUB_PUSHED_OVER_CHAIN_KEY, HUB_PUSHED_OVER_KEY, hubBackSteps, hubEntryOf, hubPopRoute, isNestedHubRoute, leaveGuardAction, settingsRoute } from "../src/settings/hubModel";
import { keysTabCounts, keysTabPreset, keyTabOf, shownKeysTab, visibleKeysTabs } from "../src/keys/keyTabs";
import { KeysTabs } from "../src/keys/KeysTabs";
import { createPreset, KeyRow, KeysSettings } from "../src/keys/KeysSettings";
import { unsavedKeyConfirm } from "../src/keys/unsavedKeyConfirm";
import { readHistoryDepth, withHistoryDepth } from "../src/appShellNavigation";
import { PUSHED_OVER_CHAIN_KEY, PUSHED_OVER_KEY } from "../src/App";
import type { ApiKey, KeyGrantView } from "../src/keys/keysApi";

/**
 * Settings → API keys' tabs: General (/settings/keys/general), Vault (/settings/keys/vault), and
 * Agents (/settings/keys/agents). Which tab lists a key, the counts, the builder preset per tab, the
 * leave guard on a tab switch, the phone's history, and no tabs on an integration's page.
 */

const src = join(import.meta.dir, "..", "src");
const read = (path: string) => readFileSync(join(src, path), "utf8");
const on = { vault: true, agents: true };

const grant = (module: string, permission: string): KeyGrantView => ({ module, permission, resource: null, active: true, inactiveReason: null }) as KeyGrantView;
function apiKey(patch: Partial<ApiKey> = {}): ApiKey {
  return {
    id: crypto.randomUUID(), name: "Key", description: null, prefix: "mynotes_Ab3", kind: "general", surfaces: "mcp",
    createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: null, expiresAt: null, revokeAfter: null, revokedAt: null,
    rotatedFrom: null, state: "active", blockedBy: null, blockedMessage: null, revokedBy: null, revokeReason: null,
    grants: [grant("notes", "read")], scopes: [], effectiveScopes: [], limits: {}, usage14d: Array(14).fill(0), ...patch
  };
}
const generalOnly = apiKey({ grants: [grant("notes", "read"), grant("tasks", "write")] });
const generalAndAgents = apiKey({ grants: [grant("notes", "read"), grant("agents", "run")] });
const agentsOnly = apiKey({ grants: [grant("agents", "run"), grant("agents", "read")] });
const agentsAndKnowledge = apiKey({ grants: [grant("agents", "run"), grant("knowledge_base", "read")] });
const vaultKey = apiKey({ kind: "vault", prefix: "nkv_Ab3", grants: [{ module: "vault", permission: "read", vault: { id: "v1", name: "Deploy" }, environment: null, active: true, inactiveReason: null } as unknown as KeyGrantView] });

describe("the URLs", () => {
  test("each tab is a URL; General is /settings/keys/general", () => {
    expect(parseRoute("/settings/keys/general")).toEqual({ app: "settings", section: "mcp" });
    expect(parseRoute("/settings/keys/vault")).toEqual({ app: "settings", section: "mcp", keysTab: "vault" });
    expect(parseRoute("/settings/keys/agents")).toEqual({ app: "settings", section: "mcp", keysTab: "agents" });
    for (const tab of ["general", "vault", "agents"] as const) {
      expect(formatRoute(keysTabRoute(tab))).toBe(`/settings/keys/${tab}`);
      expect(formatRoute(parseRoute(`/settings/keys/${tab}`))).toBe(`/settings/keys/${tab}`);
    }
  });

  test("/settings/keys, the /settings/mcp alias, and unknown tabs open General; old /settings/mcp/:tab still works", () => {
    for (const path of ["/settings/keys", "/settings/mcp", "/settings/keys/", "/settings/keys/nope", "/settings/keys/constructor", "/settings/mcp/general"]) {
      expect(parseRoute(path)).toEqual({ app: "settings", section: "mcp" });
      expect(formatRoute(parseRoute(path))).toBe("/settings/keys/general");
    }
    expect(formatRoute(parseRoute("/settings/mcp/vault"))).toBe("/settings/keys/vault");
    // The hub's nav entry (no tab) opens General; a tab is the same section, not a page below it.
    expect(formatRoute(settingsRoute("mcp"))).toBe("/settings/keys/general");
    expect(hubEntryOf(keysTabRoute("vault"))).toBe("mcp");
    expect(isNestedHubRoute(keysTabRoute("agents"))).toBe(false);
    // Deeper paths are not tabs: the list, as any unknown Settings path.
    expect(parseRoute("/settings/keys/vault/extra")).toEqual({ app: "settings", section: null });
    // Back and Forward follow the tab on the URL.
    expect(hubPopRoute(parseRoute("/settings/keys/vault"), true)).toEqual(keysTabRoute("vault"));
  });

  test("document titles name the tab", () => {
    expect(settingsDocumentTitle("mcp", "vault")).toMatch(/^Settings · API keys · Vault · /);
    expect(settingsDocumentTitle("mcp", "general")).toMatch(/^Settings · API keys · General · /);
    expect(settingsDocumentTitle("mcp")).toMatch(/^Settings · API keys · /);
    expect(read("App.tsx")).toContain('settingsDocumentTitle(section ?? "security", keysTab)');
  });
});

describe("which tab lists a key", () => {
  test("general only, general with agents (General), agents only (Agents), and vault", () => {
    expect(keyTabOf(generalOnly, on)).toBe("general");
    expect(keyTabOf(generalAndAgents, on)).toBe("general");
    expect(keyTabOf(agentsOnly, on)).toBe("agents");
    expect(keyTabOf(agentsAndKnowledge, on)).toBe("agents");
    expect(keyTabOf(vaultKey, on)).toBe("vault");
    // A key with no grants left is a General key.
    expect(keyTabOf(apiKey({ grants: [] }), on)).toBe("general");
  });

  test("with the Vault off, vault keys are on General; with Chat off, agents-only keys are", () => {
    expect(keyTabOf(vaultKey, { vault: false, agents: true })).toBe("general");
    expect(keyTabOf(agentsOnly, { vault: true, agents: false })).toBe("general");
    expect(visibleKeysTabs(on)).toEqual(["general", "vault", "agents"]);
    expect(visibleKeysTabs({ vault: false, agents: true })).toEqual(["general", "agents"]);
    expect(visibleKeysTabs({ vault: true, agents: false })).toEqual(["general", "vault"]);
    expect(shownKeysTab("vault", { vault: false, agents: true })).toBe("general");
    expect(shownKeysTab("agents", { vault: true, agents: false })).toBe("general");
    expect(shownKeysTab("agents", on)).toBe("agents");
  });

  test("the General tab's chips: Agents on a key that also runs agents; Vault on a vault key", () => {
    expect(renderToStaticMarkup(<KeyRow apiKey={generalAndAgents} agentsChip />)).toContain('<span class="keys-chip">Agents</span>');
    expect(renderToStaticMarkup(<KeyRow apiKey={generalOnly} />)).not.toContain(">Agents<");
    expect(renderToStaticMarkup(<KeyRow apiKey={vaultKey} />)).toContain('<span class="keys-chip">Vault</span>');
    const source = read("keys/KeysSettings.tsx");
    expect(source).toContain('agentsChip={tabbed && shownTab === "general" && key.kind === "general" && holdsAgentGrants(key)}');
    expect(source).toContain("The Vault is turned off, so vault keys are listed here under General.");
  });

  test("counts are live keys per tab, so every key is counted once", () => {
    const keys = [generalOnly, generalAndAgents, agentsOnly, agentsAndKnowledge, vaultKey, apiKey({ kind: "vault", state: "revoked" }), apiKey({ state: "revoked" })];
    expect(keysTabCounts(keys, on)).toEqual({ general: 2, vault: 1, agents: 2 });
    expect(keysTabCounts(keys, { vault: false, agents: false })).toEqual({ general: 5, vault: 0, agents: 0 });
    const tabs = renderToStaticMarkup(<KeysTabs tabs={["general", "vault", "agents"]} selected="vault" counts={{ general: 2, vault: 1, agents: 2 }} onSelect={() => undefined} />);
    expect(tabs).toContain('<span>Vault</span> <span class="keys-tab-count">1</span>');
  });
});

describe("New key on each tab", () => {
  const policy = { keyDefaultDays: 90, restAllowed: true };
  test("General: Notes → Read; Vault: a vault key; Agents: Chat → Run agents and nothing else", () => {
    expect(keysTabPreset("general")).toEqual({ kind: "general", firstRow: { module: "notes", permission: "read" } });
    expect(createPreset("vault", true, policy)).toEqual({ kind: "vault", firstRow: { module: "notes", permission: "read" }, surfaces: "rest", expires: "90" });
    expect(createPreset("vault", true, { keyDefaultDays: 500, restAllowed: true }).expires).toBe("365");
    expect(createPreset("agents", true, policy)).toEqual({ kind: "general", firstRow: { module: "agents", permission: "run" }, surfaces: "mcp", expires: "90" });
    // No vault (an integration, or the Vault off): never a vault key.
    expect(createPreset("vault", false, policy).kind).toBe("general");
    const source = read("keys/KeysSettings.tsx");
    expect(source).toContain('preset={tabbed ? shownTab : "general"}');
    expect(source).toContain("const [rows, setRows] = useState<GrantRow[]>(() => [{ key: newRowKey(), ...preset.firstRow, applies: \"all\", resourceIds: [] }]);");
    expect(source).toContain('const [kind, setKind] = useState<"general" | "vault">(preset.kind);');
  });
});

describe("the leave guard on a tab switch", () => {
  test("a key on screen: switching tabs asks first, in the app and with Back or Forward", () => {
    expect(leaveGuardAction(keysTabRoute("vault"), keysTabRoute("general"))).toBe("tab");
    expect(leaveGuardAction(keysTabRoute("general"), keysTabRoute("agents"))).toBe("tab");
    expect(leaveGuardAction(settingsRoute("security"), keysTabRoute("vault"))).toBe("section");
    expect(leaveGuardAction(parseRoute("/notes"), keysTabRoute("vault"))).toBe("leave");
    expect(unsavedKeyConfirm("tab")).toEqual(expect.objectContaining({ title: "Leave without saving the key?", confirmLabel: "Switch tab", danger: true }));
    expect(unsavedKeyConfirm("tab").message).toContain("Switch tabs without copying it?");
    const app = read("App.tsx");
    expect(app).toContain('const openKeysTab = useCallback((tab: KeysTab) => guardLeave(() => go(keysTabRoute(tab)), "tab"), [go, guardLeave]);');
    expect(app).toContain("tab={keysTab} onTab={openKeysTab}");
    // Once the person chose to leave, the one-time panel goes with the tab it was on.
    expect(read("keys/KeysSettings.tsx")).toMatch(/tabSeenRef\.current = shownTab;\s+setNewToken\(null\);/);
  });

  test("a hidden tab's URL opens General in place", () => {
    expect(read("App.tsx")).toContain('useEffect(() => { if (keysTabHidden) go(keysTabRoute("general"), { replace: true }); }, [go, keysTabHidden]);');
  });
});

describe("history at 390 px", () => {
  /** What App's navigate pushes: one deeper, with the URL (and chain) it was pushed over. */
  function browser(start: string) {
    const entries: Array<{ url: string; state: Record<string, unknown> | null }> = [{ url: start, state: null }];
    let index = 0;
    return {
      get url() { return entries[index]!.url; },
      get state() { return entries[index]!.state; },
      push(route: Route) {
        const below = entries[index]!;
        const chain = [below.url, ...((below.state?.[HUB_PUSHED_OVER_CHAIN_KEY] as string[] | undefined) ?? [])].slice(0, 4);
        entries.splice(index + 1);
        entries.push({ url: formatRoute(route), state: withHistoryDepth({ [HUB_PUSHED_OVER_KEY]: below.url, [HUB_PUSHED_OVER_CHAIN_KEY]: chain }, readHistoryDepth(below.state) + 1) });
        index += 1;
      },
      go(delta: number) { index = Math.min(entries.length - 1, Math.max(0, index + delta)); }
    };
  }

  test("the keys match App's", () => {
    expect(HUB_PUSHED_OVER_KEY).toBe(PUSHED_OVER_KEY);
    expect(HUB_PUSHED_OVER_CHAIN_KEY).toBe(PUSHED_OVER_CHAIN_KEY);
  });

  test("list → API keys → Vault → Agents: Back moves between tabs, then to the list; Forward returns; the arrow goes to the list", () => {
    const history = browser("/");
    history.push(settingsRoute(null));
    history.push(settingsRoute("mcp"));
    history.push(keysTabRoute("vault"));
    history.push(keysTabRoute("agents"));
    // The arrow: three steps back, over both tabs, to the list.
    expect(hubBackSteps(history.state)).toBe(3);
    history.go(-1);
    expect(history.url).toBe("/settings/keys/vault");
    history.go(-1);
    expect(history.url).toBe("/settings/keys/general");
    expect(hubBackSteps(history.state)).toBe(1);
    history.go(-1);
    expect(history.url).toBe("/settings");
    history.go(-1);
    expect(history.url).toBe("/");
    history.go(1);
    history.go(1);
    history.go(1);
    expect(history.url).toBe("/settings/keys/vault");
    // From the Vault tab the arrow is two steps.
    expect(hubBackSteps(history.state)).toBe(2);
  });

  test("a tab opened by a deep link: the arrow puts the list in place (no list below it)", () => {
    const history = browser("/");
    history.push(keysTabRoute("vault"));
    expect(hubBackSteps(history.state)).toBe(0);
    history.push(keysTabRoute("agents"));
    expect(hubBackSteps(history.state)).toBe(0);
    expect(read("App.tsx")).toContain("else if (hubBackSteps(window.history.state) > 0) window.history.go(-hubBackSteps(window.history.state));");
  });
});

describe("the page", () => {
  const host = globalThis as { window?: unknown };
  let saved: unknown;
  beforeEach(() => { saved = host.window; host.window = { location: { origin: "https://nook.example" }, requestAnimationFrame: () => 0 }; });
  afterEach(() => { host.window = saved; });
  const render = (props: Partial<Parameters<typeof KeysSettings>[0]>) => renderToStaticMarkup(<KeysSettings onPendingChange={() => undefined} totpEnabled={false} role="member" {...props} />);

  test("a tablist, tabs, and the tabpanel they control", () => {
    const markup = render({ tab: "vault" });
    expect(markup).toContain('role="tablist" aria-label="Key kinds"');
    expect(markup).toContain('role="tab" id="keys-tab-vault" data-tab="vault" aria-selected="true" aria-controls="keys-panel-vault" tabindex="0"');
    expect(markup).toContain('role="tab" id="keys-tab-general" data-tab="general" aria-selected="false" aria-controls="keys-panel-general" tabindex="-1"');
    expect(markup).toContain('role="tabpanel" id="keys-panel-vault" aria-labelledby="keys-tab-vault" tabindex="0"');
    expect(markup).toContain("Your vault keys");
    // Arrow keys, Home, and End move between tabs.
    const tabs = read("keys/KeysTabs.tsx");
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) expect(tabs).toContain(`event.key === "${key}"`);
  });

  test("hidden tabs: no Vault tab with the Vault off, no Agents tab with Chat off", () => {
    const markup = render({ tab: "vault", vaultAvailable: false, agentsAvailable: false });
    expect(markup).not.toContain('id="keys-tab-vault"');
    expect(markup).not.toContain('id="keys-tab-agents"');
    expect(markup).toContain('id="keys-panel-general"');
  });

  test("an integration's page shows no tabs", () => {
    const markup = render({ integration: { name: "CI bot" }, tab: "vault" });
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('role="tabpanel"');
    expect(markup).toContain("Keys of CI bot");
    expect(read("../src/team/IntegrationPage.tsx")).not.toContain("onTab=");
  });
});
