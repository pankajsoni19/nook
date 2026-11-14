import { describe, expect, test } from "bun:test";
import { inAppOpenPath } from "../src/notifications/notificationsApi";
import "../src/workspaceModules";

/** D1260: the paths a nook:open-path event may open (embeds' Open, "Open in Bookings"). */
const id = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

describe("inAppOpenPath", () => {
  test("opens any in-app page, not only whiteboards and the Bin", () => {
    for (const path of [`/whiteboards/${id}`, "/settings/bin", "/goals/ship-it-0b12cd34ef", "/forms/onboarding-survey-0a1b2c3d4e/results", "/townhall/all-hands-0a1b2c3d4e", "/bookings/b/0a1b2c3d4e", "/bookings", "/notifications"]) {
      expect(inAppOpenPath(path)).toBe(path);
    }
  });
  test("ignores anything the router would not open as written", () => {
    for (const path of ["", "/", "https://evil.example/x", "//evil.example", "/tasks/x y", "/goals#x", 42, null]) {
      expect(inAppOpenPath(path)).toBeNull();
    }
  });
});
