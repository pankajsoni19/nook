import * as z from "zod/v4";
import { CHECKIN_CADENCES, GOAL_HEALTHS, GOAL_KINDS, KR_DIRECTIONS, KR_METRICS, PROGRESS_MODES } from "../../shared/goals";

/** Request shapes shared by the HTTP routes and the MCP tools (lane GOALS, §D.3). */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const id = z.string().uuid();
const finite = z.number().finite().gte(-1e15).lte(1e15);

export const sourceSchema = z.object({ kind: z.string().min(1).max(32), config: z.unknown().optional() }).strict();

export const krInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  ownerId: id.nullish(),
  metric: z.enum(KR_METRICS).optional(),
  direction: z.enum(KR_DIRECTIONS).optional(),
  startValue: finite.optional(),
  targetValue: finite.optional(),
  currentValue: finite.optional(),
  unit: z.string().max(16).nullish(),
  currency: z.string().length(3).nullish(),
  weight: z.number().gt(0).lte(100).optional(),
  source: sourceSchema.nullish(),
  milestones: z.array(z.object({ id: id.optional(), title: z.string().trim().min(1).max(200), done: z.boolean().optional() }).strict()).max(50).optional(),
  position: z.number().finite().optional()
}).strict();

export const krPatchSchema = krInputSchema.partial().extend({ expectedRevision: z.number().int().positive().optional() }).strict();

export const goalInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
  kind: z.enum(GOAL_KINDS).optional(),
  parentId: id.nullish(),
  periodId: id.nullish(),
  teamId: id.nullish(),
  ownerId: id.optional(),
  startOn: date.nullish(),
  dueOn: date.nullish(),
  state: z.enum(["draft", "active"]).optional(),
  progressMode: z.enum(PROGRESS_MODES).optional(),
  cadence: z.enum(CHECKIN_CADENCES).optional(),
  visibility: z.enum(["private", "all_users"]).optional(),
  shareRole: z.enum(["view", "comment", "edit"]).optional(),
  contributorIds: z.array(id).max(50).optional(),
  keyResults: z.array(krInputSchema).max(25).optional(),
  color: z.string().max(16).nullish()
}).strict();

export const goalPatchSchema = goalInputSchema.omit({ keyResults: true }).partial().extend({
  health: z.enum(GOAL_HEALTHS).optional(),
  progress: z.number().min(0).max(1).optional(),
  expectedRevision: z.number().int().positive().optional()
}).strict();

export const checkinSchema = z.object({
  health: z.enum(GOAL_HEALTHS),
  confidence: z.number().int().min(1).max(10).nullish(),
  note: z.string().max(10_000).nullish(),
  values: z.record(z.string(), z.union([finite, z.boolean()])).optional(),
  milestonesDone: z.record(z.string(), z.array(z.string().max(64)).max(50)).optional()
}).strict();

export const closeSchema = z.object({
  state: z.enum(["achieved", "missed", "dropped", "carried_over"]),
  carryOver: z.object({ periodId: id }).strict().nullish()
}).strict();

export const periodSchema = z.object({ name: z.string().trim().min(1).max(60), startsOn: date, endsOn: date }).strict();
export const periodPatchSchema = periodSchema.partial().extend({ archived: z.boolean().optional() }).strict();
