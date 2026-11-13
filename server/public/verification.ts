import { randomInt } from "node:crypto";
import { db } from "../db";
import { appName } from "../config";
import { layout, paragraph } from "../mail/layout";
import { registerMailTemplate } from "../mail/registry";
import { defineTemplate } from "../mail/templates/types";
import { enqueueExternalMail } from "../notify/external";
import { isEmail, normalizeEmail } from "../../shared/questions";
import { VERIFICATION_CODE_LENGTH, VERIFICATION_MAX_ATTEMPTS, VERIFICATION_TTL_MS } from "../../shared/publicPages";
import { keyedHash } from "./secret";
import { logSubmission } from "./limits";

/**
 * Email verification for public submissions (docs/plan/WORKSPACE_MODULES.md §B.8, T577, T508): a
 * form or booking that asks for it holds the submission as a pending verification and mails a 6-digit
 * code to the address given; the submission counts only once the code is entered. Codes are stored
 * hashed, expire after 30 minutes, and allow 5 attempts. The held payload (the answers) is at most
 * 64 KiB and is deleted on success, on expiry (the sweeper), or after the last attempt.
 *
 * The code itself rides in the outbox payload until the mail is sent (then the payload is cleared, as
 * for every mail); it is never logged or audited.
 */

type CodeMail = { code: string; minutes: number; stopHref?: string };

const verificationTemplate = defineTemplate<CodeMail>({
  name: "public.verification",
  class: "account",
  render(data, context) {
    return layout({
      instanceName: context.instanceName,
      subject: `Your ${appName()} code: ${data.code}`,
      preheader: `Enter ${data.code} to confirm your email.`,
      eyebrow: "Confirm your email",
      title: `Your code is ${data.code}`,
      lead: `Enter it on the page you just filled in. It works for ${data.minutes} minutes.`,
      blocks: [paragraph("If you did not ask for this, ignore this email; nothing was sent or booked.")],
      footer: {
        reason: `You got this because someone entered this address on a ${appName()} page.`,
        ...(data.stopHref ? { unsubscribe: { href: data.stopHref, label: "Stop emails about this" } } : {})
      }
    });
  },
  fixture: () => ({ code: "482913", minutes: 30 })
});

registerMailTemplate("public.verification", {
  ...verificationTemplate,
  resolveExternal: (payload) => typeof payload.code === "string" && /^\d{6}$/.test(payload.code) ? { data: { code: payload.code, minutes: Math.round(VERIFICATION_TTL_MS / 60_000) } } : { skip: "empty" }
});

export type VerificationStart = { verificationId: string; mailQueued: boolean };

/**
 * Holds a submission until its address is confirmed and mails the code. Returns the verification id
 * the page sends back with the code. Call inside the submission's transaction.
 */
export function startEmailVerification(input: { kind: string; itemId: string; linkId?: string | null; email: string; payload: unknown; address: string | null; nowMs?: number }): VerificationStart {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new Error("Invalid email address");
  const payload = JSON.stringify(input.payload ?? {});
  if (payload.length > 65_536) throw new Error("The submission is too large to hold");
  const nowMs = input.nowMs ?? Date.now();
  const id = Bun.randomUUIDv7();
  const code = String(randomInt(0, 10 ** VERIFICATION_CODE_LENGTH)).padStart(VERIFICATION_CODE_LENGTH, "0");
  db.query(`INSERT INTO public_verifications (id, kind, item_id, link_id, email_hash, code_hash, payload_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.kind, input.itemId, input.linkId ?? null, keyedHash("email", email), keyedHash("verify-code", `${id}:${code}`), payload, new Date(nowMs + VERIFICATION_TTL_MS).toISOString(), new Date(nowMs).toISOString());
  const queued = enqueueExternalMail({ to: email, template: "public.verification", payload: { code }, itemRef: { kind: input.kind, id: input.itemId }, nowMs });
  logSubmission({ kind: input.kind, itemId: input.itemId, linkId: input.linkId, address: input.address, email, outcome: "verification_sent", nowMs });
  return { verificationId: id, mailQueued: queued !== null };
}

export type VerificationResult = { ok: true; payload: unknown; emailHash: string } | { ok: false; reason: "invalid" | "expired" | "too_many" };

/**
 * Checks a code. Success returns the held payload once (the row is deleted); a wrong code counts an
 * attempt; the fifth wrong code, or an expired row, deletes it. Unknown ids, other kinds, and other
 * items are "invalid", the same as a wrong code.
 */
export function confirmEmailVerification(input: { id: string; code: string; kind: string; itemId: string; nowMs?: number }): VerificationResult {
  const nowMs = input.nowMs ?? Date.now();
  return db.transaction((): VerificationResult => {
    const row = db.query("SELECT id, kind, item_id, email_hash, code_hash, payload_json, attempts, expires_at FROM public_verifications WHERE id = ?").get(input.id) as
      { id: string; kind: string; item_id: string; email_hash: string; code_hash: string; payload_json: string; attempts: number; expires_at: string } | null;
    if (!row || row.kind !== input.kind || row.item_id !== input.itemId) return { ok: false, reason: "invalid" };
    if (Date.parse(row.expires_at) <= nowMs) {
      db.query("DELETE FROM public_verifications WHERE id = ?").run(row.id);
      return { ok: false, reason: "expired" };
    }
    if (typeof input.code !== "string" || keyedHash("verify-code", `${row.id}:${input.code.trim()}`) !== row.code_hash) {
      if (row.attempts + 1 >= VERIFICATION_MAX_ATTEMPTS) {
        db.query("DELETE FROM public_verifications WHERE id = ?").run(row.id);
        return { ok: false, reason: "too_many" };
      }
      db.query("UPDATE public_verifications SET attempts = attempts + 1 WHERE id = ?").run(row.id);
      return { ok: false, reason: "invalid" };
    }
    db.query("DELETE FROM public_verifications WHERE id = ?").run(row.id);
    return { ok: true, payload: JSON.parse(row.payload_json) as unknown, emailHash: row.email_hash };
  })();
}
