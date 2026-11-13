/**
 * Board codes and card keys (lane KEYS, docs/plan/TASK_KEYS.md, D710–D713). A board's code is 2–10
 * characters, A–Z and 0–9, starting with a letter ("MYT"); a card's key is the code, a hyphen, and
 * the card's number on its board ("MYT-12"). Codes compare without case; they are stored and shown
 * in upper case. Shared by the server (validation, the migration's backfill) and the app (the New
 * board suggestion, the short-link route).
 */
export const BOARD_CODE_MIN = 2;
export const BOARD_CODE_MAX = 10;
/** A stored code: upper case. */
export const BOARD_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
/** A card key as typed or linked: any case, a number from 1 with no leading zero, at most 9 digits. */
export const CARD_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]{0,8})$/;

export const boardCodeMessage = `Use ${BOARD_CODE_MIN} to ${BOARD_CODE_MAX} letters or digits, starting with a letter`;

/** The code as stored (trimmed, upper case), or null when it is not a valid code. */
export function normalizeBoardCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return BOARD_CODE_PATTERN.test(code) ? code : null;
}

/** "MYT-12" from a code and a number, or null when either is missing (an older server). */
export function cardKey(code: string | null | undefined, number: number | null | undefined): string | null {
  return code && number ? `${code}-${number}` : null;
}

/** `{ code, number }` of a key in any case ("myt-12" → MYT, 12), or null. */
export function parseCardKey(value: string): { code: string; number: number } | null {
  const match = CARD_KEY_PATTERN.exec(value.trim());
  return match ? { code: match[1]!.toUpperCase(), number: Number(match[2]) } : null;
}

/** ASCII letters and digits of each word, accents folded ("Café plans" → ["CAFE", "PLANS"]). */
function words(name: string) {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

/**
 * The code a board name suggests (D711): one word gives its first three characters ("Roadmap" →
 * ROA), two words the first two of the first and the first of the second ("My tasks" → MYT), three
 * or more their initials, at most four ("Q3 launch plan" → QLP).
 * Leading digits are dropped so the code starts with a letter; a name with no letters suggests BRD.
 */
export function suggestBoardCode(name: string): string {
  const parts = words(name);
  // The first part must start with a letter: drop leading digits, and parts that are only digits.
  while (parts.length && !/^[A-Z]/.test(parts[0]!)) {
    const trimmed = parts[0]!.replace(/^[0-9]+/, "");
    if (trimmed) parts[0] = trimmed;
    else parts.shift();
  }
  let code = "";
  if (parts.length === 1) code = parts[0]!.slice(0, 3);
  else if (parts.length === 2) code = parts[0]!.slice(0, 2) + parts[1]!.slice(0, 1);
  else if (parts.length > 2) code = parts.slice(0, 4).map((part) => part[0]).join("");
  // "X" → XBR; no letters at all → BRD.
  if (code.length < BOARD_CODE_MIN) code = `${code}BRD`.slice(0, 3);
  return code.slice(0, BOARD_CODE_MAX);
}

/**
 * The first of `base`, `base2`, `base3`, … that `taken` does not hold (upper case), trimming the base
 * so the code stays within 10 characters (D711: a suggestion never collides).
 */
export function uniqueBoardCode(base: string, taken: (code: string) => boolean): string {
  const start = normalizeBoardCode(base) ?? "BRD";
  if (!taken(start)) return start;
  for (let suffix = 2; ; suffix += 1) {
    const tail = String(suffix);
    const code = start.slice(0, BOARD_CODE_MAX - tail.length) + tail;
    if (!taken(code)) return code;
  }
}
