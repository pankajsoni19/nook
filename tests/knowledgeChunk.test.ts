import { describe, expect, test } from "bun:test";
import { chunkCsv, chunkMarkdown, chunkText, csvRecords, FAQ_MAX_CHARS, MAX_CHARS, overlapTail } from "../server/knowledge/chunk";
import { CHUNKING } from "../shared/knowledge";

/**
 * Wave 44 "AC-E" (agent chat plan §9, D369, §15 item 11): chunker goldens. Pure: no server.
 */

const words = (count: number, seed = "word") => Array.from({ length: count }, (_, index) => `${seed}${index}`).join(" ");

describe("Markdown: headings and their paths", () => {
  test("splits at ATX headings and carries the heading path", () => {
    const chunks = chunkMarkdown([
      "Intro line before any heading.",
      "",
      "# Billing",
      "Billing overview.",
      "",
      "## Refunds",
      "Annual plans are refunded pro rata.",
      "",
      "### Edge cases",
      "Refunds after 30 days need approval.",
      "",
      "## Invoices",
      "Invoices are emailed monthly.",
      "",
      "# Support",
      "Write to support."
    ].join("\n"));
    expect(chunks).toEqual([
      { heading: null, text: "Intro line before any heading." },
      { heading: "Billing", text: "Billing overview." },
      { heading: "Billing › Refunds", text: "Annual plans are refunded pro rata." },
      { heading: "Billing › Refunds › Edge cases", text: "Refunds after 30 days need approval." },
      { heading: "Billing › Invoices", text: "Invoices are emailed monthly." },
      { heading: "Support", text: "Write to support." }
    ]);
  });

  test("a heading inside a fenced code block is not a heading; empty sections are dropped; CRLF is normalized", () => {
    const chunks = chunkMarkdown("# Setup\r\n\r\n```sh\r\n# not a heading\r\necho hi\r\n```\r\n\r\n# Empty\r\n\r\n# **Styled** `title`\r\nBody");
    expect(chunks).toEqual([
      { heading: "Setup", text: "```sh\n# not a heading\necho hi\n```" },
      { heading: "Styled title", text: "Body" }
    ]);
  });
});

describe("Markdown: FAQ pairs are never split", () => {
  test("a heading that asks a question is one chunk with its whole answer", () => {
    const answer = Array.from({ length: 14 }, (_, index) => `Paragraph ${index} of the answer. ${words(40, `a${index}x`)}`).join("\n\n");
    expect(answer.length).toBeGreaterThan(CHUNKING.targetChars);
    expect(answer.length).toBeLessThan(FAQ_MAX_CHARS);
    const chunks = chunkMarkdown(`# FAQ\n\n## How do refunds work for annual plans?\n\n${answer}\n\n## Can I pause?\n\nYes, for 3 months.`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ heading: "FAQ › How do refunds work for annual plans?", text: `How do refunds work for annual plans?\n\n${answer}` });
    expect(chunks[1]).toEqual({ heading: "FAQ › Can I pause?", text: "Can I pause?\n\nYes, for 3 months." });
  });

  test("Q:/A: pairs (and **Q:** / Question:) become one chunk each; text before them is packed on its own", () => {
    const chunks = chunkMarkdown([
      "# Help",
      "Common questions below.",
      "",
      "Q: How do I reset my password?",
      "A: Use the Forgot password link.",
      "It sends a mail.",
      "",
      "**Q:** Is there a mobile app?",
      "**A:** Nook works in the phone browser.",
      "",
      "Question: Where is my data",
      "stored?",
      "Answer: On your server."
    ].join("\n"));
    expect(chunks).toEqual([
      { heading: "Help", text: "Common questions below." },
      { heading: "Help", text: "Q: How do I reset my password?\nA: Use the Forgot password link.\nIt sends a mail." },
      { heading: "Help", text: "**Q:** Is there a mobile app?\n**A:** Nook works in the phone browser." },
      { heading: "Help", text: "Question: Where is my data\nstored?\nAnswer: On your server." }
    ]);
  });

  test("an answer past the FAQ cap is split, and every piece starts with the whole question", () => {
    const answer = `A: ${words(2500, "long")}`;
    const chunks = chunkMarkdown(`Q: What is the very long policy?\n${answer}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith("Q: What is the very long policy?\n\n")).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });
});

describe("Markdown: size and overlap", () => {
  test("a long section is packed into ~3,200-character chunks; each later chunk starts with the end of the one before", () => {
    const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index}. ${words(30, `p${index}w`)}`);
    const chunks = chunkMarkdown(`# Handbook\n\n${paragraphs.join("\n\n")}`);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.heading).toBe("Handbook");
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
    }
    for (let index = 1; index < chunks.length; index += 1) {
      const tail = overlapTail(chunks[index - 1]!.text);
      expect(tail.length).toBeGreaterThan(CHUNKING.targetChars * CHUNKING.overlap * 0.5);
      expect(chunks[index]!.text.startsWith(tail)).toBe(true);
    }
    // Every paragraph appears somewhere.
    for (const paragraph of paragraphs) expect(chunks.some((chunk) => chunk.text.includes(paragraph))).toBe(true);
  });

  test("one paragraph longer than the target is cut at sentence ends, never past the cap, and nothing is lost", () => {
    const sentences = Array.from({ length: 120 }, (_, index) => `Sentence number ${index} says something useful.`);
    const chunks = chunkMarkdown(sentences.join(" "));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
    for (const sentence of sentences) expect(chunks.some((chunk) => chunk.text.includes(sentence))).toBe(true);
  });

  test("one unbroken run of characters is still cut under the cap", () => {
    const chunks = chunkText("x".repeat(20_000), "markdown");
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
  });

  test("empty or blank text has no chunks", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("\n\n   \n")).toEqual([]);
  });
});

describe("CSV: 20 rows a chunk, the header repeated", () => {
  test("rows are grouped by twenty with the header first, and the heading names the rows", () => {
    const rows = Array.from({ length: 45 }, (_, index) => `${index + 1},Item ${index + 1},${(index + 1) * 10}`);
    const chunks = chunkCsv(["id,name,price", ...rows].join("\n"));
    expect(chunks.map((chunk) => chunk.heading)).toEqual(["Rows 1–20", "Rows 21–40", "Rows 41–45"]);
    expect(chunks[0]!.text).toBe(["id,name,price", ...rows.slice(0, 20)].join("\n"));
    expect(chunks[2]!.text).toBe(["id,name,price", ...rows.slice(40)].join("\n"));
  });

  test("quoted fields may hold commas, quotes, and newlines; blank lines are skipped", () => {
    const text = 'q,a\n"How, exactly?","Line one\nline two"\n\n"Say ""hi""",ok\n';
    expect(csvRecords(text)).toEqual(["q,a", '"How, exactly?","Line one\nline two"', '"Say ""hi""",ok']);
    expect(chunkText(text, "csv")).toEqual([{ heading: "Rows 1–2", text: 'q,a\n"How, exactly?","Line one\nline two"\n"Say ""hi""",ok' }]);
  });

  test("a chunk takes fewer rows when twenty would pass the cap; a header alone is one chunk", () => {
    const wide = Array.from({ length: 10 }, (_, index) => `${index},${"y".repeat(1500)}`);
    const chunks = chunkCsv(["id,blob", ...wide].join("\n"));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith("id,blob\n")).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHARS);
    }
    expect(chunkCsv("only,a,header")).toEqual([{ heading: null, text: "only,a,header" }]);
  });
});
