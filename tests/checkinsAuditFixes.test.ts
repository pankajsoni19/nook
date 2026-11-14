import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { appendRoundToNote } = await import("../server/checkins/noteDigest");
const { createDraftNote, publishDraft, writeDraftLocked } = await import("../server/noteDrafts");
const { readPublishedMarkdown } = await import("../server/mcpTools");
const { withNoteLock, storage } = await import("../server/storage");
const { editableNote } = await import("../server/access");

/**
 * Check-ins audit fixes (§D.4): the note digest publishes only its own text, inside the note lock
 * (D955).
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
