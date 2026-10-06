import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { EMOJI_CATEGORIES } from "../src/ui/emojiData";
import { EMOJI_MAX_LENGTH, EMOJI_RECENT_KEY, EMOJI_RECENT_MAX, emojiGridMove, emojiLabel, emojiSections, findEmoji, readRecentEmoji, rememberRecentEmoji, searchEmoji } from "../src/ui/emojiModel";
import { EmojiPicker, EmojiPickerPanel } from "../src/ui/EmojiPicker";

/** The agent editor's emoji picker (src/ui/EmojiPicker.tsx): catalog, search, recent list, grid keys, markup. */
const noop = () => undefined;

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
const failing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); } };

describe("catalog", () => {
  test("a few hundred emoji in the eight categories, each unique, named, and within the icon limit", () => {
    expect(EMOJI_CATEGORIES.map((category) => category.label)).toEqual(["Smileys", "People", "Animals & nature", "Food", "Activities", "Travel", "Objects", "Symbols"]);
    const all = EMOJI_CATEGORIES.flatMap((category) => category.emoji);
    expect(all.length).toBeGreaterThan(300);
    expect(new Set(all.map((emoji) => emoji.glyph)).size).toBe(all.length);
    for (const emoji of all) {
      expect(emoji.glyph.length).toBeGreaterThan(0);
      expect(emoji.glyph.length).toBeLessThanOrEqual(EMOJI_MAX_LENGTH);
      expect(emoji.glyph).not.toMatch(/[a-z\s;]/);
      expect(emoji.name).toMatch(/^[a-z0-9]/);
    }
    for (const category of EMOJI_CATEGORIES) expect(category.emoji.some((emoji) => emoji.glyph === category.icon)).toBe(true);
  });

  test("names for labels; a typed emoji outside the catalog labels as itself", () => {
    expect(emojiLabel("🤖")).toBe("robot");
    expect(findEmoji("❤")?.glyph).toBe("❤️");
    expect(emojiLabel("🫠")).toBe("🫠");
  });
});

describe("search", () => {
  test("every word must match a name or search word, names starting with the query first", () => {
    expect(searchEmoji("")).toEqual([]);
    expect(searchEmoji("   ")).toEqual([]);
    const robot = searchEmoji("robot").map((emoji) => emoji.glyph);
    expect(robot[0]).toBe("🤖");
    expect(searchEmoji("BOT").map((emoji) => emoji.glyph)).toContain("🤖");
    const cats = searchEmoji("cat").map((emoji) => emoji.name);
    expect(cats.slice(0, 2).every((name) => name.startsWith("cat"))).toBe(true);
    expect(searchEmoji("red heart").map((emoji) => emoji.glyph)).toEqual(["❤️"]);
    expect(searchEmoji("zzzzqx")).toEqual([]);
    expect(searchEmoji("🚀").map((emoji) => emoji.glyph)).toEqual(["🚀"]);
  });

  test("a query shows only results; none shows Recent (when any) then the categories", () => {
    expect(emojiSections("rocket", []).map((section) => section.id)).toEqual(["results"]);
    expect(emojiSections("", []).map((section) => section.id)).toEqual(EMOJI_CATEGORIES.map((category) => category.id));
    const withRecent = emojiSections("", ["🚀", "not-an-emoji", "🤖"]);
    expect(withRecent[0]).toMatchObject({ id: "recent", label: "Recently used" });
    expect(withRecent[0]!.emoji.map((emoji) => emoji.glyph)).toEqual(["🚀", "🤖"]);
  });
});

describe("recently used", () => {
  test("newest first, deduplicated, capped, and saved", () => {
    const storage = memoryStorage();
    expect(readRecentEmoji(storage)).toEqual([]);
    rememberRecentEmoji("🚀", storage);
    rememberRecentEmoji("🤖", storage);
    expect(rememberRecentEmoji("🚀", storage)).toEqual(["🚀", "🤖"]);
    expect(JSON.parse(storage.data.get(EMOJI_RECENT_KEY)!)).toEqual(["🚀", "🤖"]);
    const many = EMOJI_CATEGORIES[0]!.emoji.slice(0, EMOJI_RECENT_MAX + 4).map((emoji) => emoji.glyph);
    for (const glyph of many) rememberRecentEmoji(glyph, storage);
    expect(readRecentEmoji(storage)).toHaveLength(EMOJI_RECENT_MAX);
    expect(readRecentEmoji(storage)[0]).toBe(many.at(-1)!);
  });

  test("junk in storage reads as empty or is filtered; a non-catalog glyph is not remembered", () => {
    expect(readRecentEmoji(memoryStorage({ [EMOJI_RECENT_KEY]: "{not json" }))).toEqual([]);
    expect(readRecentEmoji(memoryStorage({ [EMOJI_RECENT_KEY]: "{\"a\":1}" }))).toEqual([]);
    expect(readRecentEmoji(memoryStorage({ [EMOJI_RECENT_KEY]: JSON.stringify([1, "🚀", "<b>x</b>", "🚀", "x".repeat(40)]) }))).toEqual(["🚀"]);
    const storage = memoryStorage();
    expect(rememberRecentEmoji("<img>", storage)).toEqual([]);
    expect(storage.data.size).toBe(0);
  });

  test("storage that throws on read and write still yields a working list for the session", () => {
    expect(readRecentEmoji(failing)).toEqual([]);
    expect(rememberRecentEmoji("🚀", failing)).toEqual(["🚀"]);
    expect(rememberRecentEmoji("🤖", failing, ["🚀"])).toEqual(["🤖", "🚀"]);
    expect(readRecentEmoji(null)).toEqual([]);
    expect(rememberRecentEmoji("🚀", null)).toEqual(["🚀"]);
  });
});

describe("grid keys", () => {
  // Two sections of 10 and 3 at 4 columns: rows [0-3] [4-7] [8-9] | [10-12].
  const sizes = [10, 3];
  test("arrows move by cell and by row, keeping the column and clamping to a short row", () => {
    expect(emojiGridMove(sizes, 4, 0, "ArrowRight")).toBe(1);
    expect(emojiGridMove(sizes, 4, 0, "ArrowLeft")).toBe(0);
    expect(emojiGridMove(sizes, 4, 9, "ArrowRight")).toBe(10);
    expect(emojiGridMove(sizes, 4, 12, "ArrowRight")).toBe(12);
    expect(emojiGridMove(sizes, 4, 1, "ArrowDown")).toBe(5);
    expect(emojiGridMove(sizes, 4, 7, "ArrowDown")).toBe(9);
    expect(emojiGridMove(sizes, 4, 9, "ArrowDown")).toBe(11);
    expect(emojiGridMove(sizes, 4, 11, "ArrowDown")).toBe(11);
    expect(emojiGridMove(sizes, 4, 12, "ArrowUp")).toBe(9);
    expect(emojiGridMove(sizes, 4, 2, "ArrowUp")).toBe(2);
    expect(emojiGridMove(sizes, 4, 6, "Home")).toBe(0);
    expect(emojiGridMove(sizes, 4, 6, "End")).toBe(12);
    expect(emojiGridMove(sizes, 4, 6, "Enter")).toBeNull();
    expect(emojiGridMove([0, 0], 4, 0, "ArrowDown")).toBeNull();
    expect(emojiGridMove([0, 5, 0, 2], 4, 4, "ArrowDown")).toBe(5);
  });
});

describe("markup", () => {
  test("the trigger is a labelled button naming the current emoji; the picker renders only when open", () => {
    const set = renderToStaticMarkup(<EmojiPicker value="🚀" onChange={noop} label="Agent emoji" placeholder="🤖" />);
    expect(set).toContain('aria-haspopup="dialog" aria-expanded="false" aria-label="Agent emoji: rocket. Choose an emoji"');
    expect(set).toContain(">🚀</span>");
    expect(set).not.toContain("emoji-picker-cell");
    const empty = renderToStaticMarkup(<EmojiPicker value="" onChange={noop} label="Agent emoji" placeholder="🤖" />);
    expect(empty).toContain('aria-label="Agent emoji: none. Choose an emoji"');
    expect(empty).toContain('class="emoji-picker-placeholder" aria-hidden="true">🤖');
  });

  test("the sheet has search, category jumps, named cells with the current one pressed, and Remove", () => {
    const ref = { current: null };
    const markup = renderToStaticMarkup(<EmojiPickerPanel value="🤖" sheet anchorRef={ref} containerRef={ref} title="Choose agent emoji" onPick={noop} onClose={noop} />);
    expect(markup).toContain('role="dialog" aria-modal="true" aria-label="Choose agent emoji"');
    expect(markup).toContain('aria-label="Search emoji"');
    expect(markup).toContain('aria-label="Animals &amp; nature"');
    expect(markup).toContain('aria-label="robot" title="robot" aria-pressed="true"');
    expect(markup).toContain('aria-label="rocket" title="rocket" aria-pressed="false"');
    expect(markup).toContain("Remove emoji");
    // One tab stop in the grid: the current emoji.
    expect(markup.match(/emoji-picker-cell" tabindex="0"/g)).toHaveLength(1);
    const blank = renderToStaticMarkup(<EmojiPickerPanel value="" sheet anchorRef={ref} containerRef={ref} title="Choose agent emoji" onPick={noop} onClose={noop} />);
    expect(blank).not.toContain("Remove emoji");
  });

  test("the agent editor uses the picker and keeps the typed field with its limit (D91: no native select)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "chat", "AgentsSettings.tsx"), "utf8");
    expect(source).toContain('<EmojiPicker value={icon} onChange={setIcon} label="Agent emoji"');
    expect(source).toContain('maxLength={16} autoComplete="off" placeholder="🤖" className="agents-icon-input"');
    const picker = readFileSync(join(import.meta.dir, "..", "src", "ui", "EmojiPicker.tsx"), "utf8");
    expect(picker).not.toMatch(/<select|window\.confirm|localStorage/);
  });
});
