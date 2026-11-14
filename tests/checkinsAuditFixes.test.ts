import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { appendRoundToNote } = await import("../server/checkins/noteDigest");
const { createDraftNote, publishDraft, writeDraftLocked } = await import("../server/noteDrafts");
const { readPublishedMarkdown } = await import("../server/mcpTools");
const { withNoteLock, storage } = await import("../server/storage");
const { editableNote } = await import("../server/access");

/**
 * Check-ins audit fixes (§D.4): the note digest publishes only its own text, inside the note lock
 * (D955), and writes as the person who chose the note, telling them when it cannot (D956).
 */

type Json = Record<string, any>;
const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? (method === "GET" ? {} : { body: "{}" }) : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = JSON.parse(text) as Json; } catch { json = { text }; }
  return { status: response.status, body: json };
};

let owner: Session;
let member: Session;

/** A standup with one closed round (closed before any note is chosen, so nothing is appended yet). */
async function closedRound(session: Session, name: string, people: string[]) {
  const created = await api(session, "POST", "/checkins", { template: "standup", name, participants: { people, groups: [] } });
  const checkinId = created.body.checkin.id as string;
  await api(session, "POST", `/checkins/${checkinId}/rounds`);
  const roundId = (db.query("SELECT id FROM checkin_rounds WHERE checkin_id = ?").get(checkinId) as { id: string }).id;
  expect((await api(session, "POST", `/checkin-rounds/${roundId}/close`)).status).toBe(200);
  return { checkinId, roundId };
}

beforeAll(async () => {
  owner = await createUser("Digest owner");
  member = await createUser("Digest member");
});

describe("the digest publishes only its own text (D955)", () => {
  test("an editor's draft saved right after the digest's write is never published as the standup's owner", async () => {
    const { checkinId, roundId } = await closedRound(owner, "Locked standup", [owner.userId]);
    const note = await createDraftNote(owner.userId, null, "# Log\n");
    await publishDraft(owner.userId, note.id, 1);
    expect((await api(owner, "PATCH", `/checkins/${checkinId}`, { summary: { noteId: note.id } })).status).toBe(200);
    // The digest takes the note lock first; an editor's save is queued right behind it.
    const digest = appendRoundToNote(checkinId, roundId);
    const editor = withNoteLock(note.id, async () => {
      const row = editableNote(note.id, owner.userId)!;
      return writeDraftLocked(row, owner.userId, `${await storage.readCurrent(note.id)}\n\nUNSAVED EDITOR TEXT\n`);
    });
    expect(await digest).toBe("published");
    await editor;
    const current = (db.query("SELECT current_version, draft_revision FROM notes WHERE id = ?").get(note.id) as { current_version: number; draft_revision: number | null });
    expect(current.current_version).toBe(2);
    const published = (await readPublishedMarkdown(note.id, 2)).markdown;
    expect(published).toContain("## Locked standup");
    expect(published).not.toContain("UNSAVED EDITOR TEXT");
    // The editor's text is still their draft.
    expect(current.draft_revision).not.toBeNull();
    expect(await storage.readDraft(note.id)).toContain("UNSAVED EDITOR TEXT");
  });
});

describe("the digest writes as the person who chose the note (D956)", () => {
  const grantEdit = (checkinId: string, userId: string) => db.query("INSERT INTO item_members (item_kind, item_id, user_id, level, added_by, created_at) VALUES ('checkin', ?, ?, 'edit', NULL, ?)").run(checkinId, userId, new Date().toISOString());

  test("an editor's own note (the owner can't edit it) gets the round, authored by them", async () => {
    const { checkinId, roundId } = await closedRound(owner, "Editor's standup", [owner.userId, member.userId]);
    grantEdit(checkinId, member.userId);
    const note = await createDraftNote(member.userId, null, "# Member log\n");
    await publishDraft(member.userId, note.id, 1);
    expect(editableNote(note.id, owner.userId)).toBeNull();
    expect((await api(member, "PATCH", `/checkins/${checkinId}`, { summary: { noteId: note.id } })).status).toBe(200);
    // The setter is stored but never shown.
    expect((await api(owner, "GET", `/checkins/${checkinId}`)).body.checkin.summary).toEqual({ notifyParticipants: true, email: false, noteId: note.id });
    expect(await appendRoundToNote(checkinId, roundId)).toBe("published");
    expect(db.query("SELECT author_id FROM note_versions WHERE note_id = ? AND version_number = 2").get(note.id)).toEqual({ author_id: member.userId });
    expect((await readPublishedMarkdown(note.id, 2)).markdown).toContain("## Editor's standup");
  });

  test("when the person who chose it can no longer edit the standup, nothing is written and they are told", async () => {
    const { checkinId, roundId } = await closedRound(owner, "Revoked standup", [owner.userId, member.userId]);
    grantEdit(checkinId, member.userId);
    const note = await createDraftNote(member.userId, null, "# Revoked log\n");
    await publishDraft(member.userId, note.id, 1);
    expect((await api(member, "PATCH", `/checkins/${checkinId}`, { summary: { noteId: note.id } })).status).toBe(200);
    db.query("DELETE FROM item_members WHERE item_kind = 'checkin' AND item_id = ? AND user_id = ?").run(checkinId, member.userId);
    expect(await appendRoundToNote(checkinId, roundId)).toBe("skipped");
    expect((db.query("SELECT current_version FROM notes WHERE id = ?").get(note.id) as { current_version: number }).current_version).toBe(1);
    const told = db.query("SELECT title FROM notifications WHERE user_id = ? AND topic = 'checkins.summary' AND item_id = ?").get(member.userId, checkinId) as { title: string } | null;
    expect(told?.title).toBe("Revoked standup could not be added to its note");
  });
});
