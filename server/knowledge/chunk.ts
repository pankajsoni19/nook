import { CHUNKING } from "../../shared/knowledge";

/**
 * The chunker (plan §9, D369; Wave 44 "AC-E"). Pure: text in, chunks out, so the goldens in
 * tests/knowledgeChunk.test.ts pin it down.
 *
 * - **Markdown-aware:** the text is split at ATX headings (`#`…`######`, never inside a fenced code
 *   block), and every chunk carries its heading path ("Billing › Refunds").
 * - **Size:** about 3,200 characters (≈ 800 tokens). A long section is packed paragraph by
 *   paragraph; each chunk after the first starts with the last ~15% of the one before (the
 *   overlap), cut at a word boundary. A paragraph longer than the target is cut at sentence or
 *   word boundaries. No chunk is longer than `MAX_CHARS`.
 * - **FAQ:** a heading that ends in "?" and its body, or a `Q:` / `A:` pair (also `**Q:**`,
 *   `Question:` / `Answer:`), is one chunk, whatever its length up to `FAQ_MAX_CHARS`, so an answer
 *   is never cut from its question. A longer answer is split, and every piece starts with the
 *   whole question again, so no piece is ever without it.
 * - **CSV:** 20 records per chunk, each chunk led by the header row; quoted fields may span lines.
 *   A chunk takes fewer records when 20 would pass `MAX_CHARS`, and a single record longer than
 *   that is cut.
 */

export type Chunk = { heading: string | null; text: string };
export type ChunkFormat = "markdown" | "csv";

export const HEADING_SEPARATOR = " › ";
const TARGET = CHUNKING.targetChars;
const OVERLAP = Math.round(CHUNKING.targetChars * CHUNKING.overlap);
/** The hard cap on a regular chunk (target plus its overlap and some slack). */
export const MAX_CHARS = TARGET + OVERLAP + 400;
/** A question and its answer stay one chunk up to this length. */
export const FAQ_MAX_CHARS = TARGET * 3;

const normalize = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");

/** Chunks a source's text: CSV by rows, everything else (Markdown, plain text) by the Markdown rules. */
export function chunkText(text: string, format: ChunkFormat): Chunk[] {
  return format === "csv" ? chunkCsv(text) : chunkMarkdown(text);
}

// ------------------------------------------------------------------------------ Markdown

type Section = { path: string[]; question: boolean; lines: string[] };

const ATX = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;

/** Splits Markdown into sections at its headings, keeping the heading path of each. */
function sections(text: string): Section[] {
  const out: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let current: Section = { path: [], question: false, lines: [] };
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fenceMatch[1] === fence) fence = null;
      current.lines.push(line);
      continue;
    }
    const heading = fence === null ? ATX.exec(line) : null;
    if (!heading) {
      current.lines.push(line);
      continue;
    }
    out.push(current);
    const level = heading[1]!.length;
    const title = heading[2]!.replace(/[*_`]/g, "").trim();
    while (stack.length && stack.at(-1)!.level >= level) stack.pop();
    stack.push({ level, title });
    current = { path: stack.map((entry) => entry.title), question: title.endsWith("?"), lines: [] };
  }
  out.push(current);
  return out.filter((section) => section.lines.some((line) => line.trim()) || section.question);
}

const QUESTION = /^\s*(?:\*\*|__)?(?:Q|Question)\s*[:.)](?:\*\*|__)?\s*(.*)$/i;
const ANSWER = /^\s*(?:\*\*|__)?(?:A|Answer)\s*[:.)](?:\*\*|__)?\s*/i;

export function chunkMarkdown(input: string): Chunk[] {
  const text = normalize(input);
  const chunks: Chunk[] = [];
  for (const section of sections(text)) {
    const heading = section.path.length ? section.path.join(HEADING_SEPARATOR) : null;
    const body = trimBlank(section.lines).join("\n");
    if (section.question) {
      // A heading that asks a question: the question (the heading) and its whole body are one chunk.
      const question = section.path.at(-1)!;
      chunks.push(...faqChunk(heading, question, body, `${question}\n\n${body}`.trim()));
      continue;
    }
    const pairs = qaPairs(section.lines);
    if (pairs) {
      if (pairs.preamble.trim()) chunks.push(...packSection(heading, pairs.preamble));
      for (const pair of pairs.items) chunks.push(...faqChunk(heading, `Q: ${pair.question}`, pair.answer, pair.text));
      continue;
    }
    if (body.trim()) chunks.push(...packSection(heading, body));
  }
  return chunks;
}

const trimBlank = (lines: string[]) => {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]!.trim()) start += 1;
  while (end > start && !lines[end - 1]!.trim()) end -= 1;
  return lines.slice(start, end);
};

/** `Q:` / `A:` pairs in a section's lines, or null when it has none (or no answer follows any question). */
function qaPairs(lines: string[]): { preamble: string; items: Array<{ question: string; answer: string; text: string }> } | null {
  const starts: number[] = [];
  let fence = false;
  lines.forEach((line, index) => {
    if (FENCE.test(line)) fence = !fence;
    if (!fence && QUESTION.test(line)) starts.push(index);
  });
  if (starts.length === 0) return null;
  const items: Array<{ question: string; answer: string; text: string }> = [];
  for (let at = 0; at < starts.length; at += 1) {
    const block = trimBlank(lines.slice(starts[at], starts[at + 1] ?? lines.length));
    const answerAt = block.findIndex((line) => ANSWER.test(line));
    if (answerAt < 0) continue;
    const question = block.slice(0, answerAt).map((line, index) => index === 0 ? QUESTION.exec(line)![1]! : line).join(" ").replace(/\s+/g, " ").trim();
    items.push({ question, answer: block.slice(answerAt).join("\n"), text: block.join("\n") });
  }
  if (items.length === 0) return null;
  return { preamble: trimBlank(lines.slice(0, starts[0])).join("\n"), items };
}

/**
 * One question and its answer (`full`, the question included). Past FAQ_MAX_CHARS the answer is
 * split, and every piece starts with the whole question (`lead`).
 */
function faqChunk(heading: string | null, lead: string, answer: string, full: string): Chunk[] {
  if (full.length <= FAQ_MAX_CHARS) return [{ heading, text: full }];
  const room = Math.max(TARGET - lead.length - 2, 400);
  return splitLong(answer, room).map((piece) => ({ heading, text: `${lead}\n\n${piece}` }));
}

/** Paragraphs (blank-line separated; a fenced code block stays one paragraph). */
function paragraphs(body: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) fence = !fence;
    if (!fence && !line.trim()) {
      if (current.length) out.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) out.push(current.join("\n"));
  return out;
}

/** The last ~OVERLAP characters of a chunk, starting at a word. */
export function overlapTail(text: string, size = OVERLAP): string {
  if (text.length <= size) return text;
  const tail = text.slice(text.length - size);
  const space = tail.search(/\s/);
  return (space >= 0 && space < size / 2 ? tail.slice(space) : tail).trim();
}

/** Packs a section's paragraphs into chunks of about TARGET characters, with the overlap between them. */
function packSection(heading: string | null, body: string): Chunk[] {
  const pieces: string[] = [];
  for (const paragraph of paragraphs(body)) {
    if (paragraph.length > TARGET) pieces.push(...splitLong(paragraph, TARGET - OVERLAP, 0));
    else pieces.push(paragraph);
  }
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const next = current ? `${current}\n\n${piece}` : piece;
    if (!current || next.length <= TARGET) {
      current = next;
      continue;
    }
    chunks.push(current);
    // The overlap: the end of the chunk just closed opens the next (a short chunk is not repeated whole).
    const tail = current.length > OVERLAP * 2 ? overlapTail(current) : "";
    current = tail ? `${tail}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks.map((text) => ({ heading, text: text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text }));
}

/** Cuts a long text into pieces of at most `size` characters at sentence ends, else spaces, else anywhere; consecutive pieces overlap. */
export function splitLong(text: string, size: number, overlapChars: number = OVERLAP): string[] {
  const out: string[] = [];
  let start = 0;
  const overlap = Math.min(overlapChars, Math.floor(size / 4));
  while (start < text.length) {
    if (text.length - start <= size) {
      out.push(text.slice(start).trim());
      break;
    }
    const window = text.slice(start, start + size);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "), window.lastIndexOf("\n"));
    if (cut < size / 2) cut = window.lastIndexOf(" ");
    if (cut < size / 2) cut = size - 1;
    out.push(text.slice(start, start + cut + 1).trim());
    // The next piece starts `overlap` characters back, at a word.
    let next = start + cut + 1 - overlap;
    const space = overlap > 0 ? text.indexOf(" ", next) : -1;
    if (space >= 0 && space < start + cut + 1) next = space + 1;
    start = Math.max(next, start + 1);
  }
  return out.filter(Boolean);
}

// ------------------------------------------------------------------------------ CSV

/** CSV records with their raw text (RFC 4180: quoted fields may hold commas, quotes, and newlines). */
export function csvRecords(input: string): string[] {
  const text = normalize(input);
  const records: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") quoted = !quoted;
    else if (char === "\n" && !quoted) {
      records.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (start < text.length) records.push(text.slice(start));
  return records.filter((record) => record.trim().length > 0);
}

export function chunkCsv(input: string): Chunk[] {
  const records = csvRecords(input);
  if (records.length === 0) return [];
  const header = records[0]!.slice(0, 1000);
  const rows = records.slice(1).map((row) => row.length > MAX_CHARS - header.length - 1 ? row.slice(0, MAX_CHARS - header.length - 1) : row);
  if (rows.length === 0) return [{ heading: null, text: header }];
  const chunks: Chunk[] = [];
  let at = 0;
  while (at < rows.length) {
    const taken: string[] = [];
    let size = header.length;
    while (at < rows.length && taken.length < CHUNKING.csvRows && (taken.length === 0 || size + 1 + rows[at]!.length <= MAX_CHARS)) {
      size += 1 + rows[at]!.length;
      taken.push(rows[at]!);
      at += 1;
    }
    const first = at - taken.length + 1;
    chunks.push({ heading: `Rows ${first}–${at}`, text: [header, ...taken].join("\n") });
  }
  return chunks;
}
