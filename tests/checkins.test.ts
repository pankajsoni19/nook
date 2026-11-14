import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { createCheckin, setMyParticipation, setParticipants, updateCheckin, deleteCheckin } = await import("../server/checkins/service");
const { answerRound, driveCheckin, skipRound, startRoundNow, DRIVE_PURPOSE } = await import("../server/checkins/rounds");
const { roundView, dueRounds, stats, prefill, feed } = await import("../server/checkins/views");
const { checkinRow } = await import("../server/checkins/store");
const { binProvider, searchScope, todayProvider } = await import("../server/checkins/registrations");
const { runScheduleTick } = await import("../server/schedules/dispatcher");
const { runDatasetQuery } = await import("../server/datasets/registry");
const { todayContext } = await import("../server/today/registry");
const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { registeredWorkspaceModules } = await import("../server/workspaceModules");

/**
 * Standups (docs/plan/WORKSPACE_MODULES.md §D.4, D930–D959, T550–T554): rounds across zones and DST,
 * participation states and streaks, answers and edits, blockers that link and flag cards, anonymous
 * pulses, private answers, access over HTTP (owner, participant, guest, outsider), MCP, datasets,
 * search, Today, and the Bin with no orphans after purge.
 */

let owner: Session;
let member: Session;
let guest: Session;
let outsider: Session;
let viewer: Session;

const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json };
};

const at = (value: string) => Date.parse(value);

beforeAll(async () => {
  owner = await createUser("Standup owner");
  member = await createUser("Standup member");
  guest = await createUser("Standup guest");
  outsider = await createUser("Standup outsider");
  viewer = await createUser("Standup viewer");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
  db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(viewer.userId);
});

describe("module", () => {
  test("is registered on the server", () => {
    expect(registeredWorkspaceModules()).toContain("checkins");
  });
});

describe("rounds across zones and DST (D931, D939)", () => {
  test("a round opens per participant zone on the same date; Lisbon moves an hour after its DST change", () => {
    // Thursday 26 March 2026, 00:00 UTC. Lisbon goes to summer time on Sunday 29 March.
    const created = at("2026-03-26T00:00:00Z");
    const row = createCheckin(owner.userId, { template: "standup", schedule: { weekdays: [1, 2, 3, 4, 5], at: "09:30", zoneMode: "each", tz: "UTC" }, participants: { people: [owner.userId, member.userId], groups: [] } }, created);
    setMyParticipation(owner.userId, row.id, { tz: "Asia/Tokyo" }, created);
    setMyParticipation(member.userId, row.id, { tz: "Europe/Lisbon" }, created);
    const schedule = db.query("SELECT next_fire_at FROM schedules WHERE owner_kind = 'checkin' AND owner_id = ? AND purpose = ?").get(row.id, DRIVE_PURPOSE) as { next_fire_at: string };
    expect(schedule.next_fire_at).toBe("2026-03-26T00:30:00.000Z");

    expect(driveCheckin(row.id, at("2026-03-26T00:30:00Z")).opened).toBe(1);
    const round = db.query("SELECT * FROM checkin_rounds WHERE checkin_id = ?").get(row.id) as { id: string; round_date: string; closes_at: string };
    expect(round.round_date).toBe("2026-03-26");
    const rps = db.query("SELECT user_id, opens_at, deadline_at, notified_at FROM checkin_round_participants WHERE round_id = ? ORDER BY opens_at").all(round.id) as Array<{ user_id: string; opens_at: string; deadline_at: string; notified_at: string | null }>;
    expect(rps.map((rp) => [rp.user_id, rp.opens_at])).toEqual([[owner.userId, "2026-03-26T00:30:00.000Z"], [member.userId, "2026-03-26T09:30:00.000Z"]]);
    expect(rps[0]!.notified_at).not.toBeNull();
    expect(rps[1]!.notified_at).toBeNull();
    expect(round.closes_at).toBe("2026-03-26T15:30:00.000Z");
    // Next wake-ups: the owner's reminder (an hour before their deadline), then Lisbon's open time.
    expect((db.query("SELECT next_fire_at FROM schedules WHERE owner_kind = 'checkin' AND owner_id = ?").get(row.id) as { next_fire_at: string }).next_fire_at).toBe("2026-03-26T05:30:00.000Z");
    driveCheckin(row.id, at("2026-03-26T05:30:00Z"));
    expect((db.query("SELECT next_fire_at FROM schedules WHERE owner_kind = 'checkin' AND owner_id = ?").get(row.id) as { next_fire_at: string }).next_fire_at).toBe("2026-03-26T09:30:00.000Z");
    driveCheckin(row.id, at("2026-03-26T09:30:00Z"));
    expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND topic = 'checkins.open'").get(member.userId)).toEqual({ n: 1 });

    // Monday 30 March: Lisbon is UTC+1 now, so its 09:30 is 08:30 UTC.
    driveCheckin(row.id, at("2026-03-30T00:30:00Z"));
    const monday = db.query("SELECT id FROM checkin_rounds WHERE checkin_id = ? AND round_date = '2026-03-30'").get(row.id) as { id: string };
    expect((db.query("SELECT opens_at FROM checkin_round_participants WHERE round_id = ? AND user_id = ?").get(monday.id, member.userId) as { opens_at: string }).opens_at).toBe("2026-03-30T08:30:00.000Z");
    // The Thursday and Friday rounds closed on the way (summaries went out); no weekend rounds.
    expect((db.query("SELECT round_date, status FROM checkin_rounds WHERE checkin_id = ? ORDER BY round_date").all(row.id) as Array<{ round_date: string; status: string }>).map((entry) => `${entry.round_date}:${entry.status}`))
      .toEqual(["2026-03-26:closed", "2026-03-30:open"]);
    expect((db.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND topic = 'checkins.summary'").get(owner.userId) as { n: number }).n).toBeGreaterThan(0);
  });

  test("the dispatcher runs the drive schedule at most once per occurrence", async () => {
    const created = Date.now() - 60_000;
    const row = createCheckin(owner.userId, { template: "custom", name: "Tick test", schedule: { weekdays: [0, 1, 2, 3, 4, 5, 6], at: "00:00", zoneMode: "fixed", tz: "UTC" }, participants: { people: [owner.userId], groups: [] } }, created);
    const next = Date.parse((db.query("SELECT next_fire_at FROM schedules WHERE owner_kind = 'checkin' AND owner_id = ?").get(row.id) as { next_fire_at: string }).next_fire_at);
    await runScheduleTick({ nowMs: next + 1000 });
    expect((db.query("SELECT COUNT(*) AS n FROM checkin_rounds WHERE checkin_id = ?").get(row.id) as { n: number }).n).toBe(1);
    await runScheduleTick({ nowMs: next + 2000 });
    expect((db.query("SELECT COUNT(*) AS n FROM checkin_rounds WHERE checkin_id = ?").get(row.id) as { n: number }).n).toBe(1);
  });
});

describe("answers, states, streaks, reminders (D932, D933)", () => {
  test("answer, edit, late, skip, out, and the streak", () => {
    const t0 = at("2026-04-06T08:00:00Z"); // Monday
    const row = createCheckin(owner.userId, { template: "standup", schedule: { weekdays: [1, 2, 3, 4, 5], at: "09:00", zoneMode: "fixed", tz: "UTC" }, deadlineMinutes: 120, reminderMinutesBefore: 30, participants: { people: [owner.userId, member.userId], groups: [] } }, t0);
    driveCheckin(row.id, at("2026-04-06T09:00:00Z"));
    const round = db.query("SELECT id FROM checkin_rounds WHERE checkin_id = ? AND round_date = '2026-04-06'").get(row.id) as { id: string };
    const first = answerRound(owner.userId, round.id, { answers: { done: "Shipped the release", plan: "Write docs", mood: 4 }, nowMs: at("2026-04-06T09:10:00Z") });
    expect(first.status).toBe("answered");
    const edited = answerRound(owner.userId, round.id, { answers: { done: "Shipped the release notes", plan: "Write docs", mood: 5 }, nowMs: at("2026-04-06T09:20:00Z") });
    expect(edited.edited).toBe(true);
    expect(edited.response.id).toBe(first.response.id);
    // Reminder 30 minutes before the member's deadline.
    driveCheckin(row.id, at("2026-04-06T10:30:00Z"));
    expect((db.query("SELECT reminded_at FROM checkin_round_participants WHERE round_id = ? AND user_id = ?").get(round.id, member.userId) as { reminded_at: string | null }).reminded_at).not.toBeNull();
    expect((db.query("SELECT reminded_at FROM checkin_round_participants WHERE round_id = ? AND user_id = ?").get(round.id, owner.userId) as { reminded_at: string | null }).reminded_at).toBeNull();
    // After the deadline the round closes; an answer within a day is late.
    driveCheckin(row.id, at("2026-04-06T11:00:00Z"));
    expect(answerRound(member.userId, round.id, { answers: { done: "Late but here", plan: "More" }, nowMs: at("2026-04-06T12:00:00Z") }).status).toBe("late");
    expect(() => answerRound(member.userId, round.id, { answers: { done: "x", plan: "y" }, nowMs: at("2026-04-08T12:00:00Z") })).toThrow(/closed/);
    // Tuesday: the member skips; the owner pauses Wednesday (out does not break the streak).
    driveCheckin(row.id, at("2026-04-07T09:00:00Z"));
    const tuesday = db.query("SELECT id FROM checkin_rounds WHERE checkin_id = ? AND round_date = '2026-04-07'").get(row.id) as { id: string };
    expect(skipRound(member.userId, tuesday.id, at("2026-04-07T09:05:00Z")).status).toBe("skipped");
    answerRound(owner.userId, tuesday.id, { answers: { done: "a", plan: "b" }, nowMs: at("2026-04-07T09:05:00Z") });
    expect(() => skipRound(owner.userId, tuesday.id, at("2026-04-07T09:06:00Z"))).toThrow(/already answered/);
    setMyParticipation(owner.userId, row.id, { pausedUntil: "2026-04-08" }, at("2026-04-07T10:00:00Z"));
    driveCheckin(row.id, at("2026-04-08T09:00:00Z"));
    const wednesday = db.query("SELECT id FROM checkin_rounds WHERE checkin_id = ? AND round_date = '2026-04-08'").get(row.id) as { id: string };
    expect((db.query("SELECT status FROM checkin_round_participants WHERE round_id = ? AND user_id = ?").get(wednesday.id, owner.userId) as { status: string }).status).toBe("out");
    const result = stats(row.id, owner.userId);
    expect(result.people.find((entry) => entry.person.id === owner.userId)!.streak).toBe(2);
    expect(result.people.find((entry) => entry.person.id === member.userId)).toMatchObject({ late: 1, skipped: 1 });
    expect(result.rounds[0]!.mood).toBe(5);
    // The round report: both answers, the late flag, participation.
    const view = roundView(round.id, owner.userId, at("2026-04-06T12:00:00Z"));
    expect(view.answers.map((answer) => [answer.person?.id, answer.late])).toEqual([[owner.userId, false], [member.userId, true]]);
    expect(view.participants.map((entry) => entry.status).sort()).toEqual(["answered", "late"]);
    // Prefill: last time's plan is offered for "done".
    expect(prefill(tuesday.id, owner.userId).lastPlan).toBe("Write docs");
  });
});

describe("blockers link and flag cards (D935, T554)", () => {
  test("a blocker the author can edit is flagged with card history; one they only read is linked only", async () => {
    const board = await api(owner, "POST", "/tasks/boards", { name: "Standup board", template: "kanban" });
    const boardId = (board.body.board ?? board.body).id as string;
    const detail = await api(owner, "GET", `/tasks/boards/${boardId}`);
    const column = detail.body.columns[0].id as string;
    const card = await api(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId: column, title: "Payments API" });
    const cardId = (card.body.card ?? card.body).id as string;
    const key = (db.query("SELECT b.code || '-' || k.number AS key FROM cards k JOIN boards b ON b.id = k.board_id WHERE k.id = ?").get(cardId) as { key: string }).key;
    db.query("UPDATE boards SET visibility = 'all_users', share_role = 'view' WHERE id = ?").run(boardId);

    const row = createCheckin(owner.userId, { template: "standup", participants: { people: [owner.userId, member.userId], groups: [] } });
    const round = startRoundNow(row, owner.userId);
    // The member reads the board but cannot edit it: link only.
    const memberAnswer = answerRound(member.userId, round.id, { answers: { done: "x", plan: "y", blockers: `Waiting on ${key}` } });
    expect(memberAnswer.blockers).toBe(1);
    expect(db.query("SELECT flag FROM card_flags WHERE card_id = ?").all(cardId)).toEqual([]);
    expect(db.query("SELECT relation FROM work_links WHERE a_kind = 'checkin_round' AND a_id = ? AND b_id = ? AND relation = 'blocks'").all(memberAnswer.response.id, cardId)).toEqual([{ relation: "blocks" }]);
    // The owner can edit: the card is flagged Blocked, with history naming the standup.
    answerRound(owner.userId, round.id, { answers: { done: "x", plan: "y", blockers: `${key} needs a review` } });
    expect(db.query("SELECT flag FROM card_flags WHERE card_id = ?").all(cardId)).toEqual([{ flag: "blocked" }]);
    const activity = db.query("SELECT payload FROM card_activity WHERE card_id = ? AND kind = 'blocked_by_checkin'").get(cardId) as { payload: string };
    expect(JSON.parse(activity.payload).item).toMatchObject({ id: row.id, label: row.name });
    const view = roundView(round.id, owner.userId);
    expect(view.blockers).toHaveLength(1);
    expect(view.blockers[0]).toMatchObject({ flagged: true });
    expect(view.blockers[0]!.people.map((person) => person.id).sort()).toEqual([owner.userId, member.userId].sort());
    // The answer's text refs resolve to chips for the reader.
    expect(view.answers.find((answer) => answer.mine)!.refs[0]).toMatchObject({ text: key, summary: { kind: "card", id: cardId } });
    // Editing the blocker away removes the link (the flag stays until someone unblocks).
    answerRound(member.userId, round.id, { answers: { done: "x", plan: "y", blockers: "" } });
    expect(db.query("SELECT 1 FROM work_links WHERE a_id = ? AND b_id = ? AND relation = 'blocks'").all(memberAnswer.response.id, cardId)).toEqual([]);
    // Unblock over HTTP clears it.
    expect((await api(owner, "POST", `/checkins/${row.id}/unblock`, { cardId })).body).toEqual({ unblocked: true });
    expect(db.query("SELECT flag FROM card_flags WHERE card_id = ?").all(cardId)).toEqual([]);
    // Feed with blockers only lists the owner's answer.
    expect(feed(owner.userId, { checkin: row.id, blockers: true }).items.map((item) => item.person?.id)).toEqual([owner.userId]);
  });
});

describe("anonymous pulse and private answers (D934, T550, T553)", () => {
  test("a pulse shows nothing before three answers, then no names or times; datasets wait too", async () => {
    const extra = await createUser("Pulse third");
    const row = createCheckin(owner.userId, { template: "pulse", participants: { people: [owner.userId, member.userId, extra.userId], groups: [] } });
    const round = startRoundNow(row, owner.userId);
    answerRound(owner.userId, round.id, { answers: { mood: 4 } });
    answerRound(member.userId, round.id, { answers: { mood: 2, better: "Fewer meetings" } });
    expect(db.query("SELECT respondent_user_id, respondent_kind FROM responses WHERE subject_id = ?").all(round.id)).toEqual([{ respondent_user_id: null, respondent_kind: "anonymous" }, { respondent_user_id: null, respondent_kind: "anonymous" }]);
    expect(db.query("SELECT response_id FROM checkin_round_participants WHERE round_id = ? AND status = 'answered'").all(round.id)).toEqual([{ response_id: null }, { response_id: null }]);
    let view = roundView(round.id, owner.userId);
    expect(view.answers).toEqual([]);
    expect(view.hiddenUntil).toBe(3);
    expect(view.mood?.average ?? null).toBeNull();
    const query = { dataset: "checkins.answers", measures: [{ fn: "count" as const }], filters: [{ column: "checkin_id", op: "eq" as const, value: row.id }] };
    expect(runDatasetQuery(query, { userId: owner.userId, role: "member" }).rows).toEqual([[0]]);
    // An edit finds the anonymous answer by its keyed hash (not a new response).
    answerRound(member.userId, round.id, { answers: { mood: 3 } });
    expect((db.query("SELECT COUNT(*) AS n FROM responses WHERE subject_id = ?").get(round.id) as { n: number }).n).toBe(2);
    answerRound(extra.userId, round.id, { answers: { mood: 5 } });
    view = roundView(round.id, owner.userId);
    expect(view.answers).toHaveLength(3);
    expect(view.answers.every((answer) => answer.person === null && answer.submittedAt === null && answer.id === null)).toBe(true);
    expect(view.mood?.average).toBe(4);
    expect(view.participants.every((entry) => entry.answeredAt === null)).toBe(true);
    expect(runDatasetQuery(query, { userId: owner.userId, role: "member" }).rows).toEqual([[3]]);
    // Anonymous answers are never in the feed or search.
    expect(feed(owner.userId, { checkin: row.id }).items).toEqual([]);
  });

  test("private answers: a participant reads only their own; the owner reads all", () => {
    const row = createCheckin(owner.userId, { template: "custom", privateAnswers: true, participants: { people: [owner.userId, member.userId], groups: [] } });
    const round = startRoundNow(row, owner.userId);
    answerRound(owner.userId, round.id, { answers: { update: "Owner's private note" } });
    answerRound(member.userId, round.id, { answers: { update: "Member's own" } });
    expect(roundView(round.id, member.userId).answers.map((answer) => answer.person?.id)).toEqual([member.userId]);
    expect(roundView(round.id, owner.userId).answers).toHaveLength(2);
    expect(feed(member.userId, { checkin: row.id }).items.map((item) => item.person?.id)).toEqual([member.userId]);
  });
});

describe("HTTP access (T90, T550, D817)", () => {
  test("owner, participant, guest participant, viewer, and outsider", async () => {
    const created = await api(owner, "POST", "/checkins", { template: "standup", name: "API standup", participants: { people: [owner.userId, member.userId, guest.userId], groups: [] } });
    expect(created.status).toBe(201);
    const checkin = created.body.checkin;
    expect(checkin.href).toMatch(/^\/standups\/api-standup-[0-9a-z]{10}$/);
    expect(checkin.questions.questions.map((question: { role?: string }) => question.role)).toEqual(["done", "plan", "blockers", "mood"]);
    // By short id too.
    expect((await api(member, "GET", `/checkins/${checkin.shortId}`)).status).toBe(200);
    expect((await api(outsider, "GET", `/checkins/${checkin.id}`)).status).toBe(404);
    expect((await api(viewer, "GET", `/checkins/${checkin.id}`)).status).toBe(404);
    // Participants comment-level but not edit.
    expect((await api(member, "PATCH", `/checkins/${checkin.id}`, { name: "Renamed" })).status).toBe(403);
    expect((await api(outsider, "PATCH", `/checkins/${checkin.id}`, { name: "Renamed" })).status).toBe(404);
    const started = await api(owner, "POST", `/checkins/${checkin.id}/rounds`, {});
    expect(started.status).toBe(201);
    const roundId = started.body.round.round.id as string;
    expect((await api(owner, "POST", `/checkins/${checkin.id}/rounds`, {})).body.code).toBe("ROUND_EXISTS");
    // A guest participant answers (a read-only role's registered write) but cannot create standups.
    expect((await api(guest, "POST", `/checkin-rounds/${roundId}/answer`, { answers: { done: "Guest work", plan: "More" } })).status).toBe(201);
    expect((await api(guest, "POST", "/checkins", { template: "custom" })).status).toBe(403);
    // Invalid answers are field errors.
    const bad = await api(member, "POST", `/checkin-rounds/${roundId}/answer`, { answers: { mood: 9 } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_ANSWERS");
    expect((await api(outsider, "POST", `/checkin-rounds/${roundId}/answer`, { answers: { done: "x", plan: "y" } })).status).toBe(404);
    // Due list and the Today section.
    expect((await api(member, "GET", "/checkins/due")).body.items.map((item: { roundId: string }) => item.roundId)).toContain(roundId);
    const today = await todayProvider.load(todayContext(member.userId, "UTC"));
    expect(today.items.map((item: any) => item.id)).toContain(roundId);
    // The round by date, and the reading of a participant's answers.
    const date = started.body.round.round.date as string;
    const byDate = await api(member, "GET", `/checkins/${checkin.shortId}/rounds/${date}`);
    expect(byDate.status).toBe(200);
    expect(byDate.body.answers.map((answer: { person: { id: string } }) => answer.person.id)).toEqual([guest.userId]);
    // Comments on an answer go through the generic item routes (participants comment; the guest reads).
    const answerId = byDate.body.answers[0].id as string;
    expect((await api(member, "POST", `/items/checkin_round/${answerId}/comments`, { body: "Nice work" })).status).toBe(201);
    expect((await api(outsider, "GET", `/items/checkin_round/${answerId}/comments`)).status).toBe(404);
    // Reactions on answers.
    expect((await request(`/reactions/checkin_answer/${answerId}/thumbs_up`, { method: "PUT", headers: { "Content-Type": "application/json" } }, member)).status).toBe(200);
    expect((await api(member, "GET", `/checkin-rounds/${roundId}`)).body.answers[0].reactions).toEqual([{ emoji: "thumbs_up", count: 1, reacted: true, names: [] }]);
  });

  test("search finds answers only for readers", async () => {
    const row = createCheckin(owner.userId, { template: "custom", name: "Search standup", participants: { people: [owner.userId], groups: [] } });
    const round = startRoundNow(row, owner.userId);
    answerRound(owner.userId, round.id, { answers: { update: "Migrated the zeppelin database" } });
    const mine = await searchScope.search({ userId: owner.userId, role: "member", q: "zeppelin", limit: 5 });
    expect(mine.results.map((result) => result.kind)).toEqual(["checkin_round"]);
    expect((await searchScope.search({ userId: outsider.userId, role: "member", q: "zeppelin", limit: 5 })).results).toEqual([]);
  });
});

describe("MCP (T551)", () => {
  test("get_due_checkins → answer_checkin → get_checkin_round; only as the key owner and only rounds they take part in", async () => {
    const row = createCheckin(owner.userId, { template: "standup", name: "MCP standup", participants: { people: [owner.userId, member.userId], groups: [] } });
    const round = startRoundNow(row, owner.userId);
    const key = createApiKey(member.userId, { name: "Standups key", surfaces: "both", grants: [{ module: "checkins", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const parse = (result: { content: Array<{ text: string }>; isError?: boolean }) => ({ error: result.isError ?? false, body: JSON.parse(result.content[0]!.text) });
    const due = parse(await invokeMcpToolForTests("get_due_checkins", {}, key.id) as never);
    expect(due.body.items.map((item: { roundId: string }) => item.roundId)).toContain(round.id);
    const answered = parse(await invokeMcpToolForTests("answer_checkin", { roundId: round.id, answers: { done: "From MCP", plan: "More MCP" } }, key.id) as never);
    expect(answered).toMatchObject({ error: false, body: { status: "answered", edited: false } });
    const read = parse(await invokeMcpToolForTests("get_checkin_round", { checkinId: row.short_id, date: round.round_date }, key.id) as never);
    expect(read.body.answers.map((answer: { person: { id: string } }) => answer.person.id)).toEqual([member.userId]);
    const summary = parse(await invokeMcpToolForTests("summarize_checkin_round", { roundId: round.id }, key.id) as never);
    expect(summary.body.participation.pending).toEqual(["Standup owner"]);
    expect(parse(await invokeMcpToolForTests("checkin_stats", { checkinId: row.id }, key.id) as never).body.participationRate).toBe(0.5);
    // The outsider's key: the round is NOT_FOUND, not "not a participant".
    const outsiderKey = createApiKey(outsider.userId, { name: "Outsider key", surfaces: "both", grants: [{ module: "checkins", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    expect(parse(await invokeMcpToolForTests("answer_checkin", { roundId: round.id, answers: { done: "x", plan: "y" } }, outsiderKey.id) as never)).toMatchObject({ error: true, body: { code: "NOT_FOUND" } });
    // A read-only key cannot answer.
    const readKey = createApiKey(member.userId, { name: "Read key", surfaces: "both", grants: [{ module: "checkins", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    expect(parse(await invokeMcpToolForTests("answer_checkin", { roundId: round.id, answers: { done: "x", plan: "y" } }, readKey.id) as never).error).toBe(true);
    // A key limited to another standup does not see this one.
    const other = createCheckin(member.userId, { template: "custom", participants: { people: [member.userId], groups: [] } });
    const chosen = createApiKey(member.userId, { name: "Chosen key", surfaces: "both", grants: [{ module: "checkins", permission: "read", resourceKind: "checkin", resourceId: other.id }], expiresInDays: 30 });
    expect(parse(await invokeMcpToolForTests("get_checkin", { checkinId: row.id }, chosen.id) as never)).toMatchObject({ error: true, body: { code: "NOT_FOUND" } });
    expect(parse(await invokeMcpToolForTests("list_checkins", {}, chosen.id) as never).body.items.map((item: { id: string }) => item.id)).toEqual([other.id]);
  });
});

describe("participants and groups", () => {
  test("a group's members take part, follow the group, and join an open round", async () => {
    const group = crypto.randomUUID();
    db.query("INSERT INTO user_groups (id, name, created_by, created_at, updated_at) VALUES (?, 'Standup crew', ?, ?, ?)").run(group, owner.userId, new Date().toISOString(), new Date().toISOString());
    db.query("INSERT INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)").run(group, member.userId, new Date().toISOString());
    const row = createCheckin(owner.userId, { template: "custom", participants: { people: [owner.userId], groups: [] } });
    const round = startRoundNow(row, owner.userId);
    setParticipants(owner.userId, row.id, { people: [owner.userId], groups: [group] });
    expect(db.query("SELECT via_group_id FROM checkin_participants WHERE checkin_id = ? AND user_id = ?").get(row.id, member.userId)).toEqual({ via_group_id: group });
    expect(dueRounds(member.userId).map((due) => due.roundId)).toContain(round.id);
    setParticipants(owner.userId, row.id, { people: [owner.userId], groups: [] });
    expect(db.query("SELECT 1 FROM checkin_round_participants WHERE round_id = ? AND user_id = ?").all(round.id, member.userId)).toEqual([]);
  });
});

describe("Bin and purge (§B.13)", () => {
  test("binned standups are 404 and stop; restore wakes them; purge leaves no orphans", async () => {
    const row = createCheckin(owner.userId, { template: "standup", participants: { people: [owner.userId, member.userId], groups: [] } });
    const round = startRoundNow(row, owner.userId);
    const answer = answerRound(owner.userId, round.id, { answers: { done: "Some work", plan: "More", blockers: "" } });
    db.query("INSERT INTO item_comments (id, item_kind, item_id, author_id, body_md, created_at, updated_at) VALUES (?, 'checkin_round', ?, ?, 'c', ?, ?)").run(crypto.randomUUID(), answer.response.id, owner.userId, new Date().toISOString(), new Date().toISOString());
    expect(() => deleteCheckin(member.userId, row.id)).toThrow(/can't delete/);
    deleteCheckin(owner.userId, row.id);
    expect((await api(owner, "GET", `/checkins/${row.id}`)).status).toBe(404);
    expect(db.query("SELECT 1 FROM schedules WHERE owner_id = ?").all(row.id)).toEqual([]);
    expect(binProvider.list(owner.userId).map((item) => item.id)).toContain(row.id);
    expect((await binProvider.restore(row.id, owner.userId)).status).toBe("restored");
    expect(db.query("SELECT 1 FROM schedules WHERE owner_id = ?").all(row.id)).toHaveLength(1);
    deleteCheckin(owner.userId, row.id);
    expect(await binProvider.purge(row.id, owner.userId)).toBe("purged");
    for (const [sql, ...params] of [
      ["SELECT COUNT(*) AS n FROM checkin_rounds WHERE checkin_id = ?", row.id],
      ["SELECT COUNT(*) AS n FROM responses WHERE host_id = ?", row.id],
      ["SELECT COUNT(*) AS n FROM question_sets WHERE host_id = ?", row.id],
      ["SELECT COUNT(*) AS n FROM schedules WHERE owner_id = ?", row.id],
      ["SELECT COUNT(*) AS n FROM item_activity WHERE item_id IN (?, ?)", row.id, round.id],
      ["SELECT COUNT(*) AS n FROM item_comments WHERE item_id = ?", answer.response.id],
      ["SELECT COUNT(*) AS n FROM work_links WHERE a_id = ? OR b_id = ?", answer.response.id, row.id],
      ["SELECT COUNT(*) AS n FROM checkins_fts WHERE response_id = ?", answer.response.id],
      ["SELECT COUNT(*) AS n FROM checkin_participants WHERE checkin_id = ?", row.id]
    ] as Array<[string, ...string[]]>) expect({ sql, n: (db.query(sql).get(...params) as { n: number }).n }).toEqual({ sql, n: 0 });
    expect(checkinRow(row.id)).toBeNull();
  });

  test("pausing stops new rounds; resuming schedules the next", () => {
    const row = createCheckin(owner.userId, { template: "standup", participants: { people: [owner.userId], groups: [] } });
    updateCheckin(owner.userId, row.id, { status: "paused" });
    expect(db.query("SELECT 1 FROM schedules WHERE owner_id = ?").all(row.id)).toEqual([]);
    updateCheckin(owner.userId, row.id, { status: "active" });
    expect(db.query("SELECT 1 FROM schedules WHERE owner_id = ?").all(row.id)).toHaveLength(1);
  });
});

describe("datasets (T502)", () => {
  test("participation rows only for readers", () => {
    const row = createCheckin(owner.userId, { template: "custom", participants: { people: [owner.userId, member.userId], groups: [] } });
    const round = startRoundNow(row, owner.userId);
    answerRound(owner.userId, round.id, { answers: { update: "x" } });
    const query = { dataset: "checkins.participation", measures: [{ fn: "count" as const }], dimensions: ["state"], filters: [{ column: "checkin_id", op: "eq" as const, value: row.id }], sort: [{ column: "state", dir: "asc" as const }] };
    expect(runDatasetQuery(query, { userId: member.userId, role: "member" }).rows).toEqual([["answered", 1], ["pending", 1]]);
    expect(runDatasetQuery(query, { userId: outsider.userId, role: "member" }).rows).toEqual([]);
  });
});
