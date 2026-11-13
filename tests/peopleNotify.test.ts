import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { createContactBook, ensureClientsBook, upsertContactByEmail, markContactEdited, contactSummaries, readableBookIds } = await import("../server/people/contacts");
const { notify, enqueueExternalMail, EXTERNAL_CAPS, NotifyError } = await import("../server/notify");
const { registerMailTemplate } = await import("../server/mail/registry");
const { layout } = await import("../server/mail/layout");
const mail = await import("../server/mail");
const { mentionMarkdown } = await import("../shared/itemActivity");

/**
 * People core and module notifications (docs/plan/WORKSPACE_MODULES.md §B.3, §B.7, D806, D807, D809,
 * T503, T505, T508, T509).
 */

let owner: Session;
let reader: Session;
let outsider: Session;
let bookId: string;

const api = async (session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await request(path, { method, headers, ...(body === undefined && method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) }, session);
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json as Record<string, any>, etag: response.headers.get("etag") };
};

beforeAll(async () => {
  owner = await createUser("People owner");
  reader = await createUser("People reader");
  outsider = await createUser("People outsider");
  bookId = createContactBook({ ownerId: owner.userId, name: "Sales" });
});

describe("upsert by email (D806)", () => {
  test("creates once, links the company by domain (never free mail), fills only empty fields, never overwrites an edit", () => {
    const first = db.transaction(() => upsertContactByEmail(bookId, { email: "Ana.Silva@Acme.test" }, { source: "booking", actor: null }))();
    expect(first).toMatchObject({ created: true, filled: [] });
    expect(first.companyId).not.toBeNull();
    const company = db.query("SELECT name, domain, source FROM companies WHERE id = ?").get(first.companyId!) as { name: string; domain: string; source: string };
    expect(company).toEqual({ name: "Acme", domain: "acme.test", source: "email_domain" });
    expect((db.query("SELECT display_name FROM contacts WHERE id = ?").get(first.contactId) as { display_name: string }).display_name).toBe("ana.silva");
    // Same email, any case: the same contact; the empty name and phone are filled.
    const second = db.transaction(() => upsertContactByEmail(bookId, { email: "ana.silva@acme.test", name: "Ana Silva", phone: "+351 912 345 678" }, { source: "form", actor: null }))();
    expect(second).toMatchObject({ contactId: first.contactId, created: false, filled: ["name", "phone"] });
    expect(db.query("SELECT first_name, last_name, display_name FROM contacts WHERE id = ?").get(first.contactId)).toEqual({ first_name: "Ana", last_name: "Silva", display_name: "Ana Silva" });
    // A person edits the name: later upserts leave it alone.
    db.query("UPDATE contacts SET first_name = 'Anabela', display_name = 'Anabela Silva' WHERE id = ?").run(first.contactId);
    markContactEdited(first.contactId, ["name"]);
    const third = db.transaction(() => upsertContactByEmail(bookId, { email: "ana.silva@acme.test", name: "Somebody Else" }, { source: "booking", actor: null }))();
    expect(third.filled).toEqual([]);
    expect((db.query("SELECT display_name FROM contacts WHERE id = ?").get(first.contactId) as { display_name: string }).display_name).toBe("Anabela Silva");
    // A free-mail address never links a company.
    const gmail = db.transaction(() => upsertContactByEmail(bookId, { email: "joe@gmail.com", name: "Joe" }, { source: "booking", actor: null }))();
    expect(gmail.companyId).toBeNull();
    // A second contact at the same domain joins the same company.
    expect(db.transaction(() => upsertContactByEmail(bookId, { email: "bo@acme.test" }, { source: "form", actor: null }))().companyId).toBe(first.companyId);
    // Activity records the source, never the address (T505).
    const activity = db.query("SELECT kind, payload FROM item_activity WHERE item_id = ? ORDER BY created_at").all(first.contactId) as Array<{ kind: string; payload: string }>;
    expect(activity.map((row) => row.kind)).toEqual(["contact_created", "contact_filled"]);
    expect(activity.some((row) => row.payload.includes("acme.test"))).toBe(false);
  });

  test("the Clients book is one per person and hidden from book lists", async () => {
    const clients = ensureClientsBook(owner.userId);
    expect(ensureClientsBook(owner.userId)).toBe(clients);
    const listed = await api(owner, "GET", "/workspace/key-resources?module=crm");
    expect(listed.body.resources.map((item: { id: string }) => item.id)).toEqual([bookId]);
  });
});

describe("contact access (T503) and the generic Access sheet", () => {
  test("readers of the book see a contact's details; others see 'A contact'; sharing through /api/access opens it", async () => {
    const contact = db.transaction(() => upsertContactByEmail(bookId, { email: "cara@acme.test", name: "Cara" }, { source: "manual", actor: owner.userId }))();
    expect(contactSummaries([contact.contactId], reader.userId).get(contact.contactId)).toEqual({ kind: "contact", id: contact.contactId, hidden: true });
    expect(contactSummaries([contact.contactId], owner.userId).get(contact.contactId)).toMatchObject({ kind: "contact", name: "Cara", email: "cara@acme.test" });
    expect((await api(reader, "GET", `/access/contact_book/${bookId}`)).status).toBe(404);
    const sheet = await api(owner, "GET", `/access/contact_book/${bookId}`);
    expect(sheet.body).toMatchObject({ kind: "contact_book", title: "Sales", audience: "private", yourLevel: "owner", levels: ["view", "comment", "edit", "manage"] });
    expect((await api(owner, "PUT", `/access/contact_book/${bookId}`, { audience: "selected", people: [{ id: reader.userId, level: "view" }] })).status).toBe(428);
    const shared = await api(owner, "PUT", `/access/contact_book/${bookId}`, { audience: "selected", people: [{ id: reader.userId, level: "view" }] }, { "If-Match": sheet.etag! });
    expect(shared.status).toBe(200);
    expect(readableBookIds(reader.userId)).toContain(bookId);
    expect(readableBookIds(outsider.userId)).not.toContain(bookId);
    expect(contactSummaries([contact.contactId], reader.userId).get(contact.contactId)).toMatchObject({ name: "Cara" });
    // A viewer of the book is not a manager: the sheet is the owner's.
    expect((await api(reader, "GET", `/access/contact_book/${bookId}`)).status).toBe(403);
    const search = await api(reader, "GET", "/people/search?q=car&allow=user,contact");
    expect(search.body.people).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "contact", name: "Cara", bookId })]));
    expect((await api(outsider, "GET", "/people/search?q=car&allow=contact")).body.people).toEqual([]);
  });

  test("a mention on a contact notifies the people who can read it, and nobody else", async () => {
    const contact = db.transaction(() => upsertContactByEmail(bookId, { email: "dee@acme.test", name: "Dee" }, { source: "manual", actor: owner.userId }))();
    const body = `${mentionMarkdown("People reader", reader.userId)} and ${mentionMarkdown("People outsider", outsider.userId)}: call Dee`;
    expect((await api(owner, "POST", `/items/contact/${contact.contactId}/comments`, { body })).status).toBe(201);
    // A viewer of the book reads but cannot comment (comment level and up).
    expect((await api(reader, "POST", `/items/contact/${contact.contactId}/comments`, { body: "x" })).status).toBe(403);
    const readerBell = await api(reader, "GET", "/notifications");
    expect(readerBell.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "module", module: "crm", topic: "core.mention", href: expect.stringMatching(/^\/contacts\/dee-[0-9][0-9a-z]{9}$/), actor: { id: owner.userId, name: "People owner" } })]));
    expect((await api(outsider, "GET", "/notifications")).body.items.filter((item: { kind: string }) => item.kind === "module")).toEqual([]);
  });
});

describe("notify() (D809, T509)", () => {
  test("writes one unread row per user and dedupe key, skips the actor, and refuses an unsafe href", async () => {
    const send = (title: string) => notify({ userIds: [reader.userId, owner.userId], module: "forms", topic: "forms.response", title, href: "/forms/abc", actor: owner.userId, dedupeKey: "responses:abc" });
    expect(db.transaction(() => send("1 new response"))().notified).toEqual([reader.userId]);
    db.transaction(() => send("2 new responses"))();
    const rows = db.query("SELECT title FROM notifications WHERE user_id = ? AND dedupe_key = 'responses:abc'").all(reader.userId);
    expect(rows).toEqual([{ title: "2 new responses" }]);
    for (const href of ["https://evil.example", "//evil.example", "javascript:alert(1)", "/ok\\evil"]) {
      expect(() => notify({ userIds: [reader.userId], module: "forms", topic: "forms.response", title: "x", href })).toThrow(NotifyError);
    }
    expect(() => notify({ userIds: [reader.userId], module: "nope" as never, topic: "forms.response", title: "x", href: "/x" })).toThrow(NotifyError);
    // Read: a new event makes a new unread row.
    expect((await api(reader, "POST", "/notifications/read", { all: true })).status).toBe(200);
    db.transaction(() => send("3 new responses"))();
    expect(db.query("SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND dedupe_key = 'responses:abc'").get(reader.userId)).toEqual({ count: 2 });
  });
});

describe("mail to outside addresses (T508)", () => {
  let unregister: () => void;
  beforeAll(() => {
    unregister = registerMailTemplate("test.outside", {
      name: "test.outside", class: "activity",
      render: (data: { name: string; stopHref?: string }, context) => layout({ instanceName: context.instanceName, subject: `Hi ${data.name}`, preheader: "Hi", eyebrow: "Test", title: "Hi", blocks: [], footer: { reason: "Test." } }),
      fixture: () => ({ name: "Ana" }),
      resolveExternal: (payload) => ({ data: { name: String(payload.name) } })
    }) as unknown as () => void;
  });
  afterAll(() => unregister?.());

  test("nothing is queued while mail is off; caps per address and per item; only registered outside templates", () => {
    mail.setMailTransportForTests(null);
    expect(enqueueExternalMail({ to: "x@outside.test", template: "test.outside", payload: { name: "X" }, itemRef: { kind: "booking", id: "b1" } })).toBeNull();
    mail.setMailTransportForTests(async () => ({ id: "msg" }));
    try {
      const queued: Array<string | null> = [];
      for (let index = 0; index < EXTERNAL_CAPS.addressHour + 1; index += 1) {
        queued.push(enqueueExternalMail({ to: "cap@outside.test", template: "test.outside", payload: { name: "Cap" }, itemRef: { kind: "booking", id: `b${index}` } }));
      }
      expect(queued.filter((id) => id !== null).length).toBe(EXTERNAL_CAPS.addressHour);
      expect(queued[EXTERNAL_CAPS.addressHour]).toBeNull();
      const row = db.query("SELECT user_id, to_address, coalesce_key FROM mail_outbox WHERE id = ?").get(queued[0]!) as { user_id: string | null; to_address: string; coalesce_key: string };
      expect(row).toMatchObject({ user_id: null, to_address: "cap@outside.test" });
      expect(row.coalesce_key).toMatch(/^x:booking:b0:/);
      expect(() => enqueueExternalMail({ to: "x@outside.test", template: "digest.summary", payload: {}, itemRef: { kind: "booking", id: "b1" } })).toThrow(/not registered/);
      expect(enqueueExternalMail({ to: "not an address", template: "test.outside", payload: { name: "X" }, itemRef: { kind: "booking", id: "b1" } })).toBeNull();
    } finally {
      mail.setMailTransportForTests(null);
    }
  });
});
