import * as z from "zod/v4";
import { BIN_BUCKETS, BIN_DESCRIPTION, defineTool, McpToolError, restoreResult, type McpKeyContext } from "../mcpToolKit";
import { binProvider } from "./bin";
import { keyContainerIds, keyReach } from "../keyResources";
import { CHECKIN_TEMPLATES } from "../../shared/checkins";
import { CheckinError, checkinLevel, checkinRow, roundRow } from "./store";
import { createCheckin, deleteCheckin, setParticipants, updateCheckin } from "./service";
import { answerRound, skipRound } from "./rounds";
import { goalUpdatesSchema } from "./goalUpdates";
import { detailOf, dueRounds, feed, listCheckins, roundByDate, roundSummary, roundsPage, roundView, stats } from "./views";

/**
 * Standups' MCP tools (docs/plan/WORKSPACE_MODULES.md §D.4 MCP, §B.15): `checkins:read` reads,
 * `checkins:write` writes, as the key's owner. `answer_checkin` answers only as the key owner and only
 * rounds they take part in (T551); agents propose it (`checkin_answer`) for the person to approve.
 * Lists narrow by a chosen-item key's standups before LIMIT; missing, unreadable, and outside the key
 * look the same (NOT_FOUND).
 */

function run<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CheckinError) {
      const code = error.status === 404 ? "NOT_FOUND" : error.status === 403 ? "READ_ONLY" : "INVALID";
      throw new McpToolError(code, error.message, { reason: error.code, ...(error.details ?? {}) });
    }
    throw error;
  }
}

const ids = (key: McpKeyContext) => keyContainerIds(key, "checkins:read", "checkin");
const ref = z.string().min(1).max(64);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const answers = z.record(z.string(), z.unknown()).describe("Answers by question id (get_checkin lists the questions: text for long_text/short_text, a number for rating/scale, option ids for choices)");
const scheduleInput = z.object({
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).describe("0 = Sunday … 6 = Saturday"),
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe("HH:MM"),
  everyNWeeks: z.number().int().min(1).max(8),
  zoneMode: z.enum(["each", "fixed"]).describe("each: at that time in each participant's zone; fixed: in tz"),
  tz: z.string().max(64).describe("IANA time zone")
}).partial().strict();

/** The round an answer names: `roundId`, or `checkinId` and `date`. */
function roundOf(args: { roundId?: string; checkinId?: string; date?: string }, userId: string): string {
  if (args.roundId) return args.roundId.toLowerCase();
  if (args.checkinId && args.date) return roundByDate(args.checkinId, args.date, userId);
  throw new McpToolError("INVALID", "Give roundId, or checkinId and date");
}

const roundArgs = {
  roundId: z.string().uuid().optional().describe("The round (from get_due_checkins or list_checkin_rounds)"),
  checkinId: ref.optional().describe("Or the standup (id or short id) with date"),
  date: date.optional().describe("The round's date, YYYY-MM-DD")
};

export const answerTool = defineTool({
  name: "answer_checkin",
  title: "Answer a standup",
  description: "Answer (or edit your answer to) a standup round you take part in, as the key's owner. Answers after your deadline count as late; a round takes answers until a day after it closes. Card keys like KAN-12 in a blockers answer link the card and flag it Blocked when you can edit it.",
  scopes: ["checkins:write"],
  // goalUpdates name goals: the handler needs the key to reach Goals' writes on its whole module (T596), and Goals checks each goal as the person.
  access: { mode: "items", items: [{ arg: "roundId", kind: "checkin_round", ifAbsent: "allow" }, { arg: "checkinId", kind: "checkin", ifAbsent: "allow" }], related: ["goalUpdates"] },
  write: true,
  annotations: { idempotentHint: true },
  inputSchema: z.object({ ...roundArgs, answers, goalUpdates: goalUpdatesSchema.optional().describe("For a goal_update question: check-ins on your goals, [{ goalId, values: { <keyResultId>: number }, health?, confidence? }] (list_goals mine, get_goal)") }).strict(),
  outputSchema: z.object({ status: z.string(), edited: z.boolean(), blockers: z.number(), roundId: z.string() }),
  handler: (args, key) => run(() => {
    const roundId = roundOf(args, key.userId);
    if (args.goalUpdates?.length && keyReach(key, "goals:write") !== "all") throw new McpToolError("SCOPE_REQUIRED", "Goal updates need a key with goals:write on every goal");
    const result = answerRound(key.userId, roundId, { answers: args.answers, goalUpdates: args.goalUpdates });
    return { status: result.status, edited: result.edited, blockers: result.blockers, roundId };
  })
});

export const checkinTools = [
  defineTool({
    name: "list_checkins",
    title: "List standups",
    description: "Standups (scheduled standups, weekly updates, retros, pulse surveys) the user can read, by name. mine: participant lists only those they take part in. Each has its schedule, participants, the user's streak, and the last round's participation.",
    scopes: ["checkins:read"],
    access: { mode: "list", lists: ["checkin"] },
    write: false,
    inputSchema: z.object({ mine: z.enum(["participant", "all"]).optional(), cursor: z.string().max(500).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    handler: ({ mine, cursor, limit }, key) => run(() => listCheckins(key.userId, { mine, cursor, limit, ids: ids(key) }))
  }),
  defineTool({
    name: "get_checkin",
    title: "Get a standup",
    description: "One standup: its questions (ids, types, roles), schedule, deadline, participants, and summary options.",
    scopes: ["checkins:read"],
    access: { mode: "items", items: [{ arg: "checkinId", kind: "checkin" }] },
    write: false,
    inputSchema: z.object({ checkinId: ref }).strict(),
    handler: ({ checkinId }, key) => run(() => detailOf(checkinId, key.userId))
  }),
  defineTool({
    name: "list_checkin_rounds",
    title: "List a standup's rounds",
    description: "A standup's rounds, newest first, with participation counts and the user's own status.",
    scopes: ["checkins:read"],
    access: { mode: "items", items: [{ arg: "checkinId", kind: "checkin" }] },
    write: false,
    inputSchema: z.object({ checkinId: ref, cursor: date.optional() }).strict(),
    handler: ({ checkinId, cursor }, key) => run(() => roundsPage(checkinId, key.userId, cursor))
  }),
  defineTool({
    name: "get_checkin_round",
    title: "Read a standup round",
    description: "One round's report: participation, blockers, mood, and the answers the user may read (anonymous standups: no names, nothing before three answers).",
    scopes: ["checkins:read"],
    access: { mode: "items", items: [{ arg: "roundId", kind: "checkin_round", ifAbsent: "allow" }, { arg: "checkinId", kind: "checkin", ifAbsent: "allow" }] },
    write: false,
    inputSchema: z.object(roundArgs).strict(),
    handler: (args, key) => run(() => roundView(roundOf(args, key.userId), key.userId))
  }),
  defineTool({
    name: "summarize_checkin_round",
    title: "Summarize a standup round",
    description: "A structured summary of a round for writing a recap: who answered, who is pending, skipped, or out, the blockers with the cards they name, the mood, and each answer by question title.",
    scopes: ["checkins:read"],
    access: { mode: "items", items: [{ arg: "roundId", kind: "checkin_round", ifAbsent: "allow" }, { arg: "checkinId", kind: "checkin", ifAbsent: "allow" }] },
    write: false,
    inputSchema: z.object(roundArgs).strict(),
    handler: (args, key) => run(() => roundSummary(roundOf(args, key.userId), key.userId))
  }),
  defineTool({
    name: "get_due_checkins",
    title: "Standups due",
    description: "Rounds open for the user that they have not answered yet, soonest deadline first. Answer one with answer_checkin.",
    scopes: ["checkins:read"],
    access: { mode: "list", lists: ["checkin"] },
    write: false,
    inputSchema: z.object({}).strict(),
    handler: (_args, key) => run(() => ({ items: dueRounds(key.userId, Date.now(), 50, ids(key)) }))
  }),
  defineTool({
    name: "get_checkin_feed",
    title: "Read the standups feed",
    description: "Recent named answers across the standups the user reads, newest first. Filter by standup, person (user id), blockersOnly, or q (words in the answers).",
    scopes: ["checkins:read"],
    access: { mode: "list", lists: ["checkin"], items: [{ arg: "checkinId", kind: "checkin", ifAbsent: "allow" }], related: ["person"] },
    write: false,
    inputSchema: z.object({ checkinId: ref.optional(), person: z.string().uuid().optional(), blockersOnly: z.boolean().optional(), q: z.string().max(200).optional(), cursor: z.string().max(500).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    handler: (args, key) => run(() => feed(key.userId, { checkin: args.checkinId, person: args.person, blockers: args.blockersOnly, q: args.q, cursor: args.cursor, limit: args.limit, ids: ids(key) }))
  }),
  answerTool,
  defineTool({
    name: "skip_checkin",
    title: "Skip a standup round",
    description: "Skip a round you take part in and have not answered (it shows as skipped, not missed).",
    scopes: ["checkins:write"],
    access: { mode: "items", items: [{ arg: "roundId", kind: "checkin_round", ifAbsent: "allow" }, { arg: "checkinId", kind: "checkin", ifAbsent: "allow" }] },
    write: true,
    inputSchema: z.object(roundArgs).strict(),
    handler: (args, key) => run(() => skipRound(key.userId, roundOf(args, key.userId)))
  }),
  defineTool({
    name: "checkin_stats",
    title: "Standup stats",
    description: "Participation per round, the participation rate, each person's answered/late/skipped/missed counts and streak, and the mood trend (anonymous: only rounds with three answers or more).",
    scopes: ["checkins:read"],
    access: { mode: "items", items: [{ arg: "checkinId", kind: "checkin" }] },
    write: false,
    inputSchema: z.object({ checkinId: ref, from: date.optional(), to: date.optional() }).strict(),
    handler: ({ checkinId, from, to }, key) => run(() => stats(checkinId, key.userId, { from, to }))
  }),
  defineTool({
    name: "create_checkin",
    title: "Create a standup",
    description: `Create a standup from a template (${CHECKIN_TEMPLATES.join(", ")}): it seeds the questions, the schedule (weekdays at a time, in each person's zone by default), the deadline, and the reminder. participants are user ids (the user alone when omitted).`,
    scopes: ["checkins:write"],
    access: { mode: "global", related: ["participants", "groups"] },
    write: true,
    annotations: { idempotentHint: false },
    inputSchema: z.object({
      template: z.enum(CHECKIN_TEMPLATES), name: z.string().min(1).max(120).optional(), description: z.string().max(4000).optional(), schedule: scheduleInput.optional(),
      deadlineMinutes: z.number().int().min(30).max(10_080).optional(), reminderMinutesBefore: z.number().int().min(5).max(10_080).nullable().optional(),
      participants: z.array(z.string().uuid()).max(200).optional(), groups: z.array(z.string().uuid()).max(20).optional()
    }).strict(),
    handler: (args, key) => run(() => {
      const row = createCheckin(key.userId, { ...args, participants: args.participants || args.groups ? { people: args.participants ?? [], groups: args.groups ?? [] } : undefined } as never);
      return detailOf(row.id, key.userId);
    })
  }),
  defineTool({
    name: "update_checkin",
    title: "Update a standup",
    description: "Change a standup's name, description, schedule, deadline, reminder, or status (paused stops new rounds). expectedRevision guards against overwriting someone else's change.",
    scopes: ["checkins:write"],
    access: { mode: "items", items: [{ arg: "checkinId", kind: "checkin" }] },
    write: true,
    inputSchema: z.object({
      checkinId: ref, name: z.string().min(1).max(120).optional(), description: z.string().max(4000).optional(), schedule: scheduleInput.optional(),
      deadlineMinutes: z.number().int().min(30).max(10_080).optional(), reminderMinutesBefore: z.number().int().min(5).max(10_080).nullable().optional(),
      status: z.enum(["active", "paused"]).optional(), expectedRevision: z.number().int().positive().optional()
    }).strict(),
    handler: ({ checkinId, ...patch }, key) => run(() => detailOf(updateCheckin(key.userId, checkinId, patch as never).id, key.userId))
  }),
  defineTool({
    name: "set_checkin_participants",
    title: "Set a standup's participants",
    description: "Replace who takes part: people (user ids) and groups (group ids; their members take part and follow the group). People who join get the open round too.",
    scopes: ["checkins:write"],
    access: { mode: "items", items: [{ arg: "checkinId", kind: "checkin" }], related: ["people", "groups"] },
    write: true,
    annotations: { idempotentHint: true },
    inputSchema: z.object({ checkinId: ref, people: z.array(z.string().uuid()).max(200), groups: z.array(z.string().uuid()).max(20).optional() }).strict(),
    handler: ({ checkinId, people, groups }, key) => run(() => setParticipants(key.userId, checkinId, { people, groups: groups ?? [] }))
  }),
  defineTool({
    name: "bin_checkin",
    title: "Move a standup to the Bin",
    description: `Move a standup, with its rounds and answers, to the Bin (owner or manager). ${BIN_DESCRIPTION}`,
    scopes: ["checkins:write"],
    alsoRequires: ["bin:write"],
    access: { mode: "items", items: [{ arg: "checkinId", kind: "checkin" }] },
    write: true,
    buckets: BIN_BUCKETS,
    annotations: { destructiveHint: true },
    inputSchema: z.object({ checkinId: ref }).strict(),
    handler: ({ checkinId }, key) => run(() => deleteCheckin(key.userId, checkinId))
  }),
  defineTool({
    name: "restore_checkin",
    title: "Restore a standup from the Bin",
    description: "Restore a standup you own or binned from the Bin, with its rounds and answers; its schedule starts again.",
    scopes: ["checkins:write"],
    alsoRequires: ["bin:write"],
    access: { mode: "items", items: [{ arg: "checkinId", kind: "checkin" }] },
    write: true,
    inputSchema: z.object({ checkinId: z.string().uuid() }).strict(),
    handler: async ({ checkinId }, key) => restoreResult(await binProvider.restore(checkinId.toLowerCase(), key.userId), "Standup")
  })
];

export const CHECKIN_READ_TOOLS = ["list_checkins", "get_checkin", "list_checkin_rounds", "get_checkin_round", "summarize_checkin_round", "get_due_checkins", "get_checkin_feed", "checkin_stats"];
export const CHECKIN_WRITE_TOOLS = ["answer_checkin", "skip_checkin", "create_checkin", "update_checkin", "set_checkin_participants", "bin_checkin", "restore_checkin"];

/** `nook://checkin_round/<id>`: a round's report, through the same checks as get_checkin_round. */
export const roundResource = {
  kind: "checkin_round", title: "Standup round", description: "A standup round: participation, blockers, mood, and the answers you may read.",
  scopes: ["checkins:read" as const], itemKind: "checkin_round" as const,
  read: (id: string, key: McpKeyContext) => {
    try {
      const round = roundRow(id);
      const row = round ? checkinRow(round.checkin_id) : null;
      if (!round || checkinLevel(row, key.userId) === "none") return null;
      return roundView(round.id, key.userId);
    } catch {
      return null;
    }
  }
};
