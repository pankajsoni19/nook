/**
 * Friendly URLs on the server (docs/plan/FRIENDLY_URLS.md, D770–D789); the path builders are in
 * friendlyPaths.ts.
 *
 * - `GET /api/links/:kind/:ref`, the generic resolver the app calls for a friendly URL it has no name
 *   for yet: the item's id (and its current title or code, which the app needs to write the canonical
 *   URL) only when the caller can read it now; anything else, unknown, binned, or unreadable alike, is
 *   the same 404 with no title (T490).
 */
import { whiteboardDisplayName } from "../shared/whiteboardScene";
import type { Hono } from "hono";
import type { AppEnv } from "./auth";
import { db } from "./db";
import { readableNote } from "./access";
import { readableDocumentSummary } from "./documentAccess";
import { readableCollection } from "./collections/access";
import { readableReport } from "./reports/access";
import { readableBoard } from "./tasks/access";
import { boardIdForCode } from "./tasks/keys";
import { readableWhiteboard } from "./whiteboards/service";
import { normalizeBoardCode } from "../shared/boardKeys";
import { isLinkKind, shortIdOfSegment, type LinkKind } from "../shared/friendlyUrls";

export type ResolvedLink = { id: string; title?: string; code?: string };

const byShortId = (table: string, column = "title") => (shortId: string) =>
  db.query(`SELECT id, ${column} AS title FROM ${table} WHERE short_id = ?`).get(shortId) as { id: string; title: string } | null;
const noteRow = byShortId("notes");
const documentRow = byShortId("documents", "name");
const collectionRow = byShortId("collections", "name");
const reportRow = byShortId("reports");

/**
 * What a friendly URL's reference names, if `userId` can read it now (D775, T490). `ref` is a short
 * id, a whole `<slug>-<shortid>` segment, or (for `board`) a board code, current or former (D714).
 * Every miss, whatever the reason, is null, and the title is read only after the access check.
 */
export function resolveLinkRef(kind: LinkKind, ref: string, userId: string): ResolvedLink | null {
  if (kind === "board") {
    const code = normalizeBoardCode(ref);
    const boardId = code ? boardIdForCode(code) : null;
    const board = boardId ? readableBoard(boardId, userId) : null;
    if (!board) return null;
    const current = (db.query("SELECT code FROM boards WHERE id = ?").get(board.id) as { code: string | null } | null)?.code ?? null;
    return { id: board.id, ...(current ? { code: current } : {}) };
  }
  const shortId = shortIdOfSegment(ref);
  if (!shortId) return null;
  if (kind === "note") {
    const row = noteRow(shortId);
    const note = row ? readableNote(row.id, userId) : null;
    return note ? { id: note.id, title: note.title } : null;
  }
  if (kind === "file" || kind === "whiteboard") {
    const row = documentRow(shortId);
    if (!row) return null;
    if (kind === "whiteboard") {
      const board = readableWhiteboard(row.id, userId);
      return board ? { id: board.id, title: whiteboardDisplayName(board.name) } : null;
    }
    const document = readableDocumentSummary(row.id, userId);
    return document && document.kind !== "whiteboard" ? { id: document.id, title: document.name } : null;
  }
  if (kind === "collection") {
    const row = collectionRow(shortId);
    const collection = row ? readableCollection(row.id, userId) : null;
    return collection ? { id: collection.id, title: collection.name } : null;
  }
  const row = reportRow(shortId);
  if (!row) return null;
  try {
    const report = readableReport(row.id, userId);
    return { id: report.id, title: report.title };
  } catch {
    return null;
  }
}

/** A ref the resolver accepts: a board code, or a segment carrying a short id; at most 200 characters. */
const REF = /^[A-Za-z0-9._~%-]{1,200}$/;

export function registerLinkRoutes(app: Hono<AppEnv>) {
  // D775: one resolver for every kind, so the app's router needs no per-module lookups. A miss is 404
  // whatever the reason (unknown, binned, unreadable, malformed), with nothing about the item (T490).
  app.get("/api/links/:kind/:ref", (c) => {
    const kind = c.req.param("kind");
    const ref = c.req.param("ref");
    const found = isLinkKind(kind) && REF.test(ref) ? resolveLinkRef(kind, ref, c.get("user").id) : null;
    c.header("Cache-Control", "no-store");
    return found ? c.json(found) : c.json({ error: "Not found" }, 404);
  });
}
