import { randomBytes } from "node:crypto";
import { db } from "../db";
import { keyedHash, sign, signatureMatches } from "./secret";
import { HONEYPOT_FIELD, MIN_FILL_MS } from "../../shared/publicPages";

/**
 * Anti-abuse for public pages (docs/plan/WORKSPACE_MODULES.md §B.8, D810, T506, T507), with no third
 * party: per-address rate limits (in memory; one replica, as today), the per-link hourly limit
 * (durable, server/public/links.ts), a honeypot field, a minimum fill time and a single-use nonce
 * (both from a signed render nonce), a 64 KiB body cap (middleware), and email verification
 * (server/public/verification.ts). Every submission's outcome goes to `public_submissions_log` with a
 * salted IP hash only (kept 30 days).
 */

export const PUBLIC_LIMITS = {
  pagePerMinute: 120,
  submitPerMinute: 10,
  submitPerHour: 60
} as const;
/** A render nonce is good for a day. */
export const NONCE_TTL_MS = 86_400_000;

type Bucket = { stamps: number[] };
const buckets = new Map<string, Bucket>();

function take(key: string, limit: number, windowMs: number, nowMs: number): number {
  const bucket = buckets.get(key) ?? { stamps: [] };
  bucket.stamps = bucket.stamps.filter((stamp) => stamp > nowMs - windowMs);
  if (bucket.stamps.length >= limit) {
    buckets.set(key, bucket);
    return Math.max(1, Math.ceil((bucket.stamps[0]! + windowMs - nowMs) / 1000));
  }
  bucket.stamps.push(nowMs);
  buckets.set(key, bucket);
  if (buckets.size > 20_000) for (const [name, entry] of buckets) if (!entry.stamps.some((stamp) => stamp > nowMs - 3_600_000)) buckets.delete(name);
  return 0;
}

/**
 * Charges one public request from `address` (`page`: a page or its JSON; `submit`: a submission).
 * Returns 0 when allowed, else the seconds to wait (429 with Retry-After).
 */
export function publicLimit(kind: "page" | "submit", address: string | null, nowMs = Date.now()): number {
  const who = address ?? "unknown";
  if (kind === "page") return take(`page:${who}`, PUBLIC_LIMITS.pagePerMinute, 60_000, nowMs);
  const minute = take(`submit-m:${who}`, PUBLIC_LIMITS.submitPerMinute, 60_000, nowMs);
  if (minute) return minute;
  return take(`submit-h:${who}`, PUBLIC_LIMITS.submitPerHour, 3_600_000, nowMs);
}

/** Test hook: forget every bucket. */
export function resetPublicLimits() {
  buckets.clear();
}

/** The per-module pause switch (§B.8): an operator stops every public submission of a kind at once (in memory; a restart clears it). */
const paused = new Set<string>();
export function setPublicPause(kind: string, pause: boolean) {
  if (pause) paused.add(kind);
  else paused.delete(kind);
}
export const publicPaused = (kind: string) => paused.has(kind);

// ---------------------------------------------------------------- render nonces

/**
 * A signed nonce for one render of a public page: the kind and item it is for, when it was rendered
 * (the minimum fill time counts from here), and a random id (single use). Sent back with the
 * submission; nothing is stored until it is used.
 */
export function issueRenderNonce(kind: string, itemId: string, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify([kind, itemId, nowMs, randomBytes(12).toString("base64url")])).toString("base64url");
  return `v1.${body}.${sign("render-nonce", body)}`;
}

type NonceBody = { kind: string; itemId: string; renderedAt: number; id: string };

function readNonce(nonce: unknown): NonceBody | null {
  if (typeof nonce !== "string" || nonce.length > 400) return null;
  const [version, body, signature, extra] = nonce.split(".");
  if (version !== "v1" || !body || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(body)) return null;
  if (!signatureMatches("render-nonce", body, signature)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value) || value.length !== 4 || typeof value[0] !== "string" || typeof value[1] !== "string" || typeof value[2] !== "number" || typeof value[3] !== "string") return null;
    return { kind: value[0], itemId: value[1], renderedAt: value[2], id: value[3] };
  } catch {
    return null;
  }
}

export type SubmissionOutcome = "accepted" | "rate_limited" | "honeypot" | "too_fast" | "replay" | "invalid" | "verification_sent" | "verified" | "policy_off";

/** Records a public submission's outcome: a salted IP hash, never the address (T505). */
export function logSubmission(input: { kind: string; itemId: string | null; linkId?: string | null; address: string | null; email?: string | null; outcome: SubmissionOutcome; nowMs?: number }) {
  db.query("INSERT INTO public_submissions_log (id, link_id, kind, item_id, ip_hash, email_hash, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(Bun.randomUUIDv7(), input.linkId ?? null, input.kind, input.itemId, keyedHash("ip", input.address ?? "unknown"), input.email ? keyedHash("email", input.email.trim().toLowerCase()) : null, input.outcome, new Date(input.nowMs ?? Date.now()).toISOString());
}

/** How many accepted submissions an email made for an item since `sinceMs` (the "3 upcoming per booker" style caps). */
export function emailSubmissionCount(kind: string, itemId: string, email: string, sinceMs: number) {
  return (db.query("SELECT COUNT(*) AS count FROM public_submissions_log WHERE kind = ? AND item_id = ? AND email_hash = ? AND outcome IN ('accepted','verified') AND created_at > ?")
    .get(kind, itemId, keyedHash("email", email.trim().toLowerCase()), new Date(sinceMs).toISOString()) as { count: number }).count;
}

export type SubmissionCheck = { ok: true } | { ok: false; outcome: SubmissionOutcome; status: 400 | 404 | 429; retryAfter?: number };

/**
 * The checks every public submission passes before the module looks at it (§B.8), in order: the
 * module pause, the per-address limit, the nonce (signature, kind and item, age), the honeypot, the
 * minimum fill time, and single use. Each refusal is logged; `ok` means the module may now validate
 * and save (and count the link with consumePublicLink). A bot that fills the honeypot or is too fast
 * gets the same 400 as a bad nonce.
 */
export function checkSubmission(input: {
  kind: string; itemId: string; linkId?: string | null; address: string | null; body: Record<string, unknown>;
  minFillMs?: number; email?: string | null; nowMs?: number;
}): SubmissionCheck {
  const nowMs = input.nowMs ?? Date.now();
  const log = (outcome: SubmissionOutcome) => logSubmission({ kind: input.kind, itemId: input.itemId, linkId: input.linkId, address: input.address, email: input.email, outcome, nowMs });
  if (publicPaused(input.kind)) {
    log("policy_off");
    return { ok: false, outcome: "policy_off", status: 404 };
  }
  const wait = publicLimit("submit", input.address, nowMs);
  if (wait) {
    log("rate_limited");
    return { ok: false, outcome: "rate_limited", status: 429, retryAfter: wait };
  }
  const nonce = readNonce(input.body.nonce);
  if (!nonce || nonce.kind !== input.kind || nonce.itemId !== input.itemId || nowMs - nonce.renderedAt > NONCE_TTL_MS || nonce.renderedAt > nowMs + 60_000) {
    log("invalid");
    return { ok: false, outcome: "invalid", status: 400 };
  }
  const honeypot = input.body[HONEYPOT_FIELD];
  if (honeypot !== undefined && honeypot !== null && honeypot !== "") {
    log("honeypot");
    return { ok: false, outcome: "honeypot", status: 400 };
  }
  if (nowMs - nonce.renderedAt < (input.minFillMs ?? MIN_FILL_MS.form)) {
    log("too_fast");
    return { ok: false, outcome: "too_fast", status: 400 };
  }
  db.query("DELETE FROM public_nonces WHERE expires_at < ?").run(new Date(nowMs).toISOString());
  const used = db.query("INSERT OR IGNORE INTO public_nonces (nonce_hash, expires_at) VALUES (?, ?)").run(keyedHash("nonce", nonce.id), new Date(nonce.renderedAt + NONCE_TTL_MS).toISOString()).changes;
  if (used !== 1) {
    log("replay");
    return { ok: false, outcome: "replay", status: 400 };
  }
  return { ok: true };
}

/** Sweeper step: the submissions log and used nonces past their 30 days / expiry. */
export function sweepPublicLog(nowMs = Date.now()) {
  const log = db.query("DELETE FROM public_submissions_log WHERE created_at < ?").run(new Date(nowMs - 30 * 86_400_000).toISOString()).changes;
  const nonces = db.query("DELETE FROM public_nonces WHERE expires_at < ?").run(new Date(nowMs).toISOString()).changes;
  const verifications = db.query("DELETE FROM public_verifications WHERE expires_at < ?").run(new Date(nowMs - 86_400_000).toISOString()).changes;
  const usage = db.query("DELETE FROM public_link_usage WHERE hour < ?").run(new Date(nowMs - 2 * 86_400_000).toISOString().slice(0, 13)).changes;
  return { log, nonces, verifications, usage };
}
