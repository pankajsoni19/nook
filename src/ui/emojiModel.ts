// Pure logic for EmojiPicker: search over the curated names, the recently-used row kept in
// localStorage (every read and write may fail: a private window, blocked site data), and the grid's
// arrow-key moves across sections that each start on a new row.
import { EMOJI_CATEGORIES, type Emoji } from "./emojiData";

export const EMOJI_RECENT_KEY = "mynotes.emoji.recent";
export const EMOJI_RECENT_MAX = 16;
/** The agent icon's limit (server: z.string().max(16)); every pick fits it. */
export const EMOJI_MAX_LENGTH = 16;

const byGlyph = new Map<string, Emoji>();
for (const category of EMOJI_CATEGORIES) for (const emoji of category.emoji) if (!byGlyph.has(emoji.glyph)) byGlyph.set(emoji.glyph, emoji);

/** The catalog entry for a glyph (ignoring a missing or extra U+FE0F), or undefined for one typed in. */
export function findEmoji(glyph: string): Emoji | undefined {
  return byGlyph.get(glyph) ?? byGlyph.get(glyph.replace(/️/g, "")) ?? byGlyph.get(`${glyph}️`);
}

/** A short accessible name: the catalog name, else the glyph itself. */
export const emojiLabel = (glyph: string) => findEmoji(glyph)?.name ?? glyph;

/**
 * The emoji whose name or search words contain every word of `query` (case-insensitive), names
 * that start with the query first. An empty query returns nothing (the caller shows the categories).
 */
export function searchEmoji(query: string, categories = EMOJI_CATEGORIES): Emoji[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const seen = new Set<string>();
  const first: Emoji[] = [];
  const rest: Emoji[] = [];
  for (const category of categories) for (const emoji of category.emoji) {
    if (seen.has(emoji.glyph)) continue;
    const haystack = `${emoji.name} ${emoji.keywords}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word)) && emoji.glyph !== query.trim()) continue;
    seen.add(emoji.glyph);
    (emoji.name.toLowerCase().startsWith(words[0]!) ? first : rest).push(emoji);
  }
  return [...first, ...rest];
}

type RecentStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): RecentStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const isRecentEntry = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= EMOJI_MAX_LENGTH && findEmoji(value) !== undefined;

/** The recently-picked glyphs, newest first; empty when storage is unavailable or holds junk. */
export function readRecentEmoji(storage: RecentStorage | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(EMOJI_RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? [...new Set(parsed.filter(isRecentEntry))].slice(0, EMOJI_RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** `glyph` moved to the front of the recent list (deduplicated, capped), saved when storage allows. Returns the new list either way. */
export function rememberRecentEmoji(glyph: string, storage: RecentStorage | null = defaultStorage(), current = readRecentEmoji(storage)): string[] {
  const next = isRecentEntry(glyph) ? [glyph, ...current.filter((item) => item !== glyph)].slice(0, EMOJI_RECENT_MAX) : current;
  if (storage && next !== current) {
    try { storage.setItem(EMOJI_RECENT_KEY, JSON.stringify(next)); } catch { /* Quota or blocked storage: the list lives for this session only. */ }
  }
  return next;
}

/** The sections the picker shows: search results, or Recent (when any) then every category. */
export type EmojiSection = { id: string; label: string; emoji: Emoji[] };

export function emojiSections(query: string, recent: readonly string[]): EmojiSection[] {
  if (query.trim()) return [{ id: "results", label: "Results", emoji: searchEmoji(query) }];
  const recentEmoji = recent.map(findEmoji).filter((emoji): emoji is Emoji => emoji !== undefined);
  return [
    ...(recentEmoji.length > 0 ? [{ id: "recent", label: "Recently used", emoji: recentEmoji }] : []),
    ...EMOJI_CATEGORIES.map((category) => ({ id: category.id, label: category.label, emoji: category.emoji }))
  ];
}

/**
 * The focused cell after an arrow, Home, or End key in a grid of `columns` whose sections each
 * start a new row (`sizes` are the section lengths; cells are numbered across them). Up and Down
 * keep the column, clamped to a shorter row. Null for any other key.
 */
export function emojiGridMove(sizes: readonly number[], columns: number, from: number, key: string): number | null {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total === 0 || columns <= 0) return null;
  const rows: Array<{ start: number; length: number }> = [];
  let start = 0;
  for (const size of sizes) {
    for (let offset = 0; offset < size; offset += columns) rows.push({ start: start + offset, length: Math.min(columns, size - offset) });
    start += size;
  }
  const at = Math.min(Math.max(from, 0), total - 1);
  const row = rows.findIndex((item) => at >= item.start && at < item.start + item.length);
  const column = at - rows[row]!.start;
  const toRow = (index: number) => rows[index]!.start + Math.min(column, rows[index]!.length - 1);
  switch (key) {
    case "ArrowRight": return Math.min(at + 1, total - 1);
    case "ArrowLeft": return Math.max(at - 1, 0);
    case "ArrowDown": return row + 1 < rows.length ? toRow(row + 1) : at;
    case "ArrowUp": return row > 0 ? toRow(row - 1) : at;
    case "Home": return 0;
    case "End": return total - 1;
    default: return null;
  }
}
