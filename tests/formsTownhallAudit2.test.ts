import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import type { QuestionSet } from "../shared/questions";
import { authorLabel } from "../shared/townhall";

const { issueRenderNonce, resetPublicLimits, PUBLIC_LIMITS } = await import("../server/public/limits");
const { resetTownhallParticipantMints, resetTownhallVoteBuckets } = await import("../server/townhall/publicRoutes");
const { townhallNamedAskerMigration } = await import("../server/migrations/116_townhall_named_asker");
const { dayFilter, formRowById } = await import("../server/forms/service");
const mail = await import("../server/mail");

/**
 * Audit 2 fixes for Forms, Townhall, and the public foundation (docs/plan/WORKSPACE_MODULES.md §D.9,
 * D1100–D1109, T620–T623).
 */

type Json = Record<string, any>;
let host: Session;
let member: Session;
let reader: Session;

const api = async (session: Session | null, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, ...(body === undefined ? (method === "GET" ? {} : { body: "{}" }) : { body: JSON.stringify(body) }) }, session ?? undefined);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as Json, text, headers: response.headers };
};
const publicApi = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${origin}/api/public${path}`, { method, headers: { "Content-Type": "application/json", Origin: origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as Json, headers: response.headers };
};

async function liveSession(title: string, body: Json = {}) {
  const session = (await api(host, "POST", "/townhall/sessions", { title, ...body })).body.session as Json;
  expect((await api(host, "POST", `/townhall/sessions/${session.id}/state`, { state: "live" })).status).toBeLessThan(300);
  return session;
}
async function audienceLink(sessionId: string) {
  const link = await api(host, "PUT", `/townhall/sessions/${sessionId}/public-link`, { enabled: true });
  return String(link.body.publicUrl).split("/").pop()!;
}

beforeAll(async () => {
  host = await createUser("Audit2 host");
  member = await createUser("Audit2 member");
  reader = await createUser("Audit2 reader");
});
afterAll(() => mail.setMailTransportForTests(null));

describe("anonymous questions and responses name nobody (FT1, FT2; D1100, D1101, T620)", () => {
  test("audit rows of an anonymous question and its withdrawal carry no actor and no question id", async () => {
    const session = await liveSession("Audit2 anon audit");
    const anon = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Secret one", anonymous: true });
    expect(anon.status).toBe(201);
    const asked = db.query("SELECT actor_id, metadata_json FROM audit_log WHERE event_type = 'townhall.question_asked' AND json_extract(metadata_json, '$.sessionId') = ?").all(session.id) as Json[];
    expect(asked).toHaveLength(1);
    expect(asked[0]!.actor_id).toBeNull();
    expect(JSON.parse(asked[0]!.metadata_json).questionId).toBeUndefined();
    expect((await api(member, "DELETE", `/townhall/questions/${anon.body.question.id}`)).status).toBe(200);
    const withdrawn = db.query("SELECT actor_id, metadata_json FROM audit_log WHERE event_type = 'townhall.question_withdrawn' AND json_extract(metadata_json, '$.sessionId') = ?").all(session.id) as Json[];
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]!.actor_id).toBeNull();
    expect(JSON.parse(withdrawn[0]!.metadata_json).questionId).toBeUndefined();
  });

  test("an anonymous question waiting for review notifies the host with no actor", async () => {
    const session = await liveSession("Audit2 anon review", { moderation: "review" });
    expect((await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Pending secret", anonymous: true })).status).toBe(201);
    const note = db.query("SELECT * FROM notifications WHERE user_id = ? AND topic = 'townhall.review' ORDER BY created_at DESC LIMIT 1").get(host.userId) as Json;
    expect(JSON.stringify(note)).not.toContain(member.userId);
  });

  test("a named and an anonymous question of one person have unrelated asker hashes; both stay theirs", async () => {
    const session = await liveSession("Audit2 hashes");
    const named = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Named one" });
    const anon = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Anon one", anonymous: true });
    const anon2 = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Anon two", anonymous: true });
    const hash = (id: string) => (db.query("SELECT asker_hash FROM townhall_questions WHERE id = ?").get(id) as Json).asker_hash as string;
    expect(hash(named.body.question.id)).not.toBe(hash(anon.body.question.id));
    expect(hash(named.body.question.id)).toMatch(/^[0-9a-f]{64}$/);
    const state = (await api(member, "GET", `/townhall/sessions/${session.id}`)).body as Json;
    const mine = Object.fromEntries((state.questions as Json[]).map((question) => [question.id, question.mine]));
    expect(mine).toEqual({ [named.body.question.id]: true, [anon.body.question.id]: true, [anon2.body.question.id]: true });
    // Nobody else sees them as theirs.
    const other = (await api(reader, "GET", `/townhall/sessions/${session.id}`)).body as Json;
    expect((other.questions as Json[]).some((question) => question.mine)).toBe(false);
    expect((await api(reader, "DELETE", `/townhall/questions/${named.body.question.id}`)).status).toBe(404);
    expect((await api(member, "DELETE", `/townhall/questions/${named.body.question.id}`)).status).toBe(200);
  });

  test("a public participant keeps withdraw on their named question (salted hash)", async () => {
    resetPublicLimits(); resetTownhallParticipantMints(); resetTownhallVoteBuckets();
    const session = await liveSession("Audit2 public named");
    const token = await audienceLink(session.id);
    const page = await publicApi("GET", `/townhall/${token}`);
    await Bun.sleep(1600);
    const asked = await publicApi("POST", `/townhall/${token}/questions`, { participant: page.body.participant, text: "From outside", name: "Pat", nonce: page.body.renderNonce, website: "" });
    expect(asked.status).toBe(201);
    expect(asked.body.question.mine).toBe(true);
    const other = await publicApi("GET", `/townhall/${token}`);
    expect((other.body.questions as Json[]).find((question) => question.id === asked.body.question.id)?.mine).toBe(false);
    expect((await publicApi("POST", `/townhall/${token}/questions/${asked.body.question.id}/withdraw`, { participant: page.body.participant })).status).toBe(200);
  });

  test("migration 116 replaces named rows' session hashes and leaves anonymous rows alone", async () => {
    const session = await liveSession("Audit2 migration");
    const named = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Old named" });
    const anon = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Old anon", anonymous: true });
    const anonHash = (db.query("SELECT asker_hash FROM townhall_questions WHERE id = ?").get(anon.body.question.id) as Json).asker_hash as string;
    // A row as the old code wrote it: the named question carries the same session hash.
    db.query("UPDATE townhall_questions SET asker_hash = ? WHERE id = ?").run(anonHash, named.body.question.id);
    townhallNamedAskerMigration.up(db);
    const after = (id: string) => (db.query("SELECT asker_hash FROM townhall_questions WHERE id = ?").get(id) as Json).asker_hash as string;
    expect(after(anon.body.question.id)).toBe(anonHash);
    expect(after(named.body.question.id)).not.toBe(anonHash);
    expect(after(named.body.question.id)).toMatch(/^[0-9a-f]{64}$/);
    const state = (await api(member, "GET", `/townhall/sessions/${session.id}`)).body as Json;
    expect((state.questions as Json[]).every((question) => question.mine)).toBe(true);
  });

  test("an anonymous form response's audit row has no actor and no response id", async () => {
    const poll = (await api(host, "POST", "/forms/polls", { question: "Audit2 secret?", options: ["a", "b"], anonymous: true })).body.form as Json;
    const view = (await api(member, "GET", `/forms/${poll.id}/respond`)).body as Json;
    const question = view.set.questions[0];
    expect((await api(member, "POST", `/forms/${poll.id}/responses`, { answers: { [question.id]: question.options[0].id } })).status).toBe(201);
    const rows = db.query("SELECT actor_id, metadata_json FROM audit_log WHERE event_type = 'forms.response_submit' AND json_extract(metadata_json, '$.formId') = ?").all(poll.id) as Json[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBeNull();
    expect(JSON.parse(rows[0]!.metadata_json).responseId).toBeUndefined();
  });
});

describe("anonymous forms read by the day (FT3; D1102, T623)", () => {
  test("CSV, the response list, and its cursor carry the day only", async () => {
    const poll = (await api(host, "POST", "/forms/polls", { question: "Audit2 day?", options: ["a", "b"], anonymous: true })).body.form as Json;
    for (const session of [member, reader]) {
      const view = (await api(session, "GET", `/forms/${poll.id}/respond`)).body as Json;
      const question = view.set.questions[0];
      expect((await api(session, "POST", `/forms/${poll.id}/responses`, { answers: { [question.id]: question.options[0].id } })).status).toBe(201);
    }
    const csv = (await api(host, "GET", `/forms/${poll.id}/export.csv`)).text.replace(/^﻿/, "");
    const lines = csv.trim().split("\r\n").slice(1);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.split(",")[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const page = (await api(host, "GET", `/forms/${poll.id}/responses?limit=1`)).body as Json;
    expect(page.items[0].submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const cursor = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8")) as string[];
    expect(cursor[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const next = (await api(host, "GET", `/forms/${poll.id}/responses?limit=1&cursor=${page.nextCursor}`)).body as Json;
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).not.toBe(page.items[0].id);
  });

  test("since/until move to whole days on anonymous forms only", () => {
    const anonymous = { anonymous: 1 } as never;
    expect(dayFilter(anonymous, { since: "2026-11-14T13:45:10.000Z", until: "2026-11-14T13:45:11.000Z" })).toEqual({ since: "2026-11-14T00:00:00.000Z", until: "2026-11-15T00:00:00.000Z" });
    expect(dayFilter(anonymous, { until: "2026-11-15T00:00:00.000Z" })).toEqual({ until: "2026-11-15T00:00:00.000Z" });
    expect(dayFilter({ anonymous: 0 } as never, { since: "2026-11-14T13:45:10.000Z" })).toEqual({ since: "2026-11-14T13:45:10.000Z" });
  });
});

describe("a room behind one address (FT4; D1103, T622)", () => {
  test("townhall reads use their own buckets: many participants pass, one participant is capped, pages keep their budget", async () => {
    resetPublicLimits(); resetTownhallParticipantMints();
    const session = await liveSession("Audit2 room");
    const token = await audienceLink(session.id);
    const first = await publicApi("GET", `/townhall/${token}`);
    const participants: string[] = [first.body.participant];
    for (let index = 0; index < PUBLIC_LIMITS.pagePerMinute + 20; index += 1) {
      const loaded = await publicApi("GET", `/townhall/${token}?p=${encodeURIComponent(participants[index % participants.length]!)}${index}`);
      expect(loaded.status).toBe(200);
    }
    // The page budget of the address is untouched: other public pages still load.
    const page = await fetch(`${origin}/p/t/${token}`);
    expect(page.status).toBe(200);
    // One participant past its own cap gets a 429 with Retry-After.
    let limited: { status: number; headers: Headers } | null = null;
    for (let index = 0; index <= PUBLIC_LIMITS.roomParticipantPerMinute; index += 1) {
      const loaded = await publicApi("GET", `/townhall/${token}?p=${encodeURIComponent(first.body.participant)}`);
      if (loaded.status === 429) { limited = loaded; break; }
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get("Retry-After"))).toBeGreaterThan(0);
    resetPublicLimits();
  });
});

const REQUIRED_SET: QuestionSet = {
  version: 1, sections: [], endings: [], logic: [],
  questions: [{ id: "name", type: "short_text", title: "Your name", required: true }]
};
async function publicForm(title: string, patch: Json = {}, questions: QuestionSet = REQUIRED_SET) {
  const created = await api(host, "POST", "/forms", { kind: "form", title, questions, publish: true });
  const formId = created.body.form.id as string;
  const link = await api(host, "POST", `/forms/${formId}/public-link`);
  if (Object.keys(patch).length) expect((await api(host, "PATCH", `/forms/${formId}`, patch)).status).toBe(200);
  return { formId, token: link.body.token as string };
}
const submit = (formId: string, token: string, body: Json, nonce = issueRenderNonce("form", formId, Date.now() - 10_000)) =>
  api(null, "POST", `/public/forms/${token}/responses`, { nonce, website: "", ...body });

describe("refusals after the shared checks carry a fresh nonce (FT5; D1105)", () => {
  test("a 400 for answers gives a nonce that the next try can use", async () => {
    resetPublicLimits();
    const { formId, token } = await publicForm("Audit2 nonce");
    const refused = await submit(formId, token, { answers: {} });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("INVALID_ANSWERS");
    expect(typeof refused.body.renderNonce).toBe("string");
    await Bun.sleep(3100);
    const sent = await submit(formId, token, { answers: { name: "Ada" } }, refused.body.renderNonce);
    expect(sent.status).toBe(201);
  });

  test("a 409 carries one too; the uniform 404 does not", async () => {
    resetPublicLimits();
    const { formId, token } = await publicForm("Audit2 nonce 409", { limitPer: "browser" });
    const browser = "audit2browser00000001";
    expect((await submit(formId, token, { answers: { name: "Ada" }, browser })).status).toBe(201);
    const again = await submit(formId, token, { answers: { name: "Ada" }, browser });
    expect(again.status).toBe(409);
    expect(typeof again.body.renderNonce).toBe("string");
    const missing = await api(null, "POST", `/public/forms/not-a-token-at-all/responses`, { nonce: "x", answers: {} });
    expect(missing.status).toBe(404);
    expect(missing.body.renderNonce).toBeUndefined();
  });

  test("a townhall question refused by the session (questions closed) gets a fresh nonce", async () => {
    resetPublicLimits(); resetTownhallParticipantMints();
    const session = await liveSession("Audit2 th nonce");
    const token = await audienceLink(session.id);
    const page = await publicApi("GET", `/townhall/${token}`);
    expect((await api(host, "PATCH", `/townhall/sessions/${session.id}`, { questionsOpen: false })).status).toBe(200);
    await Bun.sleep(1600);
    const refused = await publicApi("POST", `/townhall/${token}/questions`, { participant: page.body.participant, text: "Too late", name: null, nonce: page.body.renderNonce, website: "" });
    expect(refused.status).toBe(409);
    expect(typeof refused.body.renderNonce).toBe("string");
    expect(refused.body.renderNonce).not.toBe(page.body.renderNonce);
  });
});

describe("guest names say so (FT6; D1104, T621)", () => {
  test("a public participant typing a member's name shows as a guest everywhere", async () => {
    resetPublicLimits(); resetTownhallParticipantMints();
    const session = await liveSession("Audit2 guest");
    const token = await audienceLink(session.id);
    const page = await publicApi("GET", `/townhall/${token}`);
    await Bun.sleep(1600);
    expect((await publicApi("POST", `/townhall/${token}/questions`, { participant: page.body.participant, text: "Fake host", name: "Audit2 host", nonce: page.body.renderNonce, website: "" })).status).toBe(201);
    expect((await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Real member" })).status).toBe(201);
    const state = (await api(member, "GET", `/townhall/sessions/${session.id}`)).body as Json;
    const byText = Object.fromEntries((state.questions as Json[]).map((question) => [question.text, question]));
    expect(byText["Fake host"]).toMatchObject({ author: "Audit2 host", authorKind: "guest" });
    expect(authorLabel(byText["Fake host"] as never)).toBe("Audit2 host · guest");
    expect(byText["Real member"]).toMatchObject({ author: "Audit2 member", authorKind: "member" });
    expect(authorLabel(byText["Real member"] as never)).toBe("Audit2 member");
    const recap = (await api(host, "GET", `/townhall/sessions/${session.id}/recap?format=markdown`)).text;
    expect(recap).toContain("Audit2 host · guest");
  });
});

describe("session list paging (FT7; D1106)", () => {
  test("live sessions first, then newest, with no repeats or skips across pages", async () => {
    const tag = `pg${Date.now().toString(36)}`;
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) ids.push((await liveSession(`${tag} live ${index}`)).id);
    for (let index = 0; index < 3; index += 1) {
      ids.push((await api(host, "POST", "/townhall/sessions", { title: `${tag} later ${index}`, startsAt: new Date(Date.now() + (index + 2) * 86_400_000).toISOString() })).body.session.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Json = (await api(host, "GET", `/townhall/sessions?q=${tag}&limit=2${cursor ? `&cursor=${cursor}` : ""}`)).body;
      seen.push(...(page.items as Json[]).map((item) => item.id as string));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect(seen.slice(0, 3).sort()).toEqual(ids.slice(0, 3).sort());
  });
});

describe("a response limit reached in public closes the form properly (FT8; D1107)", () => {
  test("status, audit, and item change as any close", async () => {
    resetPublicLimits();
    const { formId, token } = await publicForm("Audit2 limit", { maxResponses: 1 });
    expect((await submit(formId, token, { answers: { name: "Ada" } })).status).toBe(201);
    expect(formRowById(formId)!.status).toBe("closed");
    expect(formRowById(formId)!.closed_at).not.toBeNull();
    const audits = db.query("SELECT metadata_json FROM audit_log WHERE event_type = 'forms.status' AND json_extract(metadata_json, '$.formId') = ?").all(formId) as Json[];
    expect(audits.map((row) => JSON.parse(row.metadata_json).to)).toContain("closed");
    expect((await submit(formId, token, { answers: { name: "Bo" } })).body.code).toBe("FORM_CLOSED");
  });
});

describe("minor fixes (D1108, D1109)", () => {
  test("the public time-poll grid shows members by first name and no response ids", async () => {
    resetPublicLimits();
    const start = Date.parse("2026-12-03T09:00:00Z");
    const slots = Array.from({ length: 2 }, (_, index) => ({ start: new Date(start + index * 3_600_000).toISOString(), end: new Date(start + (index + 1) * 3_600_000).toISOString() }));
    const created = await api(host, "POST", "/forms/time-polls", { title: "Audit2 when", slots });
    const id = created.body.form.id as string;
    const link = await api(host, "POST", `/forms/${id}/public-link`);
    expect((await api(host, "PATCH", `/forms/${id}`, { resultsVisibility: "live" })).status).toBe(200);
    const view = (await api(member, "GET", `/forms/${id}/respond`)).body as Json;
    const question = view.set.questions[0];
    expect((await api(member, "POST", `/forms/${id}/responses`, { answers: { [question.id]: { [question.slots[0].id]: "yes", [question.slots[1].id]: "no" } } })).status).toBe(201);
    const response = db.query("SELECT id FROM responses WHERE host_kind = 'form' AND host_id = ?").get(id) as Json;
    const shown = await api(null, "GET", `/public/forms/${link.body.token}`);
    expect(shown.status).toBe(200);
    const participants = shown.body.results.participants as Json[];
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({ name: "Audit2", key: "p1" });
    expect(JSON.stringify(shown.body)).not.toContain(response.id);
  });

  test("an owner-only poll shows no vote count publicly", async () => {
    const poll = (await api(host, "POST", "/forms/polls", { question: "Audit2 count?", options: ["a", "b"], resultsVisibility: "owner_only" })).body.form as Json;
    const link = await api(host, "POST", `/forms/${poll.id}/public-link`);
    const shown = await api(null, "GET", `/public/forms/${link.body.token}`);
    expect(shown.body.form.responseCount).toBeNull();
    expect((await api(null, "GET", `/public/forms/${link.body.token}/results`)).body.responseCount).toBeNull();
  });

  test("confirming a second held response from the same browser is refused", async () => {
    mail.setMailTransportForTests(async () => ({ id: "msg" }));
    resetPublicLimits();
    const EMAIL_SET: QuestionSet = { version: 1, sections: [], endings: [], logic: [], questions: [{ id: "email", type: "email", title: "Email", required: true, role: "contact_email" }] };
    const { formId, token } = await publicForm("Audit2 verify twice", { verifyEmail: true, limitPer: "browser" }, EMAIL_SET);
    const browser = "audit2browser00000002";
    const first = await submit(formId, token, { answers: { email: "one@outside.test" }, browser });
    const second = await submit(formId, token, { answers: { email: "two@outside.test" }, browser });
    expect([first.status, second.status]).toEqual([202, 202]);
    const codeFor = (address: string) => JSON.parse((db.query("SELECT payload FROM mail_outbox WHERE template = 'public.verification' AND to_address = ? ORDER BY created_at DESC LIMIT 1").get(address) as { payload: string }).payload).code as string;
    expect((await api(null, "POST", `/public/forms/${token}/verify`, { id: first.body.verificationId, code: codeFor("one@outside.test") })).status).toBe(201);
    const refused = await api(null, "POST", `/public/forms/${token}/verify`, { id: second.body.verificationId, code: codeFor("two@outside.test") });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("ALREADY_RESPONDED");
    mail.setMailTransportForTests(null);
  });

  test("a reader's recap counts upvotes on questions they can see only", async () => {
    const session = await liveSession("Audit2 recap votes", { moderation: "review" });
    const approved = await api(host, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Host asks" });
    const pending = await api(member, "POST", `/townhall/sessions/${session.id}/questions`, { text: "Waiting" });
    expect(pending.body.question.status).toBe("pending");
    db.query("UPDATE townhall_questions SET vote_count = 5 WHERE id = ?").run(pending.body.question.id);
    db.query("UPDATE townhall_questions SET vote_count = 2 WHERE id = ?").run(approved.body.question.id);
    expect((await api(reader, "GET", `/townhall/sessions/${session.id}/recap`)).body.recap.totals.votes).toBe(2);
    expect((await api(host, "GET", `/townhall/sessions/${session.id}/recap`)).body.recap.totals.votes).toBe(7);
  });
});

describe("a public poll is one tap (UI2; D1110)", () => {
  test("a poll takes a vote 1.5 s after render; a form still refuses that as too fast, with a fresh nonce to retry", async () => {
    resetPublicLimits();
    const poll = (await api(host, "POST", "/forms/polls", { question: "Audit2 tap?", options: ["a", "b"], anonymous: true })).body.form as Json;
    const link = await api(host, "POST", `/forms/${poll.id}/public-link`);
    const shown = (await api(null, "GET", `/public/forms/${link.body.token}`)).body as Json;
    const question = shown.set.questions[0];
    const voted = await submit(poll.id, link.body.token, { answers: { [question.id]: question.options[0].id } }, issueRenderNonce("form", poll.id, Date.now() - 1500));
    expect(voted.status).toBe(201);
    const { formId, token } = await publicForm("Audit2 slow form");
    const fast = await submit(formId, token, { answers: { name: "Ada" } }, issueRenderNonce("form", formId, Date.now() - 1500));
    expect(fast.status).toBe(400);
    expect(fast.body.code).toBe("TOO_FAST");
    expect(typeof fast.body.renderNonce).toBe("string");
  });
});
