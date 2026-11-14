import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { api, apiRequestInit, setCsrfToken } from "../src/api";
import { deleteLink } from "../src/ui/workspaceApi";

/**
 * Audit 2 UI1 (D1180): the server refuses every mutation without a JSON Content-Type
 * (server/auth.ts requireMutationSafety), so api() must send one on bodyless DELETE/POST too.
 */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; setCsrfToken(""); });

function capture() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

describe("api() mutation headers", () => {
  test("every non-GET method carries application/json, the CSRF token and a body", async () => {
    setCsrfToken("tok");
    const calls = capture();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "delete"]) await api(`/x`, { method });
    expect(calls).toHaveLength(5);
    for (const { init } of calls) {
      const headers = new Headers(init.headers);
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("X-CSRF-Token")).toBe("tok");
      expect(init.body).toBe("{}");
    }
  });

  test("a supplied body is kept; a GET stays bodyless and headerless", () => {
    setCsrfToken("tok");
    const post = apiRequestInit({ method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(post.body).toBe('{"a":1}');
    expect(new Headers(post.headers).get("Content-Type")).toBe("application/json");
    const get = apiRequestInit({});
    expect(get.body).toBeUndefined();
    expect(new Headers(get.headers).get("Content-Type")).toBeNull();
    expect(new Headers(get.headers).get("X-CSRF-Token")).toBeNull();
  });

  test("a shared helper's bodyless DELETE (workspaceApi.deleteLink) goes out with the header", async () => {
    const calls = capture();
    await deleteLink("abc");
    expect(calls[0]!.url).toBe("/api/links/abc");
    expect(new Headers(calls[0]!.init.headers).get("Content-Type")).toBe("application/json");
  });

  test("no client module sends an authenticated mutation through its own fetch without a JSON Content-Type", () => {
    // Direct fetch() calls to /api outside api() must set the header themselves, or be a public route
    // (mounted before the session guards) or the multipart upload.
    const allowed = new Set(["src/api.ts", "src/editor/imageUpload.ts", "src/public/MailStopPage.tsx", "src/auth/mailPages.tsx"]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(ts|tsx)$/.test(name) || allowed.has(path)) continue;
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(/fetch\(([^;]*)/g)) {
          const call = match[1]!;
          if (!/method:\s*"(POST|PUT|PATCH|DELETE)"/.test(call)) continue;
          if (/\/api\/public|Content-Type/.test(call)) continue;
          offenders.push(path);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });
});
