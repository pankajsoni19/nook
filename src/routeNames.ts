/**
 * The names behind friendly URLs (docs/plan/FRIENDLY_URLS.md, D773): what this tab has learned about
 * the items it loaded, so the router can write /tasks/MYT-12 or /notes/engineering/release-checklist-
 * 3f9x2ab01k for a route that holds ids, and read such a URL back to ids without a request.
 *
 * Loaders call `nameItems`, `nameBoard`, and `nameCard` whenever a list or an item arrives (and after
 * a rename). A change re-canonicalizes the address bar in place (history.replaceState, never a new
 * entry) when the current URL is not the canonical one any more: a UUID link once the item's name is
 * known, a stale slug, a renamed note, a moved card. Nothing here is persisted: a reload starts empty,
 * and a friendly URL the tab cannot name yet is resolved by its app (GET /api/links/:kind/:ref).
 */
import { whiteboardDisplayName } from "../shared/whiteboardScene";
import { normalizeBoardCode, parseCardKey } from "../shared/boardKeys";
import { isShortId, slugify, type LinkKind } from "../shared/friendlyUrls";

export type ItemKind = Exclude<LinkKind, "board">;
type ItemName = { shortId: string; slug: string; folderSlug: string | null };

const items = new Map<string, ItemName>();
const byShortId = new Map<string, string>();
const boardCodes = new Map<string, string>();
const boardsByCode = new Map<string, string>();
const cardKeys = new Map<string, string>();
const cardsByKey = new Map<string, { cardId: string; boardId: string }>();

const listeners = new Set<() => void>();
let canonicalizer: (() => void) | null = null;
let scheduled = false;
function changed() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    // The address bar first, so listeners (Tasks' entry log) read the canonical URL.
    canonicalizer?.();
    for (const listener of [...listeners]) listener();
  });
}

/** The app's address-bar canonicalizer (friendlyLinks.ts), run before the listeners on every change. */
export function setCanonicalizer(next: (() => void) | null) {
  canonicalizer = next;
}

/** Called after any name changed (batched per task); returns the unsubscribe. */
export function onRouteNames(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const itemKey = (kind: ItemKind, id: string) => `${kind}:${id.toLowerCase()}`;

let suspended = 0;
/**
 * Runs `fn` as if the tab knew no names: the router then reads and writes ids and pending links only.
 * For checks that a path is one the router itself writes (a notification's href, safePath), whatever
 * this tab happens to have loaded.
 */
export function withoutRouteNames<T>(fn: () => T): T {
  suspended += 1;
  try { return fn(); } finally { suspended -= 1; }
}

/** One item: `title` is its title or name; `folderTitle` (notes only) the folder the reader sees it in, if any. */
export type NamedItem = { id: string; short_id?: string | null; shortId?: string | null; title?: string | null; name?: string | null; folderTitle?: string | null };

/** Records items' short ids and slugs; items without a short id (an older server) are skipped. */
export function nameItems(kind: ItemKind, list: readonly (NamedItem | null | undefined)[] | null | undefined) {
  if (!Array.isArray(list)) return;
  let dirty = false;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const shortId = item.short_id ?? item.shortId ?? null;
    if (!isShortId(shortId) || !item.id) continue;
    const title = item.title ?? item.name ?? "";
    // A whiteboard's stored name ends in .excalidraw; its URL uses the name people see (D777).
    const next: ItemName = { shortId, slug: slugify(kind === "whiteboard" ? whiteboardDisplayName(title) : title), folderSlug: item.folderTitle ? slugify(item.folderTitle) || null : null };
    const key = itemKey(kind, item.id);
    const before = items.get(key);
    if (before && before.shortId === next.shortId && before.slug === next.slug && before.folderSlug === next.folderSlug) continue;
    items.set(key, next);
    byShortId.set(`${kind}:${shortId}`, item.id.toLowerCase());
    dirty = true;
  }
  if (dirty) changed();
}

/** Files and whiteboards share the documents table: each is named under its own kind. */
export function nameDocuments(list: ReadonlyArray<(NamedItem & { kind?: "file" | "whiteboard" }) | null | undefined> | null | undefined) {
  if (!Array.isArray(list)) return;
  nameItems("file", list.filter((item) => item && item.kind !== "whiteboard"));
  nameItems("whiteboard", list.filter((item) => item?.kind === "whiteboard"));
}

/** The item's URL segment, `<slug>-<shortid>` (`untitled-…` without a title), or null when unknown. */
export function itemSegment(kind: ItemKind, id: string): string | null {
  if (suspended) return null;
  const name = items.get(itemKey(kind, id));
  return name ? `${name.slug || "untitled"}-${name.shortId}` : null;
}

/** A note's folder slug, when the reader sees it in a named folder. */
export function itemFolderSlug(kind: ItemKind, id: string): string | null {
  return suspended ? null : items.get(itemKey(kind, id))?.folderSlug ?? null;
}

export const itemIdForShortId = (kind: ItemKind, shortId: string): string | null => suspended ? null : byShortId.get(`${kind}:${shortId.toLowerCase()}`) ?? null;

/** A board's current code; `alias` records a former code that still names it (D714) without changing the current one. */
export function nameBoard(boardId: string, code: string | null | undefined, options: { alias?: boolean } = {}) {
  const normalized = code ? normalizeBoardCode(code) : null;
  if (!normalized || !boardId) return;
  const id = boardId.toLowerCase();
  const knownBoard = boardsByCode.get(normalized) === id;
  if (options.alias) {
    if (!knownBoard) { boardsByCode.set(normalized, id); changed(); }
    return;
  }
  if (boardCodes.get(id) === normalized && knownBoard) return;
  boardCodes.set(id, normalized);
  boardsByCode.set(normalized, id);
  changed();
}

export const boardCodeOf = (boardId: string): string | null => suspended ? null : boardCodes.get(boardId.toLowerCase()) ?? null;
export const boardIdForCode = (code: string): string | null => {
  const normalized = suspended ? null : normalizeBoardCode(code);
  return normalized ? boardsByCode.get(normalized) ?? null : null;
};

/** A card's current key and board; `alias` records an old key (a former code, a board it left, D715). */
export function nameCard(cardId: string, key: string | null | undefined, boardId: string, options: { alias?: boolean } = {}) {
  const parsed = key ? parseCardKey(key) : null;
  if (!parsed || !cardId || !boardId) return;
  const normalized = `${parsed.code}-${parsed.number}`;
  const id = cardId.toLowerCase();
  const board = boardId.toLowerCase();
  const known = cardsByKey.get(normalized);
  const sameKey = known?.cardId === id && known.boardId === board;
  if (options.alias) {
    if (!sameKey) { cardsByKey.set(normalized, { cardId: id, boardId: board }); changed(); }
    return;
  }
  if (cardKeys.get(id) === normalized && sameKey) return;
  cardKeys.set(id, normalized);
  cardsByKey.set(normalized, { cardId: id, boardId: board });
  changed();
}

export const cardKeyOf = (cardId: string): string | null => suspended ? null : cardKeys.get(cardId.toLowerCase()) ?? null;
export function cardForKey(key: string): { cardId: string; boardId: string } | null {
  const parsed = suspended ? null : parseCardKey(key);
  return parsed ? cardsByKey.get(`${parsed.code}-${parsed.number}`) ?? null : null;
}

/** Forgets everything (sign-out, another account, tests). */
export function clearRouteNames() {
  items.clear();
  byShortId.clear();
  boardCodes.clear();
  boardsByCode.clear();
  cardKeys.clear();
  cardsByKey.clear();
}
