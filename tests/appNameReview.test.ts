import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { config, isInstanceName, parseAppName } from "../server/config";
import { brandIndexHtml, brandManifest, brandServiceWorker } from "../server/branding";
import { serveStaticFile } from "../server/staticFiles";
import { senderHeader } from "../server/mail";
import { firstGrapheme } from "../server/mail/layout";
import { renderFixture } from "../server/mail/preview";
import { createTotpSecret, totpCodeAt, totpCounter, totpUri, verifyTotp } from "../server/totp";
import { DEFAULT_APP_NAME, setAppName } from "../src/appName";
import { googleErrorMessage, googleOnlyHint, googleOnlyPasswordText, linkRequiredText } from "../src/auth/googleSignIn";
import { recoveryCodesText } from "../src/auth/RecoveryCodesDialog";
import { registrationPrompt } from "../src/auth/registrationPrompt";
import { suppressionCopy } from "../src/notifications/EmailSettings";
import { pushUnavailableCopy, unavailableMessage } from "../src/notifications/NotificationSettings";
import { inviteLimitHint } from "../src/team/inviteFormat";
import { lastAdminReason } from "../src/team/teamFormat";

/**
 * Wave 39 review probes (APP_NAME). These pin down the edges the feature tests leave open: the
 * substitution regexes against other template shapes, names with HTML and replacement-pattern
 * characters, the cache story across a restart with a new name, mail header quoting, and that an
 * existing authenticator keeps working when the issuer label changes.
 */

afterEach(() => { config.appName = "Nook"; setAppName(DEFAULT_APP_NAME); });

describe("brandIndexHtml against other template shapes", () => {
  test("only the named meta tags, the first <title>, and the boot lines change; CSP, scripts, og:image, and alt text are untouched", () => {
    const template = [
      '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; img-src https://nook.example/Nook.png">',
      '<meta property="og:image" content="https://raw.githubusercontent.com/pankajsoni19/nook/main/public/social-preview.png" />',
      '<meta property="og:image:alt" content="Nook — Private notes. Local first." />',
      '<meta property="og:url" content="https://Nook.example/" />',
      '<meta property="og:title" content="Nook — Private self-hosted workspace" />',
      '<link rel="stylesheet" href="/assets/Nook-abc12345.css" />',
      "<title>Nook — Private self-hosted workspace</title>",
      '<script type="module" src="/assets/Nook-abc12345.js"></script>',
      "<svg><title>Nook icon</title></svg>",
      "<h1>Nook</h1>",
      "<p>Nook did not finish loading. Check your connection.</p>",
      '<p class="x">Nook did not finish loading</p>'
    ].join("\n");
    const out = brandIndexHtml(template, "Acme Notes");
    expect(out).toContain('img-src https://nook.example/Nook.png">');
    expect(out).toContain("public/social-preview.png");
    expect(out).toContain('content="Nook — Private notes. Local first."');
    expect(out).toContain('content="https://Nook.example/"');
    expect(out).toContain('content="Acme Notes — Private self-hosted workspace"');
    expect(out).toContain("/assets/Nook-abc12345.css");
    expect(out).toContain("/assets/Nook-abc12345.js");
    expect(out).toContain("<title>Acme Notes — Private self-hosted workspace</title>");
    expect(out).toContain("<svg><title>Nook icon</title></svg>");
    expect(out).toContain("<h1>Nook</h1>");
    expect(out).toContain("<p>Acme Notes did not finish loading.");
    expect(out).toContain('<p class="x">Nook did not finish loading</p>');
  });

  test("a meta tag written another way is left alone rather than mangled (attribute order, single quotes)", () => {
    const shapes = [
      '<meta content="Nook" name="application-name" />',
      "<meta name='application-name' content='Nook' />",
      '<meta name="application-name" content="Nook" data-x="y" /><meta name="og:title" content="Nook">'
    ];
    expect(brandIndexHtml(shapes[0]!, "Acme")).toBe(shapes[0]!);
    expect(brandIndexHtml(shapes[1]!, "Acme")).toBe(shapes[1]!);
    // Extra attributes after content: still inside the quotes, still correct.
    expect(brandIndexHtml(shapes[2]!, "Acme")).toBe('<meta name="application-name" content="Acme" data-x="y" /><meta name="og:title" content="Acme">');
  });

  test("the content capture never crosses a quote, so a name cannot land outside the attribute", () => {
    const out = brandIndexHtml('<meta name="og:title" content="Nook" /><meta name="other" content="Nook stays" />', 'x" onload="alert(1)');
    expect(out).toBe('<meta name="og:title" content="x&quot; onload=&quot;alert(1)" /><meta name="other" content="Nook stays" />');
  });

  test("names with every HTML special, 40 characters, unicode, RTL, and an emoji are escaped once and whole", () => {
    const template = '<meta name="application-name" content="Nook" /><title>Nook — X</title><p>Nook needs JavaScript. Turn it on.</p>';
    const forty = "A".repeat(40);
    expect(brandIndexHtml(template, forty)).toContain(`content="${forty}"`);
    for (const name of ['Acme "Quoted" & Co', "O'Brien's Notes", "Ünïcödé 名前 📝", "שלום Notes"]) {
      const out = brandIndexHtml(template, name);
      const escaped = name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      expect(out).toBe(`<meta name="application-name" content="${escaped}" /><title>${escaped} — X</title><p>${escaped} needs JavaScript. Turn it on.</p>`);
    }
  });

  // Fixed (server/branding.ts): `swap` used the escaped name as a String.replace replacement string,
  // so `$&`, `$$`, "$`" and `$'` were interpreted ("Acme $& Co" rendered as "Acme Nookamp; Co").
  // Every substitution is now a function replacement.
  test("a name containing $&, $$, or $` is kept literally in the title, meta tags, and boot lines", () => {
    const template = '<meta name="og:title" content="Nook — X" /><title>Nook — X</title><p>Nook needs JavaScript.</p>';
    expect(brandIndexHtml(template, "Acme $& Co")).toBe('<meta name="og:title" content="Acme $&amp; Co — X" /><title>Acme $&amp; Co — X</title><p>Acme $&amp; Co needs JavaScript.</p>');
    expect(brandIndexHtml(template, "Cost $$ 5")).toBe('<meta name="og:title" content="Cost $$ 5 — X" /><title>Cost $$ 5 — X</title><p>Cost $$ 5 needs JavaScript.</p>');
    expect(brandIndexHtml(template, "A$` B$' C")).toContain("<title>A$` B$&#39; C — X</title>");
    expect(JSON.parse(brandManifest('{"name":"Nook"}', "Acme $& Co")).name).toBe("Acme $& Co");
    expect(brandServiceWorker('const GENERIC_TITLE = "You have a reminder in Nook";', "Acme $& Co")).toContain('"You have a reminder in Acme $& Co"');
  });

  test("the manifest and the worker JSON-encode quotes, backslashes, and U+2028; unreadable JSON is served as it is", () => {
    const name = 'A"B\\C D</script>';
    const manifest = JSON.parse(brandManifest('{"name":"Nook","short_name":"Nook","icons":[{"src":"/icons/nook-192.png"}]}', name)) as { name: string; short_name: string; icons: unknown[] };
    expect(manifest.name).toBe(name);
    expect(manifest.icons).toHaveLength(1);
    expect(brandManifest("{not json", name)).toBe("{not json");
    const worker = brandServiceWorker('const GENERIC_TITLE = "You have a reminder in Nook";\nself.x = "Nook";', name);
    expect(worker).toEndWith('self.x = "Nook";');
    // The literal is valid JavaScript and evaluates back to the name.
    // `.` skips U+2028 (a line terminator in JavaScript regexes), so the capture is spelled out.
    const literal = /const GENERIC_TITLE = ([\s\S]*?);\n/.exec(worker)![1]!;
    expect(new Function(`return ${literal}`)()).toBe(`You have a reminder in ${name}`);
  });
});

describe("parseAppName", () => {
  test("refuses <, >, control, bidi, and line characters; accepts an emoji, RTL, and 40 code points of ASCII", () => {
    for (const bad of ["a<b", "a>b", "a\tb", "a\nb", "a‮b", "a⁦b", "a\u0085b", "A".repeat(41)]) expect(() => parseAppName(bad)).toThrow();
    expect(parseAppName("📝 Notes")).toBe("📝 Notes");
    expect(parseAppName("שלום")).toBe("שלום");
    expect(parseAppName("  Acme Notes  ")).toBe("Acme Notes");
    expect(parseAppName("A".repeat(40))).toBe("A".repeat(40));
  });

  // Fixed: the documented limit is 40 characters; both parseAppName and isInstanceName count code
  // points, so 40 astral characters (emoji, CJK extension characters) fit and 41 are refused.
  test("the limit is 40 code points: 40 emoji pass, 41 are refused, and MAIL_INSTANCE_NAME agrees", () => {
    expect(parseAppName("📝".repeat(40))).toBe("📝".repeat(40));
    expect(() => parseAppName("📝".repeat(41))).toThrow();
    expect(isInstanceName("📝".repeat(40))).toBe(true);
    expect(isInstanceName("📝".repeat(41))).toBe(false);
    expect(isInstanceName("")).toBe(false);
  });
});

describe("serving across a restart with a new name", () => {
  const root = mkdtempSync(join(tmpdir(), "nook-brand-review-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const html = '<!doctype html><html><head><meta name="application-name" content="Nook" /><title>Nook — X</title><script type="module" src="/assets/index-BvuYDGo0.js"></script></head><body><p>Nook did not finish loading.</p></body></html>';
  writeFileSync(join(root, "index.html"), html);
  writeFileSync(join(root, "index.html.gz"), Bun.gzipSync(html));
  writeFileSync(join(root, "manifest.webmanifest"), '{"name":"Nook","short_name":"Nook"}');
  writeFileSync(join(root, "sw.js"), 'const GENERIC_TITLE = "You have a reminder in Nook";');
  const asset = join(root, "assets");
  Bun.spawnSync(["mkdir", "-p", asset]);
  writeFileSync(join(asset, "index-BvuYDGo0.js"), "console.log('Nook');");
  const get = (path: string, name: string, headers: Record<string, string> = {}, method = "GET") =>
    serveStaticFile(new Request(`http://localhost${path}`, { headers, method }), path, root, name).then((response) => response!);

  test("a browser holding the default-name copy gets a fresh 200 with the new name, never a 304", async () => {
    const before = await get("/", "Nook");
    const stale = before.headers.get("ETag")!;
    expect(await before.text()).toBe(html);
    const after = await get("/", "Acme Notes", { "If-None-Match": stale });
    expect(after.status).toBe(200);
    expect(await after.text()).toContain("<title>Acme Notes — X</title>");
    expect(after.headers.get("ETag")).not.toBe(stale);
    // And the other way round: back to the default, the branded tag no longer matches.
    const back = await get("/", "Nook", { "If-None-Match": after.headers.get("ETag")! });
    expect(back.status).toBe(200);
    expect(await back.text()).toBe(html);
    // The date alone never produces a 304 for a branded file, with or without a stale tag.
    const since = after.headers.get("Last-Modified")!;
    expect((await get("/", "Acme Notes", { "If-Modified-Since": since })).status).toBe(200);
    expect((await get("/", "Acme Notes", { "If-None-Match": stale, "If-Modified-Since": since })).status).toBe(200);
    // A weak comparison still matches the branded tag.
    expect((await get("/", "Acme Notes", { "If-None-Match": `W/${after.headers.get("ETag")!}` })).status).toBe(304);
  });

  test("the br twin is the branded bytes under its own ETag; the on-disk .gz twin of the plain file is not used", async () => {
    const identity = await get("/index.html", "Acme Notes");
    const br = await get("/index.html", "Acme Notes", { "Accept-Encoding": "br" });
    expect(br.headers.get("Content-Encoding")).toBe("br");
    expect(br.headers.get("ETag")).toBe(identity.headers.get("ETag")!.replace(/"$/, '-br"'));
    expect(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toBe(await identity.text());
    const gzip = await get("/index.html", "Acme Notes", { "Accept-Encoding": "gzip" });
    expect(Bun.gunzipSync(new Uint8Array(await gzip.arrayBuffer())).toString() !== html).toBe(true);
    expect(Number(gzip.headers.get("Content-Length"))).toBeGreaterThan(0);
    // The plain file still serves its prebuilt .gz twin when the name is the default.
    const plainGzip = await get("/index.html", "Nook", { "Accept-Encoding": "gzip" });
    expect(Buffer.from(Bun.gunzipSync(new Uint8Array(await plainGzip.arrayBuffer()))).toString()).toBe(html);
  });

  test("HEAD carries the branded headers without a body; a hashed asset is identical under any name", async () => {
    const head = await get("/manifest.webmanifest", "Acme Notes", {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(Number(head.headers.get("Content-Length"))).toBe(new TextEncoder().encode(await (await get("/manifest.webmanifest", "Acme Notes")).text()).byteLength);
    const plainAsset = await get("/assets/index-BvuYDGo0.js", "Nook");
    const brandedAsset = await get("/assets/index-BvuYDGo0.js", "Acme Notes");
    expect(brandedAsset.headers.get("ETag")).toBe(plainAsset.headers.get("ETag"));
    expect(brandedAsset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await brandedAsset.text()).toBe("console.log('Nook');");
  });

  test("a client route under a new name serves the branded index and shares its ETag", async () => {
    const index = await get("/index.html", "Acme Notes");
    const route = await get("/notes/271650f3-9150-4a45-ae96-a7dda7c06568", "Acme Notes");
    expect(route.headers.get("ETag")).toBe(index.headers.get("ETag"));
    expect(await route.text()).toBe(await index.text());
  });
});

describe("mail and authenticator", () => {
  test("RFC 5322 specials and backslashes in the sender name are quoted and escaped; unicode is sent as it is", () => {
    expect(senderHeader("notes@example.com", 'Acme "Quoted" Notes')).toBe('"Acme \\"Quoted\\" Notes" <notes@example.com>');
    expect(senderHeader("notes@example.com", "Back\\slash")).toBe('"Back\\\\slash" <notes@example.com>');
    expect(senderHeader("notes@example.com", "Acme: Notes")).toBe('"Acme: Notes" <notes@example.com>');
    expect(senderHeader("notes@example.com", "Ünïcödé Notes")).toBe("Ünïcödé Notes <notes@example.com>");
    // A MAIL_FROM with its own display name is never rewritten, whatever the app name.
    expect(senderHeader('"Team, Inc." <notes@example.com>', "Acme Notes")).toBe('"Team, Inc." <notes@example.com>');
  });

  test("the header badge takes the first character of a name starting with a digit or an emoji", () => {
    config.appName = "1Password-ish";
    expect(renderFixture("account.password_reset", "notes.example.com")!.html).toContain(">1</td>");
    config.appName = "📝 Notes";
    expect(renderFixture("account.password_reset", "notes.example.com")!.html).toContain(">📝</td>");
    // A flag and a ZWJ family stay whole: the badge takes the first grapheme, not the first code point.
    config.appName = "🇮🇳 Notes";
    expect(renderFixture("account.password_reset", "notes.example.com")!.html).toContain(">🇮🇳</td>");
    expect(firstGrapheme("👨‍👩‍👧 Family")).toBe("👨‍👩‍👧");
    expect(firstGrapheme("")).toBe("N");
    config.appName = "Acme & Sons";
    const mail = renderFixture("account.password_reset", "notes.example.com")!;
    expect(mail.html).toContain("Acme &amp; Sons");
    expect(mail.subject).toBe("Reset your Acme & Sons password");
  });

  test("changing APP_NAME relabels the otpauth URI but an existing secret still verifies", () => {
    const secret = createTotpSecret();
    config.appName = "Nook";
    const before = totpUri(secret, "bob@example.test");
    expect(before).toContain("otpauth://totp/Nook%3Abob%40example.test?secret=");
    expect(before).toContain("&issuer=Nook&");
    const at = Date.now();
    const code = totpCodeAt(secret, totpCounter(at));
    config.appName = "Acme: Notes";
    const after = totpUri(secret, "bob@example.test");
    expect(after).toContain("otpauth://totp/Acme%20%20Notes%3Abob%40example.test?secret=");
    expect(after).toContain("&issuer=Acme%20%20Notes&");
    expect(after.split("?")[1]!.split("&")[0]).toBe(before.split("?")[1]!.split("&")[0]);
    expect(verifyTotp(secret, code, null, at)).toBe(totpCounter(at));
  });
});

describe("client copy", () => {
  test("the recovery-codes file header and the first-account prompt use the runtime name", () => {
    setAppName("Acme Notes");
    expect(recoveryCodesText(["ABCDE-FGHIJ"])).toStartWith("Acme Notes recovery codes\n");
    expect(registrationPrompt({ hasUsers: false, openRegistration: true })).toBe("Setting up Acme Notes? Create the first account");
  });

  test("body copy that names the app follows the runtime name; 'this Nook' keeps the instance noun", () => {
    setAppName("Acme Notes");
    expect(googleOnlyHint()).toBe("This Acme Notes signs people in with Google. Use the Google account with your Acme Notes email address. If that does not work, ask your admin.");
    expect(googleOnlyPasswordText()).toContain("This Acme Notes signs people in with Google only");
    expect(googleErrorMessage("blocked")).toBe("This account has been blocked. Contact your Acme Notes administrator.");
    expect(googleErrorMessage("not_allowed")).toBe("This Google account cannot sign in to this Nook. Ask your admin.");
    expect(linkRequiredText(false)).toContain("Ask your Acme Notes admin");
    expect(unavailableMessage("unsupported")).toEndWith("reminders still appear in Acme Notes.");
    expect(pushUnavailableCopy()).toEndWith("reminders still appear in Acme Notes.");
    expect(inviteLimitHint(5, 5)).toBe("5 invites are live, the most Acme Notes allows. Revoke one or wait for one to expire.");
    const admin = { id: "a", role: "admin", status: "active" } as Parameters<typeof lastAdminReason>[0];
    expect(lastAdminReason(admin, [admin])).toBe("Acme Notes needs at least one admin. Make someone else an admin first.");
    expect(suppressionCopy({ address: "a@example.test", suppression: { reason: "complaint" } } as Parameters<typeof suppressionCopy>[0])).toContain("so Acme Notes stopped sending to it");
  });

  test("the session response's app.name sets the client name (development, where Vite serves index.html as it is)", () => {
    const app = readFileSync(join(import.meta.dir, "..", "src", "App.tsx"), "utf8");
    expect(app).toContain("if (result.app?.name) setAppName(result.app.name);");
    expect(app).toContain("app?: { name?: string }");
  });

  test("setAppName rewrites only the trailing app name in the tab title, and ignores one that is not there", () => {
    const previous = (globalThis as { document?: unknown }).document;
    const fake = { title: "Nook keys · Settings · Nook" };
    (globalThis as { document?: unknown }).document = fake;
    try {
      setAppName("Acme Notes");
      expect(fake.title).toBe("Nook keys · Settings · Acme Notes");
      fake.title = "Untitled note";
      setAppName("Other");
      expect(fake.title).toBe("Untitled note");
      setAppName("x".repeat(60));
      expect(fake.title).toBe("Untitled note");
    } finally {
      (globalThis as { document?: unknown }).document = previous;
    }
  });
});
