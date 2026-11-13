import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { parseJson } from "../validation";
import { keepRequestOpen } from "../longRequests";
import type { ModuleRouter } from "../workspaceRegistry";
import {
  askQuestion, binSession, closePoll, createPoll, createSession, deletePoll, launchPoll, levelOn, listSessions, liveState, moderateQuestion, postRecapNote,
  questionsToCards, readSession, recap, recapCsv, recapMarkdown, sessionRow, setPublicLink, setSessionState, showOnScreen, touchAttendance, TownhallError,
  updatePoll, updateSession, votePoll, voteQuestion, withdrawQuestion, type Viewer
} from "./service";
import { LIVE_TIMING, STREAM_CAPS, subscribeSession, takeStream } from "./live";
import { MODERATION_ACTIONS, POLL_KINDS, TOWNHALL_LIMITS, TOWNHALL_STATES } from "../../shared/townhall";

/**
 * Townhall's HTTP routes (docs/plan/WORKSPACE_MODULES.md §D.7 Townhall), behind every session, CSRF,
 * two-factor, and role-write guard (D815). Guests and viewers may ask, upvote, vote, and withdraw
 * their own question (registered read-only writes, D817); the handlers check the session.
 */

type Handler = (c: Context<AppEnv>) => unknown | Promise<unknown>;

export function respondError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof TownhallError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  const coded = error as { status?: unknown; message?: string; code?: string; body?: () => Record<string, unknown> };
  if (error instanceof Error && typeof coded.status === "number" && coded.status >= 400 && coded.status < 500 && typeof coded.body === "function") return c.json(coded.body(), coded.status as 400);
  if (error instanceof Error && typeof coded.status === "number" && coded.status >= 400 && coded.status < 500) return c.json({ error: error.message, ...(coded.code ? { code: coded.code } : {}) }, coded.status as 400);
  throw error;
}

const handle = (fn: Handler, status: 200 | 201 = 200) => async (c: Context<AppEnv>) => {
  try {
    const result = await fn(c);
    return result instanceof Response ? result : c.json(result as Record<string, unknown>, status);
  } catch (error) {
    return respondError(c, error);
  }
};

const isoOrNull = z.string().max(40).nullable().optional();
const sessionSchema = z.object({
  title: z.string().trim().min(1).max(TOWNHALL_LIMITS.title),
  description: z.string().max(TOWNHALL_LIMITS.description).optional(),
  startsAt: isoOrNull, endsAt: isoOrNull,
  eventId: z.string().uuid().nullable().optional(),
  questionsOpen: z.boolean().optional(), allowAnonymous: z.boolean().optional(), moderation: z.enum(["off", "review"]).optional(),
  allowComments: z.boolean().optional(), reminderMinutes: z.number().int().min(0).max(1440).optional()
}).strict();
const sessionPatchSchema = sessionSchema.partial().extend({ expectedRevision: z.number().int().min(1).optional() }).strict();

const pollSchema = z.object({
  kind: z.enum(POLL_KINDS), title: z.string().trim().min(1).max(TOWNHALL_LIMITS.pollTitle),
  options: z.array(z.string().max(TOWNHALL_LIMITS.optionLabel)).max(TOWNHALL_LIMITS.pollOptions).optional(),
  resultsHidden: z.boolean().optional(), launch: z.boolean().optional()
}).strict();
const pollVoteSchema = z.object({ optionIds: z.array(z.string().max(16)).max(TOWNHALL_LIMITS.pollOptions).optional(), rating: z.number().int().min(1).max(5).optional(), text: z.string().max(TOWNHALL_LIMITS.openText).optional() }).strict();
const askSchema = z.object({ text: z.string().min(1).max(TOWNHALL_LIMITS.question), anonymous: z.boolean().optional() }).strict();

const me = (c: Context<AppEnv>): Viewer => ({ kind: "user", userId: c.get("user").id });
const sid = (c: Context<AppEnv>) => c.req.param("id") ?? "";

export const TOWNHALL_READ_ONLY_WRITES = [
  { method: "POST" as const, path: "/api/townhall/sessions/:id/questions", why: "ask in a townhall they can open (D817)" },
  { method: "PUT" as const, path: "/api/townhall/questions/:qid/vote", why: "upvote a townhall question" },
  { method: "DELETE" as const, path: "/api/townhall/questions/:qid", why: "withdraw their own townhall question" },
  { method: "POST" as const, path: "/api/townhall/sessions/:id/polls/:pollId/vote", why: "vote in a townhall poll" }
];

/** A server-sent event stream of the session's state for one viewer (D1075). */
export function liveStream(c: Context<AppEnv>, input: { sessionId: string; viewer: Viewer; slots: Array<{ key: string; limit: number }>; state: () => unknown | null }) {
  const release = takeStream([...input.slots, { key: `session:${input.sessionId}`, limit: STREAM_CAPS.perSession }]);
  if (!release) return c.json({ error: "Too many open streams; close another tab with this session", code: "TOO_MANY_STREAMS" }, 429);
  c.header("X-Accel-Buffering", "no");
  keepRequestOpen(c.req.raw);
  const response = streamSSE(c, async (stream) => {
    let dirty = true;
    let wake: (() => void) | null = null;
    const unsubscribe = subscribeSession(input.sessionId, () => { dirty = true; wake?.(); });
    const tick = setInterval(() => { wake?.(); }, Math.min(LIVE_TIMING.pingMs, LIVE_TIMING.accessCheckMs));
    stream.onAbort(() => { wake?.(); });
    let lastPing = Date.now();
    let lastCheck = Date.now();
    try {
      await stream.write(": open\n\n");
      for (;;) {
        if (stream.aborted) break;
        if (dirty || Date.now() - lastCheck >= LIVE_TIMING.accessCheckMs) {
          const wasDirty = dirty;
          dirty = false;
          lastCheck = Date.now();
          const state = input.state();
          if (state === null) { await stream.write("event: gone\ndata: {}\n\n"); break; }
          if (wasDirty) await stream.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
          // Coalesce bursts: at most one push per window.
          await new Promise((resolve) => setTimeout(resolve, LIVE_TIMING.coalesceMs));
          continue;
        }
        if (Date.now() - lastPing >= LIVE_TIMING.pingMs) { lastPing = Date.now(); await stream.write(": ping\n\n"); }
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = null;
      }
    } finally {
      clearInterval(tick);
      unsubscribe();
      release();
    }
  }, async () => { release(); });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function registerTownhallRoutes(router: ModuleRouter) {
  router.get("/api/townhall/sessions", handle((c) => {
    const state = c.req.query("state");
    return listSessions(c.get("user").id, {
      state: state && (TOWNHALL_STATES as readonly string[]).includes(state) ? state as never : "all",
      q: c.req.query("q") ?? undefined, cursor: c.req.query("cursor") ?? null, limit: Number(c.req.query("limit") ?? "50") || 50
    });
  }));
  router.post("/api/townhall/sessions", handle(async (c) => {
    const body = await parseJson(c.req.raw, sessionSchema);
    return { session: createSession(c.get("user").id, body) };
  }, 201));
  router.get("/api/townhall/sessions/:id", handle((c) => {
    const { row, level } = readSession(sid(c), c.get("user").id);
    touchAttendance(row, me(c));
    return liveState(row, me(c), level);
  }));
  router.patch("/api/townhall/sessions/:id", handle(async (c) => {
    const { expectedRevision, ...body } = await parseJson(c.req.raw, sessionPatchSchema);
    return { session: updateSession(sid(c), c.get("user").id, body, expectedRevision) };
  }));
  router.delete("/api/townhall/sessions/:id", handle((c) => binSession(sid(c), c.get("user").id)));
  router.post("/api/townhall/sessions/:id/state", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ state: z.enum(["live", "ended"]) }).strict());
    return { session: setSessionState(sid(c), c.get("user").id, body.state) };
  }));
  router.put("/api/townhall/sessions/:id/public-link", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ enabled: z.boolean() }).strict());
    return setPublicLink(sid(c), c.get("user").id, body.enabled);
  }));
  router.put("/api/townhall/sessions/:id/screen", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ pollId: z.string().uuid().nullable() }).strict());
    return showOnScreen(sid(c), c.get("user").id, body.pollId);
  }));
  // Live updates: an SSE stream of the whole state (D1075); `GET …/sessions/:id` is the fallback poll.
  router.get("/api/townhall/sessions/:id/live", (c) => {
    try {
      const userId = c.get("user").id;
      const { row } = readSession(sid(c), userId);
      return liveStream(c, {
        sessionId: row.id, viewer: me(c), slots: [{ key: `user:${userId}`, limit: STREAM_CAPS.perUser }],
        state: () => {
          const fresh = sessionRow(row.id);
          const level = levelOn(fresh, userId);
          return fresh && level !== "none" ? liveState(fresh, { kind: "user", userId }, level) : null;
        }
      });
    } catch (error) {
      return respondError(c, error);
    }
  });

  router.post("/api/townhall/sessions/:id/questions", handle(async (c) => {
    const body = await parseJson(c.req.raw, askSchema);
    return { question: askQuestion(sid(c), me(c), body) };
  }, 201));
  router.put("/api/townhall/questions/:qid/vote", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ upvote: z.boolean() }).strict());
    return voteQuestion(c.req.param("qid") ?? "", me(c), body.upvote);
  }));
  router.delete("/api/townhall/questions/:qid", handle((c) => withdrawQuestion(c.req.param("qid") ?? "", me(c))));
  router.post("/api/townhall/questions/:qid/moderate", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ action: z.enum(MODERATION_ACTIONS), targetId: z.string().uuid().optional() }).strict());
    return { question: moderateQuestion(c.req.param("qid") ?? "", c.get("user").id, body.action, { targetId: body.targetId }) };
  }));
  router.post("/api/townhall/sessions/:id/cards", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ boardId: z.string().uuid(), columnId: z.string().uuid(), questionIds: z.array(z.string().uuid()).min(1).max(TOWNHALL_LIMITS.cardsAtOnce) }).strict());
    return questionsToCards(sid(c), c.get("user").id, body);
  }, 201));

  router.post("/api/townhall/sessions/:id/polls", handle(async (c) => {
    const body = await parseJson(c.req.raw, pollSchema);
    return createPoll(sid(c), c.get("user").id, body);
  }, 201));
  router.post("/api/townhall/sessions/:id/polls/:pollId/launch", handle((c) => launchPoll(sid(c), c.req.param("pollId") ?? "", c.get("user").id)));
  router.post("/api/townhall/sessions/:id/polls/:pollId/close", handle((c) => closePoll(sid(c), c.req.param("pollId") ?? "", c.get("user").id)));
  router.patch("/api/townhall/sessions/:id/polls/:pollId", handle(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ resultsHidden: z.boolean().optional() }).strict());
    return updatePoll(sid(c), c.req.param("pollId") ?? "", c.get("user").id, body);
  }));
  router.delete("/api/townhall/sessions/:id/polls/:pollId", handle((c) => deletePoll(sid(c), c.req.param("pollId") ?? "", c.get("user").id)));
  router.post("/api/townhall/sessions/:id/polls/:pollId/vote", handle(async (c) => {
    const body = await parseJson(c.req.raw, pollVoteSchema);
    return votePoll(sid(c), c.req.param("pollId") ?? "", me(c), body);
  }));

  router.get("/api/townhall/sessions/:id/recap", handle((c) => {
    const format = c.req.query("format");
    const data = recap(sid(c), c.get("user").id);
    if (format === "markdown") return new Response(recapMarkdown(data), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="townhall-recap.md"`, "Cache-Control": "no-store" } });
    if (format === "csv") return new Response(recapCsv(sid(c), c.get("user").id), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="townhall-questions.csv"`, "Cache-Control": "no-store" } });
    return { recap: data };
  }));
  router.post("/api/townhall/sessions/:id/recap/note", handle(async (c) => postRecapNote(sid(c), c.get("user").id), 201));
}
