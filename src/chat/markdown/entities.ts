/**
 * HTML character references in agent Markdown (GFM §6.2): `marked` keeps `&amp;`, `&copy;`, and
 * `&#169;` as written, because its own renderer emits HTML. The chat renderer makes React text, so
 * it decodes them itself, into text only: the result is never parsed as HTML. Numeric references
 * decode to any valid code point except NUL and surrogates (which become U+FFFD, as the spec says);
 * named references cover the common set, and any other name stays as written.
 */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  times: "×", divide: "÷", deg: "°", plusmn: "±", middot: "·", bull: "•", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", lArr: "⇐", rArr: "⇒", hArr: "⇔",
  le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞", minus: "−", frac12: "½", frac14: "¼", frac34: "¾",
  sup2: "²", sup3: "³", micro: "µ", alpha: "α", beta: "β", gamma: "γ", delta: "δ", pi: "π", sigma: "σ", omega: "ω",
  Delta: "Δ", Sigma: "Σ", Omega: "Ω", check: "✓", cross: "✗", star: "☆", hearts: "♥", iexcl: "¡", iquest: "¿",
  ensp: " ", emsp: " ", thinsp: " ", zwj: "‍", zwnj: "‌", shy: "­", dagger: "†", Dagger: "‡",
  permil: "‰", prime: "′", Prime: "″", oline: "‾", frasl: "⁄", lowast: "∗", sum: "∑", prod: "∏", radic: "√", part: "∂"
};

const REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

function fromCodePoint(value: number): string {
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "�";
  return String.fromCodePoint(value);
}

/** `text` with its character references decoded; the result is text, never HTML. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(REFERENCE, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10));
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
    return name !== undefined && Object.hasOwn(NAMED, name) ? NAMED[name]! : whole;
  });
}
