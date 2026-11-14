import { nameItems } from "./routeNames";
import type { FolderSelection, MobileNavigationSnapshot, MobilePanel } from "./mobileNavigation";
import type { Route } from "./router";

export type NotesRoute = Extract<Route, { app: "notes" }>;
export type NotesSelection = { folder: FolderSelection; noteId: string | null };
export type NotesRouteResolution = NotesSelection & { missing: "note" | "folder" | null };

type FolderRow = { id: string };
type NoteRow = { id: string; folder_id: string | null; is_owner: number; short_id?: string | null };

export function notesRoute(folder: FolderSelection, noteId: string | null): NotesRoute {
  return { app: "notes", folder, noteId };
}

export function noteInFolder(note: NoteRow, folder: FolderSelection) {
  return folder === "all" || (folder === "shared" ? note.is_owner === 0 : note.folder_id === folder);
}

function knownFolder(folder: FolderSelection, folders: FolderRow[]) {
  return folder === "all" || folder === "shared" || folders.some((item) => item.id === folder);
}

// Maps a Notes URL onto loaded data. A note URL keeps the folder from its own history entry when
// that entry still matches, then the note's folder (or Shared for another user's note), then the
// last selected folder, then "all".
// A friendly URL the tab could not name yet (D773) is found by its short id in the loaded list; one
// the reader cannot see is not in it, so it is "Note not found" exactly like an unknown id (T490).
export function resolveNotesRoute(route: NotesRoute, data: { folders: FolderRow[]; notes: NoteRow[] }, context: { snapshot: MobileNavigationSnapshot | null; lastFolder: FolderSelection }): NotesRouteResolution {
  const pendingNote = route.pending?.kind === "note" ? route.pending.ref : null;
  const noteId = route.noteId ?? (pendingNote ? data.notes.find((item) => item.short_id === pendingNote)?.id ?? null : null);
  if (pendingNote && !noteId) return { folder: "all", noteId: null, missing: "note" };
  if (noteId) {
    const note = data.notes.find((item) => item.id === noteId);
    if (!note) return { folder: "all", noteId: null, missing: "note" };
    const candidates: FolderSelection[] = [];
    if (context.snapshot?.noteId === note.id) candidates.push(context.snapshot.folder);
    if (note.folder_id && knownFolder(note.folder_id, data.folders)) candidates.push(note.folder_id);
    // Someone else's note whose folder the viewer cannot see belongs under Shared.
    else if (note.is_owner === 0) candidates.push("shared");
    candidates.push(context.lastFolder);
    const folder = candidates.find((candidate) => knownFolder(candidate, data.folders) && noteInFolder(note, candidate)) ?? "all";
    return { folder, noteId: note.id, missing: null };
  }
  if (!knownFolder(route.folder, data.folders)) return { folder: "all", noteId: null, missing: "folder" };
  return { folder: route.folder, noteId: null, missing: null };
}

// The phone panel for a Notes entry: the entry's own hint when it describes the same selection,
// otherwise the editor for an open note, the folders panel for bare /notes, and the list elsewhere.
export function resolveNotesPanel(selection: NotesSelection, snapshot: MobileNavigationSnapshot | null): MobilePanel {
  if (snapshot && snapshot.folder === selection.folder && snapshot.noteId === selection.noteId) {
    return snapshot.panel === "editor" && !selection.noteId ? "notes" : snapshot.panel;
  }
  if (selection.noteId) return "editor";
  return selection.folder === "all" ? "folders" : "notes";
}

/**
 * Friendly URLs (D776): names every loaded note for the router, under the folder its reader sees it
 * in (a note in a folder the reader cannot see, or in none, has no folder segment).
 */
export function nameNotes(folders: ReadonlyArray<{ id: string; name: string }>, notes: ReadonlyArray<{ id: string; short_id?: string | null; title: string; folder_id: string | null }>) {
  if (!Array.isArray(notes)) return;
  const folderNames = new Map((Array.isArray(folders) ? folders : []).map((folder) => [folder.id, folder.name]));
  nameItems("note", notes.map((note) => ({ id: note.id, short_id: note.short_id ?? null, title: note.title, folderTitle: note.folder_id ? folderNames.get(note.folder_id) ?? null : null })));
}
