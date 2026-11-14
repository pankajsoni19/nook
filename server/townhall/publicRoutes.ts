import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { config } from "../config";
import { clientIp } from "../clientAddress";
import { checkSubmission, consumePublicLink, issueRenderNonce, publicNotFound, readPublicJson, readPublicLink, type PublicRouter } from "../public";
import { randomToken, readSignedToken, signedToken } from "../public/secret";
import { HONEYPOT_FIELD, NONCE_FIELD } from "../../shared/publicPages";
import { TOWNHALL_LIMITS } from "../../shared/townhall";
import { askQuestion, liveState, sessionRow, touchAttendance, votePoll, voteQuestion, withdrawQuestion, type SessionRow, type Viewer } from "./service";
import { STREAM_CAPS } from "./live";
import { liveStream, respondError } from "./routes";

/**
 * The audience link (docs/plan/WORKSPACE_MODULES.md §B.8, §D.7 Townhall, D1076, D1077): `/p/t/<token>`
 * and its JSON under `/api/public/townhall/<token>`, with no session, behind the strict public
 * headers. A public participant gets a signed participant token (kept in the page's storage), which
 * keys their upvotes, poll answers, and "my questions" (as hashes, D1073). Asking passes the shared
 * submission checks (nonce, honeypot, fill time, per-address and per-link limits); upvotes and poll
 * votes have their own per-participant and per-address buckets, since a room behind one address votes
 * at once (T611). Every miss is the one uniform 404 (T507).
 *
 * Participants and attendance (D1088, T611): an address gets at most `PARTICIPANT_MINTS.perAddress`
 * new participant tokens per session in `PARTICIPANT_MINTS.windowMs`; past that, a page load without a
 * token gets the address's most recent one again, so scripted reloads cannot mint voters. Attendance
 * counts a participant only once they act (ask, vote, withdraw) or stay: the live stream open
 * `ATTENDANCE_STAY_MS`, or a page load with a token at least that old. Loading the page alone counts
 * nobody.
 */

const opens = (itemId: string) => {
  const row = sessionRow(itemId);
  return row !== null && row.deleted_at === null;
};

function session(c: Context<AppEnv>): SessionRow | null {
  const link = readPublicLink("townhall_session", c.req.param("token") ?? "", { opens: (found) => opens(found.itemId) });
  return link ? sessionRow(link.itemId) : null;
}

/** A participant token bound to this session (its id and when it was issued, 0 for older tokens), or null. */
function readParticipant(sessionId: string, token: unknown): { id: string; issuedMs: number } | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const payload = readSignedToken("townhall-participant", token);
  if (!payload) return null;
  const [forSession, id, issued] = payload.split(":");
  return forSession === sessionId && id && /^[A-Za-z0-9_-]{16,40}$/.test(id) ? { id, issuedMs: Number(issued) || 0 } : null;
}
const participantOf = (sessionId: string, token: unknown) => readParticipant(sessionId, token)?.id ?? null;
const newParticipant = (sessionId: string, nowMs: number) => signedToken("townhall-participant", `${sessionId}:${randomToken(18)}:${nowMs}`);

export const PARTICIPANT_MINTS = { perAddress: 60, windowMs: 10 * 60_000 } as const;
export const ATTENDANCE_STAY_MS = 30_000;
/** Tokens minted per session and address (in memory, one replica, like the vote buckets). */
const mints = new Map<string, Array<{ at: number; token: string }>>();
function participantFor(sessionId: string, address: string | null, nowMs = Date.now()): string {
  const key = `${sessionId}|${address ?? "unknown"}`;
  const recent = (mints.get(key) ?? []).filter((mint) => mint.at > nowMs - PARTICIPANT_MINTS.windowMs);
  if (recent.length >= PARTICIPANT_MINTS.perAddress) {
    mints.set(key, recent);
    return recent[recent.length - 1]!.token;
  }
  const token = newParticipant(sessionId, nowMs);
  recent.push({ at: nowMs, token });
  if (mints.size > 20_000) mints.clear();
  mints.set(key, recent);
  return token;
}
export const resetTownhallParticipantMints = () => mints.clear();
const attend = (row: SessionRow, participant: string) => touchAttendance(row, { kind: "public", participant, name: null });

/** Votes: per participant (60 a minute) and per address (1200 a minute, a room behind one NAT). In memory, one replica. */
const buckets = new Map<string, number[]>();
function allowVote(participant: string, address: string | null, nowMs = Date.now()) {
  const take = (key: string, limit: number) => {
    const stamps = (buckets.get(key) ?? []).filter((stamp) => stamp > nowMs - 60_000);
    if (stamps.length >= limit) { buckets.set(key, stamps); return false; }
    stamps.push(nowMs);
    buckets.set(key, stamps);
    return true;
  };
  if (buckets.size > 50_000) buckets.clear();
  return take(`p:${participant}`, 60) && take(`a:${address ?? "unknown"}`, 1200);
}
export const resetTownhallVoteBuckets = () => buckets.clear();

const meta = () => ({ appName: config.appName, workspaceName: config.appName, logoUrl: null });

const participantSchema = z.string().max(200);
const askSchema = z.object({
  participant: participantSchema, text: z.string().min(1).max(TOWNHALL_LIMITS.question), name: z.string().max(TOWNHALL_LIMITS.name).nullish(),
  [NONCE_FIELD]: z.string().max(400), [HONEYPOT_FIELD]: z.string().max(200).optional()
}).strict();
const voteSchema = z.object({ participant: participantSchema, upvote: z.boolean() }).strict();
const pollVoteSchema = z.object({ participant: participantSchema, optionIds: z.array(z.string().max(16)).max(10).optional(), rating: z.number().int().min(1).max(5).optional(), text: z.string().max(TOWNHALL_LIMITS.openText).optional() }).strict();
const withdrawSchema = z.object({ participant: participantSchema }).strict();

const viewerOf = (row: SessionRow, participant: string | null, name?: string | null): Viewer | null => participant ? { kind: "public", participant, name: name?.trim() || null } : null;

export function registerTownhallPublicRoutes(router: PublicRouter) {
  router.page("/p/t/:token", (c) => session(c) !== null);

  router.get("/api/public/townhall/:token", (c) => {
    const row = session(c);
    if (!row) return publicNotFound(c);
    const given = c.req.query("p");
    const existing = readParticipant(row.id, given);
    const token = existing ? given! : participantFor(row.id, clientIp(c));
    const viewer: Viewer = { kind: "public", participant: existing?.id ?? participantOf(row.id, token)!, name: null };
    // A returning participant whose token is old enough has stayed; a first load counts nobody (D1088).
    if (existing && Date.now() - existing.issuedMs >= ATTENDANCE_STAY_MS) touchAttendance(row, viewer);
    return c.json({ ...liveState(row, viewer, "public"), participant: token, renderNonce: issueRenderNonce("townhall_session", row.id), meta: meta() });
  });

  router.get("/api/public/townhall/:token/live", (c) => {
    const row = session(c);
    const participant = row ? participantOf(row.id, c.req.query("p")) : null;
    if (!row || !participant) return publicNotFound(c);
    const token = c.req.param("token") ?? "";
    return liveStream(c, {
      sessionId: row.id, viewer: { kind: "public", participant, name: null },
      onStayed: { afterMs: ATTENDANCE_STAY_MS, run: () => { const fresh = sessionRow(row.id); if (fresh && fresh.deleted_at === null) attend(fresh, participant); } },
      slots: [{ key: `addr:${clientIp(c) ?? "unknown"}`, limit: STREAM_CAPS.perAddress }, { key: `participant:${participant}`, limit: 4 }],
      state: () => {
        const link = readPublicLink("townhall_session", token, { opens: (found) => opens(found.itemId) });
        const fresh = link ? sessionRow(link.itemId) : null;
        return fresh ? liveState(fresh, { kind: "public", participant, name: null }, "public") : null;
      }
    });
  });

  router.post("/api/public/townhall/:token/questions", async (c) => {
    const row = session(c);
    if (!row) return publicNotFound(c);
    const link = readPublicLink("townhall_session", c.req.param("token") ?? "")!;
    const body = await readPublicJson(c, askSchema);
    const participant = body ? participantOf(row.id, body.participant) : null;
    if (!body || !participant) return c.json({ error: "Invalid request", code: "INVALID" }, 400);
    const check = checkSubmission({ kind: "townhall_session", itemId: row.id, linkId: link.id, address: clientIp(c), body: body as Record<string, unknown>, minFillMs: 1500 });
    if (!check.ok) {
      if (check.retryAfter) c.header("Retry-After", String(check.retryAfter));
      return check.status === 404 ? publicNotFound(c) : c.json({ error: check.outcome === "rate_limited" ? "Too many questions from here. Try again in a minute." : "Reload the page and try again", code: check.outcome.toUpperCase(), renderNonce: issueRenderNonce("townhall_session", row.id) }, check.status);
    }
    if (!consumePublicLink(link)) return c.json({ error: "This session is taking too many questions right now", code: "RATE_LIMITED" }, 429);
    try {
      const question = askQuestion(row.id, viewerOf(row, participant, body.name)!, { text: body.text, name: body.name ?? null }, row);
      attend(row, participant);
      return c.json({ question, renderNonce: issueRenderNonce("townhall_session", row.id) }, 201);
    } catch (error) {
      return respondError(c, error);
    }
  });

  router.post("/api/public/townhall/:token/questions/:qid/vote", async (c) => {
    const row = session(c);
    if (!row) return publicNotFound(c);
    const body = await readPublicJson(c, voteSchema);
    const participant = body ? participantOf(row.id, body.participant) : null;
    if (!body || !participant) return c.json({ error: "Invalid request", code: "INVALID" }, 400);
    if (!allowVote(participant, clientIp(c))) return c.json({ error: "Slow down a little", code: "RATE_LIMITED" }, 429);
    try {
      const voted = voteQuestion(c.req.param("qid") ?? "", viewerOf(row, participant)!, body.upvote, row);
      attend(row, participant);
      return c.json(voted);
    } catch (error) {
      return respondError(c, error);
    }
  });

  router.post("/api/public/townhall/:token/questions/:qid/withdraw", async (c) => {
    const row = session(c);
    if (!row) return publicNotFound(c);
    const body = await readPublicJson(c, withdrawSchema);
    const participant = body ? participantOf(row.id, body.participant) : null;
    if (!body || !participant) return c.json({ error: "Invalid request", code: "INVALID" }, 400);
    try {
      const withdrawn = withdrawQuestion(c.req.param("qid") ?? "", viewerOf(row, participant)!, row);
      attend(row, participant);
      return c.json(withdrawn);
    } catch (error) {
      return respondError(c, error);
    }
  });

  router.post("/api/public/townhall/:token/polls/:pollId/vote", async (c) => {
    const row = session(c);
    if (!row) return publicNotFound(c);
    const body = await readPublicJson(c, pollVoteSchema);
    const participant = body ? participantOf(row.id, body.participant) : null;
    if (!body || !participant) return c.json({ error: "Invalid request", code: "INVALID" }, 400);
    if (!allowVote(participant, clientIp(c))) return c.json({ error: "Slow down a little", code: "RATE_LIMITED" }, 429);
    const { participant: _participant, ...vote } = body;
    try {
      const voted = votePoll(row.id, c.req.param("pollId") ?? "", viewerOf(row, participant)!, vote, row);
      attend(row, participant);
      return c.json(voted);
    } catch (error) {
      return respondError(c, error);
    }
  });
}
