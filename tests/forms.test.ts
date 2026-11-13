import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import type { QuestionSet } from "../shared/questions";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { runScheduleTick } = await import("../server/schedules/dispatcher");
const { loadToday, todayContext } = await import("../server/today/registry");
const { issueRenderNonce, resetPublicLimits } = await import("../server/public/limits");
const { createBoard, listColumns } = await import("../server/tasks/service");
const { pendingActionRuns } = await import("../server/forms/actions");
const { runDatasetQuery } = await import("../server/datasets/registry");
const { formsBinProvider } = await import("../server/forms/registry");
const { restoreUndo } = await import("../server/undo");
const { NOOK_AGENT_TOOLS, NOOK_NEVER_TOOLS } = await import("../server/agents/nookBridge");
const { escapeMarkdown, renderTemplate } = await import("../server/forms/actions");
const { pollSet } = await import("../shared/forms");

/**
 * Forms, polls, and time polls (docs/plan/WORKSPACE_MODULES.md §D.1 acceptance): the service through
 * HTTP, access (owner, shared reader, audience member, outsider, guest), versions, summaries, CSV,
 * public submissions with the anti-abuse checks, response actions (card + contact), polls with their
 * results visibility, time polls finalized into a calendar event, the Bin and purge, Today, search,
 * datasets, and the MCP tools with scopes and chosen-item keys.
 */

let owner: Session;
let member: Session;
let outsider: Session;
let guest: Session;
const api = async (session: Session | null, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, ...(body === undefined ? (method === "GET" ? {} : { body: "{}" }) : { body: JSON.stringify(body) }) }, session ?? undefined);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as Record<string, any>, text, headers: response.headers };
};
const settle = async () => { await Promise.all([...pendingActionRuns]); };

const SET: QuestionSet = {
  version: 1,
  sections: [{ id: "s1", title: "About you" }, { id: "s2", title: "Details" }],
  endings: [{ id: "e1", title: "Thanks, early bird" }],
  questions: [
    { id: "name", type: "short_text", title: "Your name", required: true, role: "contact_name", sectionId: "s1" },
    { id: "email", type: "email", title: "Email", role: "contact_email", sectionId: "s1" },
    { id: "team", type: "single_choice", title: "Team", options: [{ id: "eng", label: "Engineering" }, { id: "ops", label: "Ops" }], sectionId: "s1" },
    { id: "score", type: "nps", title: "Recommend us?", sectionId: "s2" },
    { id: "rating", type: "rating", title: "Rating", scale: { min: 1, max: 5, icon: "star" }, sectionId: "s2" },
    { id: "why", type: "long_text", title: "Why?", sectionId: "s2" },
    { id: "when", type: "date", title: "Start date", sectionId: "s2" },
    { id: "langs", type: "multi_choice", title: "Languages", options: [{ id: "ts", label: "TypeScript" }, { id: "go", label: "Go" }], sectionId: "s2" }
  ],
  logic: [{ id: "r1", when: { all: [{ questionId: "team", op: "eq", value: "ops" }] }, then: { hide: ["langs"] } }]
};

beforeAll(async () => {
  owner = await createUser("Forms owner");
  member = await createUser("Forms member");
  outsider = await createUser("Forms outsider");
  guest = await createUser("Forms guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
});

describe("forms: build, publish, answer, results", () => {
  let formId = "";
  let shortId = "";
  test("create a draft with sections and logic; publish opens it; versions pin responses", async () => {
    const created = await api(owner, "POST", "/forms", { kind: "form", title: "Onboarding survey", questions: SET });
    expect(created.status).toBe(201);
    formId = created.body.form.id;
    shortId = created.body.form.shortId;
    expect(created.body.form).toMatchObject({ status: "draft", level: "owner", hasDraft: true, version: 0 });
    expect(created.body.form.href).toBe(`/forms/onboarding-survey-${shortId}`);
    // Members cannot answer a draft.
    expect((await api(member, "POST", `/forms/${formId}/responses`, { answers: { name: "M" } })).status).toBe(404);
    const published = await api(owner, "POST", `/forms/${shortId}/publish`);
    expect(published.body.form).toMatchObject({ status: "open", version: 1, hasDraft: false, accepting: true });
    // Nothing to publish now.
    expect((await api(owner, "POST", `/forms/${formId}/publish`)).body.code).toBe("NO_DRAFT");
  });

  test("a member answers once (logic drops hidden answers); results need view; the outsider is not invited when the audience is chosen", async () => {
    const view = await api(member, "GET", `/forms/${formId}/respond`);
    expect(view.body).toMatchObject({ version: 1, closedReason: null, mine: null });
    expect(view.body.form.level).toBeNull();
    const answered = await api(member, "POST", `/forms/${formId}/responses`, { answers: { name: "Mia", email: "mia@example.test", team: "ops", score: 9, rating: 4, why: "=HYPERLINK(\"x\")", when: "2026-12-01", langs: { options: ["go"] } } });
    expect(answered.status).toBe(201);
    const again = await api(member, "POST", `/forms/${formId}/responses`, { answers: { name: "Mia" } });
    expect(again.body.code).toBe("ALREADY_RESPONDED");
    expect((await api(member, "GET", `/forms/${formId}/responses`)).status).toBe(404);
    expect((await api(member, "GET", `/forms/${formId}`)).status).toBe(404);
    // Required, validated by the engine.
    expect((await api(outsider, "POST", `/forms/${formId}/responses`, { answers: {} })).body).toMatchObject({ code: "INVALID_ANSWERS", errors: { name: "This question is required" } });
    const list = await api(owner, "GET", `/forms/${formId}/responses`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].respondentName).toBe("Forms member");
    expect(list.body.items[0].answers.langs).toBeUndefined();
    // The owner limits the audience to one person: the outsider can no longer even see it.
    const patched = await api(owner, "PATCH", `/forms/${formId}`, { audience: "selected", audienceUsers: [member.userId] });
    expect(patched.body.form.audience).toBe("selected");
    expect((await api(outsider, "GET", `/forms/${formId}/respond`)).status).toBe(404);
    expect((await api(outsider, "GET", "/forms?tab=answer")).body.items.map((item: { id: string }) => item.id)).not.toContain(formId);
    await api(owner, "PATCH", `/forms/${formId}`, { audience: "workspace" });
  });

  test("v2 keeps old answers readable; summary aggregates; CSV is formula-safe", async () => {
    const draft = await api(owner, "GET", `/forms/${formId}/draft`);
    const next = { ...draft.body.set, questions: draft.body.set.questions.map((q: { id: string; title: string }) => q.id === "team" ? { ...q, title: "Your team" } : q).filter((q: { id: string }) => q.id !== "when") };
    expect((await api(owner, "PUT", `/forms/${formId}/draft`, { set: next })).body.hasDraft).toBe(true);
    expect((await api(owner, "POST", `/forms/${formId}/publish`)).body.form.version).toBe(2);
    await api(outsider, "POST", `/forms/${formId}/responses`, { answers: { name: "Otto", team: "eng", score: 3, rating: 2, why: "slow", langs: { options: ["ts", "go"] } } });
    const list = await api(owner, "GET", `/forms/${formId}/responses`);
    const old = list.body.items.find((item: { setVersion: number }) => item.setVersion === 1);
    expect(old.answers.when).toBe("2026-12-01");
    const summary = await api(owner, "GET", `/forms/${formId}/summary`);
    expect(summary.body.responses).toBe(2);
    const nps = summary.body.questions.find((item: { questionId: string }) => item.questionId === "score");
    expect(nps).toMatchObject({ kind: "nps", promoters: 1, detractors: 1, score: 0 });
    const team = summary.body.questions.find((item: { questionId: string }) => item.questionId === "team");
    expect(team.options.map((option: { count: number }) => option.count)).toEqual([1, 1]);
    const filtered = await api(owner, "GET", `/forms/${formId}/summary?question=team&option=eng`);
    expect(filtered.body.responses).toBe(1);
    const csv = await api(owner, "GET", `/forms/${formId}/export.csv`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.text).toContain("'=HYPERLINK");
    expect(csv.text).not.toMatch(/,=HYPERLINK/);
  });

  test("sharing gives results to readers; a guest answers only when chosen; a guest cannot create", async () => {
    expect((await api(guest, "POST", "/forms", { kind: "form" })).status).toBe(403);
    expect((await api(guest, "GET", `/forms/${formId}/respond`)).status).toBe(404);
    await api(owner, "PATCH", `/forms/${formId}`, { audience: "selected", audienceUsers: [guest.userId, member.userId] });
    expect((await api(guest, "POST", `/forms/${formId}/responses`, { answers: { name: "Gus" } })).status).toBe(201);
    const access = await request("/access/form/" + formId, {}, owner);
    const etag = access.headers.get("ETag")!;
    const put = await request("/access/form/" + formId, { method: "PUT", headers: { "If-Match": etag }, body: JSON.stringify({ audience: "selected", people: [{ id: member.userId, level: "view" }], groups: [] }) }, owner);
    expect(put.status).toBe(200);
    const readerView = await api(member, "GET", `/forms/${formId}/summary`);
    expect(readerView.status).toBe(200);
    expect((await api(member, "PATCH", `/forms/${formId}`, { title: "x" })).body.code).toBe("READ_ONLY");
    expect((await api(member, "GET", "/forms?tab=shared")).body.items.map((item: { id: string }) => item.id)).toContain(formId);
  });

  test("delete a response with undo; close and reopen; max responses closes it", async () => {
    const list = await api(owner, "GET", `/forms/${formId}/responses`);
    const target = list.body.items[0].id;
    const deleted = await api(owner, "DELETE", `/forms/${formId}/responses/${target}`);
    expect(deleted.body.undoTicket).toBeString();
    expect((await api(owner, "GET", `/forms/${formId}`)).body.form.responseCount).toBe(2);
    restoreUndo(deleted.body.undoTicket, owner.userId);
    expect((await api(owner, "GET", `/forms/${formId}`)).body.form.responseCount).toBe(3);
    expect((await api(owner, "PATCH", `/forms/${formId}`, { status: "closed" })).body.form.status).toBe("closed");
    expect((await api(outsider, "GET", `/forms/${formId}/respond`)).status).toBe(404);
    await api(owner, "PATCH", `/forms/${formId}`, { audience: "workspace", status: "open", maxResponses: 4 });
    expect((await api(outsider, "POST", `/forms/${formId}/responses`, { answers: { name: "O2" } })).body.code).toBe("ALREADY_RESPONDED");
    const extra = await createUser("Forms extra");
    expect((await api(extra, "POST", `/forms/${formId}/responses`, { answers: { name: "Ext" } })).status).toBe(201);
    expect((await api(owner, "GET", `/forms/${formId}`)).body.form).toMatchObject({ status: "closed", accepting: false });
  });

  test("closing on a date is a schedule; the owner hears a day before", async () => {
    const created = await api(owner, "POST", "/forms", { kind: "form", title: "Dated", questions: SET, publish: true });
    const id = created.body.form.id;
    const closes = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await api(owner, "PATCH", `/forms/${id}`, { closesAt: closes });
    const purposes = (db.query("SELECT purpose FROM schedules WHERE owner_kind = 'form' AND owner_id = ? ORDER BY purpose").all(id) as Array<{ purpose: string }>).map((row) => row.purpose);
    expect(purposes).toEqual(["forms.close", "forms.closing"]);
    db.query("UPDATE forms SET closes_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
    await runScheduleTick({ nowMs: Date.now() + 3 * 86_400_000 });
    expect((db.query("SELECT status FROM forms WHERE id = ?").get(id) as { status: string }).status).toBe("closed");
    expect(db.query("SELECT 1 FROM notifications WHERE user_id = ? AND topic = 'forms.closing'").get(owner.userId)).not.toBeNull();
  });
});

describe("public link (§B.8)", () => {
  let formId = "";
  let token = "";
  test("create a public link; the page and JSON open logged out; anti-abuse refuses bots", async () => {
    const created = await api(owner, "POST", "/forms", { kind: "form", title: "Public intake", questions: { ...SET, logic: [] }, publish: true });
    formId = created.body.form.id;
    const link = await api(owner, "POST", `/forms/${formId}/public-link`);
    expect(link.status).toBe(201);
    token = link.body.token;
    expect((await api(owner, "GET", `/forms/${formId}`)).body.form.audience).toBe("public");
    const page = await fetch(`${origin}/p/f/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const json = await api(null, "GET", `/public/forms/${token}`);
    expect(json.status).toBe(200);
    expect(json.body.set.questions.every((q: { role?: string }) => q.role === undefined)).toBe(true);
    expect(JSON.stringify(json.body)).not.toContain(owner.userId);
    resetPublicLimits();
    const fresh = json.body.renderNonce;
    expect((await api(null, "POST", `/public/forms/${token}/responses`, { answers: { name: "Bot" }, nonce: fresh, website: "" })).body.code).toBe("TOO_FAST");
    const old = () => issueRenderNonce("form", formId, Date.now() - 10_000);
    expect((await api(null, "POST", `/public/forms/${token}/responses`, { answers: { name: "Bot" }, nonce: old(), website: "http://spam" })).body.code).toBe("HONEYPOT");
    expect((await api(null, "POST", `/public/forms/${token}/responses`, { answers: { name: "Bot" }, website: "" })).body.code).toBe("INVALID");
    const nonce = old();
    const ok = await api(null, "POST", `/public/forms/${token}/responses`, { answers: { name: "Pat Public", email: "pat@example.test", why: "@SUM(1)" }, nonce, website: "", browser: "browser-aaaaaaaaaaaaaaaa" });
    expect(ok.status).toBe(201);
    expect((await api(null, "POST", `/public/forms/${token}/responses`, { answers: { name: "Pat" }, nonce, website: "" })).body.code).toBe("REPLAY");
    expect((await api(null, "POST", `/public/forms/${token}/responses`, { answers: { name: "Pat" }, nonce: old(), website: "", browser: "browser-aaaaaaaaaaaaaaaa" })).body.code).toBe("ALREADY_RESPONDED");
    const responses = await api(owner, "GET", `/forms/${formId}/responses`);
    expect(responses.body.items[0]).toMatchObject({ respondentName: "Pat Public", respondent: { kind: "guest", email: "pat@example.test" } });
  });

  test("members-only types cannot be published publicly; revoking 404s at once", async () => {
    const draft = await api(owner, "GET", `/forms/${formId}/draft`);
    const withFile = { ...draft.body.set, questions: [...draft.body.set.questions, { id: "upload", type: "file", title: "Upload" }] };
    await api(owner, "PUT", `/forms/${formId}/draft`, { set: withFile });
    expect((await api(owner, "POST", `/forms/${formId}/publish`)).status).toBe(400);
    await api(owner, "DELETE", `/forms/${formId}/draft`);
    await api(owner, "DELETE", `/forms/${formId}/public-link`);
    expect((await api(null, "GET", `/public/forms/${token}`)).status).toBe(404);
    expect((await fetch(`${origin}/p/f/${token}`)).status).toBe(404);
  });
});

describe("response actions (C2, C3)", () => {
  test("a response creates a card with mapped, escaped fields and saves a contact; both link back", async () => {
    const board = (createBoard(owner.userId, "Intake board") as { board: { id: string } }).board;
    const column = listColumns(board.id)[0]!;
    const book = await api(owner, "POST", "/forms/contact-books", { name: "Leads" });
    const created = await api(owner, "POST", "/forms", { kind: "form", title: "Lead form", questions: { ...SET, logic: [] }, publish: true });
    const formId = created.body.form.id;
    const card = await api(owner, "POST", `/forms/${formId}/actions`, { kind: "create_card", config: { boardId: board.id, columnId: column.id, title: "Lead: {{Your name}}", description: "Why: {{why}}", dueQuestionId: "when" } });
    expect(card.status).toBe(201);
    expect((await api(owner, "POST", `/forms/${formId}/actions`, { kind: "save_contact", config: { bookId: book.body.book.id } })).status).toBe(201);
    expect((await api(owner, "POST", `/forms/${formId}/actions`, { kind: "create_deal", config: {} })).body.code).toBe("NOT_AVAILABLE");
    expect((await api(member, "POST", `/forms/${formId}/actions`, { kind: "notify", config: { userIds: [member.userId] } })).status).toBe(404);
    const answered = await api(member, "POST", `/forms/${formId}/responses`, { answers: { name: "Ana *Silva*", email: "ana@acme.test", why: "[click](http://evil)", when: "2026-12-24" } });
    await settle();
    const cardRow = db.query("SELECT id, title, description, due_on FROM cards WHERE board_id = ? ORDER BY created_at DESC LIMIT 1").get(board.id) as { id: string; title: string; description: string; due_on: string };
    expect(cardRow.title).toBe("Lead: Ana *Silva*");
    expect(cardRow.description).toContain("\\[click\\]\\(http://evil\\)");
    expect(cardRow.due_on).toBe("2026-12-24");
    expect(db.query("SELECT 1 FROM work_links WHERE a_kind = 'card' AND a_id = ? AND b_kind = 'response' AND b_id = ?").get(cardRow.id, answered.body.responseId)).not.toBeNull();
    const contact = db.query("SELECT c.display_name FROM contacts c JOIN contact_channels ch ON ch.contact_id = c.id WHERE ch.value_norm = 'ana@acme.test' AND c.book_id = ?").get(book.body.book.id) as { display_name: string };
    expect(contact.display_name).toBe("Ana *Silva*");
    const actions = await api(owner, "GET", `/forms/${formId}/actions`);
    expect(actions.body.actions.map((action: { lastRun: { status: string } }) => action.lastRun.status)).toEqual(["done", "done"]);
    const listed = await api(owner, "GET", `/forms/${formId}/responses`);
    expect(listed.body.items[0].actions.map((action: { kind: string }) => action.kind).sort()).toEqual(["create_card", "save_contact"]);
    // The owner heard about the response.
    expect(db.query("SELECT title FROM notifications WHERE user_id = ? AND topic = 'forms.response' AND item_id = ?").get(owner.userId, formId)).not.toBeNull();
  });
});

describe("polls and time polls", () => {
  test("action templates escape answers and link only http(s) urls (T520)", () => {
    const set = { ...pollSet("Pick", ["A", "B"], false), questions: [{ id: "n", type: "short_text" as const, title: "Name" }, { id: "u", type: "url" as const, title: "Site" }] };
    expect(renderTemplate("Lead: {{Name}}", set, { n: "Ana *bold*" }, { markdown: false })).toBe("Lead: Ana *bold*");
    expect(renderTemplate("{{Name}} {{Site}}", set, { n: "[x](javascript:alert(1))", u: "https://acme.test" }, { markdown: true })).toBe(`${escapeMarkdown("[x](javascript:alert(1))")} <https://acme.test>`);
  });

  test("a poll opens at once; results after voting; one vote per person, changeable; anonymous hides voters", async () => {
    const created = await api(owner, "POST", "/forms/polls", { question: "Lunch?", options: ["Pizza", "Sushi"], resultsVisibility: "after_vote" });
    expect(created.body.form).toMatchObject({ kind: "poll", status: "open" });
    const id = created.body.form.id;
    const before = await api(member, "GET", `/forms/${id}/respond`);
    expect(before.body.results).toBeNull();
    const question = before.body.set.questions[0];
    const vote = await api(member, "POST", `/forms/${id}/responses`, { answers: { [question.id]: question.options[1].id } });
    expect(vote.body.view.results.total).toBe(1);
    expect(vote.body.view.results.voters[0].people[0].name).toBe("Forms member");
    const change = await api(member, "POST", `/forms/${id}/responses`, { answers: { [question.id]: question.options[0].id } });
    expect(change.body.updated).toBe(true);
    expect(change.body.view.results.total).toBe(1);
    expect((await api(member, "DELETE", `/forms/${id}/vote`)).body.view.results).toBeNull();
    const anon = await api(owner, "POST", "/forms/polls", { question: "Secret?", options: ["Yes", "No"], anonymous: true });
    const anonQ = (await api(member, "GET", `/forms/${anon.body.form.id}/respond`)).body.set.questions[0];
    const anonVote = await api(member, "POST", `/forms/${anon.body.form.id}/responses`, { answers: { [anonQ.id]: anonQ.options[0].id } });
    expect(anonVote.body.view.results.voters).toEqual([]);
    expect(db.query("SELECT respondent_user_id FROM responses WHERE host_id = ?").get(anon.body.form.id)).toEqual({ respondent_user_id: null });
    expect((await api(member, "POST", `/forms/${anon.body.form.id}/responses`, { answers: { [anonQ.id]: anonQ.options[1].id } })).body.code).toBe("ALREADY_RESPONDED");
  });

  test("a time poll: votes in a grid; finalize creates the event, closes, and notifies participants", async () => {
    const start = Date.parse("2026-12-01T09:00:00Z");
    const slots = Array.from({ length: 6 }, (_, index) => ({ start: new Date(start + index * 3_600_000).toISOString(), end: new Date(start + (index + 1) * 3_600_000).toISOString() }));
    const created = await api(owner, "POST", "/forms/time-polls", { title: "Planning", slots });
    const id = created.body.form.id;
    const view = await api(member, "GET", `/forms/${id}/respond`);
    const question = view.body.set.questions[0];
    const votes = Object.fromEntries(question.slots.map((slot: { id: string }, index: number) => [slot.id, index === 2 ? "yes" : index === 3 ? "maybe" : "no"]));
    await api(member, "POST", `/forms/${id}/responses`, { answers: { [question.id]: votes } });
    const grid = (await api(owner, "GET", `/forms/${id}/respond`)).body.results;
    expect(grid.participants[0].votes[question.slots[2].id]).toBe("yes");
    expect(grid.summary.best).toBe(question.slots[2].id);
    const targets = await api(owner, "GET", "/forms/targets");
    const calendarId = targets.body.calendars[0].id;
    const final = await api(owner, "POST", `/forms/${id}/finalize`, { slotId: question.slots[2].id, calendarId, tz: "Europe/Paris" });
    expect(final.status).toBe(200);
    expect(final.body.form).toMatchObject({ status: "closed", finalizedSlotId: question.slots[2].id });
    const event = db.query("SELECT title, start_local, tz FROM events WHERE id = ?").get(final.body.eventId) as { title: string; start_local: string; tz: string };
    expect(event).toEqual({ title: "Planning", start_local: "2026-12-01T12:00", tz: "Europe/Paris" });
    expect(db.query("SELECT 1 FROM notifications WHERE user_id = ? AND topic = 'forms.finalized'").get(member.userId)).not.toBeNull();
    expect((await api(owner, "POST", `/forms/${id}/finalize`, { slotId: question.slots[0].id, calendarId })).body.code).toBe("ALREADY_FINALIZED");
  });
});

describe("Bin, Today, search, datasets", () => {
  test("delete → Bin → restore → purge leaves no orphans", async () => {
    const created = await api(owner, "POST", "/forms", { kind: "form", title: "Binned survey", questions: SET, publish: true });
    const id = created.body.form.id;
    await api(member, "POST", `/forms/${id}/responses`, { answers: { name: "M" } });
    await api(owner, "POST", `/forms/${id}/public-link`);
    expect((await api(member, "DELETE", `/forms/${id}`)).status).toBe(404);
    expect((await api(owner, "DELETE", `/forms/${id}`)).status).toBe(200);
    expect((await api(owner, "GET", `/forms/${id}`)).status).toBe(404);
    expect(formsBinProvider.list(owner.userId).map((item) => item.id)).toContain(id);
    expect((await formsBinProvider.restore(id, owner.userId)).status).toBe("restored");
    await api(owner, "DELETE", `/forms/${id}`);
    expect(await formsBinProvider.purge(id, owner.userId)).toBe("purged");
    for (const [table, where] of [["responses", "host_id"], ["question_sets", "host_id"], ["public_links", "item_id"], ["item_activity", "item_id"], ["schedules", "owner_id"], ["forms_fts", "form_id"]] as const) {
      expect({ table, n: (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where} = ?`).get(id) as { n: number }).n }).toEqual({ table, n: 0 });
    }
  });

  test("Today lists polls to vote on and forms with new responses; search finds forms by question title", async () => {
    const poll = await api(owner, "POST", "/forms/polls", { question: "Offsite city?", options: ["Lisbon", "Berlin"] });
    const today = await loadToday(todayContext(member.userId, "UTC"), ["pollsToVote"]);
    expect((today.sections.pollsToVote!.items as Array<{ id: string }>).map((item) => item.id)).toContain(poll.body.form.id);
    const mine = await loadToday(todayContext(owner.userId, "UTC"), ["formsResponses"]);
    expect(mine.sections.formsResponses!.items.length).toBeGreaterThan(0);
    const search = await api(owner, "GET", "/search?scope=forms&q=Languages");
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.body)).toContain("Onboarding survey");
    await api(owner, "POST", "/forms", { kind: "form", title: "Secret draft" });
    expect(JSON.stringify((await api(outsider, "GET", "/search?scope=forms&q=Secret")).body)).not.toContain("Secret draft");
    expect(JSON.stringify((await api(owner, "GET", "/search?scope=forms&q=Secret")).body)).toContain("Secret draft");
  });

  test("datasets apply the reader predicate", () => {
    const query = { dataset: "forms.responses", measures: [{ column: "response_id", fn: "count_distinct" }], dimensions: ["form"], limit: 100 };
    const ownerRows = runDatasetQuery(query as never, { userId: owner.userId, role: "member" }).rows;
    const outsiderRows = runDatasetQuery(query as never, { userId: outsider.userId, role: "member" }).rows;
    expect(ownerRows.length).toBeGreaterThan(0);
    expect(outsiderRows).toEqual([]);
  });
});

describe("MCP (forms:read / forms:write)", () => {
  test("create → get → submit (second key) → summary; create_poll embeds into a note; chosen-item keys cannot list others", async () => {
    const write = createApiKey(owner.userId, { name: "Forms writer", surfaces: "both", grants: [{ module: "forms", permission: "write", resourceKind: null, resourceId: null }, { module: "notes", permission: "draft", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const created = await invokeMcpToolForTests("create_form", { kind: "form", title: "MCP survey", questions: [{ id: "q1", type: "rating", title: "Rate", required: true, scale: { min: 1, max: 5, icon: "star" } }], publish: true }, write.id);
    expect(created.isError).toBeFalsy();
    const form = JSON.parse(created.content[0]!.text).form;
    expect(form.status).toBe("open");
    const got = JSON.parse((await invokeMcpToolForTests("get_form", { formId: form.url }, write.id)).content[0]!.text);
    expect(got.questions.questions[0].id).toBe("q1");
    const memberKey = createApiKey(member.userId, { name: "Member forms", surfaces: "both", grants: [{ module: "forms", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const submitted = await invokeMcpToolForTests("submit_response", { formId: form.shortId, answers: { q1: 5 } }, memberKey.id);
    expect(submitted.isError).toBeFalsy();
    const summary = JSON.parse((await invokeMcpToolForTests("get_form_summary", { formId: form.id }, write.id)).content[0]!.text);
    expect(summary.questions[0]).toMatchObject({ kind: "numeric", mean: 5 });
    // The member is a respondent, not a reader: results are NOT_FOUND to them.
    expect(JSON.parse((await invokeMcpToolForTests("list_responses", { formId: form.id }, memberKey.id)).content[0]!.text).code).toBe("NOT_FOUND");
    const csv = JSON.parse((await invokeMcpToolForTests("export_responses", { formId: form.id }, write.id)).content[0]!.text);
    expect(csv.csv).toContain("Rate");
    const chosen = createApiKey(owner.userId, { name: "One form", surfaces: "both", grants: [{ module: "forms", permission: "read", resourceKind: "form", resourceId: form.id }], expiresInDays: 30 });
    const listed = JSON.parse((await invokeMcpToolForTests("list_forms", { tab: "mine" }, chosen.id)).content[0]!.text);
    expect(listed.items.map((item: { id: string }) => item.id)).toEqual([form.id]);
    const other = (db.query("SELECT id FROM forms WHERE owner_id = ? AND id <> ? AND deleted_at IS NULL LIMIT 1").get(owner.userId, form.id) as { id: string }).id;
    expect(JSON.parse((await invokeMcpToolForTests("get_form", { formId: other }, chosen.id)).content[0]!.text).code).toBe("NOT_FOUND");
    const vote = JSON.parse((await invokeMcpToolForTests("create_poll", { question: "Ship Friday?", options: ["Yes", "No"] }, write.id)).content[0]!.text);
    expect(vote.embedMarkdown).toMatch(/^\[Poll\]\(\/forms\/ship-friday-[0-9a-z]{10} "nook-embed"\)$/);
    const voted = JSON.parse((await invokeMcpToolForTests("vote_poll", { formId: vote.form.id, optionIds: [JSON.parse((await invokeMcpToolForTests("get_form", { formId: vote.form.id }, memberKey.id)).content[0]!.text).questions.questions[0].options[0].id] }, memberKey.id)).content[0]!.text);
    expect(voted.results.total).toBe(1);
    // Reads scope cannot write; delete needs bin:write too.
    const reader = createApiKey(owner.userId, { name: "Reader", surfaces: "both", grants: [{ module: "forms", permission: "read", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    expect((await invokeMcpToolForTests("create_poll", { question: "x?", options: ["a", "b"] }, reader.id)).isError).toBe(true);
    expect((await invokeMcpToolForTests("bin_form", { formId: form.id }, write.id)).isError).toBe(true);
  });

  test("agents: reads, polls, and answers are offered; building and deleting forms is not", () => {
    for (const name of ["list_forms", "get_form", "create_poll", "vote_poll", "submit_response"]) expect(NOOK_AGENT_TOOLS.has(name)).toBe(true);
    for (const name of ["create_form", "bin_form", "finalize_time_poll"]) expect(NOOK_NEVER_TOOLS.has(name)).toBe(true);
  });
});
