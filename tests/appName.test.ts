import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { request } from "./support/harness";
import { config } from "../server/config";
import { brandIndexHtml, brandManifest, brandServiceWorker, shortAppName } from "../server/branding";
import { serveStaticFile } from "../server/staticFiles";
import { senderHeader } from "../server/mail";
import { renderFixture } from "../server/mail/preview";
import { totpUri } from "../server/totp";
import { appName, DEFAULT_APP_NAME, setAppName } from "../src/appName";
import { hubDocumentTitle, settingsDocumentTitle } from "../src/router";

/** Wave 39: APP_NAME renames the app in titles, link previews, the manifest, mail, and the client. */

const repo = join(import.meta.dir, "..");
const configPath = join(repo, "server", "config.ts");

function loadAppName(value: string | undefined) {
  const result = Bun.spawnSync(["bun", "--no-env-file", "--eval", `const { config } = await import(${JSON.stringify(configPath)}); console.log(JSON.stringify(config.appName));`], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: join(tmpdir(), "mynotes-config-test"), ...(value === undefined ? {} : { APP_NAME: value }) },
    stdout: "pipe",
    stderr: "pipe"
  });
  return { ok: result.exitCode === 0, value: result.exitCode === 0 ? JSON.parse(result.stdout.toString().trim()) as string : null, stderr: result.stderr.toString() };
}

afterEach(() => { config.appName = "Nook"; });

describe("APP_NAME configuration", () => {
  test("defaults to Nook; empty is Nook; the value is trimmed", () => {
    expect(loadAppName(undefined).value).toBe("Nook");
    expect(loadAppName("   ").value).toBe("Nook");
    expect(loadAppName("  Acme Notes  ").value).toBe("Acme Notes");
    expect(loadAppName("Équipe & Co").value).toBe("Équipe & Co");
  });

  test("refuses angle brackets, control characters, and more than 40 characters", () => {
    for (const value of ["A<b>&C", "Acme>", "Acme\u0007Notes", "Acme\nNotes", "x".repeat(41), "Acme‮Notes"]) {
      const result = loadAppName(value);
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("APP_NAME must be one line of 1 to 40 characters");
    }
    expect(loadAppName("x".repeat(40)).ok).toBe(true);
  });
});

describe("index.html, the manifest, and the service worker", () => {
  const indexHtml = readFileSync(join(repo, "index.html"), "utf8");

  test("the name goes into the title, application-name, og: and twitter: titles, and the boot lines; nothing else changes", () => {
    const branded = brandIndexHtml(indexHtml, "Acme Notes");
    expect(branded).toContain("<title>Acme Notes — Private self-hosted workspace</title>");
    expect(branded).toContain('<meta name="application-name" content="Acme Notes" />');
    expect(branded).toContain('<meta property="og:site_name" content="Acme Notes" />');
    expect(branded).toContain('<meta property="og:title" content="Acme Notes — Private self-hosted workspace" />');
    expect(branded).toContain('<meta name="twitter:title" content="Acme Notes — Private self-hosted workspace" />');
    expect(branded).toContain("<p>Acme Notes did not finish loading.");
    expect(branded).toContain("<p>Acme Notes needs JavaScript.");
    // The preview image, its alt text (the picture says Nook), icons, and scripts stay as they are.
    for (const kept of ['og:image" content="https://raw.githubusercontent.com/pankajsoni19/nook/main/public/social-preview.png"', 'og:image:alt" content="Nook — Private notes. Local first."', 'href="/icons/nook-192.png"', 'src="/src/main.tsx"']) expect(branded).toContain(kept);
    expect(branded.replace(/Acme Notes/g, "Nook")).toBe(indexHtml);
  });

  test("the name is HTML-escaped", () => {
    const branded = brandIndexHtml(indexHtml, `Tom & "Jerry's"`);
    expect(branded).toContain("<title>Tom &amp; &quot;Jerry&#39;s&quot; — Private self-hosted workspace</title>");
    expect(branded).toContain('<meta property="og:site_name" content="Tom &amp; &quot;Jerry&#39;s&quot;" />');
    expect(branded).not.toContain('"Jerry');
  });

  test("the manifest gets name and a short_name of at most 12 characters", () => {
    const manifest = readFileSync(join(repo, "public", "manifest.webmanifest"), "utf8");
    const branded = JSON.parse(brandManifest(manifest, "Acme Notes")) as Record<string, unknown>;
    expect(branded.name).toBe("Acme Notes");
    expect(branded.short_name).toBe("Acme Notes");
    expect(branded.icons).toEqual((JSON.parse(manifest) as { icons: unknown }).icons);
    expect(shortAppName("Acme Corporation Notes")).toBe("Acme");
    expect(shortAppName("Supercalifragilistic notes")).toBe("Supercalifra");
  });

  test("the service worker's generic title names the app, JSON-encoded", () => {
    const worker = readFileSync(join(repo, "public", "sw.js"), "utf8");
    const branded = brandServiceWorker(worker, `Acme "Notes"`);
    expect(branded).toContain('const GENERIC_TITLE = "You have a new notification in Acme \\"Notes\\"";');
    expect(branded.replace(`"You have a new notification in Acme \\"Notes\\""`, '"You have a new notification in Nook"')).toBe(worker);
  });
});

describe("serving the branded files", () => {
  const root = mkdtempSync(join(tmpdir(), "nook-brand-dist-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const built = readFileSync(join(repo, "index.html"), "utf8").replace('src="/src/main.tsx"', 'src="/assets/index-BvuYDGo0.js"');
  writeFileSync(join(root, "index.html"), built);
  writeFileSync(join(root, "manifest.webmanifest"), readFileSync(join(repo, "public", "manifest.webmanifest")));
  writeFileSync(join(root, "sw.js"), readFileSync(join(repo, "public", "sw.js")));
  const get = (path: string, name: string, headers: Record<string, string> = {}) =>
    serveStaticFile(new Request(`http://localhost${path}`, { headers }), path, root, name).then((response) => response!);

  test("index.html and client routes carry the name; the ETag differs from the default and 304 works", async () => {
    const plain = await get("/", "Nook");
    const branded = await get("/", "Acme Notes");
    expect(branded.status).toBe(200);
    expect(branded.headers.get("Cache-Control")).toBe("no-cache");
    expect(branded.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await branded.text();
    expect(body).toContain("<title>Acme Notes — Private self-hosted workspace</title>");
    expect(body).toContain('src="/assets/index-BvuYDGo0.js"');
    expect(await plain.text()).toBe(built);
    const etag = branded.headers.get("ETag")!;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
    expect(etag).not.toBe(plain.headers.get("ETag"));
    expect((await get("/settings/about", "Acme Notes")).headers.get("ETag")).toBe(etag);
    expect((await get("/", "Other Name")).headers.get("ETag")).not.toBe(etag);
    const again = await get("/", "Acme Notes", { "If-None-Match": etag });
    expect(again.status).toBe(304);
    // The date alone never answers 304: it does not change with the name.
    expect((await get("/", "Acme Notes", { "If-Modified-Since": new Date(Date.now() + 60_000).toUTCString() })).status).toBe(200);
  });

  test("compressed encodings hold the same branded bytes, each with its own ETag", async () => {
    const identity = await get("/index.html", "Acme Notes");
    const gzip = await get("/index.html", "Acme Notes", { "Accept-Encoding": "gzip" });
    expect(gzip.headers.get("Content-Encoding")).toBe("gzip");
    expect(gzip.headers.get("Vary")).toBe("Accept-Encoding");
    expect(gzip.headers.get("ETag")).toBe(identity.headers.get("ETag")!.replace(/"$/, '-gzip"'));
    const br = await get("/index.html", "Acme Notes", { "Accept-Encoding": "br, gzip" });
    expect(br.headers.get("Content-Encoding")).toBe("br");
    expect(gunzipSync(Buffer.from(await gzip.arrayBuffer())).toString()).toBe(await identity.text());
  });

  test("the manifest and the service worker carry the name", async () => {
    const manifest = await get("/manifest.webmanifest", "Acme Notes");
    expect(manifest.headers.get("Content-Type")).toBe("application/manifest+json; charset=utf-8");
    expect(await manifest.json()).toMatchObject({ name: "Acme Notes", short_name: "Acme Notes" });
    expect(await (await get("/sw.js", "Acme Notes")).text()).toContain('"You have a new notification in Acme Notes"');
    expect(await (await get("/manifest.webmanifest", "Nook")).json()).toMatchObject({ name: "Nook", short_name: "Nook" });
  });
});

describe("server text", () => {
  test("/api/about and /api/auth/me say the name", async () => {
    expect((await (await request("/about")).json() as { appName: string }).appName).toBe("Nook");
    config.appName = "Acme Notes";
    expect((await (await request("/about")).json() as { appName: string }).appName).toBe("Acme Notes");
  });

  test("mail subjects, the band, and the footer use the name; internal wording otherwise unchanged", () => {
    config.appName = "Acme Notes";
    const reset = renderFixture("account.password_reset", "notes.example.com")!;
    expect(reset.subject).toBe("Reset your Acme Notes password");
    expect(reset.text).toStartWith("Acme Notes · notes.example.com");
    expect(reset.text).toContain("Sent by Acme Notes on notes.example.com");
    expect(reset.html).toContain(">A</td>");
    expect(reset.html).not.toMatch(/\bNook\b/);
    config.appName = "Nook";
    expect(renderFixture("account.password_reset", "notes.example.com")!.subject).toBe("Reset your Nook password");
  });

  test("a bare MAIL_FROM gets the name as its display name; a named one is kept", () => {
    expect(senderHeader("notes@example.com", "Acme Notes")).toBe("Acme Notes <notes@example.com>");
    expect(senderHeader("notes@example.com", "Acme, Inc.")).toBe('"Acme, Inc." <notes@example.com>');
    expect(senderHeader("Team <notes@example.com>", "Acme Notes")).toBe("Team <notes@example.com>");
  });

  test("the authenticator entry uses the name", () => {
    config.appName = "Acme: Notes";
    expect(totpUri("ABCDEFGH", "a@example.test")).toContain("issuer=Acme%20%20Notes");
  });
});

describe("client", () => {
  afterEach(() => setAppName(DEFAULT_APP_NAME));

  test("titles use the runtime name, Nook until the server says otherwise", () => {
    expect(appName()).toBe("Nook");
    expect(hubDocumentTitle("Members")).toBe("Settings · Members · Nook");
    setAppName("Acme Notes");
    expect(hubDocumentTitle(null)).toBe("Settings · Acme Notes");
    expect(settingsDocumentTitle("about")).toBe("Settings · About · Acme Notes");
    setAppName("  ");
    expect(appName()).toBe("Nook");
  });

  test("the open tab's title follows when the name arrives", () => {
    const previous = (globalThis as { document?: unknown }).document;
    const fake = { title: "Sign in · Nook" };
    (globalThis as { document?: unknown }).document = fake;
    try {
      setAppName("Acme Notes");
      expect(fake.title).toBe("Sign in · Acme Notes");
    } finally {
      setAppName(DEFAULT_APP_NAME);
      (globalThis as { document?: unknown }).document = previous;
    }
  });
});
