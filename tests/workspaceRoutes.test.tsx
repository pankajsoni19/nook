import { afterAll, describe, expect, test } from "bun:test";
import { lazy } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownManager } from "@tiptap/markdown";
import { Gauge, Target, Timer } from "lucide-react";
import { MODULES, ModulesContext, settingsModulesFor } from "../src/modules";
import { formatRoute, locationUrl, parseRoute } from "../src/router";
import { nameItems } from "../src/routeNames";
import { readAppHistorySection } from "../src/appShellNavigation";
import { module as goalsStub } from "../src/goals/module";
import {
  friendlyWorkspaceItem, isWorkspaceModuleId, readyWorkspaceModules, registerWorkspaceClientModule, WORKSPACE_MODULE_IDS, workspaceHomeRoute, workspaceModules,
  type WorkspaceClientModule, type WorkspaceRoute
} from "../src/workspaceModules";
import { DEFAULT_SECTION_ORDER, groupTodaySections, TODAY_SECTIONS } from "../src/today/todaySections";
import { QuickActions, visibleQuickActions } from "../src/today/QuickActions";
import { cardFaceBadges, cardSections, clearCardSlotsForTests } from "../src/ui/cardSlots";
import { CardFaceBadgesOutlet, CardHeaderActionsOutlet, CardSectionsOutlet, TimelineDecorationsOutlet } from "../src/ui/CardSlotOutlets";
import { clearModuleEmbedsForTests, embedKindForPath, moduleEmbedMarkdown, registeredSlashItems } from "../src/editor/moduleEmbedRegistry";
import { markdownOptions, noteContentExtensions } from "../src/editor/extensions";
import { parseModuleEmbedLine } from "../src/editor/moduleEmbed";
import { TopBarItems } from "../src/AppShell";

/**
 * The client module registries (D832–D836, docs/plan/WORKSPACE_MODULES.md §B.1, §F.2): the seven
 * stubs stay hidden; a throwaway module, registered here only, gets routes, a Today section, a quick
 * action, card slots, an embed, a slash item, and a header item without touching a shared file.
 */

const notify = Object.assign(() => undefined, { success: () => undefined, info: () => undefined, warning: () => undefined, error: () => undefined }) as never;
const card = { id: "0b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d11", board_id: "1b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d11", key: "MYT-12", title: "Ship it" };

const goalsTest: WorkspaceClientModule = {
  ...goalsStub,
  ready: true,
  launcher: true,
  app: lazy(async () => ({ default: () => <main>Goals app</main> })),
  // /goals, /goals/<slug>-<shortid> (a goal), /goals/insights?period=q1; anything else is the list.
  parseRoute: (segments, search) => {
    const [first] = segments;
    if (first === "insights" && segments.length === 1) {
      const period = new URLSearchParams(search).get("period");
      return { path: ["insights"], search: period && /^q[1-4]$/.test(period) ? `?period=${period}` : "" };
    }
    const url = `/goals/${segments.join("/")}${search}`;
    const item = segments.length === 1 ? friendlyWorkspaceItem("note", first, url) : null;
    if (item && "pending" in item) return { path: [], pending: item.pending };
    return item ? { path: [item.id] } : { path: [] };
  },
  todaySections: {
    goalsCheckin: { title: "Goals to check in on", group: "today", empty: "none due", app: "Goals", row: (item) => ({ key: String(item.id), label: String(item.title), meta: "Due today", route: workspaceHomeRoute("goals") }) }
  },
  quickActions: [
    { id: "checkin", label: "Check in on a goal", icon: Target, href: "/goals" },
    { id: "admin-only", label: "Review goals", icon: Gauge, href: "/goals", hiddenFor: ["guest", "viewer"] }
  ],
  topBarItem: () => <span className="test-timer">0:42</span>,
  cardSections: [
    { id: "goals.side", area: "side", component: ({ card }) => <section className="test-goal-field">Goal for {card.key}</section> },
    { id: "goals.main", area: "main", order: 5, component: ({ readOnly }) => <section className="test-goal-main">{readOnly ? "read" : "write"}</section> }
  ],
  cardFaceBadges: [{ id: "goals.badge", component: ({ card }) => <span className="test-badge">G·{card.key}</span> }],
  cardHeaderActions: [{ id: "goals.action", component: () => <button type="button" aria-label="Start timer"><Timer /></button> }],
  timelineDecorations: [{ id: "goals.fill", component: () => <span className="test-fill" /> }],
  embedRenderers: [{ kind: "goal", component: ({ path }) => <p>Goal card {path}</p> }],
  slashItems: [{ label: "Goal", hint: "Show a goal's progress", keywords: "goal okr progress", run: () => undefined }]
};

afterAll(() => {
  registerWorkspaceClientModule(goalsStub);
  clearCardSlotsForTests();
  clearModuleEmbedsForTests();
});

describe("the stubs (D800, D832)", () => {
  test("seven modules, in Settings order, all registered and none ready", () => {
    expect(workspaceModules().map((module) => module.id)).toEqual([...WORKSPACE_MODULE_IDS]);
    expect(WORKSPACE_MODULE_IDS).toEqual(["forms", "time", "goals", "checkins", "crm", "bookings", "townhall"]);
    // A lane flips its module to ready when it ships (D800); a ready module always has its app.
    for (const module of workspaceModules()) expect({ id: module.id, ready: module.ready }).toEqual({ id: module.id, ready: module.app !== null });
    // Product owner names (§G.1): Contacts at /contacts, Standups at /standups.
    expect(workspaceModules().map((module) => [module.id, module.label, module.segment])).toEqual([
      ["forms", "Forms", "forms"], ["time", "Time", "time"], ["goals", "Goals", "goals"], ["checkins", "Standups", "standups"],
      ["crm", "Contacts", "contacts"], ["bookings", "Bookings", "bookings"], ["townhall", "Townhall", "townhall"]
    ]);
  });

  test("a stub is a planned module: not in Settings, no launcher, its URLs open Home", () => {
    const shipped = new Set(readyWorkspaceModules().map((module) => module.id as string));
    for (const id of WORKSPACE_MODULE_IDS) {
      const def = MODULES.find((module) => module.id === id)!;
      expect({ id, planned: def.planned === true }).toEqual({ id, planned: !shipped.has(id) });
      expect(def.routeApps).toEqual([id]);
    }
    expect(settingsModulesFor("admin").filter((module) => isWorkspaceModuleId(module.id) && !shipped.has(module.id)).length).toBe(0);
    const stubPaths: Array<[string, string]> = [["forms", "/forms"], ["crm", "/contacts/ana-silva-9xk2mm0a1b"], ["checkins", "/standups"], ["goals", "/goals/x"]];
    for (const [id, path] of stubPaths) if (!shipped.has(id)) expect(parseRoute(path)).toEqual({ app: "home" });
    expect(renderToStaticMarkup(<TopBarItems />)).toBe("");
  });

  test("guests never get Time, Contacts, or Bookings in Settings, once they ship", () => {
    // Read through the same filter Settings uses: the rule names them even while they are planned.
    const shown = settingsModulesFor("guest").map((module) => module.id);
    for (const id of ["time", "crm", "bookings", "team", "inbox"]) expect(shown).not.toContain(id);
  });

  test("Back and Forward remember a module section like any app", () => {
    expect(readAppHistorySection({ "mynotes.app-shell": { version: 1, userId: "u", section: "goals" } }, "u")).toBe("goals");
    expect(readAppHistorySection({ "mynotes.app-shell": { version: 1, userId: "u", section: "nope" } }, "u")).toBeNull();
  });
});

describe("a ready module (the throwaway test module)", () => {
  test("registers its routes: parse, format, a query it keeps, and friendly links", () => {
    registerWorkspaceClientModule(goalsTest);
    expect(parseRoute("/goals")).toEqual({ app: "goals", path: [], search: "" });
    expect(formatRoute(workspaceHomeRoute("goals"))).toBe("/goals");
    const insights = parseRoute("/goals/insights", "?period=q2&junk=1");
    expect(insights).toEqual({ app: "goals", path: ["insights"], search: "?period=q2" });
    expect(formatRoute(insights)).toBe("/goals/insights?period=q2");
    expect(locationUrl({ pathname: "/goals/insights", search: "?period=q2&junk=1" })).toBe("/goals/insights?period=q2");
    // A friendly segment the tab cannot name yet is pending (D773); once named it is the id.
    const pending = parseRoute("/goals/grow-mrr-7k3f9x2ab0") as WorkspaceRoute;
    expect(pending.pending).toEqual({ kind: "note", ref: "7k3f9x2ab0", url: "/goals/grow-mrr-7k3f9x2ab0" });
    expect(formatRoute(pending)).toBe("/goals/grow-mrr-7k3f9x2ab0");
    nameItems("note", [{ id: "2b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d11", short_id: "7k3f9x2ab0", title: "Grow MRR" }]);
    expect(parseRoute("/goals/grow-mrr-7k3f9x2ab0")).toEqual({ app: "goals", path: ["2b7c1a52-3f5e-4d8e-9a51-0c6a7f2b9d11"], search: "" });
    // Without its own formatRoute a module's URL is its segment and path.
    expect(formatRoute({ app: "goals", path: ["a b"], search: "" })).toBe("/goals/a%20b");
  });

  test("adds its Today section into its group and its quick actions by role", () => {
    expect(TODAY_SECTIONS.goalsCheckin?.module).toBe("goals");
    expect(DEFAULT_SECTION_ORDER).toContain("goalsCheckin");
    expect(groupTodaySections(["tasksDue", "goalsCheckin", "notesRecent"]).map((group) => [group.id, group.names])).toEqual([["today", ["tasksDue", "goalsCheckin"]], ["recent", ["notesRecent"]]]);
    // Shipped modules' own quick actions are left out here (each lane tests its own).
    const shipped = readyWorkspaceModules().filter((module) => module.id !== "goals").map((module) => module.id as string);
    const ids = (disabled: string[], role: "member" | "guest") => visibleQuickActions([...disabled, ...shipped], role).map((action) => action.id);
    expect(ids([], "member")).toEqual(["checkin", "admin-only"]);
    expect(ids([], "guest")).toEqual(["checkin"]);
    expect(ids(["goals"], "member")).toEqual([]);
    const markup = renderToStaticMarkup(<QuickActions onOpenRoute={() => undefined} />);
    expect(markup).toContain('<ul class="today-quick-actions" aria-label="Quick actions">');
    expect(markup).toContain('<a class="today-quick-action" href="/goals">');
    expect(renderToStaticMarkup(<ModulesContext.Provider value={["goals", ...shipped]}><QuickActions onOpenRoute={() => undefined} /></ModulesContext.Provider>)).toBe("");
  });

  test("its card slots render in the dialog, face, header, and Timeline, and hide while it is off", () => {
    const props = { card, readOnly: false, idPrefix: "c1", notify };
    expect(renderToStaticMarkup(<CardSectionsOutlet area="side" {...props} />)).toBe('<section class="test-goal-field">Goal for MYT-12</section>');
    expect(renderToStaticMarkup(<CardSectionsOutlet area="main" {...props} readOnly />)).toBe('<section class="test-goal-main">read</section>');
    expect(renderToStaticMarkup(<CardHeaderActionsOutlet {...props} />)).toContain('aria-label="Start timer"');
    expect(renderToStaticMarkup(<CardFaceBadgesOutlet card={card} />)).toBe('<span class="test-badge">G·MYT-12</span>');
    expect(renderToStaticMarkup(<TimelineDecorationsOutlet card={card} />)).toBe('<span class="test-fill"></span>');
    const off = (node: JSX.Element) => renderToStaticMarkup(<ModulesContext.Provider value={["goals"]}>{node}</ModulesContext.Provider>);
    expect(off(<CardSectionsOutlet area="side" {...props} />)).toBe("");
    expect(off(<CardFaceBadgesOutlet card={card} />)).toBe("");
    expect(cardSections("side", ["goals"])).toEqual([]);
    expect(cardFaceBadges().map((badge) => badge.module)).toEqual(["goals"]);
  });

  test("its header item joins the account row", () => {
    expect(renderToStaticMarkup(<TopBarItems />)).toBe('<span class="test-timer">0:42</span>');
  });

  test("its embed parses, keeps the neutral word, and round-trips; other lines stay links", () => {
    expect(embedKindForPath("/goals/grow-mrr-7k3f9x2ab0")?.kind).toBe("goal");
    expect(moduleEmbedMarkdown("goal", "/goals/grow-mrr-7k3f9x2ab0")).toBe('[Goal](/goals/grow-mrr-7k3f9x2ab0 "nook-embed")');
    expect(parseModuleEmbedLine('[Secret plan](/goals/grow-mrr-7k3f9x2ab0 "nook-embed")\n')?.path).toBe("/goals/grow-mrr-7k3f9x2ab0");
    expect(parseModuleEmbedLine('[Poll](/forms/x "nook-embed")')).toBeNull();
    // The word names the kind: a goal path under another kind's word is not a goal card.
    expect(parseModuleEmbedLine('[Poll](/goals/grow-mrr-7k3f9x2ab0 "nook-embed")')).toBeNull();
    expect(parseModuleEmbedLine('[Goal](/goals/insights "nook-embed")')).toBeNull();
    expect(parseModuleEmbedLine('[Goal](//evil.example/goals/x "nook-embed")')).toBeNull();
    const manager = new MarkdownManager({ extensions: noteContentExtensions(), markedOptions: markdownOptions });
    const json = manager.parse('Before\n\n[Secret plan](/goals/grow-mrr-7k3f9x2ab0 "nook-embed")\n\nAfter');
    expect(json.content?.find((node) => node.type === "moduleEmbed")?.attrs).toEqual({ kind: "goal", path: "/goals/grow-mrr-7k3f9x2ab0" });
    // The title a writer typed is never kept: the link text is the kind's word (T513).
    expect(manager.serialize(json).trim()).toBe('Before\n\n[Goal](/goals/grow-mrr-7k3f9x2ab0 "nook-embed")\n\nAfter');
    const plain = manager.parse('[Poll](/forms/x "nook-embed")');
    expect(JSON.stringify(plain)).not.toContain("moduleEmbed");
    expect(registeredSlashItems().map((item) => [item.label, item.module])).toEqual([["Goal", "goals"]]);
  });

  test("going back to the stub hides its routes again", () => {
    registerWorkspaceClientModule(goalsStub);
    expect(parseRoute("/goals")).toEqual({ app: "home" });
    expect(locationUrl({ pathname: "/goals", search: "?x=1" })).toBe("/goals");
  });
});
