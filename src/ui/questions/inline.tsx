import type { ReactNode } from "react";

/**
 * A question title's inline formatting (§B.2: **bold**, _italic_, and links only), rendered as React
 * nodes — never HTML. A link's target must be http(s) or an in-app path; anything else stays text.
 */
const TOKEN = /\*\*([^*]+)\*\*|_([^_]+)_|\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)/g;

export function inlineText(text: string, keyPrefix = "t"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyPrefix}${index++}`;
    if (match[1] !== undefined) out.push(<strong key={key}>{match[1]}</strong>);
    else if (match[2] !== undefined) out.push(<em key={key}>{match[2]}</em>);
    else {
      const href = match[4]!;
      const external = /^https?:/.test(href);
      out.push(<a key={key} href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}>{match[3]}</a>);
    }
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The plain text of a title (for accessible names and lists). */
export const plainText = (text: string) => text.replace(TOKEN, (_all, bold, italic, label) => bold ?? italic ?? label ?? "");
