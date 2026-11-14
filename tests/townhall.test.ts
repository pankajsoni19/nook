import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests, mcpToolSpecs } = await import("../server/mcpTools");
const { resetPublicLimits } = await import("../server/public/limits");
const { resetTownhallVoteBuckets } = await import("../server/townhall/publicRoutes");
const { runReminder } = await import("../server/townhall/service");
const { loadToday, todayContext } = await import("../server/today/registry");
const { runDatasetQuery } = await import("../server/datasets/registry");
const { NOOK_NEVER_TOOLS } = await import("../server/agents/nookBridge");

/**
 * Townhall (docs/plan/WORKSPACE_MODULES.md §D.7 Townhall): sessions, questions (named and anonymous,
 * review, upvotes, merge, pin, answered), polls on the question engine, live state per viewer, the
 * audience link, the recap and its exports, questions → cards, MCP with scopes and chosen-item keys,
 * the Bin and purge, Today, search, datasets, and reminders.
 */

type Json = Record<string, any>;
let host: Session;
let member: Session;
let outsider: Session;
let guest: Session;

const api = async (session: Session | null, method: string, path: string, body?: unknown) => {
  const payload = body === undefined && method !== "GET" ? {} : body;
  const response = await request(path, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }, session ?? undefined);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as Json, headers: response.headers };
};
const publicApi = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${origin}/api/public${path}`, { method, headers: { "Content-Type": "application/json", Origin: origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as Json, headers: response.headers };
};

const newSession = async (session: Session, body: Json = {}) => {
  const created = await api(session, "POST", "/townhall/sessions", { title: "All hands", ...body });
  expect(created.status).toBe(201);
  return created.body.session as Json;
};

beforeAll(async () => {
  host = await createUser("Townhall host");
  member = await createUser("Townhall member");
  outsider = await createUser("Townhall outsider");
  guest = await createUser("Townhall guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
});

describe("sessions and access", () => {
  test("create, list, get by short id and friendly segment; private sessions are NOT_FOUND to others", async () => {
    const session = await newSession(host, { description: "Q4", startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    expect(session).toMatchObject({ title: "All hands", state: "upcoming", visibility: "all_users", allowAnonymous: true });
    expect(session.href).toMatch(/^\/townhall\/all-hands-[0-9a-z]{10}$/);
    const byShort = await api(member, "GET", `/townhall/sessions/${session.shortId}`);
    expect(byShort.status).toBe(200);
    expect(byShort.body.you).toMatchObject({ canModerate: false, canAsk: true });
    expect((await api(member, "GET", `/townhall/sessions/${session.href.split("/").pop()}`)).status).toBe(200);
    const list = await api(member, "GET", "/townhall/sessions?state=upcoming");
    expect(list.body.items.map((item: Json) => item.id)).toContain(session.id);
    // Private: only the owner.
    const access = await api(host, "GET", `/access/townhall_session/${session.id}`);
    expect((await request(`/access/townhall_session/${session.id}`, { method: "PUT", headers: { "If-Match": access.body.etag }, body: JSON.stringify({ audience: "private", people: [], groups: [] }) }, host)).status).toBe(200);
    expect(await api(member, "GET", `/townhall/sessions/${session.id}`)).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect((await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Hi?" })).status).toBe(404);
  });

  test("only hosts change, run, and bin a session; members get 403", async () => {
    const session = await newSession(host);
    expect((await api(member, "PATCH", `/townhall/sessions/${session.id}`, { title: "Mine now" })).status).toBe(403);
    expect((await api(member, "POST", `/townhall/sessions/${session.id}/state`, { state: "live" })).status).toBe(403);
    expect((await api(member, "DELETE", `/townhall/sessions/${session.id}`)).status).toBe(403);
    const patched = await api(host, "PATCH", `/townhall/sessions/${session.id}`, { title: "All hands · Q4", moderation: "review", expectedRevision: session.revision });
    expect(patched.body.session).toMatchObject({ title: "All hands · Q4", moderation: "review" });
    expect((await api(host, "PATCH", `/townhall/sessions/${session.id}`, { title: "Stale", expectedRevision: session.revision })).status).toBe(409);
  });
});

describe("questions", () => {
  test("ask named and anonymous, upvote (idempotent), sort data, my questions; anonymous questions store no author", async () => {
    const session = await newSession(host);
    const named = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "What is the roadmap?" });
    expect(named.status).toBe(201);
    expect(named.body.question).toMatchObject({ author: "Townhall member", status: "approved", mine: true, votes: 0 });
    const anon = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Why the reorg?", anonymous: true });
    expect(anon.body.question).toMatchObject({ author: null, mine: true });
    expect(db.query("SELECT author_id, anonymous FROM townhall_questions WHERE id = ?").get(anon.body.question.id)).toEqual({ author_id: null, anonymous: 1 });
    // Upvotes: set-state, one per person, stored as hashes.
    for (let index = 0; index < 2; index += 1) expect((await api(host, "PUT", `/townhall/questions/${anon.body.question.id}/vote`, { upvote: true })).body).toMatchObject({ votes: 1, voted: true });
    expect((await api(outsider, "PUT", `/townhall/questions/${anon.body.question.id}/vote`, { upvote: true })).body.votes).toBe(2);
    expect((await api(outsider, "PUT", `/townhall/questions/${anon.body.question.id}/vote`, { upvote: false })).body.votes).toBe(1);
    expect(db.query("SELECT voter_hash FROM townhall_votes WHERE question_id = ?").all(anon.body.question.id).every((row) => /^[0-9a-f]{64}$/.test((row as Json).voter_hash))).toBe(true);
    const state = await api(host, "GET", `/townhall/sessions/${session.id}`);
    const anonView = state.body.questions.find((question: Json) => question.id === anon.body.question.id);
    expect(anonView).toMatchObject({ author: null, mine: false, voted: true, votes: 1 });
    // "Everyone signed in" leaves guests out; shared with them, guests ask and vote (read-only writes, D817).
    expect((await api(guest, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Guest question" })).status).toBe(404);
    const access = await api(host, "GET", `/access/townhall_session/${session.id}`);
    expect((await request(`/access/townhall_session/${session.id}`, { method: "PUT", headers: { "If-Match": access.body.etag }, body: JSON.stringify({ audience: "selected", people: [{ id: guest.userId, level: "view" }, { id: member.userId, level: "view" }, { id: outsider.userId, level: "view" }], groups: [] }) }, host)).status).toBe(200);
    const guestAsk = await api(guest, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Guest question" });
    expect(guestAsk.status).toBe(201);
    expect((await api(guest, "PUT", `/townhall/questions/${guestAsk.body.question.id}/vote`, { upvote: true })).body.votes).toBe(1);
    expect((await api(guest, "POST", `/townhall/sessions/${session.id}/polls`, { kind: "rating", title: "x" })).status).toBe(403);
    // Anonymous off: refused.
    await api(host, "PATCH", `/townhall/sessions/${session.id}`, { allowAnonymous: false });
    expect(await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "x", anonymous: true })).toMatchObject({ status: 400, body: { code: "ANONYMOUS_OFF" } });
    // Withdraw own only.
    expect((await api(outsider, "DELETE", `/townhall/questions/${named.body.question.id}`)).status).toBe(404);
    expect((await api(member, "DELETE", `/townhall/questions/${named.body.question.id}`)).body).toEqual({ withdrawn: true });
  });

  test("review: pending questions are the hosts' and the asker's; approve, hide, merge (votes move), pin, answered (notifies), star", async () => {
    const session = await newSession(host, { moderation: "review" });
    const asked = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "When is the offsite?" });
    expect(asked.body.question.status).toBe("pending");
    expect((await api(outsider, "GET", `/townhall/sessions/${session.id}`)).body.questions).toEqual([]);
    expect((await api(member, "GET", `/townhall/sessions/${session.id}`)).body.questions).toHaveLength(1);
    const hostState = await api(host, "GET", `/townhall/sessions/${session.id}`);
    expect(hostState.body.stats.pending).toBe(1);
    expect(db.query("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND topic = 'townhall.review'").get(host.userId)).toEqual({ count: 1 });
    expect((await api(member, "POST", `/townhall/questions/${asked.body.question.id}/moderate`, { action: "approve" })).status).toBe(403);
    expect((await api(host, "POST", `/townhall/questions/${asked.body.question.id}/moderate`, { action: "approve" })).body.question.status).toBe("approved");
    const dup = await api(outsider, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Offsite date?" });
    await api(host, "POST", `/townhall/questions/${dup.body.question.id}/moderate`, { action: "approve" });
    await api(outsider, "PUT", `/townhall/questions/${dup.body.question.id}/vote`, { upvote: true });
    await api(member, "PUT", `/townhall/questions/${asked.body.question.id}/vote`, { upvote: true });
    const merged = await api(host, "POST", `/townhall/questions/${dup.body.question.id}/moderate`, { action: "merge", targetId: asked.body.question.id });
    expect(merged.body.question).toMatchObject({ id: asked.body.question.id, votes: 2 });
    const after = await api(host, "GET", `/townhall/sessions/${session.id}`);
    expect(after.body.questions.map((question: Json) => question.id)).toEqual([asked.body.question.id]);
    expect(after.body.questions[0].mergedCount).toBe(1);
    await api(host, "POST", `/townhall/questions/${asked.body.question.id}/moderate`, { action: "star" });
    await api(host, "POST", `/townhall/questions/${asked.body.question.id}/moderate`, { action: "pin" });
    const pinned = await api(member, "GET", `/townhall/sessions/${session.id}`);
    expect(pinned.body.session.pinnedQuestionId).toBe(asked.body.question.id);
    expect(pinned.body.questions[0]).toMatchObject({ pinned: true, starred: false });
    expect((await api(host, "GET", `/townhall/sessions/${session.id}`)).body.questions[0].starred).toBe(true);
    await api(host, "POST", `/townhall/questions/${asked.body.question.id}/moderate`, { action: "answered" });
    const answered = await api(member, "GET", `/townhall/sessions/${session.id}`);
    expect(answered.body.session.pinnedQuestionId).toBeNull();
    expect(answered.body.questions[0].status).toBe("answered");
    expect(db.query("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND topic = 'townhall.answered'").get(member.userId)).toEqual({ count: 1 });
    // Hidden questions disappear for everyone else.
    const rude = await api(outsider, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Rude" });
    await api(host, "POST", `/townhall/questions/${rude.body.question.id}/moderate`, { action: "hide" });
    expect((await api(outsider, "GET", `/townhall/sessions/${session.id}`)).body.questions.map((question: Json) => question.id)).not.toContain(rude.body.question.id);
    // Comments on a question (item comments, readers comment while comments are on).
    const comment = await api(outsider, "POST", `/items/townhall_question/${asked.body.question.id}/comments`, { body: "+1, also travel?" });
    expect(comment.status).toBe(201);
    expect((await api(host, "GET", `/townhall/sessions/${session.id}`)).body.questions[0].commentCount).toBe(1);
  });

  test("an ended session takes no questions or votes", async () => {
    const session = await newSession(host);
    const asked = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Before the end" });
    expect((await api(host, "POST", `/townhall/sessions/${session.id}/state`, { state: "live" })).body.session.state).toBe("live");
    expect((await api(host, "POST", `/townhall/sessions/${session.id}/state`, { state: "ended" })).body.session.state).toBe("ended");
    expect(await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Late" })).toMatchObject({ status: 409, body: { code: "SESSION_ENDED" } });
    expect((await api(member, "PUT", `/townhall/questions/${asked.body.question.id}/vote`, { upvote: true })).status).toBe(409);
  });
});

describe("polls", () => {
  test("single, multi, rating, word cloud, open text: launch, vote, change vote, results, close; one live at a time", async () => {
    const session = await newSession(host);
    const base = `/townhall/sessions/${session.id}/polls`;
    const single = await api(host, "POST", base, { kind: "single", title: "Lunch?", options: ["Ramen", "Tacos"] });
    expect(single.status).toBe(201);
    expect((await api(member, "POST", `${base}/${single.body.pollId}/vote`, { optionIds: ["x"] })).body.code).toBe("POLL_CLOSED");
    // Drafts are the hosts'.
    expect((await api(member, "GET", `/townhall/sessions/${session.id}`)).body.polls).toEqual([]);
    expect((await api(member, "POST", `${base}/${single.body.pollId}/launch`)).status).toBe(403);
    await api(host, "POST", `${base}/${single.body.pollId}/launch`);
    const live = (await api(member, "GET", `/townhall/sessions/${session.id}`)).body;
    expect(live.session.activePollId).toBe(single.body.pollId);
    const [ramen, tacos] = live.polls[0].options;
    await api(member, "POST", `${base}/${single.body.pollId}/vote`, { optionIds: [ramen.id] });
    await api(outsider, "POST", `${base}/${single.body.pollId}/vote`, { optionIds: [ramen.id] });
    await api(member, "POST", `${base}/${single.body.pollId}/vote`, { optionIds: [tacos.id] });
    const counted = (await api(member, "GET", `/townhall/sessions/${session.id}`)).body.polls[0];
    expect(counted).toMatchObject({ total: 2, myVote: [tacos.id], counts: { [ramen.id]: 1, [tacos.id]: 1 } });
    expect(db.query("SELECT respondent_kind, respondent_user_id FROM responses WHERE subject_id = ?").all(single.body.pollId)).toEqual([{ respondent_kind: "anonymous", respondent_user_id: null }, { respondent_kind: "anonymous", respondent_user_id: null }]);
    // Launching another closes it.
    const rating = await api(host, "POST", base, { kind: "rating", title: "How useful?", launch: true });
    const afterLaunch = (await api(host, "GET", `/townhall/sessions/${session.id}`)).body.polls;
    expect(afterLaunch.map((poll: Json) => poll.status)).toEqual(["closed", "live"]);
    await api(member, "POST", `${base}/${rating.body.pollId}/vote`, { rating: 4 });
    await api(outsider, "POST", `${base}/${rating.body.pollId}/vote`, { rating: 5 });
    expect((await api(member, "GET", `/townhall/sessions/${session.id}`)).body.polls[1]).toMatchObject({ average: 4.5, myRating: 4, distribution: { 4: 1, 5: 1 } });
    const cloud = await api(host, "POST", base, { kind: "word_cloud", title: "One word", launch: true, resultsHidden: true });
    for (const word of ["Focus", "focus ", "growth"]) expect((await api(member, "POST", `${base}/${cloud.body.pollId}/vote`, { text: word })).status).toBe(200);
    expect((await api(member, "POST", `${base}/${cloud.body.pollId}/vote`, { text: "more" })).body.code).toBe("WORD_LIMIT");
    // Results hidden until it closes for the audience; hosts see them.
    expect((await api(member, "GET", `/townhall/sessions/${session.id}`)).body.polls[2]).toMatchObject({ counts: null, words: [], myWords: ["Focus", "focus", "growth"] });
    expect((await api(host, "GET", `/townhall/sessions/${session.id}`)).body.polls[2].words).toEqual([{ text: "focus", count: 2 }, { text: "growth", count: 1 }]);
    await api(host, "POST", `${base}/${cloud.body.pollId}/close`);
    expect((await api(member, "GET", `/townhall/sessions/${session.id}`)).body.polls[2].words).toHaveLength(2);
    const multi = await api(host, "POST", base, { kind: "multi", title: "Topics", options: ["A", "B", "C"], launch: true });
    const multiView = (await api(member, "GET", `/townhall/sessions/${session.id}`)).body.polls[3];
    await api(member, "POST", `${base}/${multi.body.pollId}/vote`, { optionIds: [multiView.options[0].id, multiView.options[2].id] });
    expect((await api(member, "GET", `/townhall/sessions/${session.id}`)).body.polls[3].myVote).toHaveLength(2);
    const open = await api(host, "POST", base, { kind: "open_text", title: "Anything else?", launch: true });
    await api(member, "POST", `${base}/${open.body.pollId}/vote`, { text: "More demos please" });
    expect((await api(host, "GET", `/townhall/sessions/${session.id}`)).body.polls[4].entries).toEqual(["More demos please"]);
    // A choice poll needs options.
    expect((await api(host, "POST", base, { kind: "single", title: "Bad", options: ["Only"] })).status).toBe(400);
    // Delete removes the poll and its answers.
    expect((await api(host, "DELETE", `${base}/${open.body.pollId}`)).body).toEqual({ deleted: true });
    expect(db.query("SELECT COUNT(*) AS count FROM responses WHERE subject_id = ?").get(open.body.pollId)).toEqual({ count: 0 });
  });
});

describe("the audience link (public)", () => {
  test("ask, upvote, vote anonymously by participant; uniform 404 when revoked; strict headers; nonce single use", async () => {
    resetPublicLimits();
    resetTownhallVoteBuckets();
    const session = await newSession(host);
    expect((await api(member, "PUT", `/townhall/sessions/${session.id}/public-link`, { enabled: true })).status).toBe(403);
    const link = await api(host, "PUT", `/townhall/sessions/${session.id}/public-link`, { enabled: true });
    expect(link.body.publicUrl).toMatch(/^\/p\/t\/[A-Za-z0-9_-]{43}$/);
    // The host sees the same link again (sealed, D1076); members never see it.
    expect((await api(host, "GET", `/townhall/sessions/${session.id}`)).body.publicUrl).toBe(link.body.publicUrl);
    expect((await api(member, "GET", `/townhall/sessions/${session.id}`)).body.publicUrl).toBeUndefined();
    const token = link.body.publicUrl.split("/").pop();
    const page = await fetch(`${origin}/p/t/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const first = await publicApi("GET", `/townhall/${token}`);
    expect(first.status).toBe(200);
    expect(first.body.session).toMatchObject({ title: "All hands", owner: { id: "" }, event: null });
    expect(JSON.stringify(first.body)).not.toContain(host.userId);
    const participant = first.body.participant as string;
    const nonce = first.body.renderNonce as string;
    expect((await publicApi("POST", `/townhall/${token}/questions`, { participant, text: "Too fast", nonce, website: "" })).body.code).toBe("TOO_FAST");
    await Bun.sleep(1600);
    const ok = await publicApi("POST", `/townhall/${token}/questions`, { participant, text: "From outside", name: "Ana", nonce, website: "" });
    expect(ok.status).toBe(201);
    // Single use: the same nonce again is a replay.
    expect((await publicApi("POST", `/townhall/${token}/questions`, { participant, text: "Again", nonce, website: "" })).body.code).toBe("REPLAY");
    const fresh = await publicApi("GET", `/townhall/${token}?p=${encodeURIComponent(participant)}`);
    expect(fresh.body.participant).toBe(participant);
    expect(ok.body.question).toMatchObject({ author: "Ana", mine: true });
    expect((await publicApi("POST", `/townhall/${token}/questions/${ok.body.question.id}/vote`, { participant, upvote: true })).body.votes).toBe(1);
    // Members see it with the name the participant gave.
    expect((await api(member, "GET", `/townhall/sessions/${session.id}`)).body.questions[0]).toMatchObject({ author: "Ana", mine: false });
    // Polls.
    const poll = await api(host, "POST", `/townhall/sessions/${session.id}/polls`, { kind: "single", title: "Yes?", options: ["Yes", "No"], launch: true });
    const state = await publicApi("GET", `/townhall/${token}?p=${encodeURIComponent(participant)}`);
    expect((await publicApi("POST", `/townhall/${token}/polls/${poll.body.pollId}/vote`, { participant, optionIds: [state.body.polls[0].options[0].id] })).status).toBe(200);
    expect((await publicApi("GET", `/townhall/${token}?p=${encodeURIComponent(participant)}`)).body.polls[0].myVote).toEqual([state.body.polls[0].options[0].id]);
    // A forged participant is refused.
    expect((await publicApi("POST", `/townhall/${token}/questions/${ok.body.question.id}/vote`, { participant: "x.y", upvote: true })).status).toBe(400);
    // Revoked: the one 404.
    await api(host, "PUT", `/townhall/sessions/${session.id}/public-link`, { enabled: false });
    expect(await publicApi("GET", `/townhall/${token}`)).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect((await fetch(`${origin}/p/t/${token}`)).status).toBe(404);
    expect((await api(host, "GET", `/townhall/sessions/${session.id}`)).body.publicUrl).toBeNull();
  });
});

describe("recap, cards, notes", () => {
  test("recap counts, markdown and CSV (formula-safe), unanswered questions become cards, recap posted as a note", async () => {
    const session = await newSession(host);
    const a = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "=cmd|' /C calc'!A0" });
    const b = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Answer me" });
    await api(host, "POST", `/townhall/questions/${b.body.question.id}/moderate`, { action: "answered" });
    await api(host, "GET", `/townhall/sessions/${session.id}`);
    await api(member, "GET", `/townhall/sessions/${session.id}`);
    const data = (await api(member, "GET", `/townhall/sessions/${session.id}/recap`)).body.recap;
    expect(data.totals).toMatchObject({ questions: 2, answered: 1, unanswered: 1, members: 2 });
    const csv = await request(`/townhall/sessions/${session.id}/recap?format=csv`, {}, host);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain(`"'=cmd|' /C calc'!A0"`);
    const md = await (await request(`/townhall/sessions/${session.id}/recap?format=markdown`, {}, host)).text();
    expect(md).toContain("## Still open");
    // A board to send cards to.
    const board = await api(host, "POST", "/tasks/boards", { name: "Follow-ups" });
    expect(board.status).toBe(201);
    const boardId = board.body.board?.id ?? board.body.id;
    const columns = await api(host, "GET", `/tasks/boards/${boardId}/columns`);
    const columnId = columns.body.columns[0].id;
    expect((await api(member, "POST", `/townhall/sessions/${session.id}/cards`, { boardId, columnId, questionIds: [a.body.question.id] })).status).toBe(403);
    const cards = await api(host, "POST", `/townhall/sessions/${session.id}/cards`, { boardId, columnId, questionIds: [a.body.question.id] });
    expect(cards.status).toBe(201);
    expect(cards.body.cards).toHaveLength(1);
    const again = await api(host, "POST", `/townhall/sessions/${session.id}/cards`, { boardId, columnId, questionIds: [a.body.question.id] });
    expect(again.body.cards[0].cardId).toBe(cards.body.cards[0].cardId);
    expect(db.query("SELECT relation FROM work_links WHERE a_kind = 'card' AND b_kind = 'townhall_question' AND b_id = ?").get(a.body.question.id)).toEqual({ relation: "source" });
    const note = await api(host, "POST", `/townhall/sessions/${session.id}/recap/note`);
    expect(note.status).toBe(201);
    expect(note.body.href).toMatch(/^\/notes\//);
    expect((await api(host, "GET", `/townhall/sessions/${session.id}`)).body.session.recapNote.id).toBe(note.body.noteId);
  });
});

describe("MCP", () => {
  test("tools by scope; chosen-item keys reach only their sessions; moderation needs a host; never offered to agents for writes", async () => {
    const mine = await newSession(host, { title: "Key session" });
    const other = await newSession(host, { title: "Other session" });
    const full = createApiKey(member.userId, { name: "Townhall key", surfaces: "both", grants: [{ module: "townhall", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const listed = await invokeMcpToolForTests("list_townhall_sessions", { state: "all" }, full.id) as Json;
    const items = (listed.structuredContent ?? JSON.parse(listed.content[0].text)).items as Json[];
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining([mine.id, other.id]));
    const asked = await invokeMcpToolForTests("ask_townhall_question", { sessionId: mine.shortId, text: "Via MCP" }, full.id) as Json;
    const question = JSON.parse(asked.content[0].text).question;
    expect(db.query("SELECT via FROM townhall_questions WHERE id = ?").get(question.id)).toEqual({ via: "mcp" });
    expect(JSON.parse((await invokeMcpToolForTests("upvote_townhall_question", { questionId: question.id, upvote: true }, full.id) as Json).content[0].text).votes).toBe(1);
    const refused = await invokeMcpToolForTests("moderate_townhall_question", { questionId: question.id, action: "hide" }, full.id) as Json;
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("READ_ONLY");
    const hostKey = createApiKey(host.userId, { name: "Host key", surfaces: "both", grants: [{ module: "townhall", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    expect((await invokeMcpToolForTests("moderate_townhall_question", { questionId: question.id, action: "pin" }, hostKey.id) as Json).isError).toBeFalsy();
    const launched = JSON.parse((await invokeMcpToolForTests("launch_townhall_poll", { sessionId: mine.id, kind: "single", title: "OK?", options: ["Yes", "No"] }, hostKey.id) as Json).content[0].text);
    expect(launched.status).toBe("live");
    expect(JSON.parse((await invokeMcpToolForTests("close_townhall_poll", { sessionId: mine.id, pollId: launched.pollId }, hostKey.id) as Json).content[0].text).status).toBe("closed");
    const exported = JSON.parse((await invokeMcpToolForTests("export_townhall_recap", { sessionId: mine.id, format: "markdown" }, full.id) as Json).content[0].text);
    expect(exported.markdown).toContain("Via MCP");
    // A read key cannot ask.
    const read = createApiKey(member.userId, { name: "Read key", surfaces: "both", grants: [{ module: "townhall", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    expect(((await invokeMcpToolForTests("ask_townhall_question", { sessionId: mine.id, text: "No" }, read.id)) as Json).isError).toBe(true);
    // Chosen items: one session.
    const chosen = createApiKey(member.userId, { name: "One session", surfaces: "both", grants: [{ module: "townhall", permission: "write", resourceKind: "townhall_session", resourceId: mine.id }], expiresInDays: 30 });
    const chosenList = await invokeMcpToolForTests("list_townhall_sessions", {}, chosen.id) as Json;
    expect(JSON.parse(chosenList.content[0].text).items.map((item: Json) => item.id)).toEqual([mine.id]);
    const hidden = await invokeMcpToolForTests("get_townhall_session", { sessionId: other.id }, chosen.id) as Json;
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0].text).toContain("NOT_FOUND");
    // Agents: reads offered, and asking (as the townhall_question proposal, D1047); other writes never.
    for (const name of ["moderate_townhall_question", "launch_townhall_poll"]) expect(NOOK_NEVER_TOOLS.has(name)).toBe(true);
    expect(NOOK_NEVER_TOOLS.has("ask_townhall_question")).toBe(false);
    for (const spec of mcpToolSpecs.filter((entry) => entry.name.includes("townhall"))) expect(spec.scopes.every((scope) => scope.startsWith("townhall:"))).toBe(true);
  });
});

describe("Bin, Today, search, datasets, reminders", () => {
  test("bin and restore by the owner; purge leaves no orphans", async () => {
    const session = await newSession(host);
    const asked = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Gone soon" });
    await api(host, "POST", `/townhall/sessions/${session.id}/polls`, { kind: "rating", title: "Rate", launch: true });
    await api(member, "POST", `/items/townhall_question/${asked.body.question.id}/comments`, { body: "c" });
    await api(host, "PUT", `/townhall/sessions/${session.id}/public-link`, { enabled: true });
    expect((await api(host, "DELETE", `/townhall/sessions/${session.id}`)).body).toEqual({ binned: true });
    expect((await api(member, "GET", `/townhall/sessions/${session.id}`)).status).toBe(404);
    const bin = await api(host, "GET", "/bin?type=townhall_session");
    expect(JSON.stringify(bin.body)).toContain(session.id);
    expect((await api(host, "POST", `/bin/townhall_session/${session.id}/restore`)).status).toBe(200);
    expect((await api(member, "GET", `/townhall/sessions/${session.id}`)).status).toBe(200);
    await api(host, "DELETE", `/townhall/sessions/${session.id}`);
    expect((await api(host, "DELETE", `/bin/townhall_session/${session.id}`)).status).toBeLessThan(300);
    for (const [sql, ...args] of [
      ["SELECT COUNT(*) AS count FROM townhall_questions WHERE session_id = ?", session.id],
      ["SELECT COUNT(*) AS count FROM item_comments WHERE item_kind = 'townhall_question' AND item_id = ?", asked.body.question.id],
      ["SELECT COUNT(*) AS count FROM responses WHERE host_kind = 'townhall_session' AND host_id = ?", session.id],
      ["SELECT COUNT(*) AS count FROM question_sets WHERE host_kind = 'townhall_session' AND host_id = ?", session.id],
      ["SELECT COUNT(*) AS count FROM public_links WHERE kind = 'townhall_session' AND item_id = ?", session.id],
      ["SELECT COUNT(*) AS count FROM item_activity WHERE item_kind = 'townhall_session' AND item_id = ?", session.id]
    ] as const) expect({ sql, ...(db.query(sql).get(...args) as Json) }).toEqual({ sql, count: 0 });
  });

  test("Today lists live sessions; search finds by title; datasets count readable questions only", async () => {
    const session = await newSession(host, { title: "Searchable zebra townhall" });
    await api(host, "POST", `/townhall/sessions/${session.id}/state`, { state: "live" });
    await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Dataset question" });
    const today = await loadToday(todayContext(member.userId, "UTC"), ["townhallLive"]) as Json;
    expect(JSON.stringify(today)).toContain("Searchable zebra townhall");
    const search = await api(member, "GET", "/search?scope=townhall&q=zebra");
    expect(JSON.stringify(search.body)).toContain(session.id);
    const result = runDatasetQuery({ dataset: "townhall.questions", measures: [{ fn: "count" }], dimensions: ["session"], filters: [{ column: "session", op: "eq", value: "Searchable zebra townhall" }] } as never, { userId: member.userId, role: "member" });
    expect(result.rows).toEqual([["Searchable zebra townhall", 1]]);
    // Guests do not have the module's datasets.
    expect(() => runDatasetQuery({ dataset: "townhall.questions", measures: [{ fn: "count" }] } as never, { userId: guest.userId, role: "guest" })).toThrow("Unknown dataset");
  });

  test("a reminder notifies the host and named askers before the start", async () => {
    const session = await newSession(host, { startsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), reminderMinutes: 30 });
    expect(db.query("SELECT purpose FROM schedules WHERE owner_kind = 'townhall_session' AND owner_id = ?").all(session.id)).toEqual([{ purpose: "townhall.remind" }]);
    await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Early question" });
    runReminder(session.id);
    for (const userId of [host.userId, member.userId]) expect(db.query("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND topic = 'townhall.reminder' AND item_id = ?").get(userId, session.id)).toEqual({ count: 1 });
    await api(host, "POST", `/townhall/sessions/${session.id}/state`, { state: "live" });
    expect(db.query("SELECT COUNT(*) AS count FROM schedules WHERE owner_kind = 'townhall_session' AND owner_id = ?").get(session.id)).toEqual({ count: 0 });
  });
});

describe("live stream", () => {
  test("the SSE stream sends the state on open and again after a change", async () => {
    const session = await newSession(host);
    const controller = new AbortController();
    const response = await request(`/townhall/sessions/${session.id}/live`, { signal: controller.signal }, member);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate() && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await until(() => text.includes("event: state"));
    expect(text).toContain("event: state");
    text = "";
    await api(host, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Live one" });
    await until(() => text.includes("Live one"));
    expect(text).toContain("Live one");
    controller.abort();
  });
});
