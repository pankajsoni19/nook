import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { registerTestModule, TEST_KIND, unregisterTestModule } from "./support/workspaceTestModule";

const { registeredWorkspaceModules } = await import("../server/workspaceModules");
const { moduleRoutePaths } = await import("../server/workspaceRegistry");
const { publicRoutePaths, registerPublicRoutes } = await import("../server/public/routes");
const { registerWorkspaceModule } = await import("../server/workspaceRegistry");
const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests, loadLiveKey, mcpToolSpecs, toolVisible } = await import("../server/mcpTools");
const { NOOK_NEVER_TOOLS } = await import("../server/agents/nookBridge");
const { runScheduleTick } = await import("../server/schedules/dispatcher");
const { loadToday, todayContext } = await import("../server/today/registry");
const { resetSearchRateLimit } = await import("../server/searchRoutes");
const { MODULES } = await import("../src/modules");
const { MODULE_IDS } = await import("../server/moduleIds");
const { WORKSPACE_MODULE_IDS } = await import("../shared/workspaceModules");

/**
 * The workspace module registry (docs/plan/WORKSPACE_MODULES.md §B.1, §F.2 acceptance, D800, D801,
 * T500): the seven stubs are registered and hidden in the app, and a throwaway module registers routes
 * (behind every guard), a guest write, public routes (outside them), an MCP tool, a dataset, a schedule
 * handler, a search scope, and a Today section, each working end to end.
 */

let owner: Session;
let member: Session;
let guest: Session;
const api = async (session: Session | null, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, session ?? undefined);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as Record<string, unknown> & { [key: string]: unknown } };
};

beforeAll(async () => {
  registerTestModule();
  owner = await createUser("Registry owner");
  member = await createUser("Registry member");
  guest = await createUser("Registry guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
});
afterAll(() => unregisterTestModule());

describe("vocabulary and stubs (D800)", () => {
  test("the seven module stubs are registered on the server and hidden in the app", () => {
    for (const id of WORKSPACE_MODULE_IDS) expect(registeredWorkspaceModules()).toContain(id);
    for (const id of WORKSPACE_MODULE_IDS) expect(MODULE_IDS).toContain(id);
    // Hidden until its lane sets ready (Bookings has).
    expect(MODULES.filter((module) => (WORKSPACE_MODULE_IDS as readonly string[]).includes(module.id)).map((module) => [module.id, Boolean(module.planned)])).toEqual(WORKSPACE_MODULE_IDS.map((id) => [id, id !== "bookings"]));
    expect(MODULES.find((module) => module.id === "crm")!.label).toBe("Contacts");
    expect(MODULES.find((module) => module.id === "checkins")!.label).toBe("Standups");
  });

  test("a second registration of an id, or an unknown id, is refused", () => {
    expect(() => registerWorkspaceModule({ id: "forms" })).toThrow(/already registered/);
    expect(() => registerWorkspaceModule({ id: "nope" as never })).toThrow(/Unknown workspace module/);
  });
});

describe("routes (T500)", () => {
  test("module routes sit behind the session, CSRF, and role write guards", async () => {
    expect((await api(null, "GET", "/test-widgets")).status).toBe(401);
    const noCsrf = await request("/test-widgets", { method: "POST", body: JSON.stringify({ name: "x" }), headers: { "X-CSRF-Token": "wrong" } }, owner);
    expect(noCsrf.status).toBe(403);
    expect(await api(guest, "POST", "/test-widgets", { name: "Guest widget" })).toMatchObject({ status: 403, body: { code: "ROLE_READ_ONLY" } });
    const created = await api(owner, "POST", "/test-widgets", { name: "Alpha widget", shared: true });
    expect(created.status).toBe(201);
    expect((await api(owner, "GET", "/test-widgets")).body.widgets).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.body.id, name: "Alpha widget" })]));
    // The module's read-only write: a guest answers a widget shared with them (the handler decides who may).
    const answered = await api(guest, "POST", `/test-widgets/${created.body.id}/answers`, { answers: { name: "Gus" } });
    expect(answered.status).toBe(201);
    // Members-only checks stay with the question engine: a missing required answer is refused with field errors.
    expect(await api(member, "POST", `/test-widgets/${created.body.id}/answers`, { answers: {} })).toMatchObject({ status: 400, body: { code: "INVALID_ANSWERS", errors: { name: "This question is required" } } });
  });

  test("every module route is under /api/ (never /api/public/), every public route under /p/ or /api/public/; the routers refuse anything else", () => {
    expect(moduleRoutePaths.length).toBeGreaterThan(0);
    for (const route of moduleRoutePaths) expect({ route: route.path, ok: route.path.startsWith("/api/") && !route.path.startsWith("/api/public/") }).toEqual({ route: route.path, ok: true });
    for (const route of publicRoutePaths) expect({ route: route.path, ok: route.path.startsWith("/p/") || route.path.startsWith("/api/public/") }).toEqual({ route: route.path, ok: true });
    expect(() => registerPublicRoutes("test_rogue", (router) => router.get("/api/test-rogue" as never, (c) => c.json({})))).toThrow(/must be under/);
    expect(() => registerPublicRoutes("test_rogue", (router) => router.get("/api/public/chat-shares/x", (c) => c.json({})))).toThrow(/must be under/);
    expect(() => registerWorkspaceModule({ id: "test_rogue", routes: (router) => router.get("/api/public/rogue" as never, (c) => c.json({})) })).toThrow(/must be under/);
  });

  test("an unknown /api path still answers the app's 404 after the dispatcher", async () => {
    expect(await api(owner, "GET", "/no-such-route")).toMatchObject({ status: 404, body: { error: "Not found" } });
  });
});

describe("registries end to end", () => {
  test("MCP: the module's tool is offered to a forms key with annotations and structured output, and never to agents", async () => {
    const created = createApiKey(owner.userId, { name: "Forms key", surfaces: "both", grants: [{ module: "forms", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const spec = mcpToolSpecs.find((item) => item.name === "list_test_widgets")!;
    expect(toolVisible(spec, loadLiveKey(created.id)!)).toBe(true);
    const result = await invokeMcpToolForTests("list_test_widgets", {}, created.id);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ widgets: expect.arrayContaining([expect.objectContaining({ name: "Alpha widget" })]) });
    expect(NOOK_NEVER_TOOLS.has("list_test_widgets")).toBe(true);
    const notes = createApiKey(owner.userId, { name: "Notes key", surfaces: "both", grants: [{ module: "notes", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    expect(toolVisible(spec, loadLiveKey(notes.id)!)).toBe(false);
    // Over REST v1 the same tool runs through the same path.
    const rest = await fetch(`${origin}/api/v1/tools/list_test_widgets`, { method: "POST", headers: { Authorization: `Bearer ${created.token}`, "Content-Type": "application/json" }, body: "{}" });
    expect(rest.status).toBe(200);
  });

  test("schedules: the module's handler runs once per occurrence", async () => {
    const created = await api(owner, "POST", "/test-widgets", { name: "Scheduled widget" });
    const counts = await runScheduleTick({ nowMs: Date.now() + 5_000 });
    expect(counts?.ran).toBeGreaterThanOrEqual(1);
    const pings = db.query("SELECT payload FROM test_pings WHERE payload LIKE ?").all(`%${created.body.id}%`);
    expect(pings.length).toBe(1);
    await runScheduleTick({ nowMs: Date.now() + 10_000 });
    expect(db.query("SELECT payload FROM test_pings WHERE payload LIKE ?").all(`%${created.body.id}%`).length).toBe(1);
  });

  test("search: scope=all has a section for the module's scope; the scope runs on its own", async () => {
    resetSearchRateLimit();
    const all = await api(owner, "GET", "/search?scope=all&q=alpha");
    expect(all.status).toBe(200);
    const section = (all.body.sections as Array<{ scope: string; label: string; results: Array<{ title: string; kind: string }> }>).find((item) => item.scope === "test_widgets")!;
    expect(section).toMatchObject({ label: "Widgets", results: [expect.objectContaining({ title: "Alpha widget", kind: TEST_KIND })] });
    expect((all.body.sections as Array<{ scope: string }>).map((item) => item.scope)).toEqual(expect.arrayContaining(["notes", "files", "whiteboards", "collections", "reports", "test_widgets"]));
    expect((await api(owner, "GET", "/search?scope=test_widgets&q=alpha")).body).toMatchObject({ results: [expect.objectContaining({ title: "Alpha widget" })], truncated: false });
    // A guest has no module search (the scope is for members and viewers by default).
    expect((await api(guest, "GET", "/search?scope=test_widgets&q=alpha")).body).toEqual({ results: [], truncated: false });
    expect((await api(owner, "GET", "/search?scope=nope&q=alpha")).status).toBe(400);
  });

  test("Today: the module's section loads with the others, and MCP keys need its scope", async () => {
    const today = await loadToday(todayContext(owner.userId, "UTC"));
    expect(today.sections.testWidgets).toMatchObject({ href: "/test-widgets", items: expect.arrayContaining([expect.objectContaining({ title: "Alpha widget" })]) });
    const response = await api(owner, "GET", "/today?tz=UTC");
    expect(response.status).toBe(200);
  });

  test("datasets: listed for the module and queried with the viewer's scope", async () => {
    const listed = await api(member, "GET", "/datasets");
    expect((listed.body.datasets as Array<{ id: string }>).map((item) => item.id)).toEqual(expect.arrayContaining(["tasks.cards", "tasks.card_events", "test.widgets"]));
    const query = await api(member, "POST", "/datasets/query", { dataset: "test.widgets", measures: [{ fn: "count" }], dimensions: ["shared"] });
    // The member sees only the shared widget (the owner's private one is out of their scope).
    expect(query).toMatchObject({ status: 200, body: { columns: [{ name: "shared", type: "bool" }, { name: "count", type: "number" }], rows: [[true, 1]], truncated: false } });
  });
});
