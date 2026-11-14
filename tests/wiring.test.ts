import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { call as mcpCall, makeKey } from "./support/mcpClient";

const { flushCardChangesForTests, onCardChange } = await import("../server/tasks/cardEvents");
const { flushGoalRecomputeForTests, krsForBoards } = await import("../server/wiring/tasksGoals");
const { pendingActionRuns } = await import("../server/forms/actions");
const { appendRoundToNote } = await import("../server/checkins/noteDigest");
const { createDraftNote, publishDraft } = await import("../server/noteDrafts");
const { readPublishedMarkdown } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { PROPOSAL_KIND_DEFS } = await import("../server/inbox/kinds");
const { NOOK_AGENT_TOOLS, NOOK_NEVER_TOOLS } = await import("../server/agents/nookBridge");
const { WIRED_PROPOSAL_KINDS } = await import("../server/wiring/proposals");

/**
 * Wave 3 wiring (docs/plan/WORKSPACE_MODULES.md §D.8, D1040–D1047): the card-change hook (after
 * commit, refused changes report nothing), Tasks → Contacts "Task done" (C17), Tasks → Goals
 * auto-progress without the sweep (C7), standup goal updates (C5) with Goals' access checks, the
 * round → note digest (C23), time in the standup prefill (C6), Forms → deals and the contact timeline
 * (C3, C21), and the new Inbox proposal kinds (C24).
 */

type Json = Record<string, any>;
const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? (method === "GET" ? {} : { body: "{}" }) : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = JSON.parse(text) as Json; } catch { json = { text }; }
  return { status: response.status, body: json };
};

let owner: Session;
let member: Session;
let outsider: Session;

async function board(session: Session, name: string) {
  const created = await api(session, "POST", "/tasks/boards", { name });
  const columns = created.body.columns as Array<{ id: string; is_done: number }>;
  return { id: created.body.board.id as string, todo: columns[0]!.id, done: columns.find((column) => column.is_done === 1)!.id };
}
const card = async (session: Session, boardId: string, columnId: string, title: string) => (await api(session, "POST", `/tasks/boards/${boardId}/cards`, { columnId, title })).body.card.id as string;
const move = (session: Session, cardId: string, columnId: string) => api(session, "POST", `/tasks/cards/${cardId}/move`, { columnId, afterCardId: null });
const until = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await Bun.sleep(20); return check(); };

beforeAll(async () => {
  owner = await createUser("Wiring owner");
  member = await createUser("Wiring member");
  outsider = await createUser("Wiring outsider");
});

describe("the card-change hook (D1040)", () => {
  test("listeners hear committed changes after the transaction, never refused ones", async () => {
    const heard: string[] = [];
    const stop = onCardChange((changes) => { for (const change of changes) heard.push(`${change.kind}:${change.cardId}`); });
    try {
      const target = await board(owner, "Hook board");
      const cardId = await card(owner, target.id, target.todo, "Hooked");
      await flushCardChangesForTests();
      expect(heard).toContain(`created:${cardId}`);
      // A refused change (an outsider can't read the board) records and reports nothing.
      heard.length = 0;
      expect((await move(outsider, cardId, target.done)).status).toBe(404);
      await flushCardChangesForTests();
      expect(heard).toEqual([]);
      await move(owner, cardId, target.done);
      await flushCardChangesForTests();
      expect(heard).toContain(`column:${cardId}`);
    } finally { stop(); }
  });
});

describe("Tasks → Contacts: a finished linked card logs Task done (C17, D1041)", () => {
  test("once per card and book, without the card's title", async () => {
    const book = await api(owner, "POST", "/crm/books", { name: "Wiring book" });
    const contact = await api(owner, "POST", "/crm/contacts", { bookId: book.body.book.id, name: "Ana Wire", email: "ana@wire.test" });
    expect(contact.status).toBe(201);
    const target = await board(owner, "CRM tasks");
    const task = await api(owner, "POST", "/crm/tasks", { subject: { kind: "contact", id: contact.body.contact.id }, boardId: target.id, columnId: target.todo, title: "Secret plan for Ana" });
    expect(task.status).toBe(201);
    await move(owner, task.body.cardId, target.done);
    await flushCardChangesForTests();
    const rows = () => db.query("SELECT i.title, i.body_md, i.kind, i.source FROM interactions i JOIN interaction_subjects s ON s.interaction_id = i.id WHERE s.subject_id = ? AND i.source = 'task'").all(contact.body.contact.id) as Json[];
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ title: "Task done", kind: "task" });
    expect(rows()[0]!.body_md).not.toContain("Secret plan");
    // Moving it out and back in logs nothing more.
    await move(owner, task.body.cardId, target.todo);
    await move(owner, task.body.cardId, target.done);
    await flushCardChangesForTests();
    expect(rows()).toHaveLength(1);
  });
});

describe("Tasks → Goals auto-progress from the hook (C7, D1042)", () => {
  test("a move on the board recomputes the board's KRs without waiting for the sweep", async () => {
    const target = await board(owner, "Goal board");
    const first = await card(owner, target.id, target.todo, "One");
    await card(owner, target.id, target.todo, "Two");
    const goal = await api(owner, "POST", "/goals", { title: "Ship the board", keyResults: [{ title: "Cards done", source: { kind: "tasks", config: { scope: "board", id: target.id, measure: "cards" } } }] });
    expect(goal.status).toBe(201);
    const krId = goal.body.goal.keyResults[0].id as string;
    expect(krsForBoards([target.id]).map((kr) => kr.id)).toContain(krId);
    expect(krsForBoards(["00000000-0000-4000-8000-000000000000"]).map((kr) => kr.id)).not.toContain(krId);
    await move(owner, first, target.done);
    await flushCardChangesForTests();
    await flushGoalRecomputeForTests();
    const kr = db.query("SELECT current_value, target_value FROM key_results WHERE id = ?").get(krId) as { current_value: number; target_value: number };
    expect(kr).toEqual({ current_value: 1, target_value: 2 });
  });
});

describe("standups: goal updates (C5, D1043), the note digest (C23, D1044), time in prefill (C6, D1046)", () => {
  let checkinId: string;
  let roundId: string;
  let goalId: string;
  let krId: string;
  beforeAll(async () => {
    const created = await api(owner, "POST", "/checkins", { template: "standup", name: "Wired standup", participants: { people: [owner.userId, member.userId], groups: [] } });
    checkinId = created.body.checkin.id;
    const set = { version: 1, sections: [], logic: [], endings: [], questions: [
      { id: "done", type: "long_text", title: "Done?", role: "done" },
      { id: "goals", type: "long_text", title: "Goal updates", role: "goal_update" }
    ] };
    expect((await api(owner, "PUT", `/checkins/${checkinId}/questions`, { set })).status).toBe(200);
    expect((await api(owner, "POST", `/checkins/${checkinId}/questions/publish`)).status).toBe(200);
    const round = await api(owner, "POST", `/checkins/${checkinId}/rounds`);
    roundId = round.body.round?.id ?? round.body.roundId ?? (db.query("SELECT id FROM checkin_rounds WHERE checkin_id = ?").get(checkinId) as { id: string }).id;
    const goal = await api(member, "POST", "/goals", { title: "Member goal", keyResults: [{ title: "Calls", targetValue: 10, currentValue: 0 }] });
    goalId = goal.body.goal.id;
    krId = goal.body.goal.keyResults[0].id;
  });

  test("the sheet lists the person's goals; values typed in the answer write a check-in as them", async () => {
    const targets = await api(member, "GET", "/goals/checkin-targets");
    expect(targets.body.goals.map((goal: Json) => goal.id)).toContain(goalId);
    expect((await api(outsider, "GET", "/goals/checkin-targets")).body.goals.map((goal: Json) => goal.id)).not.toContain(goalId);
    const answered = await api(member, "POST", `/checkin-rounds/${roundId}/answer`, { answers: { done: "Calls", goals: "Four calls booked" }, goalUpdates: [{ goalId, values: { [krId]: 4 } }] });
    expect(answered.status).toBe(201);
    const checkin = db.query("SELECT author_id, note_md, values_json FROM goal_checkins WHERE goal_id = ?").get(goalId) as Json;
    expect(checkin.author_id).toBe(member.userId);
    expect(checkin.note_md).toContain("Four calls booked");
    expect(JSON.parse(checkin.values_json)).toEqual({ [krId]: 4 });
    expect((db.query("SELECT current_value FROM key_results WHERE id = ?").get(krId) as Json).current_value).toBe(4);
  });

  test("a goal the person can't edit fails the answer with Goals' reason, and nothing is saved", async () => {
    const before = (db.query("SELECT COUNT(*) AS n FROM goal_checkins WHERE goal_id = ?").get(goalId) as Json).n;
    const refused = await api(owner, "POST", `/checkin-rounds/${roundId}/answer`, { answers: { done: "x", goals: "y" }, goalUpdates: [{ goalId, values: { [krId]: 9 } }] });
    expect([403, 404]).toContain(refused.status);
    expect((db.query("SELECT COUNT(*) AS n FROM goal_checkins WHERE goal_id = ?").get(goalId) as Json).n).toBe(before);
    expect(db.query("SELECT response_id FROM checkin_round_participants WHERE round_id = ? AND user_id = ?").get(roundId, owner.userId)).toEqual({ response_id: null });
  });

  test("time logged on a card since the last answer is suggested as done work", async () => {
    const target = await board(member, "Timed board");
    const cardId = await card(member, target.id, target.todo, "Timed card");
    expect((await api(member, "POST", "/time/entries", { startedAt: new Date(Date.now() - 3_600_000).toISOString(), duration: "30m", target: { kind: "card", id: cardId } })).status).toBe(201);
    const prefill = await api(member, "GET", `/checkin-rounds/${roundId}/me`);
    expect(prefill.body.timeCards.map((item: Json) => item.id)).toContain(cardId);
    expect(prefill.body.doneCards.map((item: Json) => item.id)).toContain(cardId);
  });

  test("closing a round appends it to the chosen note and publishes it, once", async () => {
    const note = await createDraftNote(owner.userId, null, "# Standup log\n");
    await publishDraft(owner.userId, note.id, 1);
    expect((await api(outsider, "PATCH", `/checkins/${checkinId}`, { summary: { noteId: note.id } })).status).toBe(404);
    expect((await api(owner, "PATCH", `/checkins/${checkinId}`, { summary: { noteId: "00000000-0000-4000-8000-000000000000" } })).status).toBe(400);
    expect((await api(owner, "PATCH", `/checkins/${checkinId}`, { summary: { noteId: note.id } })).status).toBe(200);
    expect((await api(owner, "POST", `/checkin-rounds/${roundId}/close`)).status).toBe(200);
    const version = () => (db.query("SELECT current_version FROM notes WHERE id = ?").get(note.id) as { current_version: number }).current_version;
    expect(await until(() => version() === 2)).toBe(true);
    const published = (await readPublishedMarkdown(note.id, 2)).markdown;
    expect(published).toContain("# Standup log");
    expect(published).toContain("## Wired standup");
    expect(published).toContain("Four calls booked");
    expect(await appendRoundToNote(checkinId, roundId)).toBe("skipped");
    expect(version()).toBe(2);
  });
});

describe("Forms → Contacts: Create a deal and the contact timeline (C3, C21, D1045)", () => {
  test("a response makes a valued deal with the respondent as its contact, logs a form interaction, and retries find it", async () => {
    const book = await api(owner, "POST", "/crm/books", { name: "Form deals" });
    const bookId = book.body.book.id as string;
    const pipelines = await api(owner, "GET", `/crm/pipelines?book=${bookId}`);
    const pipeline = pipelines.body.pipelines[0];
    const set = { version: 1, sections: [], logic: [], endings: [], questions: [
      { id: "name", type: "short_text", title: "Your name", role: "contact_name" },
      { id: "email", type: "email", title: "Email", role: "contact_email" },
      { id: "budget", type: "number", title: "Budget" }
    ] };
    const form = await api(owner, "POST", "/forms", { kind: "form", title: "Quote request", questions: set, publish: true });
    const formId = form.body.form.id as string;
    expect((await api(owner, "POST", `/forms/${formId}/actions`, { kind: "create_deal", config: { bookId: "00000000-0000-4000-8000-000000000000", title: "x" } })).body.code).toBe("INVALID");
    const action = await api(owner, "POST", `/forms/${formId}/actions`, { kind: "create_deal", config: { bookId, pipelineId: pipeline.id, stageId: pipeline.stages[1].id, title: "Quote: {{Your name}}", valueQuestionId: "budget" } });
    expect(action.status).toBe(201);
    const answered = await api(member, "POST", `/forms/${formId}/responses`, { answers: { name: "Bo Buyer", email: "bo@buyer.test", budget: 1250.5 } });
    expect(answered.status).toBe(201);
    await Promise.all([...pendingActionRuns]);
    const deal = db.query("SELECT id, title, value_minor, stage_id, source FROM deals WHERE book_id = ?").get(bookId) as Json;
    expect(deal).toMatchObject({ title: "Quote: Bo Buyer", value_minor: 125050, stage_id: pipeline.stages[1].id, source: "form" });
    const contactId = (db.query("SELECT contact_id FROM deal_contacts WHERE deal_id = ?").get(deal.id) as Json).contact_id as string;
    expect(db.query("SELECT 1 FROM work_links WHERE a_kind = 'deal' AND a_id = ? AND b_kind = 'response' AND b_id = ?").get(deal.id, answered.body.responseId)).not.toBeNull();
    const timeline = await api(owner, "GET", `/crm/records/contact/${contactId}/timeline`);
    expect(timeline.status).toBe(200);
    expect(timeline.body.interactions.map((item: Json) => `${item.kind}:${item.title}`)).toContain("form:Form response");
    // A retried run finds the deal it made.
    db.query("UPDATE form_action_runs SET status = 'failed' WHERE action_id = ?").run(action.body.action.id);
    await api(owner, "POST", `/forms/${formId}/actions/${action.body.action.id}/retry`);
    expect((db.query("SELECT COUNT(*) AS n FROM deals WHERE book_id = ?").get(bookId) as Json).n).toBe(1);
  });
});

describe("Inbox proposal kinds for agents (C24, D1047)", () => {
  test("each kind is registered from its tool, and those tools are offered to agents", () => {
    for (const [kind, def] of Object.entries(WIRED_PROPOSAL_KINDS)) {
      expect(PROPOSAL_KIND_DEFS[kind as keyof typeof PROPOSAL_KIND_DEFS]).toBeDefined();
      expect(NOOK_AGENT_TOOLS.has(def.tool)).toBe(true);
      expect(NOOK_NEVER_TOOLS.has(def.tool)).toBe(false);
    }
    for (const name of ["merge_contacts", "bulk_upsert_contacts", "moderate_townhall_question", "bin_form", "update_form"]) expect(NOOK_NEVER_TOOLS.has(name)).toBe(true);
  });

  test("an agent's contact, deal, interaction, goal check-in, form, and question wait for approval and apply as the approver", async () => {
    resetMcpLimits();
    const book = await api(owner, "POST", "/crm/books", { name: "Proposal book" });
    const bookId = book.body.book.id as string;
    const goal = await api(owner, "POST", "/goals", { title: "Proposal goal", keyResults: [{ title: "Demos", targetValue: 5, currentValue: 0 }] });
    const goalId = goal.body.goal.id as string;
    const krId = goal.body.goal.keyResults[0].id as string;
    const session = await api(owner, "POST", "/townhall/sessions", { title: "Proposal all-hands" });
    const sessionId = (session.body.session?.id ?? session.body.id) as string;
    expect(sessionId).toBeTruthy();
    const key = makeKey(owner, ["crm:read", "goals:read", "forms:read", "townhall:read", "inbox:write"]);
    const submitted = await mcpCall(key, "submit_proposals", { proposals: [
      { kind: "contact_create", title: "Add Cy", payload: { bookId, name: "Cy Prospect", email: "cy@prospect.test" } },
      { kind: "deal_create", title: "Add a deal", payload: { bookId, title: "Cy renewal", value: 50000 } },
      { kind: "goal_checkin", title: "Check in", payload: { goalId, health: "at_risk", values: { [krId]: 2 } } },
      { kind: "form_create", title: "A survey", payload: { kind: "form", title: "Agent survey", questions: [{ id: "q1", type: "short_text", title: "Why?" }] } },
      { kind: "townhall_question", title: "Ask", payload: { sessionId, text: "When is the offsite?" } }
    ] });
    expect(submitted.isError).toBe(false);
    // Nothing applied yet.
    expect(db.query("SELECT 1 FROM contacts WHERE display_name = 'Cy Prospect'").get()).toBeNull();
    const pending = db.query("SELECT id, kind FROM proposals WHERE owner_id = ? AND status = 'pending' AND kind IN ('contact_create','deal_create','goal_checkin','form_create','townhall_question') ORDER BY created_at").all(owner.userId) as Array<{ id: string; kind: string }>;
    expect(pending.map((row) => row.kind).sort()).toEqual(["contact_create", "deal_create", "form_create", "goal_checkin", "townhall_question"]);
    for (const row of pending) {
      const preview = await api(owner, "GET", `/inbox/proposals/${row.id}`);
      expect(preview.status).toBe(200);
      const approved = await api(owner, "POST", `/inbox/proposals/${row.id}/approve`, {});
      expect(approved.status).toBe(200);
    }
    const contact = db.query("SELECT id FROM contacts WHERE display_name = 'Cy Prospect' AND book_id = ?").get(bookId) as { id: string };
    expect(contact).not.toBeNull();
    expect(db.query("SELECT 1 FROM deals WHERE title = 'Cy renewal' AND book_id = ?").get(bookId)).not.toBeNull();
    expect((db.query("SELECT current_value FROM key_results WHERE id = ?").get(krId) as Json).current_value).toBe(2);
    expect(db.query("SELECT 1 FROM forms WHERE title = 'Agent survey' AND owner_id = ?").get(owner.userId)).not.toBeNull();
    expect(db.query("SELECT 1 FROM townhall_questions WHERE session_id = ? AND body = 'When is the offsite?'").get(sessionId)).not.toBeNull();
    // An interaction and a contact update on what was just made.
    const second = await mcpCall(key, "submit_proposals", { proposals: [
      { kind: "contact_update", title: "Fix title", payload: { contactId: contact.id, jobTitle: "CTO" } },
      { kind: "interaction_log", title: "Log the call", payload: { kind: "call", title: "Intro call", contactIds: [contact.id] } }
    ] });
    expect(second.isError).toBe(false);
    for (const row of db.query("SELECT id FROM proposals WHERE owner_id = ? AND status = 'pending' AND kind IN ('contact_update','interaction_log')").all(owner.userId) as Array<{ id: string }>) {
      expect((await api(owner, "POST", `/inbox/proposals/${row.id}/approve`, {})).status).toBe(200);
    }
    expect((db.query("SELECT job_title FROM contacts WHERE id = ?").get(contact.id) as Json).job_title).toBe("CTO");
    expect(db.query("SELECT 1 FROM interactions i JOIN interaction_subjects s ON s.interaction_id = i.id WHERE s.subject_id = ? AND i.title = 'Intro call'").get(contact.id)).not.toBeNull();
  });

  test("a proposal for something the key's owner can't read is NOT_FOUND", async () => {
    resetMcpLimits();
    const book = await api(owner, "POST", "/crm/books", { name: "Private book" });
    const key = makeKey(outsider, ["crm:read", "inbox:write"]);
    const refused = await mcpCall(key, "submit_proposals", { proposals: [{ kind: "contact_create", title: "Sneak", payload: { bookId: book.body.book.id, name: "Nope" } }] });
    expect(JSON.stringify(refused.value)).toContain("NOT_FOUND");
  });
});
