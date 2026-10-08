import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../src/api";
import { ACCESS_REVOKED_TEXT, accessLost, ChatOffNotice } from "../src/chat/accessNotice";

/**
 * TODO "ACCESS_REVOKED text": losing chat rights while an answer runs ends it ACCESS_REVOKED, and
 * every later Chat request is 403 ROLE_REFUSED, so the chat (with its stopped answer) can no longer
 * load and the module shows "Chat is off for your role". That page now says why the answer stopped.
 */

const source = readFileSync(join(import.meta.dir, "..", "src", "chat", "ChatApp.tsx"), "utf8");

describe("ACCESS_REVOKED stays visible when the chat role is removed", () => {
  test("a 403 ROLE_REFUSED or ACCESS_REVOKED is an access loss; other failures are not", () => {
    expect(accessLost(new ApiError("Your role cannot chat with agents", 403, { code: "ROLE_REFUSED" }))).toBe(true);
    expect(accessLost(new ApiError("gone", 403, { code: "ACCESS_REVOKED" }))).toBe(true);
    expect(accessLost(new ApiError("no", 403, { code: "CSRF" }))).toBe(false);
    expect(accessLost(new ApiError("missing", 404, { code: "ROLE_REFUSED" }))).toBe(false);
    expect(accessLost(new Error("offline"))).toBe(false);
  });

  test("the Chat-is-off page shows why the answer stopped, as an alert, and nothing extra otherwise", () => {
    const withReason = renderToStaticMarkup(<ChatOffNotice revoked={ACCESS_REVOKED_TEXT} />);
    expect(withReason).toContain("Chat is off for your role");
    expect(withReason).toContain(`role="alert">${ACCESS_REVOKED_TEXT.replace(/'/g, "&#x27;")}</p>`);
    const plain = renderToStaticMarkup(<ChatOffNotice revoked={null} />);
    expect(plain).toContain("Chat is off for your role");
    expect(plain).not.toContain("role=\"alert\"");
  });

  test("ChatApp keeps the reason from the stream (error or snapshot) and from a 403 on the stream, the chat, send, or regenerate", () => {
    expect(source).toContain("event.data.code === \"ACCESS_REVOKED\"");
    expect(source).toContain("event.data.errorCode === \"ACCESS_REVOKED\"");
    // The stream stops retrying and ends the live answer with the reason; the status reload shows the page.
    expect(source).toMatch(/if \(accessLost\(reason\)\) \{ loseAccess\(\); return; \}/);
    expect(source.match(/if \(accessLost\(reason\)\) loseAccess\(\);/g)?.length).toBe(2);
    // Opening a chat (a deep link) with no answer running only reloads the status: nothing stopped.
    expect(source).toContain("if (accessLost(reason)) { if (liveRef.current) loseAccess(); else void loadStatus(); }");
    expect(source).toContain("<ChatOffNotice revoked={revoked} />");
    expect(source).toContain("ACCESS_REVOKED: ACCESS_REVOKED_TEXT");
  });
});
