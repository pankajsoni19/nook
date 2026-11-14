import { audit, db } from "../db";
import { logger } from "../log";
import { config } from "../config";
import { editableNote } from "../access";
import { checksum, storage, withNoteLock } from "../storage";
import { publishDraftLocked, writeDraftLocked } from "../noteDrafts";
import { recordItemActivity } from "../activity/service";
import { notify } from "../notify";
import { checkinHref, checkinLevel, checkinRow, roundRow, summaryNoteSetter, summaryOptions, type CheckinRow } from "./store";
import { LEVEL_RANK } from "../access/levels";
import { roundSummary } from "./views";
import { dateLabel } from "./rounds";

const slog = logger("checkins");

/**
 * Standup digest → note (docs/plan/WORKSPACE_MODULES.md §C C23, D1044). A standup's summary options may
 * name a note (`summary.noteId`, set by someone who can manage the standup and edit the note). When a
 * round closes, the round is appended to that note as the person who chose it (D956; the owner for
 * older settings), who must still be able to edit the note and the standup, or they are told it was
 * not added: with no unpublished draft the appended text is published as the next version (inside the
 * lock, D955); when someone has a draft open, it is appended to that draft instead (nobody's unsaved
 * text is published), and the person is told. What goes in: the date, the one-line summary, and, for named standups whose answers
 * are not private, each person's answers as plain text. Anonymous and private-answer standups append
 * the summary line only; blockers are counted, never named (card titles stay with card readers, T596).
 * Once per round (the `summary_posted` activity entry); a failure is logged and never undoes the close.
 */

const escapeLine = (text: string) => text.replace(/\r/g, "").replace(/^(#{1,6}\s|>|-{3,}|\*{3,})/gm, "\\$1");

export function roundMarkdown(row: CheckinRow, roundId: string): string {
  const round = roundRow(roundId)!;
  const summary = roundSummary(roundId, row.owner_id);
  const lines = [`## ${escapeLine(row.name)} · ${dateLabel(round.round_date)}`, "", escapeLine(round.summary_md ?? "")];
  if (!row.anonymous && row.private_answers === 0) {
    for (const answer of summary.answers) {
      if (!answer.person) continue;
      lines.push("", `**${escapeLine(answer.person)}**${answer.late ? " (late)" : ""}`);
      for (const item of answer.answers) {
        const text = String(item.answer ?? "").trim();
        if (text) lines.push(`- ${escapeLine(item.question)}: ${escapeLine(text).replace(/\n+/g, " ")}`);
      }
    }
  }
  return lines.join("\n").trim();
}

const alreadyPosted = (checkinId: string, roundId: string) => Boolean(db.query(`SELECT 1 FROM item_activity WHERE item_kind = 'checkin' AND item_id = ? AND kind = 'summary_posted'
  AND json_extract(payload, '$.item.id') = ?`).get(checkinId, roundId));

/** Appends a closed round to the standup's note (see above). Returns what happened, for tests. */
export async function appendRoundToNote(checkinId: string, roundId: string): Promise<"published" | "drafted" | "skipped"> {
  const row = checkinRow(checkinId);
  const round = roundRow(roundId);
  if (!row || row.deleted_at !== null || !round || round.status !== "closed") return "skipped";
  const { noteId } = summaryOptions(row);
  if (!noteId || alreadyPosted(row.id, round.id)) return "skipped";
  // D956: written as the person who chose the note, who must still edit both the note and the standup.
  const actor = summaryNoteSetter(row);
  const outcome = await withNoteLock(noteId, async (): Promise<"published" | "drafted" | "skipped" | "denied"> => {
    if (alreadyPosted(row.id, round.id)) return "skipped";
    const note = editableNote(noteId, actor);
    if (!note || LEVEL_RANK[checkinLevel(row, actor)] < LEVEL_RANK.edit) return "denied";
    let text = "";
    const hasDraft = note.draft_revision !== null;
    if (hasDraft) {
      const markdown = await storage.readDraft(note.id);
      if (!note.draft_checksum || checksum(markdown) !== note.draft_checksum) return "skipped";
      text = markdown;
    } else if (note.current_version > 0) {
      const { readPublishedMarkdown } = await import("../mcpTools");
      text = (await readPublishedMarkdown(note.id, note.current_version)).markdown;
    }
    const next = `${text.replace(/\s+$/, "")}${text.trim() ? "\n\n" : ""}${roundMarkdown(row, round.id)}\n`;
    if (Buffer.byteLength(next, "utf8") > config.maxMarkdownBytes) return "skipped";
    const saved = await writeDraftLocked(note, actor, next);
    if (!saved) return "skipped";
    recordItemActivity({ itemKind: "checkin", itemId: row.id, actorId: null, via: "system", kind: "summary_posted", payload: { item: { id: round.id, label: round.round_date, kind: "checkin_round" } } });
    audit(actor, note.id, "checkins.summary_note", { checkinId: row.id, roundId: round.id, draft: hasDraft });
    if (hasDraft) return "drafted";
    // Published in the same lock, at the revision just written (D955): nobody's draft can slip in
    // between, so only the round's own text (on top of the published version) is ever published.
    try {
      await publishDraftLocked(actor, note.id, saved.revision, { allowEditors: true });
      return "published";
    } catch (error) {
      slog.warn("A standup summary could not be published to its note", { checkinId: row.id, error: error instanceof Error ? error.message : String(error) });
      return "drafted";
    }
  });
  if (outcome === "drafted") {
    db.transaction(() => notify({ userIds: [actor], module: "checkins", topic: "checkins.summary", title: `${row.name} was added to the note's draft`, body: "Someone has unpublished changes there, so it waits in the draft.", href: checkinHref(row), item: { kind: "checkin", id: row.id }, dedupeKey: `checkin-note:${row.id}` }))();
  } else if (outcome === "denied") {
    // Never silent (D956): the person who chose the note hears that this round did not reach it.
    db.transaction(() => notify({ userIds: [actor], module: "checkins", topic: "checkins.summary", title: `${row.name} could not be added to its note`, body: "You can no longer edit the note or the standup. Choose another note in the standup's settings.", href: checkinHref(row), item: { kind: "checkin", id: row.id }, dedupeKey: `checkin-note:${row.id}` }))();
    audit(actor, noteId, "checkins.summary_note_denied", { checkinId: row.id, roundId: round.id });
    return "skipped";
  }
  return outcome;
}

/** Called by closeRound after its transaction (a microtask), so the close never waits on the note. */
export function queueRoundNote(checkinId: string, roundId: string) {
  queueMicrotask(() => { appendRoundToNote(checkinId, roundId).catch((error) => slog.warn("A standup summary could not reach its note", { checkinId, error: error instanceof Error ? error.message : String(error) })); });
}
