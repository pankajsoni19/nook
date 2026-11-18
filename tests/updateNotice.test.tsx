import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { request } from "./support/harness";
import { BUILD_HEADER, CHECK_GAP_MS, CHECK_INTERVAL_MS, createBuildWatch, DEV_BUILD, isNewBuild, LATER_KEY, normalBuild, pageBuild } from "../src/update/buildWatch";
import { guardedReload } from "../src/update/reload";
import { UpdateNotice } from "../src/update/UpdateNotice";
import { installChunkReload, onChunkLoadFailure, resetChunkReloadForTests, setGuardedReload } from "../src/chunkReload";
import { paletteEntries } from "../src/shell/paletteModel";
import { buildIdFromHtml, readBuildId, RECHECK_MS, resetBuildIdCacheForTests } from "../server/buildId";
import { buildIdOf, withBuildMeta } from "../vite.config";

/** The update notice: build ids, detection, Later, the guarded reload, its place on screen, and the server's report. */

const repo = join(import.meta.dir, "..");

type Listener = () => void;
function fakeTarget(visibility: "visible" | "hidden" = "visible") {
  const listeners = new Map<string, Set<Listener>>();
  const on = (name: string, listener: Listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(listener); };
  const off = (name: string, listener: Listener) => { listeners.get(name)?.delete(listener); };
  const doc = { visibilityState: visibility as DocumentVisibilityState, addEventListener: on as never, removeEventListener: off as never };
  return {
    target: { addEventListener: on as never, removeEventListener: off as never, document: doc },
    doc,
    fire: (name: string) => { for (const listener of [...listeners.get(name) ?? []]) listener(); },
    count: (name: string) => listeners.get(name)?.size ?? 0
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, values };
}

function watchWith(server: () => string | null, options: { client?: string; clock?: { now: number }; storage?: ReturnType<typeof memoryStorage> } = {}) {
  let fetches = 0;
  const intervals: Array<() => void> = [];
  const clock = options.clock ?? { now: 1_000_000 };
  const watch = createBuildWatch({
    clientBuild: options.client ?? "0.48.1-aaaaaaaaaaaa",
    fetchBuild: async () => { fetches += 1; return server(); },
    storage: () => options.storage ?? null,
    now: () => clock.now,
    setInterval: (run) => { intervals.push(run); return intervals.length; },
    clearInterval: () => undefined
  });
  return { watch, clock, fetches: () => fetches, tick: () => { for (const run of intervals) run(); }, intervals };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("build ids", () => {
  test("a new build is a different, real build; development and malformed ids never are", () => {
    expect(isNewBuild("0.48.1-aaaaaaaaaaaa", "0.48.2-bbbbbbbbbbbb")).toBe(true);
    expect(isNewBuild("0.48.1-aaaaaaaaaaaa", "0.48.1-aaaaaaaaaaaa")).toBe(false);
    expect(isNewBuild(DEV_BUILD, "0.48.2-bbbbbbbbbbbb")).toBe(false);
    expect(isNewBuild("0.48.1-aaaaaaaaaaaa", DEV_BUILD)).toBe(false);
    expect(isNewBuild("0.48.1-aaaaaaaaaaaa", null)).toBe(false);
    expect(isNewBuild("0.48.1-aaaaaaaaaaaa", "<script>")).toBe(false);
    expect(isNewBuild("0.48.1-aaaaaaaaaaaa", "x".repeat(65))).toBe(false);
    expect(normalBuild(" 0.48.1-abc ")).toBe("0.48.1-abc");
  });

  test("the page's build comes from the production meta; dev mode and a page without it are development", () => {
    const doc = (content: string | null) => ({ querySelector: () => content === null ? null : { getAttribute: () => content } }) as unknown as Document;
    expect(pageBuild(doc("0.48.1-aaaaaaaaaaaa"), false)).toBe("0.48.1-aaaaaaaaaaaa");
    expect(pageBuild(doc("0.48.1-aaaaaaaaaaaa"), true)).toBe(DEV_BUILD);
    expect(pageBuild(doc(null), false)).toBe(DEV_BUILD);
    expect(pageBuild(null, false)).toBe(DEV_BUILD);
  });

  test("the production build's id is stable for the same output and changes with any file; the meta is written once", () => {
    const files = [{ name: "assets/index-a.js", content: "one" }, { name: "assets/boot-b.css", content: "two" }];
    const id = buildIdOf("0.48.1", files);
    expect(id).toMatch(/^0\.48\.1-[0-9a-f]{12}$/);
    expect(buildIdOf("0.48.1", [...files].reverse())).toBe(id);
    expect(buildIdOf("0.48.1", [files[0], { name: "assets/boot-b.css", content: "three" }])).not.toBe(id);
    const html = withBuildMeta(withBuildMeta("<html><head><title>Nook</title></head></html>", "0.48.1-111111111111"), id);
    expect(html.match(/name="nook-build"/g)?.length).toBe(1);
    expect(buildIdFromHtml(html)).toBe(id);
    expect(() => withBuildMeta(html, "bad id\"")).toThrow();
  });
});

describe("detection", () => {
  test("no notice in development: no checks, no listeners, and a reported build is ignored", async () => {
    const { watch, fetches, intervals } = watchWith(() => "0.48.2-bbbbbbbbbbbb", { client: DEV_BUILD });
    const page = fakeTarget();
    watch.start(page.target);
    expect(page.count("focus")).toBe(0);
    expect(intervals.length).toBe(0);
    await watch.check(true);
    watch.report("0.48.2-bbbbbbbbbbbb");
    await watch.chunkFailed();
    expect(fetches()).toBe(0);
    expect(watch.getState()).toEqual({ waiting: null, shown: false });
  });

  test("focus, visibility, online, and the interval check the server; a hidden tab is never polled; checks are spaced", async () => {
    let server = "0.48.1-aaaaaaaaaaaa";
    const { watch, fetches, clock, tick } = watchWith(() => server);
    const page = fakeTarget();
    const stop = watch.start(page.target);
    page.fire("focus");
    await flush();
    expect(fetches()).toBe(1);
    expect(watch.getState().shown).toBe(false);
    // Within the gap, focus and visibility do not ask again.
    page.fire("visibilitychange");
    page.fire("focus");
    await flush();
    expect(fetches()).toBe(1);
    // A hidden tab: the interval and visibility do nothing.
    clock.now += CHECK_INTERVAL_MS;
    page.doc.visibilityState = "hidden";
    tick();
    page.fire("visibilitychange");
    await flush();
    expect(fetches()).toBe(1);
    // Back to visible with a new release out: the notice shows.
    server = "0.48.2-bbbbbbbbbbbb";
    page.doc.visibilityState = "visible";
    page.fire("visibilitychange");
    await flush();
    expect(fetches()).toBe(2);
    expect(watch.getState()).toEqual({ waiting: "0.48.2-bbbbbbbbbbbb", shown: true });
    // online skips the gap.
    page.fire("online");
    await flush();
    expect(fetches()).toBe(3);
    clock.now += CHECK_GAP_MS;
    tick();
    await flush();
    expect(fetches()).toBe(4);
    stop();
    expect(page.count("focus") + page.count("online") + page.count("visibilitychange")).toBe(0);
  });

  test("a header on any API response shows the notice without a request of its own", () => {
    const { watch, fetches } = watchWith(() => null);
    const seen: string[] = [];
    watch.subscribe(() => seen.push(String(watch.getState().waiting)));
    watch.report(new Headers({ [BUILD_HEADER]: "0.48.1-aaaaaaaaaaaa" }).get(BUILD_HEADER));
    expect(watch.getState().shown).toBe(false);
    watch.report(new Headers({ [BUILD_HEADER]: "0.48.2-bbbbbbbbbbbb" }).get(BUILD_HEADER));
    expect(watch.getState()).toEqual({ waiting: "0.48.2-bbbbbbbbbbbb", shown: true });
    // The same header again changes nothing (no extra renders).
    watch.report("0.48.2-bbbbbbbbbbbb");
    expect(seen).toEqual(["0.48.2-bbbbbbbbbbbb"]);
    expect(fetches()).toBe(0);
  });

  test("api() reads the header from every response", () => {
    const source = readFileSync(join(repo, "src/api.ts"), "utf8");
    expect(source).toContain("noteResponseBuild(response)");
  });
});

describe("Later", () => {
  test("hides the notice for that build for the session; a newer build shows it again; a chunk failure shows it anyway", async () => {
    const storage = memoryStorage();
    let server = "0.48.2-bbbbbbbbbbbb";
    const { watch } = watchWith(() => server, { storage });
    watch.report(server);
    expect(watch.getState().shown).toBe(true);
    watch.later();
    expect(storage.values.get(LATER_KEY)).toBe("0.48.2-bbbbbbbbbbbb");
    expect(watch.getState()).toEqual({ waiting: "0.48.2-bbbbbbbbbbbb", shown: false });
    watch.report("0.48.2-bbbbbbbbbbbb");
    expect(watch.getState().shown).toBe(false);
    // Another page of the same session starts hidden for that build.
    const other = watchWith(() => server, { storage }).watch;
    other.report("0.48.2-bbbbbbbbbbbb");
    expect(other.getState()).toEqual({ waiting: "0.48.2-bbbbbbbbbbbb", shown: false });
    // A chunk that failed to load shows it again.
    await other.chunkFailed();
    expect(other.getState().shown).toBe(true);
    // A newer build shows it.
    server = "0.48.3-cccccccccccc";
    watch.report(server);
    expect(watch.getState()).toEqual({ waiting: "0.48.3-cccccccccccc", shown: true });
  });

  test("without storage Later still hides it for this page", () => {
    const { watch } = watchWith(() => null);
    watch.report("0.48.2-bbbbbbbbbbbb");
    watch.later();
    expect(watch.getState().shown).toBe(false);
  });
});

describe("reload to update", () => {
  test("runs the frame's guard, then App's leave (Notes saves), then the before-reload hooks, then the reload", async () => {
    const calls: string[] = [];
    const started = await guardedReload({
      guard: (leave) => { calls.push("guard"); leave(); },
      leave: async () => { calls.push("note saved"); return true; },
      beforeReload: async () => { calls.push("whiteboard kept"); },
      go: () => calls.push("reload")
    });
    expect(started).toBe(true);
    expect(calls).toEqual(["guard", "note saved", "whiteboard kept", "reload"]);
  });

  test("a declined confirm or a note that could not be saved stops it", async () => {
    let reloaded = false;
    const declined = guardedReload({ guard: () => undefined, go: () => { reloaded = true; } });
    await flush();
    expect(reloaded).toBe(false);
    void declined;
    expect(await guardedReload({ guard: (leave) => leave(), leave: () => false, go: () => { reloaded = true; } })).toBe(false);
    expect(await guardedReload({ guard: (leave) => leave(), leave: async () => { throw new Error("offline"); }, go: () => { reloaded = true; } })).toBe(false);
    expect(reloaded).toBe(false);
  });

  test("a chunk that failed to load reloads through the frame's guarded path, and tells the build watch", () => {
    resetChunkReloadForTests();
    const calls: string[] = [];
    const listeners: Array<(event: { preventDefault: () => void }) => void> = [];
    const target = { addEventListener: ((_name: string, listener: never) => { listeners.push(listener); }) as never, sessionStorage: memoryStorage(), location: { href: "https://nook.test/reports", reload: () => { calls.push("reload"); }, replace: () => undefined } as never };
    installChunkReload(target);
    onChunkLoadFailure(() => calls.push("watch told"));
    setGuardedReload((go) => { calls.push("guards asked"); go(); });
    listeners.at(-1)!({ preventDefault: () => undefined });
    expect(calls).toEqual(["watch told", "guards asked", "reload"]);
    resetChunkReloadForTests();
  });

  test("the frame and the palette use the guarded path", () => {
    const frame = readFileSync(join(repo, "src/shell/AppFrame.tsx"), "utf8");
    expect(frame).toContain("guard: guarded");
    expect(frame).toContain("setGuardedReload(");
    expect(frame).toMatch(/command === "reloadUpdate"\) \{ restoreFocus\(\); reloadToUpdate\(\); \}/);
    expect(readFileSync(join(repo, "src/App.tsx"), "utf8")).toContain('onBeforeReload={async () => activeApp !== "notes" || await leaveNotes()}');
  });
});

describe("the notice", () => {
  test("a polite status with Later and Reload, no autofocus; nothing while hidden", () => {
    const html = renderToStaticMarkup(<UpdateNotice state={{ waiting: "0.48.2-b", shown: true }} onReload={() => undefined} onLater={() => undefined} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("A new version of Nook is available");
    expect(html).toMatch(/<button type="button" class="action-button secondary">Later<\/button><button type="button" class="action-button">Reload<\/button>/);
    expect(html).not.toMatch(/autofocus/i);
    expect(renderToStaticMarkup(<UpdateNotice state={{ waiting: "0.48.2-b", shown: false }} onReload={() => undefined} onLater={() => undefined} />)).toBe("");
  });

  test("sits above the toasts, which sit above the phone's bottom bar and safe area", () => {
    const css = readFileSync(join(repo, "src/update/update.css"), "utf8");
    const toasts = readFileSync(join(repo, "src/ui/toasts.css"), "utf8");
    const lift = /--update-notice-bottom:\s*calc\(var\(--toast-offset-bottom\) \+ (\d+)px\)/.exec(css);
    expect(lift).not.toBeNull();
    // One collapsed toast stack is about 46 px tall plus its peeking edges.
    expect(Number(lift![1])).toBeGreaterThanOrEqual(64);
    expect(css).toMatch(/\.update-notice \{ position: fixed;[^}]*bottom: var\(--update-notice-bottom\)/);
    // The phone offset clears the 61 px bottom bar and the safe area.
    const phone = /@media \(max-width: 760px\) \{\s*:root \{ --toast-offset-bottom: calc\((\d+)px \+ env\(safe-area-inset-bottom\)\); \}/.exec(toasts);
    expect(phone).not.toBeNull();
    expect(Number(phone![1])).toBeGreaterThan(61);
    // No inline style: the CSP stays strict.
    expect(readFileSync(join(repo, "src/update/UpdateNotice.tsx"), "utf8")).not.toContain("style=");
  });

  test("⌘K offers Reload to update only while a build is waiting", () => {
    const tree = { primary: [], pinned: [], apps: [], settings: { id: "settings", label: "Settings", icon: (() => null) as never, kind: "settings" }, notesSearch: false } as never;
    expect(paletteEntries({ tree, searchNotes: false }).some((entry) => entry.id === "command:reload-update")).toBe(false);
    const entry = paletteEntries({ tree, searchNotes: false, updateWaiting: true }).find((item) => item.id === "command:reload-update");
    expect(entry?.label).toBe("Reload to update");
    expect(entry?.action).toEqual({ kind: "command", command: "reloadUpdate" });
  });
});

describe("the server's build", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); resetBuildIdCacheForTests(); });

  test("GET /api/build answers without a session, never cached, and every API response carries X-Nook-Build", async () => {
    const response = await request("/build");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ build: DEV_BUILD });
    expect(response.headers.get(BUILD_HEADER)).toBe(DEV_BUILD);
    expect((await request("/health")).headers.get(BUILD_HEADER)).toBe(DEV_BUILD);
    // Even a refusal names the build.
    expect((await request("/folders")).headers.get(BUILD_HEADER)).toBe(DEV_BUILD);
  });

  test("reads the id from the served index.html, again once it changes; no index.html is development", () => {
    const root = mkdtempSync(join(tmpdir(), "nook-build-"));
    dirs.push(root);
    expect(readBuildId(root, 0)).toBe(DEV_BUILD);
    const index = join(root, "index.html");
    writeFileSync(index, withBuildMeta("<html><head></head></html>", "0.48.1-aaaaaaaaaaaa"));
    expect(readBuildId(root, RECHECK_MS)).toBe("0.48.1-aaaaaaaaaaaa");
    writeFileSync(index, withBuildMeta("<html><head></head></html>", "0.48.2-bbbbbbbbbbbb"));
    utimesSync(index, new Date(), new Date(Date.now() + 10_000));
    // Within RECHECK_MS the cached id stands; after it, the new file is read.
    expect(readBuildId(root, RECHECK_MS + 1)).toBe("0.48.1-aaaaaaaaaaaa");
    expect(readBuildId(root, RECHECK_MS * 2 + 1)).toBe("0.48.2-bbbbbbbbbbbb");
  });
});
