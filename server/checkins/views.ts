import { db } from "../db";
import { reactionAggregates } from "../reactions/service";
import { resolveRef, resolveRefs } from "../links/service";
import { readableContainerSql } from "../access/workspaceItems";
import { LEVEL_RANK, type ItemLevel } from "../access/levels";
import { cardPath } from "../friendlyPaths";
import { cardKey } from "../../shared/boardKeys";
import { WORK_KIND_ICONS, type WorkSummary } from "../../shared/workRefs";
import { getResponse, setVersion, currentSet, draftSet } from "../questions/service";
import { nextFires } from "../../shared/schedules";
import { ANONYMOUS_MIN_ANSWERS, ANSWER_GRACE_MS, ANSWER_REF_PATTERN, DATE_PATTERN, type AnswerPrefill, type AnswerView, type CheckinDetail, type CheckinStats, type CheckinSummary, type DueRound, type FeedEntry, type ParticipationState, type RoundView } from "../../shared/checkins";
import type { QuestionSet, ResponseSummary } from "../../shared/questions";
import { checkinHref, checkinLevel, checkinRow, notFound, people, readableCheckinSql, readsAllAnswers, roundRow, scheduleOf, summaryOptions, type CheckinRow, type RoundParticipantRow, type RoundRow } from "./store";
import { currentResponseId, nextEventMs, participantsOf, roleQuestionIds, roundMood, zoneOf } from "./rounds";

/**
 * Standups' reads (docs/plan/WORKSPACE_MODULES.md §D.4): lists, a standup's detail, a round's report
 * (blockers on top, answers by person, participation, mood), the answer sheet's prefill (D936), the
 * team feed, and stats. Every read checks the viewer's level first and filters answers by
 * `private_answers` (T550); anonymous standups never show who said what, and nothing before three
 * answers (T553).
 */

const iso = (ms: number) => new Date(ms).toISOString();

/** Consecutive scheduled rounds the person answered, newest first; out rounds and their still-open round don't break it (D932). */
export function streakOf(checkinId: string, userId: string): number {
  const rows = db.query(`SELECT rp.status, r.status AS round_status FROM checkin_round_participants rp JOIN checkin_rounds r ON r.id = rp.round_id
    WHERE r.checkin_id = ? AND rp.user_id = ? ORDER BY r.round_date DESC LIMIT 400`).all(checkinId, userId) as Array<{ status: ParticipationState; round_status: string }>;
  let streak = 0;
  for (const row of rows) {
    if (row.status === "out") continue;
    if (row.status === "answered" || row.status === "late") { streak += 1; continue; }
    if (row.status === "pending" && row.round_status === "open") continue;
    break;
  }
  return streak;
}

function lastRoundOf(checkinId: string) {
  const round = db.query("SELECT * FROM checkin_rounds WHERE checkin_id = ? ORDER BY round_date DESC LIMIT 1").get(checkinId) as RoundRow | null;
  return round ? { id: round.id, date: round.round_date, status: round.status, answered: round.answered_count, participants: round.participant_count } : null;
}

export function summaryOf(row: CheckinRow, userId: string, level: ItemLevel = checkinLevel(row, userId)): CheckinSummary {
  const participants = participantsOf(row.id);
  const shown = people(participants.slice(0, 8).map((participant) => participant.user_id));
  const youParticipate = participants.some((participant) => participant.user_id === userId);
  const next = nextEventMs(row, Date.now());
  const rule = scheduleOf(row);
  const yours = participants.find((participant) => participant.user_id === userId);
  const [nextOpen] = row.status === "active" ? nextFires({ cadence: { weekdays: rule.weekdays, at: rule.at, ...(rule.everyNWeeks > 1 ? { everyNWeeks: rule.everyNWeeks } : {}) } }, yours ? zoneOf(row, yours) : row.tz, Date.now(), 1) : [];
  return {
    id: row.id, shortId: row.short_id, href: checkinHref(row), name: row.name, template: row.template, anonymous: row.anonymous === 1, status: row.status,
    schedule: scheduleOf(row), deadlineMinutes: row.deadline_minutes, participantCount: participants.length, participants: [...shown.values()],
    level, youParticipate, streak: youParticipate ? streakOf(row.id, userId) : null, lastRound: lastRoundOf(row.id),
    nextOpensAt: nextOpen !== undefined ? iso(nextOpen) : next ? null : null, revision: row.revision
  };
}

export function listCheckins(userId: string, options: { mine?: "participant" | "all"; cursor?: string | null; limit?: number; ids?: readonly string[] | null } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const terms = [readableCheckinSql("c")];
  const params: Record<string, string | number> = { userId, limit: limit + 1 };
  if (options.mine === "participant") terms.push("EXISTS (SELECT 1 FROM checkin_participants mp WHERE mp.checkin_id = c.id AND mp.user_id = $userId)");
  if (options.ids) { terms.push("c.id IN (SELECT value FROM json_each($ids))"); params.ids = JSON.stringify(options.ids); }
  if (options.cursor) {
    const [name, id] = (() => { try { return JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as [string, string]; } catch { return ["", ""]; } })();
    terms.push("(c.name COLLATE NOCASE, c.id) > ($cursorName, $cursorId)");
    params.cursorName = name;
    params.cursorId = id;
  }
  const rows = db.query(`SELECT c.* FROM checkins c WHERE ${terms.join(" AND ")} ORDER BY c.name COLLATE NOCASE, c.id LIMIT $limit`).all(params) as CheckinRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map((row) => summaryOf(row, userId)), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.name, last.id])).toString("base64url") : null };
}

export function detailOf(ref: string, userId: string): CheckinDetail {
  const row = checkinRow(ref);
  const level = checkinLevel(row, userId);
  if (!row || level === "none") throw notFound();
  const participants = participantsOf(row.id);
  const shown = people(participants.map((participant) => participant.user_id));
  const groups = db.query("SELECT g.id, g.name FROM checkin_participant_groups pg JOIN user_groups g ON g.id = pg.group_id WHERE pg.checkin_id = ? ORDER BY g.name COLLATE NOCASE").all(row.id) as Array<{ id: string; name: string }>;
  const yours = participants.find((participant) => participant.user_id === userId);
  const sub = db.query("SELECT summaries FROM checkin_subscriptions WHERE checkin_id = ? AND user_id = ?").get(row.id, userId) as { summaries: number } | null;
  const options = summaryOptions(row);
  const defaultSummaries = row.owner_id === userId || (options.notifyParticipants && Boolean(yours));
  const host = { kind: "checkin" as const, id: row.id };
  const current = currentSet(host);
  const canEdit = LEVEL_RANK[level] >= LEVEL_RANK.edit;
  return {
    ...summaryOf(row, userId, level),
    description: row.description_md, privateAnswers: row.private_answers === 1, tz: row.tz, reminderMinutesBefore: row.reminder_minutes_before,
    summary: options, ownerId: row.owner_id, groups,
    people: participants.map((participant) => ({ ...shown.get(participant.user_id)!, tz: canEdit || participant.user_id === userId ? participant.tz : null, pausedUntil: participant.paused_until, viaGroupId: participant.via_group_id })),
    you: yours || row.owner_id === userId ? { tz: yours?.tz ?? null, pausedUntil: yours?.paused_until ?? null, summaries: sub ? sub.summaries === 1 : defaultSummaries } : null,
    questions: current?.set ?? { version: 1, questions: [], sections: [], logic: [], endings: [] }, questionsVersion: current?.version ?? 0,
    hasDraft: canEdit && draftSet(host) !== null, createdAt: row.created_at
  };
}

export function roundsPage(ref: string, userId: string, cursor?: string | null, limit = 30) {
  const row = checkinRow(ref);
  if (!row || checkinLevel(row, userId) === "none") throw notFound();
  const bounded = Math.min(Math.max(limit, 1), 100);
  const after = cursor && DATE_PATTERN.test(cursor) ? cursor : null;
  const rows = db.query(`SELECT * FROM checkin_rounds WHERE checkin_id = ?${after ? " AND round_date < ?" : ""} ORDER BY round_date DESC LIMIT ?`).all(...[row.id, ...(after ? [after] : []), bounded + 1]) as RoundRow[];
  const page = rows.slice(0, bounded);
  const mine = new Map((db.query(`SELECT round_id, status FROM checkin_round_participants WHERE user_id = ? AND round_id IN (SELECT value FROM json_each(?))`).all(userId, JSON.stringify(page.map((round) => round.id))) as Array<{ round_id: string; status: ParticipationState }>).map((entry) => [entry.round_id, entry.status]));
  return {
    items: page.map((round) => ({ id: round.id, date: round.round_date, status: round.status, opensAt: round.opens_at, closesAt: round.closes_at, answered: round.answered_count, participants: round.participant_count, summary: round.summary_md, you: mine.get(round.id) ?? null, href: `${checkinHref(row)}/${round.round_date}` })),
    nextCursor: rows.length > bounded ? page[page.length - 1]!.round_date : null
  };
}

export function roundByDate(ref: string, date: string, userId: string) {
  const row = checkinRow(ref);
  if (!row || checkinLevel(row, userId) === "none" || !DATE_PATTERN.test(date)) throw notFound("Round");
  const round = db.query("SELECT id FROM checkin_rounds WHERE checkin_id = ? AND round_date = ?").get(row.id, date) as { id: string } | null;
  if (!round) throw notFound("Round");
  return round.id;
}

/** Refs an answer names (card keys, in-app links, card answers) that the viewer can read. */
function refsOf(set: QuestionSet | null, response: ResponseSummary, viewerId: string): AnswerView["refs"] {
  if (!set) return [];
  const tokens = new Set<string>();
  const cardIds = new Set<string>();
  for (const question of set.questions) {
    const value = response.answers[question.id];
    if (typeof value === "string" && (question.type === "long_text" || question.type === "short_text")) for (const token of value.match(ANSWER_REF_PATTERN) ?? []) tokens.add(token);
    if (question.type === "card" && Array.isArray(value)) for (const id of value) cardIds.add(String(id));
  }
  const refs: AnswerView["refs"] = [];
  for (const token of [...tokens].slice(0, 30)) {
    const resolved = resolveRef(token, { userId: viewerId });
    if (resolved) refs.push({ text: token, summary: resolved.summary });
  }
  const cards = resolveRefs([...cardIds].slice(0, 20).map((id) => ({ kind: "card" as const, id: id.toLowerCase() })), { userId: viewerId });
  for (const id of cardIds) {
    const summary = cards.get(`card:${id.toLowerCase()}`);
    if (summary) refs.push({ text: id, summary });
  }
  return refs;
}

/** Answer views for responses the viewer may read (the caller filtered them). */
function answerViews(row: CheckinRow, responses: ResponseSummary[], viewerId: string, lateIds: ReadonlySet<string>): AnswerView[] {
  const anonymous = row.anonymous === 1;
  const ids = responses.map((response) => response.id);
  const reactions = anonymous ? new Map() : reactionAggregates("checkin_answer", viewerId, ids);
  const comments = anonymous || !ids.length ? new Map<string, number>() : new Map((db.query(`SELECT item_id, COUNT(*) AS count FROM item_comments WHERE item_kind = 'checkin_round' AND deleted_at IS NULL AND item_id IN (SELECT value FROM json_each(?)) GROUP BY item_id`).all(JSON.stringify(ids)) as Array<{ item_id: string; count: number }>).map((entry) => [entry.item_id, entry.count]));
  const persons = people(responses.flatMap((response) => response.respondent.userId ? [response.respondent.userId] : []));
  const sets = new Map<number, QuestionSet | null>();
  const setOf = (version: number) => { if (!sets.has(version)) sets.set(version, setVersion({ kind: "checkin", id: row.id }, version)); return sets.get(version)!; };
  return responses.map((response) => anonymous
    ? { id: null, person: null, late: false, submittedAt: null, updatedAt: null, setVersion: response.setVersion, answers: response.answers, refs: [], reactions: [], commentCount: 0, mine: false }
    : {
      id: response.id, person: response.respondent.userId ? persons.get(response.respondent.userId)! : null, late: lateIds.has(response.id), submittedAt: response.submittedAt, updatedAt: response.updatedAt,
      setVersion: response.setVersion, answers: response.answers, refs: refsOf(setOf(response.setVersion), response, viewerId),
      reactions: ((reactions.get(response.id) ?? []) as Array<{ emoji: string; count: number; reacted: boolean; names: string[] }>).map(({ emoji, count, reacted, names }) => ({ emoji, count, reacted, names })),
      commentCount: comments.get(response.id) ?? 0, mine: response.respondent.userId === viewerId
    });
}

export function roundView(roundId: string, viewerId: string, nowMs = Date.now()): RoundView {
  const round = roundRow(roundId);
  const row = round ? checkinRow(round.checkin_id) : null;
  const level = checkinLevel(row, viewerId);
  if (!round || !row || level === "none") throw notFound("Round");
  const all = readsAllAnswers(row, level);
  const anonymous = row.anonymous === 1;
  const rps = db.query("SELECT * FROM checkin_round_participants WHERE round_id = ? ORDER BY opens_at, user_id").all(round.id) as RoundParticipantRow[];
  const persons = people(rps.map((rp) => rp.user_id));
  const responseRows = db.query("SELECT id FROM responses WHERE host_kind = 'checkin' AND host_id = ? AND subject_id = ? AND status = 'submitted' ORDER BY submitted_at, id").all(row.id, round.id) as Array<{ id: string }>;
  let responses = responseRows.map((entry) => getResponse(entry.id)!).filter(Boolean);
  if (!anonymous && !all) responses = responses.filter((response) => response.respondent.userId === viewerId);
  let hiddenUntil: number | null = null;
  if (anonymous) {
    if (responses.length < ANONYMOUS_MIN_ANSWERS) { hiddenUntil = ANONYMOUS_MIN_ANSWERS; responses = []; }
    else responses = [...responses].sort((a, b) => a.id.localeCompare(b.id));
  }
  const lateIds = new Set(rps.filter((rp) => rp.status === "late" && rp.response_id).map((rp) => rp.response_id!));
  const sets: Record<string, QuestionSet> = {};
  for (const version of new Set([...responses.map((response) => response.setVersion), currentSet({ kind: "checkin", id: row.id })?.version ?? 0])) {
    const set = version ? setVersion({ kind: "checkin", id: row.id }, version) : null;
    if (set) sets[String(version)] = set;
  }
  const visibleResponseIds = new Set(responses.map((response) => response.id));
  const blockerRows = anonymous ? [] : (db.query("SELECT card_id, user_id, flagged, response_id FROM checkin_blockers WHERE round_id = ? ORDER BY created_at").all(round.id) as Array<{ card_id: string; user_id: string | null; flagged: number; response_id: string }>)
    .filter((entry) => visibleResponseIds.has(entry.response_id));
  const cardSummaries = resolveRefs([...new Set(blockerRows.map((entry) => entry.card_id))].map((id) => ({ kind: "card" as const, id })), { userId: viewerId });
  const blockerPeople = people(blockerRows.flatMap((entry) => entry.user_id ? [entry.user_id] : []));
  const byCard = new Map<string, { people: Set<string>; flagged: boolean }>();
  for (const entry of blockerRows) {
    const item = byCard.get(entry.card_id) ?? { people: new Set<string>(), flagged: false };
    if (entry.user_id) item.people.add(entry.user_id);
    item.flagged ||= entry.flagged === 1;
    byCard.set(entry.card_id, item);
  }
  const prev = db.query("SELECT round_date FROM checkin_rounds WHERE checkin_id = ? AND round_date < ? ORDER BY round_date DESC LIMIT 1").get(row.id, round.round_date) as { round_date: string } | null;
  const next = db.query("SELECT round_date FROM checkin_rounds WHERE checkin_id = ? AND round_date > ? ORDER BY round_date LIMIT 1").get(row.id, round.round_date) as { round_date: string } | null;
  const mine = rps.find((rp) => rp.user_id === viewerId);
  const open = round.status === "open" || nowMs <= Date.parse(round.closes_at) + ANSWER_GRACE_MS;
  const mood = roundMood(row, round.id);
  return {
    checkin: { id: row.id, shortId: row.short_id, name: row.name, href: checkinHref(row), anonymous, template: row.template, level },
    round: { id: round.id, date: round.round_date, status: round.status, opensAt: round.opens_at, closesAt: round.closes_at, closedAt: round.closed_at, manual: round.manual === 1, answered: round.answered_count, participants: round.participant_count },
    prev: prev?.round_date ?? null, next: next?.round_date ?? null, sets,
    participants: rps.map((rp) => ({ person: persons.get(rp.user_id)!, status: rp.status, opensAt: rp.opens_at, deadlineAt: rp.deadline_at, answeredAt: anonymous ? null : rp.answered_at })),
    answers: answerViews(row, responses, viewerId, lateIds), hiddenUntil,
    blockers: [...byCard].map(([cardId, item]) => ({ card: cardSummaries.get(`card:${cardId}`) ?? { kind: "card" as const, hidden: true as const }, people: [...item.people].map((id) => blockerPeople.get(id)!), flagged: item.flagged })),
    mood: mood && (all || anonymous) ? mood : null,
    you: mine ? { status: mine.status, deadlineAt: mine.deadline_at, canAnswer: open, answered: mine.status === "answered" || mine.status === "late" } : null,
    canManage: LEVEL_RANK[level] >= LEVEL_RANK.edit
  };
}

export function dueRounds(userId: string, nowMs = Date.now(), limit = 20, ids?: readonly string[] | null): DueRound[] {
  const rows = db.query(`SELECT c.*, r.id AS round_id, r.round_date, rp.deadline_at, rp.status AS rp_status FROM checkin_round_participants rp
      JOIN checkin_rounds r ON r.id = rp.round_id JOIN checkins c ON c.id = r.checkin_id
    WHERE rp.user_id = $userId AND rp.status = 'pending' AND rp.opens_at <= $now AND r.status = 'open' AND c.deleted_at IS NULL${ids ? " AND c.id IN (SELECT value FROM json_each($ids))" : ""}
    ORDER BY rp.deadline_at, r.id LIMIT $limit`).all({ userId, now: iso(nowMs), limit, ...(ids ? { ids: JSON.stringify(ids) } : {}) }) as Array<CheckinRow & { round_id: string; round_date: string; deadline_at: string; rp_status: ParticipationState }>;
  return rows.map((row) => ({ roundId: row.round_id, checkinId: row.id, name: row.name, href: `${checkinHref(row)}/${row.round_date}`, date: row.round_date, deadlineAt: row.deadline_at, status: row.rp_status, anonymous: row.anonymous === 1 }));
}

function cardSummary(row: { id: string; title: string; board_id: string; board_name: string; code: string | null; number: number | null; due_on: string | null }): WorkSummary {
  const key = cardKey(row.code, row.number) ?? undefined;
  return { kind: "card", id: row.id, ...(key ? { key } : {}), title: row.title, subtitle: row.board_name, href: cardPath(row.board_id, row.id), icon: WORK_KIND_ICONS.card, ...(row.due_on ? { due: row.due_on } : {}) };
}

const cardSelect = `SELECT DISTINCT k.id, k.title, k.board_id, b.name AS board_name, b.code, k.number, k.due_on FROM cards k JOIN boards b ON b.id = k.board_id`;

/** The answer sheet's suggestions (D936): computed on open from the person's own work, never posted without them. */
export function prefill(roundId: string, userId: string, nowMs = Date.now()): AnswerPrefill {
  const round = roundRow(roundId);
  const row = round ? checkinRow(round.checkin_id) : null;
  if (!round || !row || checkinLevel(row, userId) === "none") throw notFound("Round");
  const responseId = currentResponseId(row, round.id, userId);
  const current = responseId ? getResponse(responseId) : null;
  const previous = row.anonymous ? null : db.query(`SELECT rp.response_id, rp.answered_at FROM checkin_round_participants rp JOIN checkin_rounds r ON r.id = rp.round_id
      WHERE r.checkin_id = ? AND rp.user_id = ? AND r.round_date < ? AND rp.response_id IS NOT NULL ORDER BY r.round_date DESC LIMIT 1`).get(row.id, userId, round.round_date) as { response_id: string; answered_at: string } | null;
  const last = previous ? getResponse(previous.response_id) : null;
  const lastSet = last ? setVersion({ kind: "checkin", id: row.id }, last.setVersion) : null;
  const planQuestion = lastSet?.questions.find((question) => question.role === "plan");
  const lastPlan = planQuestion && last && typeof last.answers[planQuestion.id] === "string" ? last.answers[planQuestion.id] as string : null;
  const since = previous?.answered_at ?? iso(Date.parse(round.opens_at) - 7 * 86_400_000);
  const readable = `b.deleted_at IS NULL AND k.deleted_at IS NULL`;
  const done = (db.query(`${cardSelect} JOIN card_activity a ON a.card_id = k.id JOIN board_columns col ON col.id = json_extract(a.payload, '$.to.id')
      WHERE a.actor_id = $userId AND a.kind = 'column' AND a.created_at >= $since AND col.state = 'done' AND ${readable}
      ORDER BY k.title LIMIT 20`).all({ userId, since }) as Parameters<typeof cardSummary>[0][]);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const planned = db.query(`${cardSelect} JOIN card_assignees ca ON ca.card_id = k.id AND ca.user_id = $userId LEFT JOIN board_columns col ON col.id = k.column_id
      WHERE ${readable} AND k.archived_at IS NULL AND COALESCE(col.state, 'todo') <> 'done'
        AND (col.state = 'doing' OR (k.due_on IS NOT NULL AND k.due_on <= $soon) OR (k.start_on IS NOT NULL AND k.start_on <= $today))
      ORDER BY (col.state = 'doing') DESC, k.due_on IS NULL, k.due_on LIMIT 20`).all({ userId, today, soon: new Date(nowMs + 86_400_000).toISOString().slice(0, 10) }) as Parameters<typeof cardSummary>[0][];
  // Cards still flagged Blocked that this person named as blockers last time: offered "Unblock".
  const blockers = previous ? db.query(`${cardSelect} JOIN checkin_blockers cb ON cb.card_id = k.id JOIN card_flags f ON f.card_id = k.id AND f.flag = 'blocked'
      WHERE cb.response_id = $responseId AND ${readable}`).all({ responseId: previous.response_id }) as Parameters<typeof cardSummary>[0][] : [];
  const canRead = (card: { id: string }) => resolveRefs([{ kind: "card", id: card.id }], { userId }).get(`card:${card.id}`) !== null;
  return {
    lastAnswers: last?.answers ?? null, lastPlan,
    doneCards: done.filter(canRead).slice(0, 10).map(cardSummary), plannedCards: planned.filter(canRead).slice(0, 10).map(cardSummary), openBlockers: blockers.filter(canRead).map(cardSummary),
    current: current ? { id: current.id, answers: current.answers, revision: current.revision } : null
  };
}

/** The team feed: named answers across the standups the viewer reads, newest first (private answers: own only unless managing). */
export function feed(userId: string, options: { checkin?: string | null; person?: string | null; blockers?: boolean; q?: string | null; cursor?: string | null; limit?: number; ids?: readonly string[] | null } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const terms = ["r.host_kind = 'checkin'", "r.status = 'submitted'", "c.anonymous = 0", readableCheckinSql("c"),
    `(c.private_answers = 0 OR r.respondent_user_id = $userId OR ${readableContainerSql("checkin", "c", { minLevel: "manage" })})`];
  const params: Record<string, string | number> = { userId, limit: limit + 1 };
  if (options.checkin) {
    const row = checkinRow(options.checkin);
    if (!row) return { items: [] as FeedEntry[], nextCursor: null };
    terms.push("c.id = $checkinId");
    params.checkinId = row.id;
  }
  if (options.ids) { terms.push("c.id IN (SELECT value FROM json_each($ids))"); params.ids = JSON.stringify(options.ids); }
  if (options.person) { terms.push("r.respondent_user_id = $person"); params.person = options.person.toLowerCase(); }
  if (options.blockers) terms.push("EXISTS (SELECT 1 FROM checkin_blockers fb WHERE fb.response_id = r.id)");
  if (options.q?.trim()) {
    const query = options.q.trim().split(/\s+/).slice(0, 8).map((word) => `"${word.replace(/"/g, "")}"*`).join(" ");
    terms.push("r.id IN (SELECT response_id FROM checkins_fts WHERE checkins_fts MATCH $q)");
    params.q = query;
  }
  if (options.cursor) {
    try {
      const [at, id] = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as [string, string];
      terms.push("(r.submitted_at, r.id) < ($cursorAt, $cursorId)");
      params.cursorAt = at;
      params.cursorId = id;
    } catch { /* a bad cursor starts over */ }
  }
  const rows = db.query(`SELECT r.id, r.host_id, r.subject_id, r.submitted_at FROM responses r JOIN checkins c ON c.id = r.host_id JOIN checkin_rounds rd ON rd.id = r.subject_id
    WHERE ${terms.join(" AND ")} ORDER BY r.submitted_at DESC, r.id DESC LIMIT $limit`).all(params) as Array<{ id: string; host_id: string; subject_id: string; submitted_at: string }>;
  const page = rows.slice(0, limit);
  const items: FeedEntry[] = [];
  for (const entry of page) {
    const row = checkinRow(entry.host_id)!;
    const round = roundRow(entry.subject_id)!;
    const response = getResponse(entry.id)!;
    const late = (db.query("SELECT 1 FROM checkin_round_participants WHERE round_id = ? AND response_id = ? AND status = 'late'").get(round.id, entry.id)) !== null;
    const [view] = answerViews(row, [response], userId, late ? new Set([entry.id]) : new Set());
    const blockers = (db.query("SELECT COUNT(*) AS count FROM checkin_blockers WHERE response_id = ?").get(entry.id) as { count: number }).count;
    items.push({ ...view!, checkin: { id: row.id, name: row.name, href: checkinHref(row) }, round: { id: round.id, date: round.round_date, href: `${checkinHref(row)}/${round.round_date}` }, blockers });
  }
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.submitted_at, last.id])).toString("base64url") : null };
}

/** Participation, streaks, and mood over the standup's rounds (anonymous mood only from three answers on, T553). */
export function stats(ref: string, userId: string, options: { from?: string | null; to?: string | null } = {}): CheckinStats {
  const row = checkinRow(ref);
  const level = checkinLevel(row, userId);
  if (!row || level === "none") throw notFound();
  const from = options.from && DATE_PATTERN.test(options.from) ? options.from : "0000-01-01";
  const to = options.to && DATE_PATTERN.test(options.to) ? options.to : "9999-12-31";
  const rounds = db.query("SELECT * FROM checkin_rounds WHERE checkin_id = ? AND round_date BETWEEN ? AND ? ORDER BY round_date DESC LIMIT 60").all(row.id, from, to) as RoundRow[];
  rounds.reverse();
  const counts = db.query(`SELECT rp.round_id, rp.user_id, rp.status, r.status AS round_status FROM checkin_round_participants rp JOIN checkin_rounds r ON r.id = rp.round_id
    WHERE rp.round_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(rounds.map((round) => round.id))) as Array<{ round_id: string; user_id: string; status: ParticipationState; round_status: string }>;
  const moodIds = roleQuestionIds(row.id, "mood");
  const showMood = readsAllAnswers(row, level) || row.anonymous === 1;
  const perRound = rounds.map((round) => {
    const mine = counts.filter((entry) => entry.round_id === round.id);
    const by = (status: ParticipationState) => mine.filter((entry) => entry.status === status).length;
    const mood = showMood && moodIds.length ? roundMood(row, round.id) : null;
    return { id: round.id, date: round.round_date, status: round.status, answered: by("answered"), late: by("late"), skipped: by("skipped"), out: by("out"), pending: by("pending"), participants: mine.length, mood: mood?.average ?? null };
  });
  const expected = perRound.reduce((sum, round) => sum + round.participants - round.out, 0);
  const answered = perRound.reduce((sum, round) => sum + round.answered + round.late, 0);
  const moods = perRound.filter((round) => round.mood !== null);
  const userIds = [...new Set(counts.map((entry) => entry.user_id))];
  const persons = people(userIds);
  return {
    rounds: perRound,
    participationRate: expected ? answered / expected : null,
    averageMood: moods.length ? moods.reduce((sum, round) => sum + round.mood!, 0) / moods.length : null,
    people: userIds.map((id) => {
      const mine = counts.filter((entry) => entry.user_id === id);
      return {
        person: persons.get(id)!, answered: mine.filter((entry) => entry.status === "answered").length, late: mine.filter((entry) => entry.status === "late").length,
        skipped: mine.filter((entry) => entry.status === "skipped").length, missed: mine.filter((entry) => entry.status === "pending" && entry.round_status === "closed").length, streak: streakOf(row.id, id)
      };
    }).sort((a, b) => b.streak - a.streak || a.person.name.localeCompare(b.person.name))
  };
}

/** A structured summary of a round (the `standup_summary` of §D.4, without a model): counts, blockers, mood, and each answer's text. */
export function roundSummary(roundId: string, viewerId: string) {
  const view = roundView(roundId, viewerId);
  const latestSet = view.sets[String(Math.max(0, ...Object.keys(view.sets).map(Number)))];
  const titleOf = (version: number, id: string) => (view.sets[String(version)] ?? latestSet)?.questions.find((question) => question.id === id)?.title ?? id;
  return {
    standup: view.checkin.name, date: view.round.date, status: view.round.status,
    participation: { answered: view.round.answered, expected: view.round.participants, pending: view.participants.filter((p) => p.status === "pending").map((p) => p.person.name), skipped: view.participants.filter((p) => p.status === "skipped").map((p) => p.person.name), out: view.participants.filter((p) => p.status === "out").map((p) => p.person.name) },
    blockers: view.blockers.map((blocker) => ({ card: "hidden" in blocker.card ? "A card you can't open" : `${blocker.card.key ?? ""} ${blocker.card.title}`.trim(), people: blocker.people.map((person) => person.name), flagged: blocker.flagged })),
    mood: view.mood?.average ?? null,
    hiddenUntil: view.hiddenUntil,
    answers: view.answers.map((answer) => ({
      person: answer.person?.name ?? (view.checkin.anonymous ? "Anonymous" : null), late: answer.late,
      answers: Object.entries(answer.answers).map(([id, value]) => ({ question: titleOf(answer.setVersion, id), answer: typeof value === "string" || typeof value === "number" ? value : JSON.stringify(value) }))
    }))
  };
}
