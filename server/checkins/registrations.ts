import * as z from "zod/v4";
import { db } from "../db";
import { readableContainerSql } from "../access/workspaceItems";
import { LEVEL_RANK } from "../access/levels";
import { canWriteContent } from "../team/userRole";
import { registerReactionTarget } from "../reactions/targets";
import { McpToolError, type McpKeyContext } from "../mcpToolKit";
import { layout, paragraph, context as contextBlock } from "../mail/layout";
import { defineTemplate } from "../mail/templates/types";
import { activityFooter, itemTitle } from "../mail/templates/common";
import { appLink } from "../mail/links";
import { page as todayPage, sectionIds } from "../today/registry";
import { WORK_KIND_ICONS, type WorkSummary } from "../../shared/workRefs";
import type { WorkKindAdapter } from "../links/adapters";
import type { KindDef } from "../inbox/kinds";
import type { DatasetDef } from "../datasets/registry";
import type { DigestSection } from "../mail/digest";
import type { SearchScopeDef } from "../searchRegistry";
import type { TodayProvider } from "../today/registry";
import type { ProgressContext, ProgressSource } from "../goalsProgress";
import { isShortId } from "../../shared/friendlyUrls";
import { DATE_PATTERN } from "../../shared/checkins";
import type { QuestionSet } from "../../shared/questions";
import { getResponse, setVersion } from "../questions/service";
import { checkinHref, checkinLevel, checkinRow, readableCheckinSql, readsAllAnswers, roundRow, type CheckinRow } from "./store";
import { dateLabel, roundSummaryLine, answerableRound } from "./rounds";
import { dueRounds, roundView } from "./views";
import { answerTool } from "./mcp";

/**
 * Standups' registrations with the foundation registries (docs/plan/WORKSPACE_MODULES.md §B.1): work
 * kinds (`checkin`, `checkin_round`; a round's answers are addressed as `checkin_round` items by their
 * response id, D941), the Bin, Today, search, datasets, progress sources, the summary mail, the
 * `checkin_answer` proposal, the digest section, and the `checkin_answer` reaction target.
 */

// ---------------------------------------------------------------- work kinds

/** A `checkin_round` id: a round, or one of its answers (a response). Returns the round and the answer's author. */
export function roundItem(id: string): { round: NonNullable<ReturnType<typeof roundRow>>; responseAuthor: string | null; isAnswer: boolean } | null {
  const lower = id.toLowerCase();
  const round = roundRow(lower);
  if (round) return { round, responseAuthor: null, isAnswer: false };
  const response = db.query("SELECT subject_id, respondent_user_id, respondent_kind FROM responses WHERE id = ? AND host_kind = 'checkin' AND subject_kind = 'checkin_round'").get(lower) as { subject_id: string; respondent_user_id: string | null; respondent_kind: string } | null;
  if (!response || response.respondent_kind === "anonymous") return null;
  const parent = roundRow(response.subject_id);
  return parent ? { round: parent, responseAuthor: response.respondent_user_id, isAnswer: true } : null;
}

/** The viewer's level on a round item; an answer under `private_answers` only for its author and managers (T550). */
function roundItemLevel(id: string, userId: string) {
  const item = roundItem(id);
  if (!item) return { level: "none" as const, item: null, row: null };
  const row = checkinRow(item.round.checkin_id);
  const level = checkinLevel(row, userId);
  if (level === "none") return { level, item, row };
  if (item.isAnswer && !readsAllAnswers(row!, level) && item.responseAuthor !== userId) return { level: "none" as const, item, row };
  return { level, item, row };
}

const checkinKind: WorkKindAdapter = {
  kind: "checkin", itemKind: "checkin", scopes: { read: "checkins:read", write: "checkins:write" },
  lookup: (ref) => ref.by === "id" ? ref.ref : ref.by === "short_id" ? (db.query("SELECT id FROM checkins WHERE short_id = ?").get(ref.ref) as { id: string } | null)?.id ?? null : null,
  level: (id, viewer) => checkinLevel(checkinRow(id), viewer.userId),
  resolve: (ids, viewer) => new Map(ids.map((id) => {
    const row = checkinRow(id);
    if (!row || checkinLevel(row, viewer.userId) === "none") return [id, null];
    return [id, { kind: "checkin", id: row.id, shortId: row.short_id, title: row.name, subtitle: "Standup", href: checkinHref(row), icon: WORK_KIND_ICONS.checkin, ...(row.status === "paused" ? { status: { label: "Paused", tone: "neutral" as const } } : {}) } satisfies WorkSummary];
  }))
};

const roundKind: WorkKindAdapter = {
  kind: "checkin_round", itemKind: "checkin_round", scopes: { read: "checkins:read", write: "checkins:write" },
  level: (id, viewer) => roundItemLevel(id, viewer.userId).level,
  resolve: (ids, viewer) => new Map(ids.map((id) => {
    const { level, item, row } = roundItemLevel(id, viewer.userId);
    if (level === "none" || !item || !row) return [id, null];
    const author = item.isAnswer && item.responseAuthor ? (db.query("SELECT display_name FROM users WHERE id = ?").get(item.responseAuthor) as { display_name: string } | null)?.display_name : null;
    return [id, {
      kind: "checkin_round", id, title: `${row.name} · ${dateLabel(item.round.round_date)}`, subtitle: author ? `${author}'s answer` : "Standup round",
      href: `${checkinHref(row)}/${item.round.round_date}`, icon: WORK_KIND_ICONS.checkin_round,
      status: item.round.status === "open" ? { label: "Open", tone: "info" as const } : { label: "Closed", tone: "neutral" as const }
    } satisfies WorkSummary];
  }))
};

export const workKinds = [checkinKind, roundKind];

export const itemKinds = [
  { kind: "checkin" as const, anchors: (id: string) => { const row = checkinRow(id); return row ? [{ kind: "checkin" as const, id: row.id }] : null; } },
  { kind: "checkin_round" as const, anchors: (id: string) => { const item = roundItem(id); return item ? [{ kind: "checkin" as const, id: item.round.checkin_id }] : null; } }
];

// ---------------------------------------------------------------- reactions on answers

registerReactionTarget({
  kind: "checkin_answer",
  readable: (targetId, userId) => {
    const { level, item } = roundItemLevel(targetId, userId);
    return level !== "none" && item?.isAnswer ? { lockKey: `checkin:${item.round.checkin_id}` } : null;
  },
  writable: (targetId, userId) => canWriteContent(userId) && LEVEL_RANK[roundItemLevel(targetId, userId).level] >= LEVEL_RANK.comment
});

export { binProvider } from "./bin";

// ---------------------------------------------------------------- Today

export const todayProvider: TodayProvider = {
  href: "/standups", mcpScope: "checkins:read",
  load: (context) => {
    const ids = sectionIds(context, "checkins:read", "checkin");
    return todayPage(dueRounds(context.userId, context.now.getTime(), 11, ids).map((due) => ({ id: due.roundId, title: due.name, date: due.date, deadlineAt: due.deadlineAt, href: `${due.href}/answer`, anonymous: due.anonymous })));
  }
};

// ---------------------------------------------------------------- search

export const searchScope: SearchScopeDef = {
  scope: "standups", label: "Standups", module: "checkins", roles: ["admin", "member", "viewer", "guest"],
  search: ({ userId, q, limit }) => {
    const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 8).map((word) => `"${word.replace(/"/g, "")}"*`).join(" ");
    if (!words) return { results: [], truncated: false };
    const fetch = Math.min(limit, 50) + 1;
    const rows = db.query(`SELECT r.id, c.name, c.short_id, rd.round_date, snippet(checkins_fts, 1, '', '', '…', 12) AS snippet, u.display_name, r.updated_at
      FROM checkins_fts f JOIN responses r ON r.id = f.response_id JOIN checkin_rounds rd ON rd.id = r.subject_id JOIN checkins c ON c.id = r.host_id LEFT JOIN users u ON u.id = r.respondent_user_id
      WHERE checkins_fts MATCH $q AND c.anonymous = 0 AND ${readableCheckinSql("c")}
        AND (c.private_answers = 0 OR r.respondent_user_id = $userId OR ${readableContainerSql("checkin", "c", { minLevel: "manage" })})
      ORDER BY rank LIMIT $limit`).all({ q: words, userId, limit: fetch }) as Array<{ id: string; name: string; short_id: string; round_date: string; snippet: string; display_name: string | null; updated_at: string }>;
    const names = db.query(`SELECT c.* FROM checkins c WHERE ${readableCheckinSql("c")} AND instr(lower(c.name), lower($q)) > 0 ORDER BY c.name LIMIT 5`).all({ userId, q: q.trim() }) as CheckinRow[];
    const results = [
      ...names.map((row) => ({ kind: "checkin" as const, id: row.id, title: row.name, snippet: "Standup", href: checkinHref(row), updatedAt: row.updated_at })),
      ...rows.map((row) => ({ kind: "checkin_round" as const, id: row.id, title: `${row.name} · ${dateLabel(row.round_date)}`, snippet: `${row.display_name ?? "Former member"}: ${row.snippet}`, href: `${checkinHref({ name: row.name, short_id: row.short_id })}/${row.round_date}`, updatedAt: row.updated_at }))
    ];
    return { results: results.slice(0, limit), truncated: results.length > limit || rows.length === fetch };
  }
};

// ---------------------------------------------------------------- datasets (§B.10)

const answerVisible = `(c.private_answers = 0 OR r.respondent_user_id = $userId OR ${readableContainerSql("checkin", "c", { minLevel: "manage" })})`;
const questionField = (field: string) => `(SELECT json_extract(q.value, '$.${field}') FROM question_sets qs, json_each(qs.set_json, '$.questions') q
  WHERE qs.host_kind = 'checkin' AND qs.host_id = c.id AND qs.version = r.set_version AND json_extract(q.value, '$.id') = a.question_id)`;

export const datasets: DatasetDef[] = [{
  id: "checkins.participation", module: "checkins", label: "Standup participation", readScope: "checkins:read", roles: ["admin", "member", "viewer", "guest"],
  description: "One row per person per standup round: answered, late, skipped, out, or pending (missed once the round closed), and how late.",
  from: "checkin_round_participants rp JOIN checkin_rounds rd ON rd.id = rp.round_id JOIN checkins c ON c.id = rd.checkin_id LEFT JOIN users u ON u.id = rp.user_id",
  scope: () => ({ sql: readableCheckinSql("c") }),
  timeColumn: "round_date",
  columns: [
    { name: "checkin", sql: "c.name", type: "string", label: "Standup", dimension: true },
    { name: "checkin_id", sql: "c.id", type: "string", label: "Standup id", dimension: true },
    { name: "round_date", sql: "rd.round_date", type: "date", label: "Round date", dimension: true },
    { name: "user", sql: "u.display_name", type: "string", label: "Person", dimension: true },
    { name: "state", sql: "rp.status", type: "string", label: "Participation", dimension: true },
    { name: "answered", sql: "(rp.status IN ('answered','late'))", type: "bool", label: "Answered", dimension: true, measures: ["sum", "avg"] },
    { name: "expected", sql: "(rp.status <> 'out')", type: "bool", label: "Expected", dimension: true, measures: ["sum"] },
    { name: "late_minutes", sql: "CASE WHEN rp.status = 'late' THEN (julianday(rp.answered_at) - julianday(rp.deadline_at)) * 1440 END", type: "number", label: "Minutes late", measures: ["sum", "avg", "max"] },
    { name: "answered_at", sql: "CASE WHEN c.anonymous = 0 THEN rp.answered_at END", type: "datetime", label: "Answered at", dimension: true }
  ]
}, {
  id: "checkins.answers", module: "checkins", label: "Standup answers", readScope: "checkins:read", roles: ["admin", "member", "viewer", "guest"],
  description: "One row per answered value of a standup question: numbers (mood, ratings) and choices; text is never included. Anonymous standups: no person, and only rounds with three answers or more.",
  from: "response_answers a JOIN responses r ON r.id = a.response_id AND r.host_kind = 'checkin' AND r.status = 'submitted' JOIN checkin_rounds rd ON rd.id = r.subject_id JOIN checkins c ON c.id = r.host_id LEFT JOIN users u ON u.id = r.respondent_user_id",
  scope: () => ({ sql: `${readableCheckinSql("c")} AND ${answerVisible} AND (c.anonymous = 0 OR rd.answered_count >= 3)` }),
  timeColumn: "round_date",
  columns: [
    { name: "checkin", sql: "c.name", type: "string", label: "Standup", dimension: true },
    { name: "checkin_id", sql: "c.id", type: "string", label: "Standup id", dimension: true },
    { name: "round_date", sql: "rd.round_date", type: "date", label: "Round date", dimension: true },
    { name: "question_id", sql: "a.question_id", type: "string", label: "Question id", dimension: true },
    { name: "question", sql: questionField("title"), type: "string", label: "Question", dimension: true },
    { name: "role", sql: questionField("role"), type: "string", label: "Role (mood, blockers, …)", dimension: true },
    { name: "option", sql: "a.option_id", type: "string", label: "Choice", dimension: true },
    { name: "value", sql: "a.value_num", type: "number", label: "Value", measures: ["sum", "avg", "min", "max"] },
    { name: "user", sql: "CASE WHEN c.anonymous = 0 THEN u.display_name END", type: "string", label: "Person", dimension: true }
  ]
}];

// ---------------------------------------------------------------- progress sources (§C10)

const sourceConfig = z.object({ checkinId: z.string().min(1).max(64), questionId: z.string().max(16).optional() });
const periodTerms = (period: { start: string; end: string } | null): { sql: string; params: Record<string, string> } => period ? { sql: " AND rd.round_date BETWEEN $start AND $end", params: { start: period.start, end: period.end } } : { sql: "", params: {} };

export const progressSources: Array<{ kind: string; source: Omit<ProgressSource, "kind"> }> = [{
  kind: "checkin_average",
  source: {
    label: "Standup rating average", module: "checkins", configSchema: sourceConfig as never,
    describe: (config: z.infer<typeof sourceConfig>, { viewerId }: { viewerId: string }) => { const row = checkinRow(config.checkinId); return row && checkinLevel(row, viewerId) !== "none" ? `Average of a rating in ${row.name}` : "Average of a standup rating"; },
    compute: (config: z.infer<typeof sourceConfig>, context: ProgressContext) => {
      const row = checkinRow(config.checkinId);
      if (!row || checkinLevel(row, context.ownerId) === "none" || !config.questionId) return null;
      const period = periodTerms(context.period);
      const result = db.query(`SELECT AVG(a.value_num) AS value, COUNT(*) AS count FROM response_answers a JOIN responses r ON r.id = a.response_id JOIN checkin_rounds rd ON rd.id = r.subject_id
        WHERE r.host_kind = 'checkin' AND r.host_id = $id AND a.question_id = $question AND a.value_num IS NOT NULL${period.sql}`).get({ id: row.id, question: config.questionId, ...period.params }) as { value: number | null; count: number };
      if (result.value === null || (row.anonymous && result.count < 3)) return null;
      return { value: result.value, detail: `${result.count} answers` };
    }
  } as never
}, {
  kind: "checkin_participation",
  source: {
    label: "Standup participation rate", module: "checkins", configSchema: sourceConfig as never,
    describe: (config: z.infer<typeof sourceConfig>, { viewerId }: { viewerId: string }) => { const row = checkinRow(config.checkinId); return row && checkinLevel(row, viewerId) !== "none" ? `Participation in ${row.name}` : "Standup participation"; },
    compute: (config: z.infer<typeof sourceConfig>, context: ProgressContext) => {
      const row = checkinRow(config.checkinId);
      if (!row || checkinLevel(row, context.ownerId) === "none") return null;
      const period = periodTerms(context.period);
      const result = db.query(`SELECT SUM(rp.status IN ('answered','late')) AS answered, SUM(rp.status <> 'out') AS expected FROM checkin_round_participants rp JOIN checkin_rounds rd ON rd.id = rp.round_id
        WHERE rd.checkin_id = $id${period.sql}`).get({ id: row.id, ...period.params }) as { answered: number | null; expected: number | null };
      if (!result.expected) return null;
      return { value: Math.round(((result.answered ?? 0) / result.expected) * 1000) / 10, target: 100, detail: `${result.answered ?? 0} of ${result.expected}` };
    }
  } as never
}];

// ---------------------------------------------------------------- mail: round summary

type SummaryMail = { name: string; date: string; line: string; href: string; rows: Array<{ title: string; meta?: string }> };
const summaryTemplate = defineTemplate<SummaryMail>({
  name: "checkins.summary",
  class: "activity",
  category: "checkins",
  render: (data, renderContext) => layout({
    instanceName: renderContext.instanceName, subject: `${itemTitle(data.name)} · ${data.date}`, preheader: data.line, eyebrow: "Standup", title: `${itemTitle(data.name)} · ${data.date}`, lead: data.line,
    blocks: data.rows.length ? [contextBlock(data.rows.slice(0, 20))] : [paragraph("Nobody answered this round.")],
    action: { label: "Open the round", href: data.href },
    footer: activityFooter("checkins", "You got this because you follow this standup's summaries.", renderContext)
  }),
  fixture: () => ({ name: "Daily standup", date: "Tue 14 Jan", line: "3 of 4 answered · 1 blocker", href: "https://nook.example/standups/daily-standup-0abc123def/2027-01-14", rows: [{ title: "Ana Silva", meta: "Answered" }] })
});

export const mailTemplates = {
  "checkins.summary": {
    ...summaryTemplate,
    resolve: (payload: Record<string, unknown>, recipient: { id: string }) => {
      const round = typeof payload.roundId === "string" ? roundRow(payload.roundId) : null;
      const row = round ? checkinRow(round.checkin_id) : null;
      if (!round || !row || checkinLevel(row, recipient.id) === "none") return { skip: "access_lost" as const };
      const view = roundView(round.id, recipient.id);
      return { data: { name: row.name, date: dateLabel(round.round_date), line: roundSummaryLine(row, round.id), href: appLink(`${checkinHref(row)}/${round.round_date}`), rows: view.participants.map((entry) => ({ title: entry.person.name, meta: entry.status === "pending" ? "No answer" : entry.status[0]!.toUpperCase() + entry.status.slice(1) })) } };
    }
  }
};

// ---------------------------------------------------------------- proposal: an agent answers for the person

const answerPayload = answerTool.inputSchema;
const proposalRound = (payload: Record<string, unknown>) => typeof payload.roundId === "string" ? payload.roundId.toLowerCase() : null;

export const proposalKind: KindDef & { tool: string } = {
  tool: "answer_checkin",
  scope: "checkins:read",
  label: "Answer standup",
  target: { field: "roundId", kind: "checkin_round" },
  submit: async (key: McpKeyContext, payload: unknown) => {
    const parsed = answerPayload.safeParse(payload ?? {});
    if (!parsed.success) throw new McpToolError("INVALID", "Invalid payload", { details: parsed.error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`) });
    const data = parsed.data as { roundId?: string; checkinId?: string; date?: string; answers: Record<string, unknown>; goalUpdates?: unknown[] };
    let roundId = data.roundId?.toLowerCase() ?? null;
    if (!roundId && data.checkinId && data.date && DATE_PATTERN.test(data.date)) {
      const row = checkinRow(data.checkinId);
      roundId = row ? (db.query("SELECT id FROM checkin_rounds WHERE checkin_id = ? AND round_date = ?").get(row.id, data.date) as { id: string } | null)?.id ?? null : null;
    }
    if (!roundId) throw new McpToolError("NOT_FOUND", "Round not found");
    try { answerableRound(roundId, key.userId, Date.now()); } catch { throw new McpToolError("NOT_FOUND", "Round not found"); }
    return { targetType: "checkin_round", targetId: roundId, payload: { roundId, answers: data.answers, ...(data.goalUpdates?.length ? { goalUpdates: data.goalUpdates } : {}) } };
  },
  apply: async (approverId, proposal) => {
    const result = await answerTool.handler(proposal.payload as never, { keyId: proposal.key_id ?? "", userId: approverId, name: proposal.key_name, scopes: [], person: true }) as { roundId: string };
    const round = roundRow(result.roundId)!;
    const row = checkinRow(round.checkin_id)!;
    return { type: "checkin_round", id: round.id, href: `${checkinHref(row)}/${round.round_date}` };
  },
  preview: (viewerId, proposal) => {
    const roundId = proposalRound(proposal.payload);
    const round = roundId ? roundRow(roundId) : null;
    const row = round ? checkinRow(round.checkin_id) : null;
    if (!round || !row || checkinLevel(row, viewerId) === "none") return { restricted: true };
    const current = db.query("SELECT version, set_json FROM question_sets WHERE host_kind = 'checkin' AND host_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1").get(row.id) as { version: number; set_json: string } | null;
    const set = current ? JSON.parse(current.set_json) as QuestionSet : null;
    const before = db.query("SELECT response_id FROM checkin_round_participants WHERE round_id = ? AND user_id = ?").get(round.id, viewerId) as { response_id: string | null } | null;
    const previous = before?.response_id ? getResponse(before.response_id) : null;
    const answers = (proposal.payload.answers ?? {}) as Record<string, unknown>;
    const show = (value: unknown) => value === undefined || value === null ? null : typeof value === "string" ? value : JSON.stringify(value);
    return { fields: (set?.questions ?? []).filter((question) => answers[question.id] !== undefined).map((question) => ({ name: question.title, before: show(previous?.answers[question.id]), after: show(answers[question.id]) })) };
  },
  targetLabel: (viewerId, proposal) => {
    const roundId = proposalRound(proposal.payload);
    const round = roundId ? roundRow(roundId) : null;
    const row = round ? checkinRow(round.checkin_id) : null;
    return round && row && checkinLevel(row, viewerId) !== "none" ? `${row.name} · ${dateLabel(round.round_date)}` : null;
  },
  digest: () => "Answers",
  targetHref: (proposal) => {
    const roundId = proposalRound(proposal.payload);
    const round = roundId ? roundRow(roundId) : null;
    const row = round ? checkinRow(round.checkin_id) : null;
    return round && row ? `${checkinHref(row)}/${round.round_date}/answer` : null;
  }
};

// ---------------------------------------------------------------- digest: standups you missed

export const digestSection: DigestSection = {
  id: "checkins.missed", label: "Standups you missed", module: "checkins",
  rows: (recipient, digestContext) => {
    const days = digestContext.period === "weekly" ? 7 : 1;
    const since = new Date(digestContext.nowMs - days * 86_400_000).toISOString();
    const rows = db.query(`SELECT c.*, r.round_date FROM checkin_round_participants rp JOIN checkin_rounds r ON r.id = rp.round_id JOIN checkins c ON c.id = r.checkin_id
      WHERE rp.user_id = ? AND rp.status = 'pending' AND r.status = 'closed' AND r.closed_at >= ? AND c.deleted_at IS NULL ORDER BY r.closed_at DESC LIMIT 21`).all(recipient.id, since) as Array<CheckinRow & { round_date: string }>;
    return { rows: rows.slice(0, 20).map((row) => ({ title: row.name, meta: dateLabel(row.round_date), href: `${checkinHref(row)}/${row.round_date}` })), total: rows.length };
  }
};

export const isRoundRef = (value: string) => isShortId(value) || /^[0-9a-f-]{36}$/i.test(value);
export { setVersion };
