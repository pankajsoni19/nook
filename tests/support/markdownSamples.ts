import { pngDataUrl } from "./images";

/**
 * Markdown the fake provider can stream (`md:<name>`, `mdslow:<ms>:<name>`, and `mdimg:<file id>|<image URL>`;
 * tests/support/fakeProvider.ts), for the renderer's live check and its tests: every GFM feature,
 * a long reply (about 5,000 words with tables and code) for streaming performance, and images of
 * every kind.
 */

export const GFM_SAMPLE = `# Quarterly report

A paragraph with **bold**, *italic*, ***both***, ~~struck~~, and \`inline code\`.
A soft line break here,
and the next line. A hard break with a backslash\\
and the line after it.

## Lists

- First bullet
- Second bullet with a [link](https://docs.example.test/guide?x=1 "The guide")
  - Nested bullet
    - Third level
- Back at the top

3. Third (this list starts at 3)
4. Fourth
5. Fifth

- [x] Ship the renderer
- [ ] Write the docs
- [ ] Measure streaming

### Table with alignment

| Region | Left | Centre | Right |
|:-------|:-----|:------:|------:|
| North  | a    | b      | 1,204 |
| South  | longer text that wraps when the column is narrow | c | 98 |
| East   | e    | f      | 7 |
| West   | g    | h      | 42 |

#### Code

\`\`\`ts
export function greet(name: string) {
  return \`Hello, \${name}!\`; // a long line to show horizontal scrolling inside the block, never the page itself
}
\`\`\`

> A block quote with **emphasis**.
>
> > A nested quote.

---

##### Links and escapes

Autolinks: https://example.test/path and www.example.test and someone@example.test.
Reference links: [the spec][gfm] and [Nook](/chat).
Escapes: \\*not italic\\*, \\# not a heading, 1\\. not a list.
Entities: &amp; &copy; &#169; &rarr; &mdash; &lt;b&gt;.
Raw HTML stays text: <b onclick="x()">bold?</b> <script>alert(1)</script>

###### Footnotes

Markdown has footnotes[^1] and named ones[^note].

[gfm]: https://github.github.com/gfm/
[^1]: The first footnote.
[^note]: A named footnote with \`code\`.
`;

const paragraph = (index: number) => `Paragraph ${index}: the agent explains a point in some detail, with **bold words**, a bit of \`code\`, and a [link](https://example.test/p/${index}). It keeps going for a while so the reply is long enough to measure how streaming behaves when many blocks have settled and the tail keeps growing at the end of the message.`;

/** About 5,000 words: headings, paragraphs, lists, tables, and code blocks, repeated in sections. */
export function longSample(sections = 24): string {
  const out: string[] = ["# A long answer", ""];
  for (let section = 1; section <= sections; section += 1) {
    out.push(`## Section ${section}`, "", paragraph(section * 10 + 1), "", paragraph(section * 10 + 2), "");
    out.push("- one point", "- another point with `code`", "- a third point", "");
    out.push("| Name | Value | Notes |", "|:-----|------:|:------|");
    for (let row = 1; row <= 6; row += 1) out.push(`| item ${section}.${row} | ${section * row} | note for row ${row} of section ${section} |`);
    out.push("", "```js", `function section${section}() {`, `  const values = [${Array.from({ length: 8 }, (_, i) => i * section).join(", ")}];`, "  return values.reduce((sum, value) => sum + value, 0);", "}", "```", "");
    out.push(paragraph(section * 10 + 3), "");
  }
  return out.join("\n");
}

/** Images of every kind: data:, a Nook file, an outside picture, an SVG (refused), and a broken Nook path. */
export function imagesSample(fileId: string, externalUrl: string): string {
  return [
    "## Images",
    "",
    "An embedded PNG (shown at once):",
    "",
    `![Gradient swatch](${pngDataUrl(160, 90)})`,
    "",
    "A picture from this Nook (shown to people who can open the file):",
    "",
    `![Team photo](/files/${fileId})`,
    "",
    "An outside picture (loads only when you click):",
    "",
    `![Remote chart](${externalUrl})`,
    "",
    "An SVG is never shown: ![Logo](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)",
    "",
    "A file that does not exist: ![Missing](/api/files/00000000-0000-4000-8000-000000000000/content)",
    ""
  ].join("\n");
}

export function markdownSample(name: string): string {
  if (name === "gfm") return GFM_SAMPLE;
  if (name === "long") return longSample();
  return `Unknown sample ${name}`;
}
