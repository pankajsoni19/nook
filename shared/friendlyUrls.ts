/**
 * Friendly, shareable URLs (docs/plan/FRIENDLY_URLS.md, D770–D789). An item a person would share gets
 * a URL segment `<title-slug>-<shortid>` (/notes/engineering/release-checklist-3f9x2ab01k): the short
 * id is authoritative and random; the slug is cosmetic, so a stale or wrong slug still opens the item
 * and the app replaces the URL with the current one. Shared by the server (links in mail, MCP, Inbox;
 * the migration's backfill) and the app (the router).
 */

/**
 * Short ids are 10 characters of lowercase base36, the first a digit (10 × 36^9 ≈ 10^15), unique per
 * table (D771). The leading digit tells a short id from a word ("objectives" is never one).
 */
export const SHORT_ID_LENGTH = 10;
export const SHORT_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const SHORT_ID = /^[0-9][0-9a-z]{9}$/;
const TRAILING_SHORT_ID = /-([0-9][0-9a-z]{9})$/;

export const isShortId = (value: unknown): value is string => typeof value === "string" && SHORT_ID.test(value);

/** A fresh short id from a CSPRNG (rejection sampling keeps every character equally likely). */
export function newShortId(): string {
  let out = "";
  while (out.length < SHORT_ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (out.length === 0) { if (byte < 250) out += SHORT_ID_ALPHABET[byte % 10]; }
      else if (byte < 252 && out.length < SHORT_ID_LENGTH) out += SHORT_ID_ALPHABET[byte % 36];
    }
  }
  return out;
}

/** The longest slug (D772): titles are cut at a dash boundary where one is near. */
export const SLUG_MAX = 60;

// Letters NFKD does not decompose into ASCII (D772: "transliteration where easy").
const TRANSLITERATE: Record<string, string> = {
  ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ð: "d", þ: "th", ł: "l", ħ: "h", ı: "i", ŀ: "l", ŧ: "t", ĸ: "k", ŉ: "n", ſ: "s", "&": " and "
};

/**
 * A URL slug (D772): lower case, accents folded to ASCII (Café → cafe, Straße → strasse), every run of
 * anything else (other scripts, punctuation, emoji) one dash, no leading or trailing dash, at most
 * SLUG_MAX characters. Letters without an ASCII form are dropped, always the same way, so a title in
 * another script slugs to "" and the item uses the fallback ("untitled").
 */
export function slugify(text: string | null | undefined, max = SLUG_MAX): string {
  if (!text) return "";
  const folded = text.toLowerCase().replace(/[ßæœøđðþłħıŀŧĸŉſ&]/g, (letter) => TRANSLITERATE[letter] ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const slug = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const dash = cut.lastIndexOf("-");
  return (dash >= max / 2 ? cut.slice(0, dash) : cut).replace(/-+$/g, "");
}

/** An item's URL segment: `release-checklist-3f9x2ab01k`, or `untitled-3f9x2ab01k` for a title that slugs to nothing. */
export function slugSegment(title: string | null | undefined, shortId: string): string {
  return `${slugify(title) || "untitled"}-${shortId}`;
}

/**
 * The short id a URL segment carries (any case): the part after its last dash when that is a short id
 * (`release-checklist-3f9x2ab01k`), or the whole segment when it is a bare short id. Null otherwise; a
 * word ("objectives") or a UUID is never a short id.
 */
export function shortIdOfSegment(segment: string | null | undefined): string | null {
  if (!segment) return null;
  let text: string;
  try { text = decodeURIComponent(segment).toLowerCase(); } catch { return null; }
  const trailing = TRAILING_SHORT_ID.exec(text);
  if (trailing) return trailing[1]!;
  return SHORT_ID.test(text) ? text : null;
}

/** The kinds the generic resolver (GET /api/links/:kind/:ref) and the app's name registry know (D775). */
export const LINK_KINDS = ["note", "file", "whiteboard", "collection", "report", "board"] as const;
export type LinkKind = typeof LINK_KINDS[number];
export const isLinkKind = (value: unknown): value is LinkKind => typeof value === "string" && (LINK_KINDS as readonly string[]).includes(value);

/** The app path of an item by kind and segment (no folder for notes: the server cannot know which folders the reader sees, D776). */
export function itemPath(kind: Exclude<LinkKind, "board">, title: string | null | undefined, shortId: string): string {
  const base = kind === "note" ? "/notes" : kind === "file" ? "/files" : kind === "whiteboard" ? "/whiteboards" : kind === "collection" ? "/collections" : "/reports";
  return `${base}/${slugSegment(title, shortId)}`;
}
