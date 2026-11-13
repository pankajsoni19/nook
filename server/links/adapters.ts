import { db } from "../db";
import { noteLevel, readableNote } from "../access";
import { readableDocument } from "../documentAccess";
import { boardLevel, readableBoard, readableCard } from "../tasks/access";
import { calendarLevel, readableCalendar, readableEvent } from "../calendar/access";
import { collectionLevel, readableCollection, readableRow } from "../collections/access";
import { readableReport, reportLevel } from "../reports/access";
import { boardPath, cardPath, collectionPath, collectionRowPath, documentPath, notePath, reportPath, sprintsPath, whiteboardPath } from "../friendlyPaths";
import { cardIdForKey } from "../tasks/keys";
import { cardKey } from "../../shared/boardKeys";
import { WORK_KIND_ICONS, type ParsedWorkRef, type WorkKind, type WorkSummary } from "../../shared/workRefs";
import type { ItemLevel } from "../access/levels";
import type { ItemKind } from "../keyResources";
import type { McpScope } from "../mcpScopes";

/**
 * Work kind adapters (docs/plan/WORKSPACE_MODULES.md §B.4.2, D804): how the link resolver reads an
 * item of each kind for a viewer. W1 registers the existing kinds here; each lane registers its own
 * (`registerWorkKind`). An adapter never returns a summary of an item the viewer cannot read (null:
 * missing, binned, or unreadable look the same, T501).
 */

export type Viewer = { userId: string };

export type WorkKindAdapter = {
  kind: WorkKind;
  /** Summaries of readable items; null for anything else. */
  resolve: (ids: readonly string[], viewer: Viewer) => Map<string, WorkSummary | null>;
  /** The viewer's level on the item, for the link rules (edit on side A, read on side B). */
  level: (id: string, viewer: Viewer) => ItemLevel;
  /** A short id, card key, or board code → the item's id (no access check; `resolve` does that). */
  lookup?: (ref: ParsedWorkRef) => string | null;
  /** The key grant item kind (chosen-item keys) and the module scopes of MCP's cross-module tools. */
  itemKind?: ItemKind;
  scopes: { read: McpScope; write: McpScope };
};

const adapters = new Map<WorkKind, WorkKindAdapter>();

export function registerWorkKind(adapter: WorkKindAdapter) {
  if (adapters.has(adapter.kind)) throw new Error(`Work kind ${adapter.kind} is already registered`);
  adapters.set(adapter.kind, adapter);
  return () => { if (adapters.get(adapter.kind) === adapter) adapters.delete(adapter.kind); };
}

export const workKindAdapter = (kind: string) => adapters.get(kind as WorkKind) ?? null;
export const registeredWorkKinds = () => [...adapters.keys()];

/** One-at-a-time resolve helper for adapters built from a single-item reader. */
export const each = (read: (id: string, viewer: Viewer) => WorkSummary | null) => (ids: readonly string[], viewer: Viewer) => new Map(ids.map((id) => [id, read(id, viewer)]));

const byShortId = (table: string, column = "id") => (ref: ParsedWorkRef) => ref.by === "id" ? ref.ref
  : ref.by === "short_id" ? (db.query(`SELECT ${column} AS id FROM ${table} WHERE short_id = ?`).get(ref.ref) as { id: string } | null)?.id ?? null : null;

const noteTitle = (noteId: string, ownerId: string, userId: string, draftTitle: string, version: number) => ownerId === userId
  ? draftTitle || "Untitled"
  : (db.query("SELECT title FROM note_versions WHERE note_id = ? AND version_number = ?").get(noteId, version) as { title: string } | null)?.title || "Untitled";

registerWorkKind({
  kind: "card", itemKind: "card", scopes: { read: "tasks:read", write: "tasks:write" },
  lookup: (ref) => ref.by === "id" ? ref.ref : ref.by === "key" ? cardIdForKey(ref.ref) : null,
  level: (id, viewer) => { const found = readableCard(id, viewer.userId); return found ? boardLevel(found.board, viewer.userId) : "none"; },
  resolve: each((id, viewer) => {
    const found = readableCard(id, viewer.userId);
    if (!found) return null;
    const column = found.card.column_id ? db.query("SELECT name, is_done FROM board_columns WHERE id = ?").get(found.card.column_id) as { name: string; is_done: number } | null : null;
    const key = cardKey((found.board as { code?: string | null }).code, (found.card as { number?: number | null }).number ?? null) ?? undefined;
    return {
      kind: "card", id, key, title: found.card.title, subtitle: found.board.name, href: cardPath(found.board.id, id), icon: WORK_KIND_ICONS.card,
      ...(column ? { status: { label: column.name, tone: column.is_done ? "success" as const : "neutral" as const } } : {}),
      ...(found.card.due_on ? { due: found.card.due_on } : {})
    };
  })
});

registerWorkKind({
  kind: "board", itemKind: "board", scopes: { read: "tasks:read", write: "tasks:write" },
  lookup: (ref) => ref.by === "id" ? ref.ref : ref.by === "code" ? (db.query("SELECT id FROM boards WHERE code = ? COLLATE NOCASE").get(ref.ref) as { id: string } | null)?.id
    ?? (db.query("SELECT board_id AS id FROM board_code_aliases WHERE code = ? COLLATE NOCASE").get(ref.ref) as { id: string } | null)?.id ?? null : null,
  level: (id, viewer) => { const board = readableBoard(id, viewer.userId); return board ? boardLevel(board, viewer.userId) : "none"; },
  resolve: each((id, viewer) => {
    const board = readableBoard(id, viewer.userId);
    return board ? { kind: "board", id, key: (board as { code?: string | null }).code ?? undefined, title: board.name, href: boardPath(id), icon: WORK_KIND_ICONS.board } : null;
  })
});

registerWorkKind({
  kind: "sprint", itemKind: "sprint", scopes: { read: "tasks:read", write: "tasks:write" },
  level: (id, viewer) => {
    const sprint = db.query("SELECT board_id FROM board_sprints WHERE id = ?").get(id) as { board_id: string } | null;
    const board = sprint ? readableBoard(sprint.board_id, viewer.userId) : null;
    return board ? boardLevel(board, viewer.userId) : "none";
  },
  resolve: each((id, viewer) => {
    const sprint = db.query("SELECT id, board_id, name, status FROM board_sprints WHERE id = ?").get(id) as { id: string; board_id: string; name: string; status: string } | null;
    const board = sprint ? readableBoard(sprint.board_id, viewer.userId) : null;
    return sprint && board ? { kind: "sprint", id, title: sprint.name, subtitle: board.name, href: sprintsPath(board.id), icon: WORK_KIND_ICONS.sprint, status: { label: sprint.status, tone: sprint.status === "active" ? "info" : "neutral" } } : null;
  })
});

registerWorkKind({
  kind: "note", itemKind: "note", scopes: { read: "notes:read", write: "notes:write-draft" },
  lookup: byShortId("notes"),
  level: (id, viewer) => { const note = readableNote(id, viewer.userId); return note && note.deleted_at === null ? noteLevel(note, viewer.userId) : "none"; },
  resolve: each((id, viewer) => {
    const note = readableNote(id, viewer.userId);
    if (!note || note.deleted_at !== null || (note.owner_id !== viewer.userId && note.current_version < 1)) return null;
    return { kind: "note", id, shortId: note.short_id ?? undefined, title: noteTitle(id, note.owner_id, viewer.userId, note.title, note.current_version), href: notePath(id), icon: WORK_KIND_ICONS.note };
  })
});

registerWorkKind({
  kind: "document", itemKind: "document", scopes: { read: "files:read", write: "files:write" },
  lookup: byShortId("documents"),
  level: (id, viewer) => { const document = readableDocument(id, viewer.userId); return document && document.purpose === "file" && document.deleted_at === null ? (document.owner_id === viewer.userId ? "owner" : "view") : "none"; },
  resolve: each((id, viewer) => {
    const document = readableDocument(id, viewer.userId);
    if (!document || document.purpose !== "file" || document.deleted_at !== null) return null;
    return { kind: "document", id, shortId: (document as { short_id?: string | null }).short_id ?? undefined, title: document.name, href: documentPath(id), icon: WORK_KIND_ICONS.document };
  })
});

registerWorkKind({
  kind: "whiteboard", itemKind: "whiteboard", scopes: { read: "whiteboards:read", write: "whiteboards:write" },
  lookup: byShortId("documents"),
  level: (id, viewer) => {
    const document = readableDocument(id, viewer.userId);
    if (!document || document.deleted_at !== null || !db.query("SELECT 1 FROM whiteboards WHERE document_id = ?").get(id)) return "none";
    return document.owner_id === viewer.userId ? "owner" : "view";
  },
  resolve: each((id, viewer) => {
    const document = readableDocument(id, viewer.userId);
    if (!document || document.purpose !== "file" || document.deleted_at !== null || !db.query("SELECT 1 FROM whiteboards WHERE document_id = ?").get(id)) return null;
    return { kind: "whiteboard", id, shortId: (document as { short_id?: string | null }).short_id ?? undefined, title: document.name.replace(/\.excalidraw$/i, ""), href: whiteboardPath(id), icon: WORK_KIND_ICONS.whiteboard };
  })
});

registerWorkKind({
  kind: "calendar", itemKind: "calendar", scopes: { read: "calendar:read", write: "calendar:write" },
  level: (id, viewer) => { const calendar = readableCalendar(id, viewer.userId); return calendar ? calendarLevel(calendar, viewer.userId) : "none"; },
  resolve: each((id, viewer) => {
    const calendar = readableCalendar(id, viewer.userId);
    return calendar ? { kind: "calendar", id, title: calendar.name, href: "/calendar", icon: WORK_KIND_ICONS.calendar } : null;
  })
});

registerWorkKind({
  kind: "event", itemKind: "event", scopes: { read: "calendar:read", write: "calendar:write" },
  level: (id, viewer) => { const found = readableEvent(id, viewer.userId); return found ? calendarLevel(found.calendar, viewer.userId) : "none"; },
  resolve: each((id, viewer) => {
    const found = readableEvent(id, viewer.userId);
    // Events stay opaque in URLs (D782): the id path, never a slug.
    return found ? { kind: "event", id, title: found.event.title, subtitle: found.calendar.name, href: `/calendar/event/${id}`, icon: WORK_KIND_ICONS.event } : null;
  })
});

registerWorkKind({
  kind: "collection", itemKind: "collection", scopes: { read: "collections:read", write: "collections:write" },
  lookup: byShortId("collections"),
  level: (id, viewer) => { const collection = readableCollection(id, viewer.userId); return collection ? collectionLevel(collection, viewer.userId) : "none"; },
  resolve: each((id, viewer) => {
    const collection = readableCollection(id, viewer.userId);
    return collection ? { kind: "collection", id, shortId: (collection as { short_id?: string | null }).short_id ?? undefined, title: collection.name, href: collectionPath(id), icon: WORK_KIND_ICONS.collection } : null;
  })
});

registerWorkKind({
  kind: "row", itemKind: "row", scopes: { read: "collections:read", write: "collections:write" },
  level: (id, viewer) => { const found = readableRow(id, viewer.userId); return found ? collectionLevel(found.collection, viewer.userId) : "none"; },
  resolve: each((id, viewer) => {
    const found = readableRow(id, viewer.userId);
    return found ? { kind: "row", id, title: `Row in ${found.collection.name}`, subtitle: found.collection.name, href: collectionRowPath(found.collection.id, id), icon: WORK_KIND_ICONS.row } : null;
  })
});

const reportOrNull = (id: string, userId: string) => {
  try {
    return readableReport(id, userId);
  } catch {
    return null;
  }
};

registerWorkKind({
  kind: "report", itemKind: "report", scopes: { read: "reports:read", write: "reports:write" },
  lookup: byShortId("reports"),
  level: (id, viewer) => {
    const report = reportOrNull(id, viewer.userId);
    if (!report) return "none";
    const level = reportLevel(report, viewer.userId);
    return level === "owner" ? "owner" : level;
  },
  resolve: each((id, viewer) => {
    const report = reportOrNull(id, viewer.userId);
    return report ? { kind: "report", id, shortId: (report as { short_id?: string | null }).short_id ?? undefined, title: report.title, href: reportPath(id), icon: WORK_KIND_ICONS.report } : null;
  })
});
