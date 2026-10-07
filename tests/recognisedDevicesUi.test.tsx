import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { deviceSeenLine, RecognisedDevices, RecognisedDevicesView, type RecognisedDevice } from "../src/auth/RecognisedDevices";

/**
 * Settings → Security → Recognised devices (migration 043). Rendered with fixed devices; the
 * confirm, history, and 44 px contracts are read from the source and stylesheet. The browser walk
 * (1280 and 390 px, Back closing the confirm) is in the live QA notes.
 */

const read = (path: string) => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();
const devices: RecognisedDevice[] = [
  { id: "11111111-1111-4111-8111-111111111111", label: "Firefox on Linux", browser: "firefox", os: "linux", firstSeenAt: "2026-10-01T09:00:00.000Z", lastSeenAt: "2026-10-07T09:00:00.000Z", current: true },
  { id: "22222222-2222-4222-8222-222222222222", label: "Safari on iOS", browser: "safari", os: "ios", firstSeenAt: "2026-09-20T09:00:00.000Z", lastSeenAt: "2026-10-05T18:30:00.000Z", current: false }
];
const view = (list: RecognisedDevice[] | null, extra: Partial<Parameters<typeof RecognisedDevicesView>[0]> = {}) =>
  renderToStaticMarkup(<RecognisedDevicesView devices={list} max={20} busy={false} message="" error="" onForget={() => undefined} onForgetAll={() => undefined} {...extra} />);

test("lists each device with its label, seen times, This device, and a labelled Forget", () => {
  const markup = view(devices);
  expect(markup).toContain("Recognised devices");
  expect(markup).toContain("Firefox on Linux");
  expect(markup).toContain("Safari on iOS");
  expect(markup.match(/This device/g)).toHaveLength(1);
  expect(markup).toContain('aria-label="Forget Firefox on Linux (this device)"');
  expect(markup).toContain('aria-label="Forget Safari on iOS"');
  expect(markup).toContain("Forget all");
  expect(markup).toContain("never your IP address");
  expect(markup).toContain("Forgetting a device signs nothing out.");
  // Plain buttons, the app's own classes (D91): no native select, prompt, or form controls.
  expect(markup).not.toMatch(/<select|<input/);
  expect(deviceSeenLine(devices[0]!)).toStartWith("Active now · First seen ");
  expect(deviceSeenLine(devices[1]!)).toStartWith("Last seen ");
});

test("one device has no Forget all; none says how the list fills; loading and errors are announced", () => {
  expect(view([devices[0]!])).not.toContain("Forget all");
  expect(view([])).toContain("No devices yet.");
  expect(view(null)).toContain('role="status"');
  expect(view(devices, { error: "Could not load your devices" })).toContain('role="alert"');
  expect(view(devices, { message: "Safari on iOS forgotten." })).toContain("Safari on iOS forgotten.");
  expect(view(devices, { busy: true }).match(/disabled=""/g)?.length).toBe(3);
});

test("the loading card renders before the request answers", () => {
  expect(renderToStaticMarkup(<RecognisedDevices />)).toContain("Loading…");
});

test("Forget asks through the app's confirm, a history layer (Back closes it), never a native confirm", async () => {
  const source = await read("auth/RecognisedDevices.tsx");
  expect(source).toContain("useConfirm()");
  expect(source).toContain("await ask({");
  expect(source).toContain('title: "Forget all devices?"');
  expect(source).toContain("{confirmElement}");
  expect(source).not.toMatch(/window\.confirm|\bconfirm\(|\balert\(/);
  const hook = await read("ui/useConfirm.tsx");
  expect(hook).toContain("useHistoryDialogGuard(true, cancel);");
  // It sits in Settings → Security, after the password and Google cards, outside two-factor setup.
  const app = await read("App.tsx");
  expect(app).toContain("{!state.setupRequired && <RecognisedDevices />}");
});

test("44 px targets, and at phone width the Forget button drops under the text", async () => {
  const css = await read("auth/auth.css");
  expect(css).toContain(".recognised-devices-list .secondary-button { min-height: 44px;");
  expect(css).toContain(".recognised-devices-summary .secondary-button { min-height: 44px;");
  expect(css).toMatch(/@media \(max-width: 520px\) \{\n {2}\.recognised-devices-list li \{ grid-template-columns: minmax\(0, 1fr\);/);
});
