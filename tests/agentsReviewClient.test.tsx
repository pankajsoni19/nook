import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { classifyLink, hostOf, lex, Markdown, type RenderContext } from "../src/chat/markdown/render";

/**
 * Wave 40 security review: hostile Markdown goldens against the renderer (T303, T304). Each case
 * records what the renderer produces; the assertions name the behaviour that holds and the one that
 * does not (a backslash path is accepted as a Nook path although browsers read it as an external URL).
 */

const calls: string[] = [];
const context: RenderContext = { onExternalLink: (href) => calls.push(`external:${href}`), onNookLink: (path) => calls.push(`nook:${path}`) };
const render = (text: string, streaming = false) => renderToStaticMarkup(<Markdown text={text} context={context} streaming={streaming} />);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!);
const NOOK = "https://nook.example.test";

describe("review: hostile Markdown", () => {
  test("script, nested HTML, event handlers, and an img onerror are text, never elements", () => {
    const html = render("<div><img src=x onerror=alert(1)><svg onload=alert(2)><iframe srcdoc='x'></iframe></div>\n\n<a href=\"javascript:alert(3)\">a</a> text <math><mtext><table><mglyph><style><img src=x onerror=alert(4)>");
    expect(html).not.toMatch(/<img|<svg|<iframe|<a |<math|<style/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toMatch(/<[a-z]+[^>]*onerror=/);
  });

  test("reference-style and autolinked javascript:, data:, vbscript:, file:, and protocol-relative links are text", () => {
    const html = render("[ref][1] [ref2][2] [ref3][3] <javascript:alert(1)> <data:text/html,x> [rel](//evil.example.test/x) [file](file:///etc/passwd) [back](\\\\evil.example.test)\n\n[1]: javascript:alert(1)\n[2]: data:text/html;base64,PHNjcmlwdD4=\n[3]: vbscript:msgbox");
    for (const href of hrefs(html)) {
      expect(href).toMatch(/^(https?:|mailto:|\/[^/])/);
    }
    expect(html).not.toMatch(/href="(javascript|data|vbscript|file):/);
    expect(html).not.toContain('href="//evil');
    expect(classifyLink("//evil.example.test/x")).toEqual({ kind: "text" });
    expect(classifyLink("\\\\evil.example.test")).toEqual({ kind: "text" });
  });

  test("a Nook path beginning with a backslash is accepted although browsers resolve it to another origin", () => {
    // `/\evil.example.test` passes NOOK_PATH (`/` then not `/`), yet `new URL("/\\evil.example.test", nook)` is https://evil.example.test/.
    const target = classifyLink("/\\evil.example.test/steal?x=1");
    expect(target.kind).toBe("nook");
    const html = render("[docs](/\\evil.example.test/steal?x=1)");
    const [href] = hrefs(html);
    expect(href).toBe("/\\evil.example.test/steal?x=1");
    expect(new URL(href!, NOOK).origin).toBe("https://evil.example.test");
    // The in-app click goes through onNookLink (the router), but the href itself is what a middle click or "Copy link" uses.
    for (const candidate of ["/\\x", "/\\\\x", "/\\evil.example.test"]) expect(new URL(candidate, NOOK).origin === NOOK).toBe(false);
    // Percent-encoded and other variants stay on the Nook origin.
    for (const candidate of ["/%5Cevil.example.test", "/x/\\evil", "/notes/abc"]) expect(new URL(candidate, NOOK).origin).toBe(NOOK);
  });

  test("a mailto with headers passes the mailto check", () => {
    expect(classifyLink("mailto:a@b.test?subject=hi&body=Paste%20your%20password").kind).toBe("mailto");
  });

  test("homoglyph hosts show their punycode form; the sheet gets the full URL", () => {
    calls.length = 0;
    const html = render("[Apple](https://аpple.example.test/login?next=x)");
    expect(html).toContain("xn--pple-43d.example.test");
    expect(hostOf("https://аpple.example.test/")).toBe("xn--pple-43d.example.test");
    const [href] = hrefs(html);
    expect(href).toBe("https://xn--pple-43d.example.test/login?next=x");
  });

  test("images never produce an img element, including inside links and with data: and javascript: sources", () => {
    const html = render("![a](data:image/svg+xml;base64,PHN2Zz4=) [![b](https://evil.example.test/p.png)](https://evil.example.test/) ![c](javascript:alert(1)) <img src=x>");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<[a-z]+[^>]* src=/);
  });

  test("lexing time of a hostile inline-heavy message grows faster than its size (evidence for the renderer's cost)", () => {
    const line = "[a](/\\x) **b** *c* `d` <e> [f][g] ![h](i) ";
    const timeFor = (bytes: number) => {
      const text = `${line.repeat(Math.ceil(bytes / line.length))}\n\n[g]: javascript:x`;
      const started = performance.now();
      lex(text);
      return Math.round(performance.now() - started);
    };
    const at64 = timeFor(64 * 1024);
    const at256 = timeFor(256 * 1024);
    console.log(`review markdown lex: 64 KiB ${at64} ms, 256 KiB ${at256} ms (stored assistant cap is 256 KiB; the live stream is capped at 8 MiB)`);
    const html = render(`${line.repeat(64)}\n\n[g]: javascript:x`);
    expect(html).not.toContain("javascript:");
    expect(at256).toBeGreaterThan(0);
  }, 120_000);

  test("code blocks keep their text verbatim and tables carry only the known alignments", () => {
    const html = render("```html\n<script>alert(1)</script>\n```\n\n| a | b |\n|:--|--:|\n| <b>x</b> | y |");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toMatch(/style="text-align:left"/);
    expect(html).not.toContain("<b>x</b>");
  });
});
