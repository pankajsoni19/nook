import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applicationServerKey, deviceLabel, pushAvailability, type Environment } from "../src/notifications/pushClient";
import { IOS_HOME_SCREEN_COPY, pushUnavailableCopy, unavailableMessage } from "../src/notifications/NotificationSettings";

const source = readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8");
const eventId = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";
const notificationId = "b1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";

type Shown = { title: string; options: { tag?: string; data?: { path: string }; body?: string } };

/** Runs public/sw.js against a fake worker scope and returns its event handlers and effects. */
function loadWorker(options: { api?: () => Promise<Response>; clients?: Array<{ url: string }>; navigateFails?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const fetched: Array<{ url: string; init: RequestInit }> = [];
  const clients = (options.clients ?? []).map((client) => ({ ...client, focus: async () => undefined, navigate: async (url: string) => {
    if (options.navigateFails) throw new TypeError("navigate failed");
    navigated.push(url);
  } }));
  const self = {
    location: new URL("https://nook.example.test/sw.js"),
    addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
    skipWaiting: () => undefined,
    registration: { showNotification: async (title: string, shownOptions: Shown["options"]) => { shown.push({ title, options: shownOptions }); } },
    clients: { claim: async () => undefined, matchAll: async () => clients, openWindow: async (url: string) => { opened.push(url); } }
  };
  const fetchStub = async (url: string, init: RequestInit) => {
    fetched.push({ url, init });
    return options.api ? options.api() : new Response("{}", { status: 500 });
  };
  new Function("self", "fetch", source)(self, fetchStub);
  async function dispatch(type: string, extra: Record<string, unknown> = {}) {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get(type)?.({ ...extra, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  }
  return { handlers, shown, opened, navigated, fetched, dispatch };
}

const apiReturning = (items: unknown[]) => async () => new Response(JSON.stringify({ items, unreadCount: items.length }), { headers: { "Content-Type": "application/json" } });

describe("public/sw.js", () => {
  test("has no fetch handler and listens only for install, activate, push, and notificationclick", () => {
    const worker = loadWorker();
    expect([...worker.handlers.keys()].sort()).toEqual(["activate", "install", "notificationclick", "push"]);
    expect(source).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(source).not.toMatch(/caches\./);
  });

  test("a push fetches unread notifications with the session cookie and shows each with tag = id", async () => {
    const worker = loadWorker({ api: apiReturning([
      { id: notificationId, title: "Dentist", href: `/calendar/event/${eventId}`, late: false },
      { id: eventId, title: "Sneaky", href: "https://evil.example/x", late: true },
      { id: "not-an-id", title: "Dropped", href: "/notifications" }
    ]) });
    await worker.dispatch("push");
    expect(worker.fetched).toEqual([{ url: "/api/notifications?unread=1&limit=5", init: { credentials: "same-origin", cache: "no-store", redirect: "error" } }]);
    expect(worker.shown).toEqual([
      { title: "Dentist", options: expect.objectContaining({ tag: notificationId, data: { path: `/calendar/event/${eventId}` } }) },
      { title: "Sneaky", options: expect.objectContaining({ tag: eventId, data: { path: "/notifications" }, body: "Calendar reminder (delivered late)" }) }
    ]);
  });

  test("a failed or empty fetch shows the generic notice", async () => {
    for (const api of [async () => new Response("", { status: 401 }), apiReturning([]), async () => { throw new Error("offline"); }]) {
      const worker = loadWorker({ api });
      await worker.dispatch("push");
      expect(worker.shown).toEqual([{ title: "You have a reminder in Nook", options: expect.objectContaining({ tag: "nook-reminder", data: { path: "/notifications" } }) }]);
    }
  });

  test("a click opens only same-origin id paths, reusing an open Nook window", async () => {
    const close = () => undefined;
    for (const [path, expected] of [
      [`/calendar/event/${eventId}`, `https://nook.example.test/calendar/event/${eventId}`],
      ["https://evil.example/phish", "https://nook.example.test/notifications"],
      ["//evil.example", "https://nook.example.test/notifications"],
      ["javascript:alert(1)", "https://nook.example.test/notifications"],
      [`/calendar/event/${eventId}/../../admin`, "https://nook.example.test/notifications"]
    ] as const) {
      const worker = loadWorker();
      await worker.dispatch("notificationclick", { notification: { close, data: { path } } });
      expect(worker.opened).toEqual([expected]);
    }
    const reuse = loadWorker({ clients: [{ url: "https://other.example/" }, { url: "https://nook.example.test/calendar" }] });
    await reuse.dispatch("notificationclick", { notification: { close, data: { path: `/calendar/event/${eventId}` } } });
    expect(reuse.opened).toEqual([]);
    expect(reuse.navigated).toEqual([`https://nook.example.test/calendar/event/${eventId}`]);
    // L8: when navigating the open window fails, the same safe path opens in a new one.
    const failing = loadWorker({ clients: [{ url: "https://nook.example.test/calendar" }], navigateFails: true });
    await failing.dispatch("notificationclick", { notification: { close, data: { path: "https://evil.example/phish" } } });
    expect(failing.navigated).toEqual([]);
    expect(failing.opened).toEqual(["https://nook.example.test/notifications"]);
  });
});

describe("web app manifest and icons", () => {
  test("the manifest is valid JSON with the Nook scope and the planned icon paths", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "public", "manifest.webmanifest"), "utf8")) as { start_url: string; scope: string; display: string; icons: Array<{ src: string; sizes: string }> };
    expect(manifest).toMatchObject({ start_url: "/", scope: "/", display: "standalone" });
    expect(manifest.icons.map((icon) => icon.src)).toEqual(["/icons/nook-192.png", "/icons/nook-512.png", "/icons/nook.svg"]);
    expect(readFileSync(join(import.meta.dir, "..", "public", "icons", "nook.svg"), "utf8")).toContain("<svg");
    expect(readFileSync(join(import.meta.dir, "..", "index.html"), "utf8")).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });
});

describe("push client helpers", () => {
  const desktop: Environment = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36", standalone: false, hasServiceWorker: true, hasPushManager: true, hasNotification: true, secure: true };
  const iphone: Environment = { ...desktop, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" };

  test("availability explains why push cannot be enabled here", () => {
    const on = { enabled: true as const, publicKey: "x" };
    expect(pushAvailability(on, desktop)).toEqual({ available: true });
    expect(pushAvailability({ enabled: false, reason: "insecure_origin" }, desktop)).toEqual({ available: false, reason: "server_insecure" });
    expect(pushAvailability({ enabled: false, reason: "disabled" }, desktop)).toEqual({ available: false, reason: "server_disabled" });
    expect(pushAvailability(on, { ...desktop, secure: false })).toEqual({ available: false, reason: "server_insecure" });
    expect(pushAvailability(on, iphone)).toEqual({ available: false, reason: "ios_home_screen" });
    expect(pushAvailability(on, { ...iphone, standalone: true })).toEqual({ available: true });
    expect(pushAvailability(on, { ...desktop, hasPushManager: false })).toEqual({ available: false, reason: "unsupported" });
    expect(unavailableMessage("server_insecure")).toBe(pushUnavailableCopy());
    expect(pushUnavailableCopy()).toBe("Push needs the HTTPS address, such as your Tailscale URL; reminders still appear in Nook.");
    expect(unavailableMessage("ios_home_screen").startsWith(IOS_HOME_SCREEN_COPY)).toBe(true);
    expect(IOS_HOME_SCREEN_COPY).toBe("Add to Home Screen first.");
  });

  test("device labels and the application server key", () => {
    expect(deviceLabel(desktop.userAgent)).toBe("Chrome on Linux");
    expect(deviceLabel(iphone.userAgent)).toBe("Safari on iOS");
    expect(deviceLabel("Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0")).toBe("Firefox on Android");
    const raw = new Uint8Array(65).map((_, index) => (index * 37) % 256);
    expect([...applicationServerKey(Buffer.from(raw).toString("base64url"))]).toEqual([...raw]);
  });
});
