/**
 * Live embeds in notes and card descriptions (§B.4.4, generalizing the whiteboard embed D208): a line
 * that is only `[<Neutral word>](<path> "nook-embed")` renders as a live card (vote on a poll inline,
 * "Respond" to a form, a goal's progress, a booking link). The link text is always the kind's neutral
 * word, never the item's title, so a reader who cannot open the item never learns its title from the
 * Markdown, version history, MCP, or search (QA H1, T513). The card fetches what the reader may see.
 */
import { parseWorkRef, type ParsedWorkRef, type WorkKind } from "./workRefs";

export const EMBED_TITLE = "nook-embed";

/** v1 embed kinds and their neutral words. A poll and a time poll are forms (kind `form`). */
export const EMBED_KINDS = ["poll", "form", "time_poll", "goal", "booking_type", "townhall_session"] as const;
export type EmbedKind = typeof EMBED_KINDS[number];
export const EMBED_WORDS: Record<EmbedKind, string> = {
  poll: "Poll", form: "Form", time_poll: "Time poll", goal: "Goal", booking_type: "Booking link", townhall_session: "Townhall"
};
/** The work kind each embed kind resolves to. */
export const EMBED_WORK_KIND: Record<EmbedKind, WorkKind> = {
  poll: "form", form: "form", time_poll: "form", goal: "goal", booking_type: "booking_type", townhall_session: "townhall_session"
};

const WORD_TO_KIND = new Map(Object.entries(EMBED_WORDS).map(([kind, word]) => [word, kind as EmbedKind]));
const EMBED_LINE = new RegExp(`^ {0,3}\\[([^\\]\\n]{1,40})\\]\\((/[^\\s)]{1,300}) "${EMBED_TITLE}"\\)[ \\t]*$`);

/** The Markdown line of an embed: always the neutral word, never a title. */
export const embedMarkdown = (kind: EmbedKind, path: string) => `[${EMBED_WORDS[kind]}](${path} "${EMBED_TITLE}")`;

export type ParsedEmbed = { kind: EmbedKind; path: string; ref: ParsedWorkRef | null };

/** Parses one Markdown line as an embed, or null. The path must be an in-app path. */
export function parseEmbedLine(line: string): ParsedEmbed | null {
  const match = EMBED_LINE.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
  if (!match) return null;
  const kind = WORD_TO_KIND.get(match[1]!.trim());
  const path = match[2]!;
  if (!kind) {
    // Any other text is treated as a form embed and neutralized on save (the title never stays).
    return { kind: "form", path, ref: parseWorkRef(path) };
  }
  return { kind, path, ref: parseWorkRef(path) };
}

/**
 * The same Markdown with every embed line's text replaced by its neutral word (a title typed or
 * pasted into the text never stays). Lines in fenced code are left alone. Returns the input itself
 * when nothing changes.
 */
export function neutralizeEmbeds(markdown: string): string {
  if (!markdown.includes(`"${EMBED_TITLE}")`)) return markdown;
  const lines = markdown.split("\n");
  let fence: string | null = null;
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (opener && opener[1]![0] === fence[0] && opener[1]!.length >= fence.length) fence = null; continue; }
    if (opener) { fence = opener[1]!; continue; }
    const embed = parseEmbedLine(line);
    if (!embed) continue;
    const indent = /^ {0,3}/.exec(line)![0];
    const next = `${indent}${embedMarkdown(embed.kind, embed.path)}${line.endsWith("\r") ? "\r" : ""}`;
    if (next !== line) { lines[index] = next; changed = true; }
  }
  return changed ? lines.join("\n") : markdown;
}
