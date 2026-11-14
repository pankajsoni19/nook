import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../auth";
import { db } from "../db";
import { config } from "../config";
import { clientIp } from "../clientAddress";
import { checkSubmission, confirmEmailVerification, consumePublicLink, issueRenderNonce, publicNotFound, publicPolicyAllows, readPublicJson, readPublicLink, startEmailVerification, type PublicLink, type PublicRouter } from "../public";
import { mailEnabled } from "../mail";
import { currentSet } from "../questions/service";
import { HONEYPOT_FIELD, MIN_FILL_MS, NONCE_FIELD, type PublicPageMeta } from "../../shared/publicPages";
import { formatWhen, LOCATION_LABELS, MAX_PUBLIC_SLOT_DAYS, slotsByDate, type PublicSlots, type PublicTypeSummary } from "../../shared/bookings";
import { BookingError, bookingRow, durationsOf, parseJson, typeRow, userName, type ProfileRow, type TypeRow } from "./model";
import { profileByHandle } from "./setup";
import { availability, ownerActive } from "./availability";
import { bookingHasIcs, bookingIcs, cancelBooking, createBooking, managePath, rescheduleBooking } from "./service";
import { bookerSchema, sendError, windowFrom } from "./routes";

/**
 * Public booking pages (§B.8, §D.6): `/p/book/<handle>`, `/p/book/<handle>/<slug>`,
 * `/p/book/link/<token>` (secret one-off or expiring links), and `/p/book/manage/<token>` (the
 * booker's own booking, D1004). JSON under `/api/public/book…` and `/api/public/bookings/manage…`.
 *
 * - Policy `public_booking_pages` (on by default, §G.1 Q2) and a profile's own switch; a hidden or
 *   binned type, a disabled profile, an unknown handle, and a bad token all get the one 404 (T507).
 * - Slots only, never event details (T575): 31-day windows, the page limit (120/min per address),
 *   and a 30-second cache per type, window, duration, and zone.
 * - Submissions: signed single-use render nonce, honeypot, 5 s minimum fill time, per-address limits
 *   (checkSubmission), per-link hourly limit, per-email upcoming cap and per-type hourly cap
 *   (createBooking), optional email verification (T577). The server computes everything in UTC
 *   and re-checks the slot under a lock (T576, T581).
 */

const SLOT_CACHE_MS = 30_000;
const slotCache = new Map<string, { at: number; value: PublicSlots }>();
export const resetPublicSlotCache = () => slotCache.clear();

const meta = (kind: string, itemId: string): PublicPageMeta => ({ appName: config.appName, workspaceName: config.appName, logoUrl: null, renderNonce: issueRenderNonce(kind, itemId) });

type Target = { type: TypeRow; profile: ProfileRow | null; link: PublicLink | null; source: "public" | "secret_link" };

const typeOpens = (type: TypeRow | null): type is TypeRow => Boolean(type && type.deleted_at === null && type.status === "active");

function byHandle(c: Context<AppEnv>): Target | null {
  if (!publicPolicyAllows("booking_type")) return null;
  const profile = profileByHandle(c.req.param("handle") ?? "");
  if (!profile) return null;
  const type = db.query("SELECT * FROM booking_types WHERE owner_id = ? AND slug = ? AND deleted_at IS NULL").get(profile.user_id, (c.req.param("slug") ?? "").toLowerCase()) as TypeRow | null;
  if (!typeOpens(type) || type.public !== 1) return null;
  return { type, profile, link: null, source: "public" };
}

function byLink(c: Context<AppEnv>): Target | null {
  const link = readPublicLink("booking_type", c.req.param("token") ?? "", { opens: (found) => typeOpens(typeRow(found.itemId)) });
  if (!link) return null;
  const type = typeRow(link.itemId)!;
  // A secret link pauses with its owner (D1029, T589): a blocked or removed owner, or a profile
  // switched off, gets the same 404 as /p/book/<handle>. The link is kept, so an unblock resumes it.
  if (!ownerActive(type.owner_id)) return null;
  const profile = db.query("SELECT * FROM booking_profiles WHERE user_id = ?").get(type.owner_id) as ProfileRow | null;
  if (profile && profile.enabled !== 1) return null;
  return { type, profile, link, source: "secret_link" };
}

const needsLocation = (type: TypeRow) => type.location_kind === "ask" || (type.location_kind === "phone" && !type.location_value.trim());

function typeSummary(type: TypeRow): PublicTypeSummary {
  return { slug: type.slug, title: type.title, description: type.description_md, durations: durationsOf(type), locationKind: type.location_kind, color: type.color };
}

function typePage(c: Context<AppEnv>, target: Target | null) {
  if (!target) return publicNotFound(c);
  const { type, profile } = target;
  const set = currentSet({ kind: "booking_type", id: type.id });
  return c.json({
    meta: meta("booking", type.id),
    host: { name: profile?.display_name ?? userName(type.owner_id), welcome: profile?.welcome_md ?? "", handle: target.link ? null : profile?.handle ?? null, tz: profile?.tz ?? "UTC" },
    type: { ...typeSummary(type), locationLabel: LOCATION_LABELS[type.location_kind], location: type.location_kind === "in_person" || type.location_kind === "custom" ? type.location_value : "",
      needsLocation: needsLocation(type), confirm: type.confirm, assignment: type.assignment },
    questions: set?.set ?? null,
    verifyEmail: type.verify_email === 1 && mailEnabled(),
    mail: mailEnabled()
  });
}

async function slots(c: Context<AppEnv>, target: Target | null, excludeBookingId: string | null = null, fixedDuration: number | null = null) {
  if (!target) return publicNotFound(c);
  try {
    const window = windowFrom(c.req.query(), MAX_PUBLIC_SLOT_DAYS);
    const durations = durationsOf(target.type);
    const duration = fixedDuration ?? (durations.includes(Number(c.req.query("duration"))) ? Number(c.req.query("duration")) : durations[0]!);
    const key = `${target.type.id}:${target.type.revision}:${window.from}:${window.to}:${window.tz}:${duration}:${excludeBookingId ?? ""}`;
    const cached = slotCache.get(key);
    if (cached && Date.now() - cached.at < SLOT_CACHE_MS) return c.json(cached.value);
    const map = await availability(target.type, { fromMs: window.fromMs, toMs: window.toMs, durationMin: duration, nowMs: Date.now(), excludeBookingId });
    const value: PublicSlots = { tz: window.tz, durations, duration, days: slotsByDate([...map.keys()], window.tz) };
    if (slotCache.size > 2000) slotCache.clear();
    slotCache.set(key, { at: Date.now(), value });
    return c.json(value);
  } catch (error) {
    return sendError(c, error);
  }
}

const submitSchema = bookerSchema.extend({ start: z.string().max(40), duration: z.number().int(), [NONCE_FIELD]: z.string().max(400).optional(), [HONEYPOT_FIELD]: z.string().max(200).optional() });
type Submission = z.infer<typeof submitSchema>;

function finish(c: Context<AppEnv>, target: Target, body: Submission, verified = false) {
  const created = db.transaction(() => {
    // A secret link counts first, so a single-use link books once (the booking rolls the use back if it fails).
    if (target.link && !consumePublicLink(target.link)) throw new BookingError(429, "LINK_USED", "This link was already used");
    return createBooking({
      type: target.type, start: body.start, durationMin: body.duration, source: target.source, actorId: null, linkId: target.link?.id ?? null,
      booker: { name: body.name, email: body.email, guests: body.guests, tz: body.tz, location: body.location, answers: body.answers }
    });
  }).immediate();
  slotCache.clear();
  const booking = created.booking;
  return c.json({
    status: booking.status, verified, mailQueued: created.mailQueued, manageUrl: managePath(created.manageToken),
    booking: { typeTitle: booking.type_title, hostName: userName(booking.host_id), start: booking.start_utc, end: booking.end_utc, tz: booking.booker_tz,
      when: formatWhen(booking.start_utc, booking.end_utc, booking.booker_tz), location: booking.location_resolved, locationKind: booking.location_kind }
  }, 201);
}

async function submit(c: Context<AppEnv>, target: Target | null) {
  if (!target) return publicNotFound(c);
  const body = await readPublicJson(c, submitSchema);
  if (!body) return c.json({ error: "Invalid request", code: "INVALID" }, 400);
  const check = checkSubmission({ kind: "booking", itemId: target.type.id, linkId: target.link?.id ?? null, address: clientIp(c), body: body as Record<string, unknown>, minFillMs: MIN_FILL_MS.booking, email: body.email });
  if (!check.ok) {
    if (check.retryAfter) c.header("Retry-After", String(check.retryAfter));
    return check.status === 404 ? publicNotFound(c) : c.json({ error: check.outcome === "too_fast" ? "That was quick. Check the details and try again." : "This booking was not accepted. Reload the page and try again.", code: check.outcome.toUpperCase() }, check.status);
  }
  try {
    if (target.type.verify_email === 1 && mailEnabled()) {
      const { nonce: _nonce, website: _website, ...held } = body as Submission & Record<string, unknown>;
      const started = startEmailVerification({ kind: "booking", itemId: target.type.id, linkId: target.link?.id ?? null, email: body.email, payload: held, address: clientIp(c) });
      return c.json({ status: "verify", verificationId: started.verificationId, mailQueued: started.mailQueued }, 202);
    }
    return finish(c, target, body);
  } catch (error) {
    return sendError(c, error);
  }
}

async function verify(c: Context<AppEnv>, target: Target | null) {
  if (!target) return publicNotFound(c);
  const body = await readPublicJson(c, z.object({ id: z.string().max(64), code: z.string().max(12) }));
  if (!body) return c.json({ error: "Invalid request", code: "INVALID" }, 400);
  const result = confirmEmailVerification({ id: body.id, code: body.code, kind: "booking", itemId: target.type.id });
  if (!result.ok) return c.json({ error: result.reason === "expired" ? "That code expired. Book again." : result.reason === "too_many" ? "Too many tries. Book again." : "That code did not work", code: result.reason.toUpperCase() }, 400);
  const parsed = submitSchema.safeParse(result.payload);
  if (!parsed.success) return c.json({ error: "Invalid request", code: "INVALID" }, 400);
  try {
    return finish(c, target, parsed.data, true);
  } catch (error) {
    return sendError(c, error);
  }
}

// ---------------------------------------------------------------- manage (the booker's own booking)

function manageTarget(c: Context<AppEnv>) {
  const link = readPublicLink("booking_manage", c.req.param("token") ?? "", { opens: (found) => bookingRow(found.itemId) !== null });
  if (!link) return null;
  const booking = bookingRow(link.itemId)!;
  const type = booking.type_id ? typeRow(booking.type_id) : null;
  return { link, booking, type };
}

function manageView(target: NonNullable<ReturnType<typeof manageTarget>>) {
  const { booking, type } = target;
  const canChange = (booking.status === "pending" || booking.status === "confirmed") && Date.parse(booking.start_utc) > Date.now();
  return {
    meta: meta("booking_manage", booking.id),
    booking: {
      typeTitle: booking.type_title, hostName: userName(booking.host_id), start: booking.start_utc, end: booking.end_utc, durationMin: booking.duration_min, tz: booking.booker_tz,
      when: formatWhen(booking.start_utc, booking.end_utc, booking.booker_tz), status: booking.status, location: booking.location_resolved, locationKind: booking.location_kind,
      locationLabel: LOCATION_LABELS[booking.location_kind], bookerName: booking.booker_name, guests: parseJson<string[]>(booking.guests_json, []), cancelReason: booking.cancel_reason
    },
    canCancel: canChange,
    canReschedule: canChange && Boolean(type && type.deleted_at === null),
    color: type?.color ?? null
  };
}

const manageSchema = z.object({ reason: z.string().max(500).optional(), start: z.string().max(40).optional(), [NONCE_FIELD]: z.string().max(400).optional(), [HONEYPOT_FIELD]: z.string().max(200).optional() });

async function manageAction(c: Context<AppEnv>, action: "cancel" | "reschedule") {
  const target = manageTarget(c);
  if (!target) return publicNotFound(c);
  const body = await readPublicJson(c, manageSchema);
  if (!body) return c.json({ error: "Invalid request", code: "INVALID" }, 400);
  const check = checkSubmission({ kind: "booking_manage", itemId: target.booking.id, linkId: target.link.id, address: clientIp(c), body: body as Record<string, unknown>, minFillMs: 1000 });
  if (!check.ok) {
    if (check.retryAfter) c.header("Retry-After", String(check.retryAfter));
    return check.status === 404 ? publicNotFound(c) : c.json({ error: "This change was not accepted. Reload the page and try again.", code: check.outcome.toUpperCase() }, check.status);
  }
  try {
    if (action === "cancel") {
      const updated = cancelBooking(target.booking, "booker", null, body.reason ?? null);
      slotCache.clear();
      return c.json(manageView({ ...target, booking: updated }));
    }
    if (!body.start) return c.json({ error: "Choose a time", code: "INVALID" }, 400);
    const created = rescheduleBooking(target.booking, { start: body.start, by: "booker", actorId: null, reason: body.reason ?? null });
    slotCache.clear();
    return c.json({ ...manageView({ ...target, booking: created.booking }), manageUrl: managePath(created.manageToken) });
  } catch (error) {
    return sendError(c, error);
  }
}

export function registerBookingPublicRoutes(router: PublicRouter) {
  // Pages (the client renders them; 404 shell when nothing opens). Specific prefixes first.
  router.page("/p/book/link/:token", (c) => byLink(c) !== null);
  router.page("/p/book/manage/:token", (c) => manageTarget(c) !== null);
  router.page("/p/book/:handle", (c) => publicPolicyAllows("booking_type") && profileByHandle(c.req.param("handle") ?? "") !== null);
  router.page("/p/book/:handle/:slug", (c) => byHandle(c) !== null);

  router.get("/api/public/book/link/:token", (c) => typePage(c, byLink(c)));
  router.get("/api/public/book/link/:token/slots", (c) => slots(c, byLink(c)));
  router.post("/api/public/book/link/:token/bookings", (c) => submit(c, byLink(c)));
  router.post("/api/public/book/link/:token/verify", (c) => verify(c, byLink(c)));

  router.get("/api/public/bookings/manage/:token", (c) => { const target = manageTarget(c); return target ? c.json(manageView(target)) : publicNotFound(c); });
  router.get("/api/public/bookings/manage/:token/ics", (c) => {
    const target = manageTarget(c);
    // A request awaiting approval (or declined, expired) has no calendar file (D1122).
    if (!target || !bookingHasIcs(target.booking)) return publicNotFound(c);
    return new Response(bookingIcs(target.booking), { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": "attachment; filename=\"booking.ics\"" } });
  });
  router.get("/api/public/bookings/manage/:token/slots", (c) => {
    const target = manageTarget(c);
    if (!target || !target.type || target.type.deleted_at !== null) return publicNotFound(c);
    return slots(c, { type: target.type, profile: null, link: null, source: "public" }, target.booking.id, target.booking.duration_min);
  });
  router.post("/api/public/bookings/manage/:token/cancel", (c) => manageAction(c, "cancel"));
  router.post("/api/public/bookings/manage/:token/reschedule", (c) => manageAction(c, "reschedule"));

  router.get("/api/public/book/:handle", (c) => {
    if (!publicPolicyAllows("booking_type")) return publicNotFound(c);
    const profile = profileByHandle(c.req.param("handle") ?? "");
    if (!profile) return publicNotFound(c);
    const types = db.query("SELECT * FROM booking_types WHERE owner_id = ? AND deleted_at IS NULL AND status = 'active' AND public = 1 ORDER BY title COLLATE NOCASE LIMIT 50").all(profile.user_id) as TypeRow[];
    return c.json({ meta: { appName: config.appName, workspaceName: config.appName, logoUrl: null }, host: { name: profile.display_name, welcome: profile.welcome_md, handle: profile.handle, tz: profile.tz }, types: types.map(typeSummary) });
  });
  router.get("/api/public/book/:handle/:slug", (c) => typePage(c, byHandle(c)));
  router.get("/api/public/book/:handle/:slug/slots", (c) => slots(c, byHandle(c)));
  router.post("/api/public/book/:handle/:slug/bookings", (c) => submit(c, byHandle(c)));
  router.post("/api/public/book/:handle/:slug/verify", (c) => verify(c, byHandle(c)));
}
