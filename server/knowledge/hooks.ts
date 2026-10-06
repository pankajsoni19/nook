/**
 * Hooks other modules call without importing the knowledge module (no import cycles): Notes tells
 * it a note was published (plan §9: a source re-indexes after a publish, debounced 60 s).
 */

type Listener = (noteId: string) => void;
const listeners = new Set<Listener>();

export function onNotePublished(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called by server/noteDrafts.ts after a publish committed. Never throws. */
export function notePublishedHook(noteId: string) {
  for (const listener of listeners) {
    try {
      listener(noteId);
    } catch (error) {
      console.error("A note publish hook failed", error instanceof Error ? error.name : "Unknown error");
    }
  }
}
