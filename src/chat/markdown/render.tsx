import { Check, Copy } from "lucide-react";
import { lexer, type Token, type Tokens } from "marked";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { AGENT_BOUNDS } from "../../../shared/agents";

/**
 * Agent Markdown (agent chat plan §8, D370, T303, T304): `marked.lexer` tokens are turned straight
 * into React elements. No HTML string is ever produced, raw HTML tokens render as their text,
 * images never load (a chip names the alt text and host), and links are limited to http(s),
 * mailto, and Nook paths. An external link shows its host and opens through `onExternalLink` (a
 * sheet with the full URL) instead of navigating. Headings render one level smaller so an h1 in a
 * message is not a page title. No syntax highlighting in v1 (AC-O13).
 *
 * A Nook path is what the browser would keep on this origin (review M1): `/\host` is read by every
 * browser as `//host`, so the href a middle click or "Copy link" uses would leave Nook. A path with a
 * backslash is text; every other `/…` is canonicalised with `new URL(path, location.origin)` and is a
 * Nook path only when that URL keeps the origin. A `mailto:` keeps the address only: its `?subject=`
 * and `?body=` (which can pre-fill a mail with a request for a password) are dropped.
 *
 * Streaming (§8): completed top-level blocks are memoised by their source (`raw`), so only the tail
 * re-renders while text arrives; an unclosed fence renders as an open code block. The tail is lexed
 * at most every `TAIL_LEX_MS` and the text shown live is capped at the stored message bound (review L5).
 */

export type LinkHandler = (href: string) => void;
export type RenderContext = { onExternalLink: LinkHandler; onNookLink: LinkHandler };

/** The origin Nook paths are resolved against: the page's, or a placeholder where there is no window (tests). */
const pageOrigin = () => (typeof location !== "undefined" && location.origin && location.origin !== "null" ? location.origin : "https://nook.invalid");

/** How often at most the streaming tail is re-lexed (review L5); the settled prefix is memoised. */
export const TAIL_LEX_MS = 250;

/** The link kinds the renderer follows: external http(s), mailto, or a Nook path; anything else is text. */
export function classifyLink(href: string, origin = pageOrigin()): { kind: "external"; url: URL } | { kind: "mailto"; href: string } | { kind: "nook"; path: string } | { kind: "text" } {
  const value = href.trim();
  if (value.startsWith("/")) {
    // `/\host`: browsers treat a backslash like a slash, so this is a protocol-relative URL in disguise.
    if (value.startsWith("//") || value.includes("\\") || /\s/.test(value)) return { kind: "text" };
    try {
      const url = new URL(value, origin);
      if (url.origin !== origin || !url.pathname.startsWith("/")) return { kind: "text" };
      return { kind: "nook", path: `${url.pathname}${url.search}${url.hash}` };
    } catch {
      return { kind: "text" };
    }
  }
  const mail = /^mailto:([^\s@?#/\\]+@[^\s@?#/\\]+)(?:[?#].*)?$/i.exec(value);
  if (mail) return { kind: "mailto", href: `mailto:${mail[1]}` };
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return { kind: "external", url };
  } catch {
    // not a URL
  }
  return { kind: "text" };
}

/** The host an image chip or link suffix shows, or null when the URL is unparsable. */
export function hostOf(href: string): string | null {
  try {
    const url = new URL(href.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

function inline(tokens: Token[] | undefined, context: RenderContext, keyPrefix = "i"): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((token, index) => {
    const key = `${keyPrefix}${index}`;
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens ? <span key={key}>{inline(text.tokens, context, key)}</span> : text.text;
      }
      case "escape": return (token as Tokens.Escape).text;
      // A task item's box is rendered by the list (read-only); the token itself shows nothing.
      case "checkbox": return null;
      case "strong": return <strong key={key}>{inline((token as Tokens.Strong).tokens, context, key)}</strong>;
      case "em": return <em key={key}>{inline((token as Tokens.Em).tokens, context, key)}</em>;
      case "del": return <del key={key}>{inline((token as Tokens.Del).tokens, context, key)}</del>;
      case "codespan": return <code key={key} className="chat-md-code">{(token as Tokens.Codespan).text}</code>;
      case "br": return <br key={key} />;
      case "link": return <MarkdownLink key={key} token={token as Tokens.Link} context={context} />;
      case "image": {
        const image = token as Tokens.Image;
        return <span key={key} className="chat-md-image" title="Images in agent replies are never loaded">🖼 {image.text || "image"}{hostOf(image.href) ? ` · ${hostOf(image.href)}` : ""}</span>;
      }
      case "html": return (token as Tokens.HTML).raw;
      default: return (token as Tokens.Generic).raw ?? "";
    }
  });
}

function MarkdownLink({ token, context }: { token: Tokens.Link; context: RenderContext }) {
  const target = classifyLink(token.href);
  const label = inline(token.tokens, context, "l");
  if (target.kind === "external") {
    return <a href={target.url.toString()} className="chat-md-link" rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); context.onExternalLink(target.url.toString()); }}>{label}<span className="chat-md-link-host"> ↗ {target.url.host}</span></a>;
  }
  if (target.kind === "mailto") return <a href={target.href} className="chat-md-link">{label}</a>;
  if (target.kind === "nook") return <a href={target.path} className="chat-md-link" onClick={(event) => { event.preventDefault(); context.onNookLink(target.path); }}>{label}</a>;
  return <span>{token.text}</span>;
}

function CodeBlock({ token }: { token: Tokens.Code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refused: the text stays selectable.
    }
  };
  return <div className="chat-md-pre">
    <div className="chat-md-pre-bar"><span>{token.lang?.split(/\s/)[0] || "code"}</span><button type="button" className="chat-md-copy" onClick={() => { void copy(); }} aria-label="Copy code">{copied ? <Check /> : <Copy />}<span>{copied ? "Copied" : "Copy"}</span></button></div>
    <pre><code>{token.text}</code></pre>
  </div>;
}

function listItems(list: Tokens.List, context: RenderContext, keyPrefix: string) {
  return list.items.map((item, index) => {
    const key = `${keyPrefix}${index}`;
    const body = blocks(item.tokens, context, key);
    return <li key={key} className={item.task ? "chat-md-task" : undefined}>
      {item.task && <input type="checkbox" checked={item.checked === true} readOnly disabled aria-label={item.checked ? "Done" : "Not done"} />}
      {item.task ? <span>{body}</span> : body}
    </li>;
  });
}

function blocks(tokens: Token[], context: RenderContext, keyPrefix = "b"): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}${index}`;
    switch (token.type) {
      case "space": return null;
      case "paragraph": return <p key={key}>{inline((token as Tokens.Paragraph).tokens, context, key)}</p>;
      case "text": {
        // A tight list item's line: inline, with no paragraph of its own.
        const text = token as Tokens.Text;
        return <span key={key} className="chat-md-line">{text.tokens ? inline(text.tokens, context, key) : text.text}</span>;
      }
      case "checkbox": return null;
      case "heading": {
        const heading = token as Tokens.Heading;
        const level = Math.min(6, heading.depth + 1);
        const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
        return <Tag key={key} className="chat-md-heading">{inline(heading.tokens, context, key)}</Tag>;
      }
      case "code": return <CodeBlock key={key} token={token as Tokens.Code} />;
      case "blockquote": return <blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, context, key)}</blockquote>;
      case "list": {
        const list = token as Tokens.List;
        return list.ordered ? <ol key={key} start={typeof list.start === "number" ? list.start : undefined}>{listItems(list, context, key)}</ol> : <ul key={key}>{listItems(list, context, key)}</ul>;
      }
      case "hr": return <hr key={key} />;
      case "table": {
        const table = token as Tokens.Table;
        return <div key={key} className="chat-md-table"><table>
          <thead><tr>{table.header.map((cell, cellIndex) => <th key={cellIndex} style={cell.align ? { textAlign: cell.align } : undefined}>{inline(cell.tokens, context, `${key}h${cellIndex}`)}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} style={cell.align ? { textAlign: cell.align } : undefined}>{inline(cell.tokens, context, `${key}r${rowIndex}c${cellIndex}`)}</td>)}</tr>)}</tbody>
        </table></div>;
      }
      case "html": return <p key={key}>{(token as Tokens.HTML).raw}</p>;
      case "def": return null;
      default: return <p key={key}>{(token as Tokens.Generic).raw ?? ""}</p>;
    }
  });
}

/** Splits streamed Markdown into completed top-level blocks and the tail still being written. */
export function splitStreaming(text: string): { settled: string; tail: string } {
  let fence = false;
  let lastBlank = -1;
  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && line.trim() === "") lastBlank = offset;
    offset += line.length + 1;
  }
  if (lastBlank < 0) return { settled: "", tail: text };
  return { settled: text.slice(0, lastBlank + 1), tail: text.slice(lastBlank + 1) };
}

export const lex = (text: string) => lexer(text, { gfm: true, breaks: false });

const Settled = memo(function Settled({ source, context }: { source: string; context: RenderContext }) {
  return <>{blocks(lex(source), context, "s")}</>;
}, (previous, next) => previous.source === next.source && previous.context === next.context);

/** The latest value at most every `intervalMs`, always ending on the last one (trailing edge). */
function useThrottled<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value);
  const lastAt = useRef(0);
  useEffect(() => {
    if (Object.is(shown, value)) return;
    const wait = Math.max(0, lastAt.current + intervalMs - Date.now());
    const timer = window.setTimeout(() => { lastAt.current = Date.now(); setShown(value); }, wait);
    return () => window.clearTimeout(timer);
  }, [value, intervalMs, shown]);
  return shown;
}

function StreamingMarkdown({ text, context }: { text: string; context: RenderContext }) {
  const { settled, tail } = splitStreaming(text.length > AGENT_BOUNDS.assistantMessageChars ? text.slice(0, AGENT_BOUNDS.assistantMessageChars) : text);
  const shownTail = useThrottled(tail, TAIL_LEX_MS);
  return <div className="chat-md">{settled && <Settled source={settled} context={context} />}{shownTail && blocks(lex(shownTail), context, "t")}</div>;
}

/** Renders Markdown; while `streaming`, the completed prefix is memoised and only the tail re-lexes (at most every 250 ms). */
export function Markdown({ text, context, streaming = false }: { text: string; context: RenderContext; streaming?: boolean }) {
  if (!streaming) return <div className="chat-md">{blocks(lex(text), context)}</div>;
  return <StreamingMarkdown text={text} context={context} />;
}
