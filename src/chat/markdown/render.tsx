import { Check, Copy } from "lucide-react";
import { Marked, type Token, type Tokens } from "marked";
import { memo, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { AGENT_BOUNDS } from "../../../shared/agents";
import { decodeEntities } from "./entities";
import { footnoteDef, footnoteLabels, footnoteRef, type FootnoteDefToken, type FootnoteRefToken } from "./footnotes";
import { MarkdownImage, PUBLIC_IMAGES, type ImagePolicy } from "./MarkdownImage";
import "./markdown.css";

/**
 * Agent Markdown (agent chat plan §8, D370, T303, T304): `marked` tokens are turned straight into
 * React elements. No HTML string is ever produced and raw HTML tokens render as their text. Links
 * are limited to http(s), mailto, and Nook paths. An external link shows its host and opens through
 * `onExternalLink` (a sheet with the full URL) instead of navigating. Headings render one level
 * smaller so an h1 in a message is not a page title (each level keeps its own size). No syntax
 * highlighting in v1 (AC-O13).
 *
 * GitHub-flavoured Markdown as GitHub renders comments: soft line breaks are line breaks, tables keep
 * their column alignment and scroll inside the bubble, task items are read-only boxes, ordered lists
 * keep their start number, character references (`&amp;`, `&#169;`) are decoded into text, and
 * footnotes (`[^1]`, footnotes.ts) link to their note and back.
 *
 * Images (images.ts, MarkdownImage.tsx): Nook's own access-checked image routes and small PNG, JPEG,
 * GIF, and WebP `data:` images show at once; an external image is a card that loads it through
 * Nook's image proxy only when the person clicks; SVG and anything else stay a chip. On the public
 * page (`images: { mode: "public" }`, also the default) nothing is fetched: only `data:` images show.
 *
 * A Nook path is what the browser would keep on this origin (review M1): `/\host` is read by every
 * browser as `//host`, so the href a middle click or "Copy link" uses would leave Nook. A path with a
 * backslash is text; every other `/…` is canonicalised with `new URL(path, location.origin)` and is a
 * Nook path only when that URL keeps the origin. A `mailto:` keeps the address only: its `?subject=`
 * and `?body=` (which can pre-fill a mail with a request for a password) are dropped.
 *
 * Streaming (§8): completed top-level blocks are lexed together (so loose lists and reference links
 * stay whole) and each block is memoised by its source, so a finished block never re-renders while
 * text arrives; an unclosed fence renders as an open code block. The tail is lexed at most every
 * `TAIL_LEX_MS` and the text shown live is capped at the stored message bound (review L5).
 */

export type LinkHandler = (href: string) => void;
export type RenderContext = { onExternalLink: LinkHandler; onNookLink: LinkHandler; images?: ImagePolicy };
export type { ImagePolicy } from "./MarkdownImage";

/** What every element of one message shares: the handlers, the footnote ids' prefix, and the defined footnotes. */
type Scope = { context: RenderContext; images: ImagePolicy; ids: string; notes: Map<string, number> };

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

const footnoteId = (scope: Scope, label: string) => `${scope.ids}fn-${encodeURIComponent(label)}`;
const footnoteRefId = (scope: Scope, label: string) => `${scope.ids}fnref-${encodeURIComponent(label)}`;
/** In-page jumps scroll instead of changing the URL (the app's router owns the hash-free path). */
const jumpTo = (id: string) => (event: MouseEvent) => {
  event.preventDefault();
  document.getElementById(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
};

const imageTokens = (tokens: Token[] | undefined): Tokens.Image[] => (tokens ?? []).flatMap((token) => token.type === "image" ? [token as Tokens.Image] : "tokens" in token && Array.isArray(token.tokens) ? imageTokens(token.tokens as Token[]) : []);

function inline(tokens: Token[] | undefined, scope: Scope, keyPrefix = "i"): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((token, index) => {
    const key = `${keyPrefix}${index}`;
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens ? <span key={key}>{inline(text.tokens, scope, key)}</span> : decodeEntities(text.text);
      }
      case "escape": return (token as Tokens.Escape).text;
      // A task item's box is rendered by the list (read-only); the token itself shows nothing.
      case "checkbox": return null;
      case "strong": return <strong key={key}>{inline((token as Tokens.Strong).tokens, scope, key)}</strong>;
      case "em": return <em key={key}>{inline((token as Tokens.Em).tokens, scope, key)}</em>;
      case "del": return <del key={key}>{inline((token as Tokens.Del).tokens, scope, key)}</del>;
      // Code keeps its characters as written: `&amp;` in a code span is those five characters (GFM §6.1).
      case "codespan": return <code key={key} className="chat-md-code">{(token as Tokens.Codespan).text}</code>;
      case "br": return <br key={key} />;
      case "link": return <MarkdownLink key={key} token={token as Tokens.Link} scope={scope} />;
      case "image": {
        const image = token as Tokens.Image;
        return <MarkdownImage key={key} href={image.href} alt={decodeEntities(image.text)} title={image.title} policy={scope.images} onExternalLink={scope.context.onExternalLink} />;
      }
      case "footnoteRef": {
        const { label, raw } = token as unknown as FootnoteRefToken;
        const number = scope.notes.get(label);
        if (number === undefined) return raw;
        return <sup key={key} className="chat-md-fnref"><a href={`#${footnoteId(scope, label)}`} id={footnoteRefId(scope, label)} onClick={jumpTo(footnoteId(scope, label))} aria-label={`Footnote ${number}`}>{number}</a></sup>;
      }
      case "html": return (token as Tokens.HTML).raw;
      default: return (token as Tokens.Generic).raw ?? "";
    }
  });
}

function MarkdownLink({ token, scope }: { token: Tokens.Link; scope: Scope }) {
  const { context } = scope;
  const target = classifyLink(token.href);
  // A linked image (`[![alt](src)](href)`) shows the image with its own viewer, and the link after it:
  // a button inside a link would be two controls in one.
  const images = imageTokens(token.tokens);
  const label = images.length > 0
    ? [...images.map((image, index) => <MarkdownImage key={`m${index}`} href={image.href} alt={decodeEntities(image.text)} title={image.title} policy={scope.images} onExternalLink={context.onExternalLink} />), " "]
    : inline(token.tokens, scope, "l");
  const text = images.length > 0 ? "Link" : label;
  const title = token.title ? decodeEntities(token.title) : undefined;
  if (target.kind === "external") {
    const link = <a href={target.url.toString()} className="chat-md-link" title={title} rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); context.onExternalLink(target.url.toString()); }}>{text}<span className="chat-md-link-host"> ↗ {target.url.host}</span></a>;
    return images.length > 0 ? <span className="chat-md-linked-image">{label}{link}</span> : link;
  }
  if (target.kind === "mailto") {
    const link = <a href={target.href} className="chat-md-link" title={title}>{text}</a>;
    return images.length > 0 ? <span className="chat-md-linked-image">{label}{link}</span> : link;
  }
  if (target.kind === "nook") {
    const link = <a href={target.path} className="chat-md-link" title={title} onClick={(event) => { event.preventDefault(); context.onNookLink(target.path); }}>{text}</a>;
    return images.length > 0 ? <span className="chat-md-linked-image">{label}{link}</span> : link;
  }
  return images.length > 0 ? <span className="chat-md-linked-image">{label}</span> : <span>{decodeEntities(token.text)}</span>;
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
  const lang = token.lang?.split(/\s/)[0]?.slice(0, 32) || "";
  return <div className="chat-md-pre">
    <div className="chat-md-pre-bar"><span>{lang || "code"}</span><button type="button" className="chat-md-copy" onClick={() => { void copy(); }} aria-label="Copy code">{copied ? <Check /> : <Copy />}<span>{copied ? "Copied" : "Copy"}</span></button></div>
    <pre tabIndex={0} aria-label={lang ? `${lang} code` : "Code"}><code>{token.text}</code></pre>
  </div>;
}

function listItems(list: Tokens.List, scope: Scope, keyPrefix: string) {
  return list.items.map((item, index) => {
    const key = `${keyPrefix}${index}`;
    const body = blocks(item.tokens, scope, key);
    return <li key={key} className={item.task ? "chat-md-task" : undefined}>
      {item.task && <input type="checkbox" checked={item.checked === true} readOnly disabled aria-label={item.checked ? "Done" : "Not done"} />}
      {item.task ? <span className="chat-md-task-body">{body}</span> : body}
    </li>;
  });
}

const alignOf = (align: Tokens.TableCell["align"]) => align ? { textAlign: align } : undefined;

function block(token: Token, scope: Scope, key: string): ReactNode {
  switch (token.type) {
    case "space": return null;
    case "paragraph": return <p key={key}>{inline((token as Tokens.Paragraph).tokens, scope, key)}</p>;
    case "text": {
      // A tight list item's line: inline, with no paragraph of its own.
      const text = token as Tokens.Text;
      return <span key={key} className="chat-md-line">{text.tokens ? inline(text.tokens, scope, key) : decodeEntities(text.text)}</span>;
    }
    case "checkbox": return null;
    case "heading": {
      const heading = token as Tokens.Heading;
      const level = Math.min(6, heading.depth + 1);
      const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
      // The class keeps the written level, so an h5 and an h6 (both <h6> here) still look different.
      return <Tag key={key} className={`chat-md-heading chat-md-h${heading.depth}`}>{inline(heading.tokens, scope, key)}</Tag>;
    }
    case "code": return <CodeBlock key={key} token={token as Tokens.Code} />;
    case "blockquote": return <blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, scope, key)}</blockquote>;
    case "list": {
      const list = token as Tokens.List;
      const className = list.items.length > 0 && list.items.every((item) => item.task) ? "chat-md-tasks" : undefined;
      return list.ordered
        ? <ol key={key} className={className} start={typeof list.start === "number" ? list.start : undefined}>{listItems(list, scope, key)}</ol>
        : <ul key={key} className={className}>{listItems(list, scope, key)}</ul>;
    }
    case "hr": return <hr key={key} />;
    case "table": {
      const table = token as Tokens.Table;
      // The wrapper scrolls sideways (keyboard too), so a wide table never widens the page (390 px).
      return <div key={key} className="chat-md-table" tabIndex={0} role="region" aria-label="Table"><table>
        <thead><tr>{table.header.map((cell, cellIndex) => <th key={cellIndex} scope="col" style={alignOf(cell.align)}>{inline(cell.tokens, scope, `${key}h${cellIndex}`)}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} style={alignOf(cell.align)}>{inline(cell.tokens, scope, `${key}r${rowIndex}c${cellIndex}`)}</td>)}</tr>)}</tbody>
      </table></div>;
    }
    case "footnoteDef": {
      const note = token as unknown as FootnoteDefToken;
      const number = scope.notes.get(note.label) ?? 0;
      return <div key={key} className="chat-md-footnote" id={footnoteId(scope, note.label)} role="note" aria-label={`Footnote ${number}`}>
        <span className="chat-md-footnote-number">{number}.</span>
        <span className="chat-md-footnote-text">{inline(note.tokens, scope, key)} <a href={`#${footnoteRefId(scope, note.label)}`} className="chat-md-footnote-back" onClick={jumpTo(footnoteRefId(scope, note.label))} aria-label="Back to the text">↩</a></span>
      </div>;
    }
    case "html": return <p key={key}>{(token as Tokens.HTML).raw}</p>;
    case "def": return null;
    default: return <p key={key}>{(token as Tokens.Generic).raw ?? ""}</p>;
  }
}

function blocks(tokens: Token[], scope: Scope, keyPrefix = "b"): ReactNode[] {
  return tokens.map((token, index) => block(token, scope, `${keyPrefix}${index}`));
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

const markdown = new Marked({ gfm: true, breaks: true, extensions: [footnoteDef, footnoteRef] });
/** GFM with soft breaks as line breaks (as GitHub renders comments) and footnotes. */
export const lex = (text: string): Token[] => markdown.lexer(text);

/** One finished top-level block: re-rendered only when its own source changes. */
const Block = memo(function Block({ token, scope, keyId }: { token: Token; scope: Scope; keyId: string }) {
  return <>{block(token, scope, keyId)}</>;
}, (previous, next) => previous.token.raw === next.token.raw && previous.token.type === next.token.type && previous.scope === next.scope && previous.keyId === next.keyId);

const Settled = memo(function Settled({ source, scope }: { source: string; scope: Scope }) {
  const tokens = useMemo(() => lex(source), [source]);
  return <>{tokens.map((token, index) => <Block key={`s${index}`} token={token} scope={scope} keyId={`s${index}`} />)}</>;
}, (previous, next) => previous.source === next.source && previous.scope === next.scope);

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

const Tail = memo(function Tail({ source, scope }: { source: string; scope: Scope }) {
  const tokens = useMemo(() => lex(source), [source]);
  return <>{blocks(tokens, scope, "t")}</>;
});

function useScope(context: RenderContext, text: string): Scope {
  const ids = useId().replace(/[^A-Za-z0-9_-]/g, "");
  // Footnote numbers come from the definitions in the whole text; the map is rebuilt only when they change.
  const labels = [...footnoteLabels(text).keys()].join("\u0000");
  return useMemo(() => ({
    context, images: context.images ?? PUBLIC_IMAGES, ids: `md${ids}-`,
    notes: new Map(labels ? labels.split("\u0000").map((label, index) => [label, index + 1] as const) : [])
  }), [context, ids, labels]);
}

/**
 * One component for both states, so the end of a stream keeps every finished block (and an open
 * image viewer) mounted: streaming splits off the tail; a settled message is all "settled".
 */
function MarkdownBody({ text, context, streaming }: { text: string; context: RenderContext; streaming: boolean }) {
  const shown = streaming && text.length > AGENT_BOUNDS.assistantMessageChars ? text.slice(0, AGENT_BOUNDS.assistantMessageChars) : text;
  const { settled, tail } = useMemo(() => streaming ? splitStreaming(shown) : { settled: shown, tail: "" }, [shown, streaming]);
  const throttledTail = useThrottled(tail, TAIL_LEX_MS);
  const shownTail = streaming ? throttledTail : "";
  const scope = useScope(context, shown);
  return <div className="chat-md">{settled && <Settled source={settled} scope={scope} />}{shownTail && <Tail source={shownTail} scope={scope} />}</div>;
}

/** Renders Markdown; while `streaming`, the completed prefix is memoised and only the tail re-lexes (at most every 250 ms). */
export function Markdown({ text, context, streaming = false }: { text: string; context: RenderContext; streaming?: boolean }) {
  return <MarkdownBody text={text} context={context} streaming={streaming} />;
}
