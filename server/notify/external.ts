import { db } from "../db";
import { addressHash, mailEnabled, recipientHash } from "../mail";
import { registeredMailTemplate } from "../mail/registry";
import { suppressionOf } from "../mail/suppression";
import { isEmail, normalizeEmail } from "../../shared/questions";
import { keyedHash, readSignedToken, signedToken } from "../public/secret";

/**
 * Mail to people outside the workspace (docs/plan/WORKSPACE_MODULES.md §B.7, T508): bookers and
 * time-poll guests, only at an address they typed for their own booking or vote.
 *
 * - The template must be registered with `resolveExternal` (server/mail/registry.ts).
 * - Caps per address: 10 an hour and 50 a day; per item: 30 a day (counted from the outbox, so a
 *   restart cannot reset them). Over a cap, nothing is queued (null).
 * - Suppressed addresses (bounces, complaints) and addresses that stopped mail about the item are
 *   skipped. Every mail carries a "Stop emails about this …" link (`stopHref`).
 * - The payload is ids and plain values for the resolver; the template must never print an internal
 *   id (the stop link is sealed).
 *
 * Returns the outbox row id, or null when nothing was queued (mail off: callers say "No email will be
 * sent"). Call inside the action's transaction.
 */
export const EXTERNAL_CAPS = { addressHour: 10, addressDay: 50, itemDay: 30 } as const;

export type ExternalMailInput = {
  to: string;
  template: string;
  payload: Record<string, unknown>;
  /** The item the mail is about (a booking, a time poll): caps and the stop link use it. */
  itemRef: { kind: string; id: string };
  /** Earliest send (reminders). */
  notBeforeMs?: number;
  nowMs?: number;
};

export function enqueueExternalMail(input: ExternalMailInput): string | null {
  if (!mailEnabled()) return null;
  const template = registeredMailTemplate(input.template);
  if (!template?.resolveExternal) throw new Error(`Mail template ${input.template} is not registered for outside addresses`);
  const to = normalizeEmail(input.to);
  if (!isEmail(to)) return null;
  if (!/^[a-z_]{1,20}$/.test(input.itemRef.kind) || !/^[A-Za-z0-9-]{1,40}$/.test(input.itemRef.id)) throw new Error("Invalid item reference");
  const nowMs = input.nowMs ?? Date.now();
  if (suppressionOf(to, nowMs)) return null;
  if (externalMailStopped(to, input.itemRef.kind, input.itemRef.id)) return null;
  const hash = recipientHash(to);
  const since = (ms: number) => new Date(nowMs - ms).toISOString();
  const count = (sql: string, ...params: string[]) => (db.query(sql).get(...params) as { count: number }).count;
  if (count("SELECT COUNT(*) AS count FROM mail_outbox WHERE user_id IS NULL AND to_hash = ? AND created_at > ? AND coalesce_key LIKE 'x:%'", hash, since(3_600_000)) >= EXTERNAL_CAPS.addressHour) return null;
  if (count("SELECT COUNT(*) AS count FROM mail_outbox WHERE user_id IS NULL AND to_hash = ? AND created_at > ? AND coalesce_key LIKE 'x:%'", hash, since(86_400_000)) >= EXTERNAL_CAPS.addressDay) return null;
  const itemKey = `x:${input.itemRef.kind}:${input.itemRef.id}:`;
  if (count("SELECT COUNT(*) AS count FROM mail_outbox WHERE user_id IS NULL AND created_at > ? AND substr(coalesce_key, 1, ?) = ?", since(86_400_000), String(itemKey.length), itemKey) >= EXTERNAL_CAPS.itemDay) return null;
  const id = crypto.randomUUID();
  const createdAt = new Date(nowMs).toISOString();
  // A unique coalesce key (never merged) that keeps the item for the per-item cap after the payload is cleared.
  const coalesceKey = `${itemKey}${id.slice(0, 8)}`;
  db.query(`INSERT INTO mail_outbox (id, user_id, to_hash, to_address, template, class, category, coalesce_key, payload, idempotency_key, not_before, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
    .run(id, hash, to, input.template, template.class, coalesceKey, JSON.stringify({ ...input.payload, _item: input.itemRef }), id, new Date(Math.max(nowMs, input.notBeforeMs ?? 0)).toISOString(), createdAt);
  return id;
}

const STOP = "external-mail-stop";
/** The keyed hash of an item for the stop list: an internal id never appears in a mail or a stop link. */
const itemHash = (kind: string, id: string) => keyedHash("mail-item", `${kind}:${id}`);

/** Whether the address asked to hear nothing more about the item (or anything). */
export function externalMailStopped(address: string, kind: string, id: string) {
  return Boolean(db.query("SELECT 1 FROM external_mail_stops WHERE address_hash = ? AND item_kind = 'item' AND item_id IN (?, '*')").get(addressHash(address), itemHash(kind, id)));
}

/** The signed token of a "stop emails about this" link: the address hash and the item's keyed hash only. */
export const externalStopToken = (address: string, kind: string, id: string) => signedToken(STOP, `${addressHash(address)}.${itemHash(kind, id)}`);

/** Records a stop from its token; true when the token was ours. Idempotent. */
export function applyExternalStop(token: string, nowMs = Date.now()) {
  const text = readSignedToken(STOP, token);
  const match = text ? /^([0-9a-f]{64})\.([0-9a-f]{64})$/.exec(text) : null;
  if (!match) return false;
  db.query("INSERT OR IGNORE INTO external_mail_stops (address_hash, item_kind, item_id, created_at) VALUES (?, 'item', ?, ?)").run(match[1]!, match[2]!, new Date(nowMs).toISOString());
  return true;
}
