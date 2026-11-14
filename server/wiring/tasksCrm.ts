import { db } from "../db";
import { logger } from "../log";
import { onCardChange, type CardChange } from "../tasks/cardEvents";
import { logInteraction } from "../crm/interactions";
import { canEditBook } from "../people/contacts";

const slog = logger("wiring");

/**
 * Tasks → Contacts (docs/plan/WORKSPACE_MODULES.md §C C17, D1041): when a card linked to contacts,
 * companies, or deals (a `work_links` row either way, e.g. Contacts' "Create task") moves into a done
 * column, each linked record's book gets one `task` interaction "Task done" naming those records. It is
 * written as the person who finished the card when they may edit the book, else as the person who made
 * the link if they still may; otherwise nothing is logged. The interaction carries no card title (book
 * readers may not read the board, T595): the card itself is in the record's Linked work, where readers
 * who cannot open it see "An item you can't open" (T501). One
 * interaction per card and book (`source = 'task'`, `source_ref = <card>:<book>`), so finishing a card
 * again, or a coalesced drag, never logs twice.
 */

type LinkedRecord = { kind: "contact" | "company" | "deal"; id: string; book_id: string; created_by: string | null };

const LINKED = `SELECT x.kind, x.id, x.created_by, COALESCE(c.book_id, co.book_id, d.book_id) AS book_id FROM (
    SELECT b_kind AS kind, b_id AS id, created_by FROM work_links WHERE a_kind = 'card' AND a_id = $card AND b_kind IN ('contact','company','deal')
    UNION SELECT a_kind, a_id, created_by FROM work_links WHERE b_kind = 'card' AND b_id = $card AND a_kind IN ('contact','company','deal')
  ) x
  LEFT JOIN contacts c ON x.kind = 'contact' AND c.id = x.id AND c.deleted_at IS NULL
  LEFT JOIN companies co ON x.kind = 'company' AND co.id = x.id AND co.deleted_at IS NULL
  LEFT JOIN deals d ON x.kind = 'deal' AND d.id = x.id AND d.deleted_at IS NULL
  WHERE COALESCE(c.book_id, co.book_id, d.book_id) IS NOT NULL LIMIT 60`;

const inDoneColumn = (cardId: string) => Boolean(db.query(`SELECT 1 FROM cards k JOIN board_columns col ON col.id = k.column_id
  WHERE k.id = ? AND k.deleted_at IS NULL AND (col.is_done = 1 OR col.state = 'done')`).get(cardId));

/** Logs "Task done" on the card's linked records when it sits in a done column now; returns how many interactions were written. */
export function logTaskDone(change: Pick<CardChange, "cardId" | "boardId" | "actorId" | "at">) {
  if (!inDoneColumn(change.cardId)) return 0;
  const records = db.query(LINKED).all({ card: change.cardId }) as LinkedRecord[];
  const byBook = new Map<string, LinkedRecord[]>();
  for (const record of records) byBook.set(record.book_id, [...(byBook.get(record.book_id) ?? []), record]);
  let logged = 0;
  for (const [bookId, subjects] of byBook) {
    const actor = [change.actorId, ...subjects.map((subject) => subject.created_by)].find((id): id is string => typeof id === "string" && canEditBook(bookId, id));
    if (!actor) continue;
    const sourceRef = `${change.cardId}:${bookId}`;
    if (db.query("SELECT 1 FROM interactions WHERE source = 'task' AND source_ref = ?").get(sourceRef)) continue;
    try {
      logInteraction(actor, {
        kind: "task", title: "Task done", body: "A linked task was finished.", occurredAt: change.at, source: "task", sourceRef,
        subjects: subjects.slice(0, 20).map((subject) => ({ kind: subject.kind, id: subject.id }))
      });
      logged += 1;
    } catch (error) {
      slog.warn("A finished task could not be logged on its contacts", { cardId: change.cardId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return logged;
}

onCardChange((changes) => {
  const seen = new Set<string>();
  for (const change of changes) {
    if (change.kind !== "column" && change.kind !== "created") continue;
    if (seen.has(change.cardId)) continue;
    seen.add(change.cardId);
    logTaskDone(change);
  }
});
