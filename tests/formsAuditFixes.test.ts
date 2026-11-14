import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import type { QuestionSet } from "../shared/questions";

const { issueRenderNonce, resetPublicLimits } = await import("../server/public/limits");
const mail = await import("../server/mail");
const { pendingActionRuns } = await import("../server/forms/actions");
const settle = async () => { await Promise.all([...pendingActionRuns]); };

/**
 * Forms audit fixes (§D.1): email verification with mail off (D863); hidden fields never give a
 * public respondent their identity (D864, T523).
 */

let owner: Session;
const api = async (session: Session | null, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, ...(body === undefined ? (method === "GET" ? {} : { body: "{}" }) : { body: JSON.stringify(body) }) }, session ?? undefined);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as Record<string, any> };
};

const SET: QuestionSet = {
  version: 1, sections: [], endings: [], logic: [],
  questions: [
    { id: "name", type: "short_text", title: "Your name", required: true, role: "contact_name" },
    { id: "email", type: "email", title: "Email", role: "contact_email" }
  ]
};

async function publicForm(title: string, patch: Record<string, unknown> = {}) {
  const created = await api(owner, "POST", "/forms", { kind: "form", title, questions: SET, publish: true });
  const formId = created.body.form.id as string;
  const link = await api(owner, "POST", `/forms/${formId}/public-link`);
  if (Object.keys(patch).length) expect((await api(owner, "PATCH", `/forms/${formId}`, patch)).status).toBe(200);
  return { formId, token: link.body.token as string };
}
const submit = (formId: string, token: string, body: Record<string, unknown>) =>
  api(null, "POST", `/public/forms/${token}/responses`, { nonce: issueRenderNonce("form", formId, Date.now() - 10_000), website: "", ...body });

beforeAll(async () => {
  owner = await createUser("Forms audit owner");
});
afterAll(() => mail.setMailTransportForTests(null));

describe("confirm email with mail off (D863)", () => {
  test("mail off: the response counts unverified at once, the page asks no code, the editor says why", async () => {
    mail.setMailTransportForTests(null);
    resetPublicLimits();
    const { formId, token } = await publicForm("Mail-off intake", { verifyEmail: true });
    const detail = await api(owner, "GET", `/forms/${formId}`);
    expect(detail.body.form).toMatchObject({ verifyEmail: true, mailEnabled: false });
    expect((await api(null, "GET", `/public/forms/${token}`)).body.form.verifyEmail).toBe(false);
    const sent = await submit(formId, token, { answers: { name: "Ada", email: "ada@outside.test" } });
    expect(sent.status).toBe(201);
    expect(db.query("SELECT COUNT(*) AS n FROM public_verifications WHERE item_id = ?").get(formId)).toEqual({ n: 0 });
    const meta = JSON.parse((db.query("SELECT meta_json FROM responses WHERE host_kind = 'form' AND host_id = ?").get(formId) as { meta_json: string }).meta_json);
    expect(meta.verified).toBeUndefined();
  });

  test("mail on: the response is held for a code", async () => {
    mail.setMailTransportForTests(async () => ({ id: "msg" }));
    resetPublicLimits();
    const { formId, token } = await publicForm("Mail-on intake", { verifyEmail: true });
    expect((await api(null, "GET", `/public/forms/${token}`)).body.form.verifyEmail).toBe(true);
    const held = await submit(formId, token, { answers: { name: "Ada", email: "ada@outside.test" } });
    expect(held.status).toBe(202);
    mail.setMailTransportForTests(null);
  });
});

describe("hidden fields are not identity on public submissions (D864, T523)", () => {
  const HIDDEN_SET: QuestionSet = {
    version: 1, sections: [], endings: [], logic: [],
    questions: [
      { id: "name", type: "short_text", title: "Your name", required: true, role: "contact_name" },
      { id: "email", type: "email", title: "Email", role: "contact_email" },
      { id: "ref", type: "hidden", title: "Referrer email", hiddenKey: "ref" }
    ]
  };
  async function hiddenForm(title: string, verifyEmail: boolean) {
    const book = await api(owner, "POST", "/forms/contact-books", { name: `${title} book` });
    const created = await api(owner, "POST", "/forms", { kind: "form", title, questions: HIDDEN_SET, publish: true });
    const formId = created.body.form.id as string;
    const link = await api(owner, "POST", `/forms/${formId}/public-link`);
    if (verifyEmail) await api(owner, "PATCH", `/forms/${formId}`, { verifyEmail: true });
    expect((await api(owner, "POST", `/forms/${formId}/actions`, { kind: "save_contact", config: { bookId: book.body.book.id, emailQuestionId: "ref" } })).status).toBe(201);
    return { formId, token: link.body.token as string, bookId: book.body.book.id as string };
  }
  const emailsIn = (bookId: string) => (db.query("SELECT ch.value_norm AS email FROM contacts c JOIN contact_channels ch ON ch.contact_id = c.id WHERE c.book_id = ? AND ch.kind = 'email' ORDER BY 1").all(bookId) as Array<{ email: string }>).map((row) => row.email);

  test("a verified public response saves the address that confirmed the code, not the URL's hidden value", async () => {
    mail.setMailTransportForTests(async () => ({ id: "msg" }));
    resetPublicLimits();
    const { formId, token, bookId } = await hiddenForm("Verified hidden", true);
    const held = await submit(formId, token, { answers: { name: "Mallory", email: "mallory@outside.test" }, hidden: { ref: "victim@outside.test" } });
    expect(held.status).toBe(202);
    const outbox = db.query("SELECT payload FROM mail_outbox WHERE template = 'public.verification' AND to_address = 'mallory@outside.test' ORDER BY created_at DESC LIMIT 1").get() as { payload: string };
    const code = JSON.parse(outbox.payload).code as string;
    const verified = await api(null, "POST", `/public/forms/${token}/verify`, { id: held.body.verificationId, code });
    expect(verified.status).toBe(201);
    await settle();
    expect(emailsIn(bookId)).toEqual(["mallory@outside.test"]);
    mail.setMailTransportForTests(null);
  });

  test("an unverified public response ignores the hidden email; a member's own response may use it", async () => {
    resetPublicLimits();
    const { formId, token, bookId } = await hiddenForm("Unverified hidden", false);
    expect((await submit(formId, token, { answers: { name: "Mallory", email: "mallory2@outside.test" }, hidden: { ref: "victim2@outside.test" } })).status).toBe(201);
    await settle();
    expect(emailsIn(bookId)).not.toContain("victim2@outside.test");
    const own = await api(owner, "POST", `/forms/${formId}/responses`, { answers: { name: "Owner" }, hidden: { ref: "lead@inside.test" } });
    expect(own.status).toBe(201);
    await settle();
    expect(emailsIn(bookId)).toContain("lead@inside.test");
  });
});
