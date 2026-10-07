import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { classifyLink, lex, Markdown, splitStreaming, type RenderContext } from "../src/chat/markdown/render";
import { decodeEntities } from "../src/chat/markdown/entities";
import { footnoteLabels } from "../src/chat/markdown/footnotes";
import { allowHost, classifyImage, DATA_IMAGE_MAX_BYTES, hostAllowed, IMAGE_PROXY_HEADER, IMAGE_PROXY_PATH, loadedImage, loadProxiedImage, resetImageConsentForTests, sniffImage, subscribeImageConsent } from "../src/chat/markdown/images";
import { ExternalImageCard, ImageViewer, MarkdownImage, ShownImage } from "../src/chat/markdown/MarkdownImage";
import { ToolCallsDisclosure, toolImageUrl } from "../src/chat/ToolDisclosure";
import { PublicTranscript } from "../src/chat/PublicChat";
import { GFM_SAMPLE, imagesSample, longSample } from "./support/markdownSamples";
import { base64, GIF_1X1, makePng, pngDataUrl, SVG_IMAGE } from "./support/images";
import type { PublicChatSnapshot, ToolCallView } from "../shared/agents";

/**
 * Chat Markdown, done well (D370 as amended, T303, T304): every GitHub-flavoured Markdown feature
 * renders as React elements (no HTML string, raw HTML as text, the link rules unchanged), and images
 * follow their rules: Nook's own access-checked routes and small PNG/JPEG/GIF/WebP data: images show,
 * outside images wait for a click and load through the proxy, SVG and the rest stay chips, and the
 * public page never fetches anything. Without a DOM, the click paths are tested through the pieces
 * the component is built from: the proxy loader, the per-chat consent store, and each card state.
 */

const NOOK = "https://nook.invalid";
const FILE_ID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const app: RenderContext = { onExternalLink: () => undefined, onNookLink: () => undefined, images: { mode: "app", scope: "chat-1", chatId: "chat-1" } };
const publicContext: RenderContext = { onExternalLink: () => undefined, onNookLink: () => undefined, images: { mode: "public" } };
const render = (text: string, context: RenderContext = app, streaming = false) => renderToStaticMarkup(<Markdown text={text} context={context} streaming={streaming} />);
const strip = (html: string) => html.replace(/<svg[^]*?<\/svg>/g, "");

beforeEach(() => resetImageConsentForTests());

describe("GitHub-flavoured Markdown", () => {
  const html = strip(render(GFM_SAMPLE));

  test("headings h1–h6 render one level smaller, each with its written level", () => {
    for (let level = 1; level <= 6; level += 1) expect(html).toContain(`class="chat-md-heading chat-md-h${level}"`);
    expect(html).toContain("<h2 class=\"chat-md-heading chat-md-h1\">Quarterly report</h2>");
    expect(html).toContain("<h6 class=\"chat-md-heading chat-md-h6\">Footnotes</h6>");
    expect(html).not.toContain("<h1");
  });

  test("paragraphs, soft and hard line breaks, bold, italic, both, strikethrough, inline code", () => {
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<em><strong>both</strong></em>");
    expect(html).toContain("<del>struck</del>");
    expect(html).toContain("<code class=\"chat-md-code\">inline code</code>");
    expect(html).toContain("A soft line break here,<br/>and the next line.");
    expect(html).toContain("a backslash<br/>and the line after it.");
  });

  test("lists: nested bullets, an ordered list's start number, and read-only task boxes", () => {
    expect(html).toMatch(/<ul><li><span class="chat-md-line">First bullet<\/span><\/li>/);
    expect(html).toContain("<ul><li><span class=\"chat-md-line\">Nested bullet</span><ul><li><span class=\"chat-md-line\">Third level</span></li></ul></li></ul>");
    expect(html).toContain("<ol start=\"3\"><li><span class=\"chat-md-line\">Third (this list starts at 3)</span>");
    expect(html).toContain("<ul class=\"chat-md-tasks\">");
    expect(html).toMatch(/<input type="checkbox" readOnly="" disabled="" aria-label="Done" checked=""\/><span class="chat-md-task-body"><span class="chat-md-line">Ship the renderer/);
    expect((html.match(/aria-label="Not done"/g) ?? []).length).toBe(2);
    expect(html).not.toContain("[x]");
    expect(html).not.toContain("[ ]");
  });

  test("tables keep their alignment, have a header row, and scroll inside their own region", () => {
    expect(html).toContain("<div class=\"chat-md-table\" tabindex=\"0\" role=\"region\" aria-label=\"Table\"><table><thead><tr><th scope=\"col\" style=\"text-align:left\">Region</th>");
    expect(html).toContain("<th scope=\"col\" style=\"text-align:center\">Centre</th><th scope=\"col\" style=\"text-align:right\">Right</th>");
    expect(html).toContain("<td style=\"text-align:right\">1,204</td>");
    expect(html).toContain("<tbody>");
    const css = readFileSync(join(import.meta.dir, "..", "src", "chat", "markdown", "markdown.css"), "utf8");
    expect(css).toMatch(/\.chat-md-table \{[^}]*overflow-x: auto/);
    expect(css).toMatch(/\.chat-md-pre pre \{[^}]*overflow-x: auto/);
    expect(css).toMatch(/\.chat-md-img-button img \{[^}]*max-width: 100%/);
    expect(css).toContain("tbody tr:nth-child(even)");
  });

  test("fenced code keeps its language label and the Copy button; quotes nest; rules render", () => {
    expect(html).toContain("<div class=\"chat-md-pre-bar\"><span>ts</span>");
    expect(html).toContain("aria-label=\"Copy code\"");
    expect(html).toContain("<code>export function greet(name: string) {");
    expect(html).toContain("return `Hello, ${name}!`;");
    expect(html).toContain("<blockquote><p>A block quote with <strong>emphasis</strong>.</p><blockquote><p>A nested quote.</p></blockquote></blockquote>");
    expect(html).toContain("<hr/>");
    expect(render("```\nplain\n```")).toContain("<span>code</span>");
  });

  test("links, autolinks, and reference-style links follow the unchanged link rules", () => {
    expect(html).toContain("<a href=\"https://docs.example.test/guide?x=1\" class=\"chat-md-link\" title=\"The guide\" rel=\"noopener noreferrer\">link<span class=\"chat-md-link-host\"> ↗ docs.example.test</span></a>");
    expect(html).toContain("<a href=\"https://example.test/path\" class=\"chat-md-link\" rel=\"noopener noreferrer\">https://example.test/path");
    expect(html).toContain("<a href=\"http://www.example.test/\" class=\"chat-md-link\" rel=\"noopener noreferrer\">www.example.test");
    expect(html).toContain("<a href=\"mailto:someone@example.test\" class=\"chat-md-link\">someone@example.test</a>");
    expect(html).toContain("<a href=\"https://github.github.com/gfm/\" class=\"chat-md-link\" rel=\"noopener noreferrer\">the spec");
    expect(html).toContain("<a href=\"/chat\" class=\"chat-md-link\">Nook</a>");
    const hostile = render("[a](javascript:alert(1)) [b][x] <javascript:alert(2)>\n\n[x]: data:text/html,hi");
    expect(hostile).not.toContain("href=\"javascript");
    expect(hostile).toContain("<span>javascript:alert(2)</span>");
    expect(hostile).not.toContain("href=\"data:");
  });

  test("escapes and character references come out as text; code keeps them as written", () => {
    expect(html).toContain("Escapes: *not italic*, # not a heading, 1. not a list.");
    expect(html).toContain("Entities: &amp; © © → — &lt;b&gt;.");
    expect(render("`a&amp;b`")).toContain("<code class=\"chat-md-code\">a&amp;amp;b</code>");
    expect(decodeEntities("&amp;lt; &#x1F600; &#0; &#xD800; &bogus; &nbsp;")).toBe("&lt; 😀 � � &bogus;  ");
    // A decoded `&lt;script&gt;` is text, never markup.
    expect(render("&lt;script&gt;alert(1)&lt;/script&gt;")).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(render("&lt;script&gt;alert(1)&lt;/script&gt;")).not.toContain("<script");
  });

  test("footnotes link to their note and back; an undefined label stays text", () => {
    expect(html).toMatch(/<sup class="chat-md-fnref"><a href="#(md[^"]+)-fn-1" id="\1-fnref-1" aria-label="Footnote 1">1<\/a><\/sup>/);
    expect(html).toMatch(/<div class="chat-md-footnote" id="md[^"]+-fn-note" role="note" aria-label="Footnote 2"><span class="chat-md-footnote-number">2\.<\/span>/);
    expect(html).toContain("A named footnote with <code class=\"chat-md-code\">code</code>.");
    expect(html).toContain("aria-label=\"Back to the text\"");
    expect(render("No note here[^9].")).toContain("No note here[^9].");
    expect([...footnoteLabels("x[^a]\n\n[^b]: one\n[^a]: two\n[^b]: again").entries()]).toEqual([["b", 1], ["a", 2]]);
  });

  test("raw HTML and the safety rules are unchanged: no HTML string, no handler, no inner HTML in the renderer", () => {
    expect(html).toContain("&lt;b onclick=&quot;x()&quot;&gt;bold?&lt;/b&gt; &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<[a-z]+[^>]* onclick=/);
    const blockHtml = render("<div onmouseover=\"x()\">\n<img src=x onerror=alert(1)>\n</div>");
    expect(blockHtml).not.toContain("<div onmouseover");
    expect(blockHtml).not.toContain("<img src=\"x\"");
    for (const file of ["render.tsx", "MarkdownImage.tsx", "images.ts", "footnotes.ts", "entities.ts"]) {
      const source = readFileSync(join(import.meta.dir, "..", "src", "chat", "markdown", file), "utf8");
      expect({ file, html: /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|DOMParser/.test(source) }).toEqual({ file, html: false });
      expect({ file, confirm: /window\.confirm|<select[\s>]/.test(source) }).toEqual({ file, confirm: false });
    }
    expect(classifyLink("/\\evil.example.test")).toEqual({ kind: "text" });
  });

  test("streaming: an unclosed fence is an open block, settled blocks are split at blank lines outside fences", () => {
    expect(render("Start\n\n```python\nprint(1)\n", app, true)).toContain("<code>print(1)");
    expect(splitStreaming("a\n\nb\n\n```\nc\n\nd")).toEqual({ settled: "a\n\nb\n\n", tail: "```\nc\n\nd" });
    // A settled message and the same message streamed render the same blocks.
    const text = longSample(2);
    const settled = strip(render(text));
    const streamed = strip(render(`${text}\n\n`, app, true));
    expect(streamed.replace(/md[^"-]*-/g, "")).toBe(settled.replace(/md[^"-]*-/g, ""));
  });

  test("lexing a long reply (about 5,000 words with tables and code) stays fast", () => {
    const text = longSample();
    expect(text.split(/\s+/).length).toBeGreaterThan(4500);
    const started = performance.now();
    for (let run = 0; run < 5; run += 1) lex(text);
    const lexMs = (performance.now() - started) / 5;
    const renderStarted = performance.now();
    const out = render(text);
    const renderMs = performance.now() - renderStarted;
    console.log(`chat markdown: ${text.length} chars, ${text.split(/\s+/).length} words; lex ${lexMs.toFixed(1)} ms, full render ${renderMs.toFixed(1)} ms`);
    expect(out).toContain("Section 24");
    expect(lexMs).toBeLessThan(250);
  });
});

describe("image classification", () => {
  test("Nook images: only the access-checked image routes on this origin, canonicalised", () => {
    expect(classifyImage(`/files/${FILE_ID}`, NOOK)).toEqual({ kind: "nook", src: `/api/files/${FILE_ID}/content?disposition=inline` });
    expect(classifyImage(`/api/files/${FILE_ID.toUpperCase()}/content?disposition=attachment`, NOOK)).toEqual({ kind: "nook", src: `/api/files/${FILE_ID}/content?disposition=inline` });
    expect(classifyImage(`${NOOK}/api/whiteboards/${FILE_ID}/thumbnail`, NOOK)).toEqual({ kind: "nook", src: `/api/whiteboards/${FILE_ID}/thumbnail` });
    expect(classifyImage(`/api/chats/${FILE_ID}/tool-images/${FILE_ID}`, NOOK).kind).toBe("nook");
    // Any other same-origin path (a GET with side effects, the proxy itself) is never an image source.
    for (const path of ["/api/auth/logout", "/api/agents/image-proxy?url=https://evil.example.test/x.png", "/chat", "/files/not-a-uuid", "//evil.example.test/x.png", "/\\evil.example.test/x.png", `/api/files/${FILE_ID}/content/../../auth/logout`]) {
      expect({ path, kind: classifyImage(path, NOOK).kind }).toEqual({ path, kind: "refused" });
    }
  });

  test("data: images: PNG, JPEG, GIF, WebP by their bytes, never SVG, within the size cap", () => {
    const png = classifyImage(pngDataUrl(8, 8));
    expect(png.kind).toBe("data");
    expect(classifyImage(`data:image/gif;base64,${base64(GIF_1X1)}`)).toMatchObject({ kind: "data", mimeType: "image/gif" });
    expect(classifyImage(`data:image/jpg;base64,${base64(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]))}`)).toMatchObject({ kind: "data", mimeType: "image/jpeg" });
    expect(classifyImage(`data:image/svg+xml;base64,${base64(SVG_IMAGE)}`)).toEqual({ kind: "refused", reason: "svg" });
    expect(classifyImage("data:image/svg+xml,<svg onload=alert(1)>")).toEqual({ kind: "refused", reason: "svg" });
    // An SVG labelled PNG is refused by its bytes.
    expect(classifyImage(`data:image/png;base64,${base64(SVG_IMAGE)}`)).toEqual({ kind: "refused", reason: "invalid" });
    expect(classifyImage("data:text/html;base64,PGgxPmhpPC9oMT4=")).toEqual({ kind: "refused", reason: "type" });
    expect(classifyImage("data:image/png,rawbytes")).toEqual({ kind: "refused", reason: "invalid" });
    const oversize = `data:image/png;base64,${base64(makePng(8, 8)).slice(0, 12)}${"A".repeat(Math.ceil((DATA_IMAGE_MAX_BYTES + 3) / 3) * 4)}`;
    expect(classifyImage(oversize)).toEqual({ kind: "refused", reason: "too-large" });
  });

  test("outside images: http(s) only, no credentials, SVG paths refused, fragments dropped", () => {
    const external = classifyImage("https://img.example.test/chart.png?user=alice#frag");
    expect(external.kind).toBe("external");
    expect(external.kind === "external" && external.url.toString()).toBe("https://img.example.test/chart.png?user=alice");
    expect(classifyImage("https://img.example.test/logo.svg")).toEqual({ kind: "refused", reason: "svg" });
    expect(classifyImage("javascript:alert(1)")).toEqual({ kind: "refused", reason: "scheme" });
    expect(classifyImage("ftp://img.example.test/a.png")).toEqual({ kind: "refused", reason: "scheme" });
    expect(classifyImage("https://u:p@img.example.test/a.png")).toEqual({ kind: "refused", reason: "scheme" });
    expect(sniffImage(makePng(2, 2))).toBe("image/png");
    expect(sniffImage(SVG_IMAGE)).toBeNull();
  });
});

describe("images in the bubble", () => {
  const sample = imagesSample(FILE_ID, "https://img.example.test/chart.png?user=alice");

  test("the app shows data: and Nook images at once; an outside image is a card with its alt, full host, Load image and Open link", () => {
    const html = strip(render(sample));
    expect(html).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="Gradient swatch"/);
    expect(html).toContain(`<img src="/api/files/${FILE_ID}/content?disposition=inline" alt="Team photo"`);
    expect(html).toContain("aria-label=\"View image: Team photo\"");
    expect(html).not.toContain("img.example.test/chart.png\"");
    expect(html).not.toMatch(/<img[^>]+img\.example\.test/);
    expect(html).toContain("<span class=\"chat-md-remote-alt\">Remote chart</span></span><span class=\"chat-md-remote-host\">img.example.test</span>");
    expect(html).toContain(">Load image</button>");
    expect(html).toContain(">Open link</button>");
    expect(html).toContain("Loading it sends its address to img.example.test.");
    expect(html).toContain("Always load images from img.example.test in this chat");
    expect(html).toContain("<span class=\"chat-md-image\" title=\"SVG images are never shown\">🖼 Logo</span>");
  });

  test("the public page never fetches: outside and Nook images are chips; data: images (no request) still show", () => {
    const html = strip(render(sample, publicContext));
    expect(html).toMatch(/<img src="data:image\/png;base64,/);
    expect(html).not.toContain("/api/files/");
    expect(html).not.toContain("Load image");
    expect(html).toContain("🖼 Remote chart · img.example.test");
    expect(html).toContain("🖼 Team photo");
    // The default (no image policy) is the public one.
    expect(strip(render(sample, { onExternalLink: () => undefined, onNookLink: () => undefined }))).not.toContain("Load image");
    const snapshot: PublicChatSnapshot = { version: 1, title: "T", agentName: "A", ownerName: "O", snapshotAt: new Date().toISOString(), includeToolResults: false, truncated: false, messages: [{ role: "assistant", content: sample, createdAt: new Date().toISOString(), toolCalls: [] }] };
    const page = renderToStaticMarkup(<PublicTranscript snapshot={snapshot} context={publicContext} />);
    expect(page).not.toContain("Load image");
    expect(page).not.toMatch(/<img[^>]+(img\.example\.test|\/api\/)/);
  });

  test("a linked image shows the picture and the link after it, never a button inside a link", () => {
    const html = strip(render(`[![Badge](${pngDataUrl(4, 4)})](https://ci.example.test/run/1)`));
    expect(html).toContain("<span class=\"chat-md-linked-image\"><span class=\"chat-md-figure\"><button");
    expect(html).toContain("<a href=\"https://ci.example.test/run/1\" class=\"chat-md-link\" rel=\"noopener noreferrer\">Link<span class=\"chat-md-link-host\"> ↗ ci.example.test</span></a>");
    expect(html).not.toMatch(/<a [^>]*>[^]*<button/);
  });

  test("click to load: the proxy is called with its header and the URL, and the picture comes back as a data: URL", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const png = makePng(4, 4);
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    }) as unknown as typeof fetch;
    const toDataUrl = async (blob: Blob) => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`;
    const url = "https://img.example.test/chart.png?user=alice";
    const result = await loadProxiedImage(url, fetcher, toDataUrl);
    expect(result).toEqual({ ok: true, src: `data:image/png;base64,${base64(png)}` });
    expect(calls).toEqual([{ url: `${IMAGE_PROXY_PATH}?url=${encodeURIComponent(url)}`, headers: { [IMAGE_PROXY_HEADER]: "1", Accept: "image/png,image/jpeg,image/gif,image/webp" } }]);
    // Loaded once: a remount shows it without another request.
    expect(loadedImage(url)).toBe(result.ok ? result.src : null);
    await loadProxiedImage(url, fetcher, toDataUrl);
    expect(calls.length).toBe(1);
  });

  test("click to load: the proxy's refusals become a message on the card; a non-image answer is refused again here", async () => {
    const answer = (status: number, body: unknown, type = "application/json") => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": type } })) as unknown as typeof fetch;
    expect(await loadProxiedImage("https://a.example.test/1.png", answer(415, { code: "NOT_AN_IMAGE" }))).toEqual({ ok: false, message: "That address is not a PNG, JPEG, GIF, or WebP image" });
    expect(await loadProxiedImage("https://a.example.test/2.png", answer(502, { code: "REDIRECT_REFUSED" }))).toEqual({ ok: false, message: "The image's host answered with a redirect, which Nook does not follow" });
    expect(await loadProxiedImage("https://a.example.test/3.png", answer(429, "slow down", "text/plain"))).toEqual({ ok: false, message: "Too many images loaded; wait a minute" });
    expect(await loadProxiedImage("https://a.example.test/4.png", answer(200, "<svg/>", "image/svg+xml"))).toEqual({ ok: false, message: "That address is not a PNG, JPEG, GIF, or WebP image" });
    const offline = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    expect(await loadProxiedImage("https://a.example.test/5.png", offline)).toEqual({ ok: false, message: "Nook could not be reached" });
  });

  test("Always load from this host: per chat, for this page's life, and every card of that host hears it", () => {
    let heard = 0;
    const stop = subscribeImageConsent(() => { heard += 1; });
    expect(hostAllowed("chat-1", "img.example.test")).toBe(false);
    allowHost("chat-1", "img.example.test");
    expect(hostAllowed("chat-1", "img.example.test")).toBe(true);
    expect(hostAllowed("chat-2", "img.example.test")).toBe(false);
    expect(hostAllowed("chat-1", "other.example.test")).toBe(false);
    expect(heard).toBe(1);
    stop();
    allowHost("chat-1", "third.example.test");
    expect(heard).toBe(1);
  });

  test("each card state renders: idle, loading, failed with Try again, and shown as a picture that opens the viewer", () => {
    const props = { host: "img.example.test", alt: "Chart", onLoad: () => undefined, onAlways: () => undefined, onOpenLink: () => undefined };
    const loading = strip(renderToStaticMarkup(<ExternalImageCard {...props} state={{ status: "loading" }} />));
    expect(loading).toContain("disabled=\"\" aria-busy=\"true\">Loading…</button>");
    const failed = strip(renderToStaticMarkup(<ExternalImageCard {...props} state={{ status: "failed", message: "The image's host did not return it" }} />));
    expect(failed).toContain("role=\"alert\">The image&#x27;s host did not return it</span>");
    expect(failed).toContain(">Try again</button>");
    const shown = renderToStaticMarkup(<ExternalImageCard {...props} state={{ status: "shown", src: "data:image/png;base64,AAAA" }} />);
    expect(shown).toContain("<img src=\"data:image/png;base64,AAAA\" alt=\"Chart\"");
    expect(shown).toContain("aria-label=\"View image: Chart\"");
  });

  test("the viewer sheet: the picture, its alt text as the title, Close, and Open link for an outside image; images keep alt text", () => {
    const viewer = strip(renderToStaticMarkup(<ImageViewer src="data:image/png;base64,AAAA" alt="Chart" host="img.example.test" onClose={() => undefined} onOpenLink={() => undefined} />));
    expect(viewer).toContain("role=\"dialog\" aria-modal=\"true\"");
    expect(viewer).toContain("<span class=\"eyebrow\">img.example.test</span>");
    expect(viewer).toContain(">Chart</h2>");
    expect(viewer).toContain("<div class=\"chat-image-viewer-body\"><img src=\"data:image/png;base64,AAAA\" alt=\"Chart\"");
    expect(viewer).toContain(">Open link</button>");
    expect(viewer).toContain(">Close</button>");
    const source = readFileSync(join(import.meta.dir, "..", "src", "chat", "markdown", "MarkdownImage.tsx"), "utf8");
    // Back closes it (D18), at 390 px too: the same history guard as every other sheet.
    expect(source).toContain("useHistoryDialogGuard(true, onClose);");
    expect(renderToStaticMarkup(<ShownImage src="/api/files/x/content" alt="" />)).toContain("aria-label=\"View image\"");
    expect(renderToStaticMarkup(<MarkdownImage href="javascript:alert(1)" alt="x" policy={{ mode: "app", scope: "c" }} onExternalLink={() => undefined} />)).not.toContain("<img");
  });

  test("tool images show inside the call's details with the reader's session, and the summary counts them", () => {
    const call: ToolCallView = { id: "c1", tool: "image", server: "fake", serverId: null, argsPreview: "{}", resultPreview: "[image: image/png, 1 KiB, shown to the person]", ok: true, truncated: false, durationMs: 12, decision: null, proposalId: null, images: [{ id: FILE_ID, mimeType: "image/png", bytes: 900 }] };
    const html = renderToStaticMarkup(<ToolCallsDisclosure calls={[call]} running={false} chatId="chat-9" />);
    expect(html).toContain("· 1 image");
    expect(toolImageUrl("chat-9", FILE_ID)).toBe(`/api/chats/chat-9/tool-images/${FILE_ID}`);
    // Without a chat (the public page, the Audit log) there is no image route, so no count.
    expect(renderToStaticMarkup(<ToolCallsDisclosure calls={[call]} running={false} />)).not.toContain("image</span>");
  });
});
