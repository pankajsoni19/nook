import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../auth";
import { audit, db, now } from "../db";
import { parseJson } from "../validation";
import { LinkError } from "../links/service";
import { cancelSchedules, upsertSchedule } from "../schedules/service";
import type { ModuleRouter } from "../workspaceRegistry";
import { isValidTimeZone } from "../../shared/calendarRecurrence";
import { ROUNDING_MINUTES, type RoundingMinutes } from "../../shared/duration";
import { isWorkKind } from "../../shared/workRefs";
import { SUMMARY_GROUPS, TIME_SOURCES, type SummaryGroup } from "../../shared/time";
import {
  bulkEntries, createEntry, deleteEntry, listEntries, parseSeconds, recentEntries, runningView, splitEntry, startTimer, stopTimer, TimeError, updateEntry, type EntryFilters
} from "./service";
import { binProject, createClient, createProject, decideWeek, listApprovals, listClients, listProjects, projectRates, projectView, setMemberRate, submitWeek, updateProject } from "./projects";
import { cardTotals, exportCsv, setCell, suggestions, summarize, timeForTarget, timesheet, todayTotals } from "./reports";

/**
 * Time's HTTP API (lane TIME, docs/plan/WORKSPACE_MODULES.md §D.2 "HTTP"), mounted through the module
 * registry behind every session, CSRF, two-factor, and role-write guard (D815). Errors are
 * `{ error, code }`; anything the caller cannot read is NOT_FOUND (T90).
 */

const ref = z.union([z.string().max(2048), z.object({ kind: z.string().max(24), id: z.string().max(64) }).strict(), z.object({ ref: z.string().max(2048) }).strict()]);
const tags = z.array(z.string().max(80)).max(10);
const isoTime = z.string().max(40);
const duration = z.union([z.number().int().min(0).max(86_400), z.string().max(32)]);

export const startSchema = z.object({
  description: z.string().max(600).nullish(), projectId: z.string().max(64).nullish(), target: ref.nullish(), billable: z.boolean().optional(),
  tags: tags.optional(), startedAt: isoTime.optional(), tz: z.string().max(64).optional()
}).strict();
export const entrySchema = z.object({
  startedAt: isoTime, duration: duration.nullish(), endedAt: isoTime.nullish(), description: z.string().max(600).nullish(), projectId: z.string().max(64).nullish(),
  target: ref.nullish(), billable: z.boolean().optional(), tags: tags.optional(), tz: z.string().max(64).optional(), source: z.enum(["manual", "calendar", "import"]).optional()
}).strict();
export const patchSchema = z.object({
  description: z.string().max(600).optional(), projectId: z.string().max(64).nullable().optional(), target: ref.nullable().optional(), billable: z.boolean().optional(),
  tags: tags.optional(), startedAt: isoTime.optional(), duration: duration.optional(), endedAt: isoTime.optional(), tz: z.string().max(64).optional(), expectedRevision: z.number().int().optional()
}).strict();
const bulkSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), items: z.array(entrySchema).min(1).max(100), dryRun: z.boolean().optional() }).strict(),
  z.object({ op: z.literal("update"), items: z.array(patchSchema.extend({ id: z.string().max(64) })).min(1).max(100), dryRun: z.boolean().optional() }).strict(),
  z.object({ op: z.literal("delete"), items: z.array(z.object({ id: z.string().max(64) }).strict()).min(1).max(100), dryRun: z.boolean().optional() }).strict()
]);
const cellSchema = z.object({ day: z.string().max(10), projectId: z.string().max(64).nullable(), target: ref.nullable(), duration: duration.nullable(), tz: z.string().max(64).optional() }).strict();
export const projectSchema = z.object({
  name: z.string().max(200).optional(), code: z.string().max(20).nullish(), color: z.string().max(24).optional(), clientId: z.string().max(64).nullish(), newClient: z.string().max(200).nullish(),
  boardId: z.string().max(64).nullish(), billableDefault: z.boolean().optional(), rateMinor: z.number().int().min(0).max(100_000_000_000).nullish(), currency: z.string().length(3).optional(),
  budget: z.object({ kind: z.enum(["none", "hours", "money"]), value: z.number().int().min(0).nullish(), period: z.enum(["total", "monthly"]).optional() }).strict().optional(),
  settings: z.object({ privateEntries: z.boolean().optional(), requireDescription: z.boolean().optional() }).strict().optional(),
  archived: z.boolean().optional(), visibility: z.enum(["private", "all_users"]).optional(), memberIds: z.array(z.string().uuid()).max(50).optional(), expectedRevision: z.number().int().optional()
}).strict();
const settingsSchema = z.object({
  dailyReminder: z.boolean(), reminderAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), reminderDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  longTimerHours: z.number().int().min(0).max(24), tz: z.string().max(64)
}).strict();

export function timeErrorResponse(c: Context<AppEnv>, error: unknown) {
  if (error instanceof TimeError) return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  if (error instanceof LinkError) return c.json({ error: error.status === 404 ? "Work item not found" : error.message, code: error.code }, error.status);
  throw error;
}

const guarded = (handler: (c: Context<AppEnv>) => Response | Promise<Response>) => async (c: Context<AppEnv>) => {
  try {
    return await handler(c);
  } catch (error) {
    return timeErrorResponse(c, error);
  }
};

function filtersOf(c: Context<AppEnv>): EntryFilters {
  const query = (name: string) => c.req.query(name) || undefined;
  const target = query("target");
  let parsedTarget: EntryFilters["target"];
  if (target) {
    const [kind, id] = target.split(":");
    if (!isWorkKind(kind) || !id) throw new TimeError(400, "INVALID", "target is kind:id");
    parsedTarget = { kind, id: id.toLowerCase() };
  }
  const billable = query("billable");
  return {
    from: query("from"), to: query("to"), user: query("user"), projectId: query("project") === "none" ? undefined : query("project"), noProject: query("project") === "none",
    target: parsedTarget, billable: billable === undefined ? undefined : billable === "true" || billable === "1", tag: query("tag"), q: query("q"), tz: query("tz"),
    cursor: query("cursor") ?? null, limit: query("limit") ? Number(query("limit")) : undefined
  };
}

function summaryInput(c: Context<AppEnv>) {
  const groupBy = (c.req.query("groupBy") ?? "project").split(",").filter((group): group is SummaryGroup => (SUMMARY_GROUPS as readonly string[]).includes(group));
  const rounding = Number(c.req.query("rounding") ?? 0);
  return {
    ...filtersOf(c), user: c.req.query("user") || "all", groupBy,
    rounding: ((ROUNDING_MINUTES as readonly number[]).includes(rounding) ? rounding : 0) as RoundingMinutes,
    roundingMode: c.req.query("roundingMode") === "up" ? "up" as const : "nearest" as const
  };
}

export function readUserSettings(userId: string) {
  const row = db.query("SELECT * FROM time_user_settings WHERE user_id = ?").get(userId) as { daily_reminder: number; reminder_at: string; reminder_days: string; long_timer_hours: number; tz: string } | null;
  return {
    dailyReminder: row?.daily_reminder === 1, reminderAt: row?.reminder_at ?? "17:00", reminderDays: row ? JSON.parse(row.reminder_days) as number[] : [1, 2, 3, 4, 5],
    longTimerHours: row?.long_timer_hours ?? 8, tz: row?.tz ?? "UTC"
  };
}

export function writeUserSettings(userId: string, input: z.infer<typeof settingsSchema>) {
  if (!isValidTimeZone(input.tz)) throw new TimeError(400, "INVALID", "Unknown time zone");
  db.transaction(() => {
    db.query(`INSERT INTO time_user_settings (user_id, daily_reminder, reminder_at, reminder_days, long_timer_hours, tz, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET daily_reminder = excluded.daily_reminder, reminder_at = excluded.reminder_at, reminder_days = excluded.reminder_days,
        long_timer_hours = excluded.long_timer_hours, tz = excluded.tz, updated_at = excluded.updated_at`)
      .run(userId, input.dailyReminder ? 1 : 0, input.reminderAt, JSON.stringify([...new Set(input.reminderDays)].sort()), input.longTimerHours, input.tz, now());
    if (input.dailyReminder) upsertSchedule({ kind: "time_user", id: userId }, "time.daily_reminder", { cadence: { weekdays: [...new Set(input.reminderDays)].sort(), at: input.reminderAt } }, {}, { tz: input.tz, userId });
    else cancelSchedules({ kind: "time_user", id: userId }, "time.daily_reminder");
    audit(userId, null, "time.settings_update", { dailyReminder: input.dailyReminder, longTimerHours: input.longTimerHours });
  })();
  return readUserSettings(userId);
}

/** Remembers the browser's zone for reminders and timesheets the first time it is seen. */
function noteZone(userId: string, tz: string | undefined) {
  if (!tz || !isValidTimeZone(tz)) return;
  db.query("INSERT OR IGNORE INTO time_user_settings (user_id, tz, updated_at) VALUES (?, ?, ?)").run(userId, tz, now());
}

export function registerTimeRoutes(router: ModuleRouter) {
  const me = (c: Context<AppEnv>) => c.get("user").id;

  // The timer
  router.get("/api/time/timer", guarded((c) => {
    noteZone(me(c), c.req.query("tz"));
    return c.json({ entry: runningView(me(c)), today: todayTotals(me(c), c.req.query("tz")) });
  }));
  router.post("/api/time/timer/start", guarded(async (c) => {
    const body = await parseJson(c.req.raw, startSchema);
    noteZone(me(c), body.tz);
    const result = startTimer({ userId: me(c) }, body);
    return c.json(result, 201);
  }));
  router.post("/api/time/timer/stop", guarded(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ at: isoTime.optional() }).strict());
    return c.json({ entry: stopTimer({ userId: me(c) }, body.at) });
  }));

  // Entries
  router.get("/api/time/entries", guarded((c) => c.json(listEntries(me(c), filtersOf(c)))));
  router.get("/api/time/recent", guarded((c) => c.json({ entries: recentEntries(me(c)) })));
  router.post("/api/time/entries", guarded(async (c) => {
    const body = await parseJson(c.req.raw, entrySchema);
    return c.json({ entry: createEntry({ userId: me(c) }, body) }, 201);
  }));
  router.post("/api/time/entries/bulk", guarded(async (c) => {
    const body = await parseJson(c.req.raw, bulkSchema);
    return c.json(bulkEntries({ userId: me(c) }, body as never));
  }));
  router.patch("/api/time/entries/:id", guarded(async (c) => {
    const body = await parseJson(c.req.raw, patchSchema);
    return c.json({ entry: updateEntry({ userId: me(c) }, c.req.param("id") ?? "", body) });
  }));
  router.delete("/api/time/entries/:id", guarded((c) => c.json(deleteEntry({ userId: me(c) }, c.req.param("id") ?? ""))));
  router.post("/api/time/entries/:id/split", guarded(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ at: isoTime }).strict());
    return c.json({ entries: splitEntry({ userId: me(c) }, c.req.param("id") ?? "", body.at) });
  }));

  // Timesheet
  router.get("/api/time/timesheet", guarded((c) => c.json(timesheet(me(c), c.req.query("week"), c.req.query("tz"), { carry: c.req.query("carry") === "1" }))));
  router.put("/api/time/timesheet/cell", guarded(async (c) => {
    const body = await parseJson(c.req.raw, cellSchema);
    const seconds = body.duration === null ? null : typeof body.duration === "number" ? body.duration : parseSeconds(body.duration, me(c));
    if (body.duration !== null && seconds === null) throw new TimeError(400, "INVALID", "Use 1h 30m, 90m, or 1:30");
    return c.json(setCell({ userId: me(c) }, { ...body, duration: seconds, target: body.target as never }));
  }));

  // Reports
  router.get("/api/time/summary", guarded((c) => c.json(summarize(me(c), summaryInput(c)))));
  router.get("/api/time/export.csv", guarded((c) => {
    const csv = exportCsv(me(c), summaryInput(c));
    audit(me(c), null, "time.export", { from: c.req.query("from") ?? null, to: c.req.query("to") ?? null });
    const name = `time-${c.req.query("from") ?? "all"}-${c.req.query("to") ?? "now"}.csv`.replace(/[^a-z0-9.-]/gi, "_");
    return new Response(`﻿${csv}`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
  }));

  // Projects, clients, rates
  router.get("/api/time/projects", guarded((c) => c.json({ projects: listProjects(me(c), { archived: c.req.query("archived") === "1" ? undefined : c.req.query("archived") === "0" ? false : undefined, q: c.req.query("q"), loggable: c.req.query("loggable") === "1" }) })));
  router.post("/api/time/projects", guarded(async (c) => {
    const body = await parseJson(c.req.raw, projectSchema);
    return c.json({ project: createProject(me(c), body) }, 201);
  }));
  router.get("/api/time/projects/:id", guarded((c) => {
    const project = projectView(c.req.param("id") ?? "", me(c));
    return project ? c.json({ project }) : c.json({ error: "Project not found", code: "NOT_FOUND" }, 404);
  }));
  router.patch("/api/time/projects/:id", guarded(async (c) => {
    const body = await parseJson(c.req.raw, projectSchema);
    return c.json({ project: updateProject(me(c), c.req.param("id") ?? "", body) });
  }));
  router.delete("/api/time/projects/:id", guarded((c) => c.json(binProject(me(c), c.req.param("id") ?? ""))));
  router.get("/api/time/projects/:id/rates", guarded((c) => c.json(projectRates(me(c), c.req.param("id") ?? ""))));
  router.put("/api/time/projects/:id/rates/:userId", guarded(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ rateMinor: z.number().int().min(0).max(100_000_000_000).nullable() }).strict());
    return c.json(setMemberRate(me(c), c.req.param("id") ?? "", (c.req.param("userId") ?? "").toLowerCase(), body.rateMinor));
  }));
  router.get("/api/time/clients", guarded((c) => c.json({ clients: listClients(me(c), c.req.query("q") ?? "") })));
  router.post("/api/time/clients", guarded(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ name: z.string().max(200) }).strict());
    return c.json({ client: createClient(body.name, me(c)) }, 201);
  }));
  router.get("/api/time/tags", guarded((c) => c.json({ tags: (db.query("SELECT name FROM time_tags ORDER BY name COLLATE NOCASE LIMIT 500").all() as Array<{ name: string }>).map((row) => row.name) })));

  // Approvals
  router.get("/api/time/approvals", guarded((c) => c.json({ approvals: listApprovals(me(c), { projectId: c.req.query("project"), mine: c.req.query("mine") === "1", status: c.req.query("status") }) })));
  router.post("/api/time/approvals", guarded(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ projectId: z.string().max(64), weekStart: z.string().max(10), note: z.string().max(500).nullish() }).strict());
    return c.json({ approval: submitWeek(me(c), body.projectId, body.weekStart, body.note) }, 201);
  }));
  router.patch("/api/time/approvals/:id", guarded(async (c) => {
    const body = await parseJson(c.req.raw, z.object({ decision: z.enum(["approve", "reject", "unlock"]), note: z.string().max(500).nullish() }).strict());
    return c.json(decideWeek(me(c), c.req.param("id") ?? "", body.decision, body.note));
  }));

  // Work items
  router.get("/api/time/targets/:kind/:id", guarded((c) => c.json(timeForTarget(me(c), { kind: c.req.param("kind") as never, id: c.req.param("id") ?? "" }))));
  router.get("/api/time/cards", guarded((c) => c.json({ cards: cardTotals(me(c), (c.req.query("ids") ?? "").split(",").slice(0, 500)) })));
  router.get("/api/time/suggestions", guarded((c) => c.json({ suggestions: suggestions(me(c), c.req.query("date") ?? new Date().toISOString().slice(0, 10), c.req.query("tz")) })));

  // Reminders
  router.get("/api/time/settings", guarded((c) => c.json({ settings: readUserSettings(me(c)) })));
  router.put("/api/time/settings", guarded(async (c) => {
    const body = await parseJson(c.req.raw, settingsSchema);
    return c.json({ settings: writeUserSettings(me(c), body) });
  }));
}

/** The writes a guest may send (§G.1 Q8): their own time on projects they belong to; the service checks membership. */
export const GUEST_TIME_WRITES = [
  { method: "POST", path: "/api/time/timer/start" }, { method: "POST", path: "/api/time/timer/stop" }, { method: "POST", path: "/api/time/entries" },
  { method: "PATCH", path: "/api/time/entries/:id" }, { method: "DELETE", path: "/api/time/entries/:id" }, { method: "POST", path: "/api/time/entries/:id/split" },
  { method: "PUT", path: "/api/time/timesheet/cell" }, { method: "POST", path: "/api/time/approvals" }, { method: "PUT", path: "/api/time/settings" }
] as const;

export { TIME_SOURCES };
