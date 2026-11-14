import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser, db, type Session } from "./support/harness";

const mail = await import("../server/mail");
const { singleEventIcs, icsAttachment } = await import("../server/mail/ics");
const { runMailDispatch } = await import("../server/mail/dispatcher");
const { registeredMailTemplate } = await import("../server/mail/registry");
const { enqueueExternalMail } = await import("../server/notify");
const { createSession, runReminder } = await import("../server/townhall/service");
const { createGoal, ownerTimeZone } = await import("../server/goals/service");
const { scheduleHandler } = await import("../server/schedules/service");
const { runScheduleTick } = await import("../server/schedules/dispatcher");

/**
 * Calendar attachments in mail (W3-WIRE D1053–D1055, T598): the transport's `attachments` field and its
 * checks, every transport (test hook, Resend, file), the ICS builder's escaping and folding, the time
 * poll's outside mail, Townhall reminder email, and Goals reminders in the owner's zone.
 */

type Sent = Parameters<import("../server/mail").MailTransport>[0];
const sent: Sent[] = [];
const capture: import("../server/mail").MailTransport = async (message) => { sent.push(message); return { id: crypto.randomUUID() }; };
let host: Session;

beforeAll(async () => {
  mail.setMailTransportForTests(capture);
  host = await createUser("Ines Host");
  db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(new Date().toISOString(), host.userId);
});
afterAll(() => mail.setMailTransportForTests(null));

const unfold = (ics: string) => ics.replace(/\r\n /g, "");

describe("the transport", () => {
  test("attachments are checked: count, name, type, size", () => {
    const ok = { filename: "invite.ics", contentType: "text/calendar; charset=utf-8; method=PUBLISH", content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" };
    expect(mail.attachmentProblem(undefined)).toBeNull();
    expect(mail.attachmentProblem([ok])).toBeNull();
    expect(mail.attachmentProblem([ok, ok, ok, ok])).toBe("too_many");
    expect(mail.attachmentProblem([{ ...ok, filename: "../evil.ics" }])).toBe("bad_name");
    expect(mail.attachmentProblem([{ ...ok, filename: "invite.exe" }])).toBe("bad_name");
    expect(mail.attachmentProblem([{ ...ok, contentType: "text/html" }])).toBe("bad_type");
    expect(mail.attachmentProblem([{ ...ok, contentType: "text/calendar\r\nBcc: x@example.test" }])).toBe("bad_type");
    expect(mail.attachmentProblem([{ ...ok, content: "x".repeat(mail.MAIL_ATTACHMENT_LIMITS.bytes + 1) }])).toBe("too_large");
  });

  test("a refused attachment fails the send without retry; a good one reaches the transport", async () => {
    sent.length = 0;
    const bad = await mail.sendMail({ to: "a@example.test", subject: "S", text: "T", attachments: [{ filename: "x.ics", contentType: "application/octet-stream", content: "x" }] }, { purpose: "test", senderId: null });
    expect(bad).toEqual({ sent: false, reason: "failed", code: "attachment_bad_type", retryable: false });
    expect(sent).toHaveLength(0);
    const ics = singleEventIcs({ uid: "u1", title: "Call", startUtc: "2026-12-01T10:00:00.000Z", endUtc: "2026-12-01T10:30:00.000Z" });
    const good = await mail.sendMail({ to: "a@example.test", subject: "S", text: "T", attachments: [icsAttachment(ics)] }, { purpose: "test", senderId: null });
    expect(good.sent).toBe(true);
    expect(sent[0]!.attachments).toEqual([{ filename: "invite.ics", contentType: "text/calendar; charset=utf-8; method=PUBLISH", content: ics }]);
  });

  test("Resend gets the attachment as a file; the file transport keeps it in its JSON", async () => {
    let body: any = null;
    const provider = Bun.serve({ port: 0, fetch: async (request) => { body = await request.json(); return Response.json({ id: "re_1" }); } });
    try {
      mail.setMailTransportForTests(mail.resendTransport("re_placeholder", `http://localhost:${provider.port}`));
      const ics = singleEventIcs({ uid: "u2", title: "Call", startUtc: "2026-12-01T10:00:00.000Z", endUtc: "2026-12-01T10:30:00.000Z" });
      expect((await mail.sendMail({ to: "b@example.test", subject: "S", text: "T", attachments: [icsAttachment(ics, "booking.ics")] }, { purpose: "test", senderId: null })).sent).toBe(true);
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0].filename).toBe("booking.ics");
      expect(body.attachments[0].content_type ?? body.attachments[0].contentType).toBe("text/calendar; charset=utf-8; method=PUBLISH");
      const content = body.attachments[0].content;
      const decoded = Array.isArray(content) ? Buffer.from(content).toString("utf8") : typeof content === "string" ? Buffer.from(content, "base64").toString("utf8") : Buffer.from(content.data).toString("utf8");
      expect(decoded).toBe(ics);
      const path = join(tmpdir(), `mail-attach-${crypto.randomUUID()}.json`);
      try {
        mail.setMailTransportForTests(mail.fileTransport(path));
        await mail.sendMail({ to: "c@example.test", subject: "S", text: "T", attachments: [icsAttachment(ics)] }, { purpose: "test", senderId: null });
        const list = JSON.parse(readFileSync(path, "utf8")) as Array<{ attachments: Array<{ content: string }> }>;
        expect(list[0]!.attachments[0]!.content).toBe(ics);
      } finally {
        if (existsSync(path)) rmSync(path);
      }
    } finally {
      provider.stop(true);
      mail.setMailTransportForTests(capture);
    }
  });
});

describe("the ICS builder (T598)", () => {
  test("text is escaped, lines folded at 75 octets with CRLF, the UID and URL sanitized", () => {
    const ics = singleEventIcs({
      uid: "abc\r\nATTENDEE:mailto:evil@example.test", sequence: 2, title: "Intro; call, with \\ Ana\r\nATTENDEE:mailto:evil@example.test", location: "Room 1\nFloor 2",
      description: "é".repeat(80), url: "https://example.test/x\r\nX:1", startUtc: "2026-12-01T10:00:00.000Z", endUtc: "2026-12-01T10:30:00.000Z", stampUtc: "2026-11-14T08:00:00.000Z"
    });
    const lines = ics.split("\r\n");
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const line of lines) expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
    // No injected property line survives: only our own lines start a property.
    expect(lines.filter((line) => line.startsWith("ATTENDEE"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("URL"))).toEqual([]);
    const flat = unfold(ics);
    expect(flat).toContain("UID:abcATTENDEEmailtoevil@example.test");
    expect(flat).toContain("SUMMARY:Intro\\; call\\, with \\\\ Ana\\nATTENDEE:mailto:evil@example.test");
    expect(flat).toContain("LOCATION:Room 1\\nFloor 2");
    expect(flat).toContain("SEQUENCE:2");
    expect(flat).toContain("DTSTART:20261201T100000Z");
    expect(flat).toContain("DTEND:20261201T103000Z");
    expect(flat).toContain("METHOD:PUBLISH");
    expect(icsAttachment(singleEventIcs({ uid: "c", title: "x", startUtc: "2026-12-01T10:00:00.000Z", endUtc: "2026-12-01T11:00:00.000Z", method: "CANCEL" })).contentType).toBe("text/calendar; charset=utf-8; method=CANCEL");
  });
});

describe("senders", () => {
  test("a time poll's outside voter gets the chosen time as invite.ics, with no internal id", async () => {
    sent.length = 0;
    const formId = crypto.randomUUID();
    const queued = enqueueExternalMail({ to: "voter@example.org", template: "forms.time_final", payload: { title: "Offsite", when: "Tue 1 Dec 2026, 11:00–12:00 (Europe/Paris)", start: "2026-12-01T10:00:00.000Z", end: "2026-12-01T11:00:00.000Z", uid: "0123456789abcdef0123456789abcdef" }, itemRef: { kind: "form", id: formId } });
    expect(queued).toBeTruthy();
    await runMailDispatch();
    const message = sent.find((entry) => entry.to === "voter@example.org")!;
    expect(message.subject).toBe("The time is set: Offsite");
    expect(message.text).toContain("The time is attached");
    expect(message.attachments).toHaveLength(1);
    const file = message.attachments![0]!;
    expect(file.filename).toBe("invite.ics");
    expect(unfold(file.content)).toContain("UID:0123456789abcdef0123456789abcdef@nook");
    expect(file.content).toContain("SUMMARY:Offsite");
    expect(file.content).not.toContain(formId);
    // An older row (no times in the payload) still sends, without a file.
    const template = registeredMailTemplate("forms.time_final")!;
    const old = template.resolveExternal!({ title: "Offsite", when: "x" }, Date.now());
    expect("data" in old && template.render(old.data as never, { instanceName: "Nook", tz: "UTC" }).attachments).toBeUndefined();
  });

  test("a townhall reminder is also an email to members, under the Townhall switch", async () => {
    sent.length = 0;
    const session = createSession(host.userId, { title: "Q4 all-hands", startsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), reminderMinutes: 30 });
    runReminder(session.id);
    const row = db.query("SELECT template, class, category FROM mail_outbox WHERE user_id = ? AND template = 'townhall.reminder'").get(host.userId);
    expect(row).toEqual({ template: "townhall.reminder", class: "reminders", category: "townhall" });
    await runMailDispatch();
    const message = sent.find((entry) => entry.subject === "Starting soon: Q4 all-hands")!;
    expect(message).toBeTruthy();
    expect(message.text).toContain("It starts ");
    expect(message.headers?.["List-Unsubscribe"]).toBeTruthy();
    // Switched off: the next one is skipped at send time.
    db.query("INSERT INTO email_prefs (user_id, categories, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET categories = excluded.categories")
      .run(host.userId, JSON.stringify({ assignments: 1, comments: 1, sharing: 1, proposals: 1, sprints: 0, bin: 0, reminders: 1, townhall: 0 }), new Date().toISOString());
    db.query("UPDATE notifications SET read_at = ? WHERE user_id = ? AND topic = 'townhall.reminder'").run(new Date().toISOString(), host.userId);
    runReminder(session.id);
    sent.length = 0;
    await runMailDispatch();
    expect(sent.find((entry) => entry.subject === "Starting soon: Q4 all-hands")).toBeUndefined();
    expect(db.query("SELECT skip_reason FROM mail_outbox WHERE user_id = ? AND template = 'townhall.reminder' ORDER BY created_at DESC LIMIT 1").get(host.userId)).toEqual({ skip_reason: "prefs_off" });
  });
});

describe("goal reminders in the owner's zone (D1055)", () => {
  test("Monday 09:00 where the owner is; UTC when nothing is set; re-armed when the zone changes", async () => {
    const owner = await createUser("Zoe Zone");
    expect(ownerTimeZone(owner.userId)).toBe("UTC");
    const goal = await createGoal(owner.userId, { title: "Ship the zone fix", cadence: "weekly" });
    const before = db.query("SELECT id, tz, next_fire_at FROM schedules WHERE owner_kind = 'goal' AND owner_id = ? AND purpose = 'goals.checkin_reminder'").get(goal.id) as { id: string; tz: string; next_fire_at: string };
    expect(before.tz).toBe("UTC");
    expect(before.next_fire_at.slice(11, 16)).toBe("09:00");
    // The owner sets a zone (Settings → Notifications); the next reminder re-arms itself there.
    db.query("INSERT INTO email_prefs (user_id, tz, updated_at) VALUES (?, 'Asia/Kolkata', ?)").run(owner.userId, new Date().toISOString());
    expect(ownerTimeZone(owner.userId)).toBe("Asia/Kolkata");
    expect(scheduleHandler("goals.checkin_reminder")).toBeTruthy();
    // The dispatcher fires the UTC occurrence; the handler re-arms in Kolkata and the advance keeps it.
    await runScheduleTick({ nowMs: Date.parse(before.next_fire_at) + 1000 });
    const after = db.query("SELECT id, tz, next_fire_at FROM schedules WHERE owner_kind = 'goal' AND owner_id = ? AND purpose = 'goals.checkin_reminder'").get(goal.id) as { id: string; tz: string; next_fire_at: string };
    expect(after.id).toBe(before.id);
    expect(after.tz).toBe("Asia/Kolkata");
    // 09:00 in Kolkata is 03:30 UTC, on a Monday.
    expect(after.next_fire_at.slice(11, 16)).toBe("03:30");
    expect(new Date(after.next_fire_at).getUTCDay()).toBe(1);
    expect(Date.parse(after.next_fire_at)).toBeGreaterThan(Date.parse(before.next_fire_at));
  });
});
