import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { PARTICIPANT_MINTS, resetTownhallParticipantMints, resetTownhallVoteBuckets } = await import("../server/townhall/publicRoutes");
const { resetPublicLimits } = await import("../server/public/limits");

/**
 * Townhall audit fixes (§D.7): page loads cannot mint unlimited participants, and attendance counts
 * people who act or stay, never a bare page load (D1088, T611).
 */

type Json = Record<string, any>;
let host: Session;
const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, ...(body === undefined && method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Json };
};
const publicApi = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${origin}/api/public${path}`, { method, headers: { "Content-Type": "application/json", Origin: origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) as Json };
};

beforeAll(async () => { host = await createUser("Townhall audit host"); });

describe("participants and attendance (D1088, T611)", () => {
  test("bare page loads count nobody and stop minting new voters past the cap; acting counts", async () => {
    resetPublicLimits();
    resetTownhallVoteBuckets();
    resetTownhallParticipantMints();
    const session = (await api(host, "POST", "/townhall/sessions", { title: "Audit hands" })).body.session as Json;
    expect((await api(host, "POST", `/townhall/sessions/${session.id}/state`, { state: "live" })).status).toBeLessThan(300);
    const link = await api(host, "PUT", `/townhall/sessions/${session.id}/public-link`, { enabled: true });
    const token = String(link.body.publicUrl).split("/").pop()!;
    const tokens = new Set<string>();
    for (let index = 0; index < PARTICIPANT_MINTS.perAddress + 5; index += 1) {
      resetPublicLimits();
      const page = await publicApi("GET", `/townhall/${token}`);
      expect(page.status).toBe(200);
      tokens.add(page.body.participant as string);
    }
    // At most the cap of distinct participants from one address; the rest get the last one again.
    expect(tokens.size).toBe(PARTICIPANT_MINTS.perAddress);
    const attendance = () => (db.query("SELECT COUNT(*) AS n FROM townhall_attendance WHERE session_id = ?").get(session.id) as Json).n as number;
    expect(attendance()).toBe(0);
    // A participant who votes is counted.
    const asked = await api(host, "POST", `/townhall/sessions/${session.id}/questions`, { text: "What is next?" });
    expect(asked.status).toBe(201);
    const participant = [...tokens][0]!;
    const voted = await publicApi("POST", `/townhall/${token}/questions/${asked.body.question.id}/vote`, { participant, upvote: true });
    expect(voted.status).toBe(200);
    expect(attendance()).toBe(1);
  });
});
