import type { Token, TokenizerExtension, TokenizerThis } from "marked";

/**
 * GFM footnotes for the chat renderer. `marked` has no footnotes of its own (it reads `[^1]: text`
 * as a link definition and `[^1]` as a reference link to it), and the `marked-footnote` package
 * renders HTML strings, which the chat renderer never uses (D370). These two tokenizers are all the
 * renderer needs: a block `footnoteDef` (`[^label]: text`, with indented continuation lines) and
 * an inline `footnoteRef` (`[^label]`). They only produce tokens; render.tsx turns them into
 * React elements. A reference whose label has no definition renders as its literal text, as on GitHub.
 */

export type FootnoteDefToken = { type: "footnoteDef"; raw: string; label: string; text: string; tokens: Token[] };
export type FootnoteRefToken = { type: "footnoteRef"; raw: string; label: string };

const LABEL = "[^\\]\\s]{1,64}";
const DEF = new RegExp(`^\\[\\^(${LABEL})\\]:[ \\t]*([^\\n]*(?:\\n(?:[ ]{2,}|\\t)[^\\n]*)*)(?:\\n|$)`);
const DEF_START = new RegExp(`^\\[\\^${LABEL}\\]:`, "m");
const REF = new RegExp(`^\\[\\^(${LABEL})\\]`);
const DEF_LABELS = new RegExp(`^\\[\\^(${LABEL})\\]:`, "gm");

export const footnoteDef: TokenizerExtension = {
  name: "footnoteDef",
  level: "block",
  start: (src: string) => src.match(DEF_START)?.index,
  tokenizer(this: TokenizerThis, src: string) {
    const match = DEF.exec(src);
    if (!match) return undefined;
    const text = match[2]!.replace(/\n(?:[ ]{2,}|\t)/g, "\n").trim();
    const token: FootnoteDefToken = { type: "footnoteDef", raw: match[0], label: match[1]!, text, tokens: [] };
    this.lexer.inline(text, token.tokens);
    return token;
  }
};

export const footnoteRef: TokenizerExtension = {
  name: "footnoteRef",
  level: "inline",
  start: (src: string) => {
    const at = src.indexOf("[^");
    return at >= 0 ? at : undefined;
  },
  tokenizer(src: string) {
    const match = REF.exec(src);
    return match ? { type: "footnoteRef", raw: match[0], label: match[1]! } satisfies FootnoteRefToken : undefined;
  }
};

/** The defined labels of a message, in order of definition: their 1-based position is the number shown. */
export function footnoteLabels(text: string): Map<string, number> {
  const labels = new Map<string, number>();
  if (!text.includes("[^")) return labels;
  for (const match of text.matchAll(DEF_LABELS)) {
    if (!labels.has(match[1]!)) labels.set(match[1]!, labels.size + 1);
  }
  return labels;
}
