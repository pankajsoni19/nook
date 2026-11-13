import { z } from "zod";
import { db } from "../db";
import { readableBoard, readableBoardPredicate, readableCard } from "../tasks/access";
import { readableViewPredicate } from "../tasks/views";
import { compileTaskQuery } from "../tasks/query";
import { visibleEstimateSql } from "../tasks/estimateSql";
import { dateInZone } from "../today/registry";
import { parse } from "../../shared/taskQuery";
import type { ProgressContext, ProgressSource, ProgressValue } from "../goalsProgress";

/**
 * The `tasks` progress source (lane GOALS, §D.3, §C7, D906, T540, T543): done / total cards (or
 * estimate points, or estimated hours) of a board, a saved view, a filter, a sprint, an epic, or a tag.
 * It reads **as the KR's owner** (`readableBoardPredicate` with the owner's id), so it counts only cards
 * the owner can read, and returns numbers only. Every query is one bounded COUNT/SUM over indexed
 * columns (board, sprint, parent, tag).
 *
 * Done means a card in a done column, or archived after it was done (archiving finished work keeps
 * counting); total leaves out cards archived without being done.
 */

export const TASK_SCOPES = ["board", "view", "filter", "sprint", "epic", "tag"] as const;
export const TASK_MEASURES = ["cards", "points", "hours"] as const;

export const tasksSourceSchema = z.object({
  scope: z.enum(TASK_SCOPES),
  /** The board, view, sprint, epic card, or tag id. */
  id: z.string().uuid().optional(),
  /** A Tasks filter (`board:MYT tag:launch`) for scope `filter`. */
  query: z.string().min(1).max(500).optional(),
  measure: z.enum(TASK_MEASURES).default("cards")
}).strict().superRefine((value, context) => {
  if (value.scope === "filter" ? !value.query : !value.id) context.addIssue({ code: "custom", message: value.scope === "filter" ? "Write a filter" : "Choose what to count" });
});
export type TasksSourceConfig = z.infer<typeof tasksSourceSchema>;

const FROM = "FROM cards k JOIN boards b ON b.id = k.board_id LEFT JOIN board_columns col ON col.id = k.column_id";
const DONE = "(COALESCE(col.is_done, 0) = 1 OR (k.archived_at IS NOT NULL AND k.done_at IS NOT NULL))";
const COUNTED = `(k.archived_at IS NULL OR ${DONE})`;

function scopeSql(config: TasksSourceConfig, userId: string, tz: string, nowMs: number): { where: string; params: Record<string, string | number> } | null {
  switch (config.scope) {
    case "board": return readableBoard(config.id!, userId) ? { where: "k.board_id = $scopeId", params: { scopeId: config.id! } } : null;
    case "sprint": {
      const sprint = db.query("SELECT board_id FROM board_sprints WHERE id = ?").get(config.id!) as { board_id: string } | null;
      return sprint && readableBoard(sprint.board_id, userId) ? { where: "k.sprint_id = $scopeId", params: { scopeId: config.id! } } : null;
    }
    case "epic": return readableCard(config.id!, userId)
      ? { where: "(k.parent_card_id = $scopeId OR k.parent_card_id IN (SELECT e.id FROM cards e WHERE e.parent_card_id = $scopeId AND e.deleted_at IS NULL))", params: { scopeId: config.id! } }
      : null;
    case "tag": {
      const tag = db.query("SELECT board_id FROM board_tags WHERE id = ?").get(config.id!) as { board_id: string } | null;
      return tag && readableBoard(tag.board_id, userId) ? { where: "EXISTS (SELECT 1 FROM card_tags ct WHERE ct.card_id = k.id AND ct.tag_id = $scopeId)", params: { scopeId: config.id! } } : null;
    }
    case "view":
    case "filter": {
      let text = config.query ?? "";
      if (config.scope === "view") {
        const view = db.query(`SELECT v.query FROM task_views v JOIN users u ON u.id = v.owner_id WHERE v.id = $viewId AND ${readableViewPredicate}`).get({ viewId: config.id!, userId }) as { query: string } | null;
        if (!view) return null;
        text = view.query;
      }
      const parsed = parse(text);
      if (!parsed.ok) return null;
      const now = new Date(nowMs);
      const compiled = compileTaskQuery(parsed.query, { userId, today: dateInZone(now, tz), nowTime: now.toISOString().slice(11, 16) });
      return { where: `(${compiled.where})`, params: compiled.params };
    }
  }
}

/** Done and total for a config, as `userId`; null when it names something they cannot read. */
export function countTasks(config: TasksSourceConfig, userId: string, tz = "UTC", nowMs = Date.now()): { done: number; total: number } | null {
  const scope = scopeSql(config, userId, tz, nowMs);
  if (!scope) return null;
  const estimate = visibleEstimateSql("b.estimate_kind");
  const measure = config.measure === "cards" ? "1" : `(CASE WHEN b.estimate_kind = '${config.measure === "points" ? "points" : "hours"}' THEN COALESCE(${estimate}, 0) ELSE 0 END)`;
  const row = db.query(`SELECT COALESCE(SUM(CASE WHEN ${DONE} THEN ${measure} ELSE 0 END), 0) AS done, COALESCE(SUM(${measure}), 0) AS total
    ${FROM} WHERE k.deleted_at IS NULL AND ${COUNTED} AND ${scope.where} AND ${readableBoardPredicate}`)
    .get({ ...scope.params, userId }) as { done: number; total: number };
  return { done: Math.round(row.done * 100) / 100, total: Math.round(row.total * 100) / 100 };
}

const MEASURE_WORD: Record<TasksSourceConfig["measure"], string> = { cards: "Done cards", points: "Points done", hours: "Estimated hours done" };

/** What the config counts, named for a viewer (a board they cannot open is not named, T540). */
export function describeTasks(config: TasksSourceConfig, viewerId: string): string {
  const word = MEASURE_WORD[config.measure];
  const named = (sql: string, id: string, canRead: (row: Record<string, string>) => boolean) => {
    const row = db.query(sql).get(id) as Record<string, string> | null;
    return row && canRead(row) ? row.name : null;
  };
  switch (config.scope) {
    case "board": { const name = named("SELECT id, name FROM boards WHERE id = ?", config.id!, (row) => readableBoard(row.id!, viewerId) !== null); return name ? `${word} on ${name}` : `${word} on a board you can't open`; }
    case "sprint": { const name = named("SELECT name, board_id FROM board_sprints WHERE id = ?", config.id!, (row) => readableBoard(row.board_id!, viewerId) !== null); return name ? `${word} in sprint ${name}` : `${word} in a sprint you can't open`; }
    case "epic": { const name = named("SELECT id, title AS name FROM cards WHERE id = ?", config.id!, (row) => readableCard(row.id!, viewerId) !== null); return name ? `${word} under ${name}` : `${word} under a card you can't open`; }
    case "tag": { const name = named("SELECT name, board_id FROM board_tags WHERE id = ?", config.id!, (row) => readableBoard(row.board_id!, viewerId) !== null); return name ? `${word} tagged ${name}` : `${word} with a tag you can't open`; }
    case "view": {
      const row = db.query(`SELECT v.name FROM task_views v JOIN users u ON u.id = v.owner_id WHERE v.id = $viewId AND ${readableViewPredicate}`).get({ viewId: config.id!, userId: viewerId }) as { name: string } | null;
      return row ? `${word} in view ${row.name}` : `${word} in a view you can't open`;
    }
    case "filter": return `${word} matching ${config.query}`;
  }
}

export const tasksProgressSource: Omit<ProgressSource<TasksSourceConfig>, "kind"> = {
  label: "Tasks",
  module: "tasks",
  configSchema: tasksSourceSchema as unknown as z.ZodType<TasksSourceConfig>,
  describe: (config, context) => describeTasks(config, context.viewerId),
  compute: (config: TasksSourceConfig, context: ProgressContext): ProgressValue | null => {
    const counts = countTasks(config, context.ownerId, context.tz, context.nowMs);
    if (!counts) return null;
    const unit = config.measure === "cards" ? "cards" : config.measure === "points" ? "points" : "hours";
    return { value: counts.done, target: counts.total, detail: `${counts.done} of ${counts.total} ${unit}` };
  }
};
