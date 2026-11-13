import * as z from "zod/v4";
import { db, withAuditContext } from "../db";
import { config } from "../config";
import { keyContainerIds } from "../keyResources";
import { BIN_BUCKETS, BIN_DESCRIPTION, defineTool, McpToolError, type McpKeyContext, type McpToolSpec } from "../mcpToolKit";
import { readableContact } from "../people/contacts";
import { QuestionError } from "../questions/service";
import { ASSIGNMENTS, LOCATION_KINDS, MAX_SLOT_WINDOW_DAYS, slotsByDate } from "../../shared/bookings";
import { BookingError, requireBooking, requireType } from "./model";
import { availability } from "./availability";
import { approveBooking, bookingView, cancelBooking, createBooking, declineBooking, markNoShow, rescheduleBooking } from "./service";
import { createType, deleteType, listTypes, typeView, updateType, type TypeInput } from "./types";
import { listBookings, windowFrom } from "./routes";
import { profileRow } from "./setup";

/**
 * Bookings MCP tools (§D.6, §B.15): `bookings:read` / `bookings:write`. Booking types are the
 * container a chosen-item key names; bookings anchor on their type (T583: a booking is readable by
 * its host and the type's managers only, whatever the key). Chat agents may read, ask for
 * availability, and book (internal); never cancel, decline, reschedule, or delete (§B.15).
 */

const ref = z.string().min(6).max(64).describe("The id or short id");
const typeFields = {
  title: z.string().min(1).max(120).optional(),
  slug: z.string().min(1).max(60).optional(),
  description: z.string().max(4000).optional(),
  durations: z.array(z.number().int().min(5).max(720)).min(1).max(6).optional().describe("Minutes the booker may choose, e.g. [30] or [15, 30, 60]"),
  locationKind: z.enum(LOCATION_KINDS).optional(),
  locationValue: z.string().max(500).optional().describe("The video link, phone number, address, or custom text"),
  assignment: z.enum(ASSIGNMENTS).optional(),
  hostIds: z.array(z.string().uuid()).max(20).optional().describe("Team hosts (round_robin or collective); members only"),
  bufferBefore: z.number().int().min(0).max(240).optional(),
  bufferAfter: z.number().int().min(0).max(240).optional(),
  minNotice: z.number().int().min(0).max(43200).optional().describe("Minutes of notice before a booking"),
  maxDaysAhead: z.number().int().min(1).max(365).optional(),
  slotInterval: z.number().int().optional().describe("5, 10, 15, 20, 30, or 60"),
  dailyLimit: z.number().int().min(1).max(100).nullable().optional(),
  weeklyLimit: z.number().int().min(1).max(500).nullable().optional(),
  confirm: z.enum(["auto", "manual"]).optional(),
  public: z.boolean().optional(),
  status: z.enum(["active", "hidden"]).optional(),
  color: z.string().max(9).optional()
};

const toInput = (args: Record<string, unknown>): TypeInput => {
  const { hostIds, ...rest } = args as { hostIds?: string[] } & TypeInput;
  return { ...rest, ...(hostIds ? { hosts: hostIds.map((userId) => ({ userId })) } : {}) };
};

function errorOf(error: unknown): never {
  if (error instanceof BookingError) {
    const code = error.status === 404 ? "NOT_FOUND" : error.status === 429 ? "RATE_LIMITED" : error.code === "READ_ONLY" ? "READ_ONLY" : error.code === "LIMIT_REACHED" ? "LIMIT_REACHED" : "INVALID";
    throw new McpToolError(code, error.message, { reason: error.code });
  }
  if (error instanceof QuestionError) throw new McpToolError(error.status === 404 ? "NOT_FOUND" : "INVALID", error.message, error.details);
  throw error;
}

async function run<T>(key: McpKeyContext, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await withAuditContext({ via: "mcp", keyId: key.keyId }, operation);
  } catch (error) {
    return errorOf(error);
  }
}

const absolute = (path: string) => `${config.appOrigin}${path}`;

export const bookingTools: McpToolSpec[] = [
  defineTool({
    name: "list_booking_types",
    title: "List booking types",
    description: "Booking types the user owns or that are shared with them: title, durations, location, hosts, public link path, and the caller's level.",
    scopes: ["bookings:read"],
    access: { mode: "list", lists: ["booking_type"] },
    write: false,
    inputSchema: z.object({ mine: z.boolean().optional().describe("Only types the user owns or hosts") }),
    handler: ({ mine }, key) => run(key, () => {
      const chosen = keyContainerIds(key, "bookings:read", "booking_type");
      const items = listTypes(key.userId, { mine }).filter((type) => chosen === null || chosen.includes(type.id));
      return { items: items.map((type) => ({ ...type, url: absolute(type.href), publicUrl: type.publicPath ? absolute(type.publicPath) : null })) };
    })
  }),
  defineTool({
    name: "get_booking_type",
    title: "Get a booking type",
    description: "One booking type with all its settings (availability rules, buffers, notice, limits, reminders, hosts) and its revision.",
    scopes: ["bookings:read"],
    access: { mode: "items", items: [{ arg: "typeId", kind: "booking_type" }] },
    write: false,
    inputSchema: z.object({ typeId: ref }),
    handler: ({ typeId }, key) => run(key, () => typeView(requireType(typeId, key.userId).type, key.userId))
  }),
  defineTool({
    name: "create_booking_type",
    title: "Create a booking type",
    description: "Create a booking type (an event type people book). It is public on the owner's booking page unless public is false. Defaults: 30 minutes, video link, 4 hours notice, 60 days ahead, weekdays 09–17 in the owner's zone.",
    scopes: ["bookings:write"],
    access: { mode: "global" },
    write: true,
    inputSchema: z.object({ ...typeFields, title: z.string().min(1).max(120) }),
    handler: (args, key) => run(key, () => createType(key.userId, toInput(args) as TypeInput & { title: string }))
  }),
  defineTool({
    name: "update_booking_type",
    title: "Update a booking type",
    description: "Change a booking type's settings (partial). Pass expectedRevision from get_booking_type to refuse a change made meanwhile.",
    scopes: ["bookings:write"],
    access: { mode: "items", items: [{ arg: "typeId", kind: "booking_type" }] },
    write: true,
    inputSchema: z.object({ typeId: ref, ...typeFields, expectedRevision: z.number().int().min(1).optional() }),
    handler: ({ typeId, ...args }, key) => run(key, () => updateType(key.userId, typeId, toInput(args)))
  }),
  defineTool({
    name: "delete_booking_type",
    title: "Delete a booking type",
    description: `Moves a booking type to the Bin; its bookings stay. ${BIN_DESCRIPTION}`,
    scopes: ["bookings:write"],
    alsoRequires: ["bin:write"],
    access: { mode: "items", items: [{ arg: "typeId", kind: "booking_type" }] },
    write: true,
    buckets: BIN_BUCKETS,
    annotations: { destructiveHint: true },
    inputSchema: z.object({ typeId: ref }),
    handler: ({ typeId }, key) => run(key, () => deleteType(key.userId, typeId))
  }),
  defineTool({
    name: "get_availability",
    title: "Get availability",
    description: "Free start times of a booking type between two dates (at most 62 days), in a time zone. Starts are UTC instants grouped by local date.",
    scopes: ["bookings:read"],
    access: { mode: "items", items: [{ arg: "typeId", kind: "booking_type" }] },
    write: false,
    inputSchema: z.object({
      typeId: ref, from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Exclusive end date"),
      tz: z.string().max(64).optional().describe("IANA zone the dates are in (default UTC)"), duration: z.number().int().optional()
    }),
    handler: ({ typeId, from, to, tz, duration }, key) => run(key, async () => {
      const { type } = requireType(typeId, key.userId);
      const window = windowFrom({ from, to, tz }, MAX_SLOT_WINDOW_DAYS);
      const minutes = duration ?? (JSON.parse(type.durations_json) as number[])[0]!;
      const map = await availability(type, { fromMs: window.fromMs, toMs: window.toMs, durationMin: minutes, nowMs: Date.now() });
      return { tz: window.tz, duration: minutes, days: slotsByDate([...map.keys()], window.tz), count: map.size };
    })
  }),
  defineTool({
    name: "list_bookings",
    title: "List bookings",
    description: "Bookings the user hosts or manages (and ones they booked): view upcoming, pending, past, or cancelled; filter by type and start range. Keyset pages.",
    scopes: ["bookings:read"],
    access: { mode: "list", lists: ["booking_type"], items: [{ arg: "typeId", kind: "booking_type", ifAbsent: "allow" }] },
    write: false,
    inputSchema: z.object({
      view: z.enum(["upcoming", "pending", "past", "cancelled"]).optional(), typeId: ref.optional(), from: z.string().max(30).optional(), to: z.string().max(30).optional(),
      cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional()
    }),
    handler: ({ typeId, ...filter }, key) => run(key, () => {
      // A key limited to chosen types sees only their bookings, in SQL before the page's LIMIT (T203).
      const page = listBookings(key.userId, { ...filter, type: typeId, typeIds: keyContainerIds(key, "bookings:read", "booking_type") });
      return { items: page.items.map((item) => ({ ...item, url: absolute(item.href) })), nextCursor: page.nextCursor };
    })
  }),
  defineTool({
    name: "get_booking",
    title: "Get a booking",
    description: "One booking: type, host, time, status, booker, location, and intake answers.",
    scopes: ["bookings:read"],
    access: { mode: "items", items: [{ arg: "bookingId", kind: "booking" }] },
    write: false,
    inputSchema: z.object({ bookingId: ref }),
    handler: ({ bookingId }, key) => run(key, () => bookingView(requireBooking(bookingId, key.userId).booking, key.userId, { answers: true }))
  }),
  defineTool({
    name: "create_booking",
    title: "Book a time",
    description: "Book a free start (from get_availability) of a booking type, as the user or for a contact (contactId) or a named person. The host and booker get the usual confirmation.",
    scopes: ["bookings:write"],
    access: { mode: "items", items: [{ arg: "typeId", kind: "booking_type" }], related: ["contactId"] },
    write: true,
    inputSchema: z.object({
      typeId: ref, start: z.string().max(40).describe("UTC instant, e.g. 2026-11-20T09:30:00.000Z"), duration: z.number().int().optional(),
      contactId: z.string().max(64).optional().describe("A contact the user can read (books for them)"),
      booker: z.object({ name: z.string().min(1).max(120), email: z.string().max(254), tz: z.string().max(64).optional() }).optional(),
      answers: z.record(z.string(), z.unknown()).optional()
    }),
    handler: (args, key) => run(key, async () => {
      const { type } = requireType(args.typeId, key.userId);
      const duration = args.duration ?? (JSON.parse(type.durations_json) as number[])[0]!;
      let booker = args.booker ? { name: args.booker.name, email: args.booker.email, tz: args.booker.tz ?? "UTC" } : null;
      let contactId: string | null = null;
      if (args.contactId) {
        const contact = readableContact(args.contactId, key.userId);
        if (!contact?.email) throw new BookingError(404, "NOT_FOUND", "Contact not found");
        booker = { name: contact.displayName, email: contact.email, tz: booker?.tz ?? "UTC" };
        contactId = contact.id;
      }
      if (!booker) {
        const me = db.query("SELECT display_name, email FROM users WHERE id = ?").get(key.userId) as { display_name: string; email: string };
        booker = { name: me.display_name, email: me.email, tz: profileRow(key.userId)?.tz ?? "UTC" };
      }
      await availability(type, { fromMs: Date.parse(args.start) - 86_400_000, toMs: Date.parse(args.start) + 86_400_000, durationMin: duration, nowMs: Date.now() }).catch(() => null);
      const created = createBooking({ type, start: args.start, durationMin: duration, booker: { ...booker, answers: args.answers }, source: "mcp", actorId: key.userId, contactId });
      const view = bookingView(created.booking, key.userId);
      return { ...view, url: absolute(view.href), mailQueued: created.mailQueued };
    })
  }),
  defineTool({
    name: "reschedule_booking",
    title: "Reschedule a booking",
    description: "Move an upcoming booking to another free start (as its host or a manager). The booker is emailed the new time.",
    scopes: ["bookings:write"],
    access: { mode: "items", items: [{ arg: "bookingId", kind: "booking" }] },
    write: true,
    inputSchema: z.object({ bookingId: ref, start: z.string().max(40), message: z.string().max(500).optional() }),
    handler: ({ bookingId, start, message }, key) => run(key, () => {
      const { booking } = requireBooking(bookingId, key.userId, true);
      return bookingView(rescheduleBooking(booking, { start, by: "host", actorId: key.userId, reason: message ?? null }).booking, key.userId);
    })
  }),
  defineTool({
    name: "cancel_booking",
    title: "Cancel a booking",
    description: "Cancel an upcoming booking as its host or a manager, with an optional message to the booker.",
    scopes: ["bookings:write"],
    access: { mode: "items", items: [{ arg: "bookingId", kind: "booking" }] },
    write: true,
    annotations: { destructiveHint: true },
    inputSchema: z.object({ bookingId: ref, message: z.string().max(500).optional() }),
    handler: ({ bookingId, message }, key) => run(key, () => bookingView(cancelBooking(requireBooking(bookingId, key.userId, true).booking, "host", key.userId, message ?? null), key.userId))
  }),
  defineTool({
    name: "approve_booking",
    title: "Approve a booking",
    description: "Confirm a booking that awaits approval.",
    scopes: ["bookings:write"],
    access: { mode: "items", items: [{ arg: "bookingId", kind: "booking" }] },
    write: true,
    inputSchema: z.object({ bookingId: ref }),
    handler: ({ bookingId }, key) => run(key, () => bookingView(approveBooking(requireBooking(bookingId, key.userId, true).booking, key.userId), key.userId))
  }),
  defineTool({
    name: "decline_booking",
    title: "Decline a booking",
    description: "Decline a booking that awaits approval, with an optional message to the booker.",
    scopes: ["bookings:write"],
    access: { mode: "items", items: [{ arg: "bookingId", kind: "booking" }] },
    write: true,
    annotations: { destructiveHint: true },
    inputSchema: z.object({ bookingId: ref, message: z.string().max(500).optional() }),
    handler: ({ bookingId, message }, key) => run(key, () => bookingView(declineBooking(requireBooking(bookingId, key.userId, true).booking, key.userId, message ?? null), key.userId))
  }),
  defineTool({
    name: "mark_no_show",
    title: "Mark a no-show",
    description: "Mark a booking that has started as a no-show.",
    scopes: ["bookings:write"],
    access: { mode: "items", items: [{ arg: "bookingId", kind: "booking" }] },
    write: true,
    inputSchema: z.object({ bookingId: ref }),
    handler: ({ bookingId }, key) => run(key, () => bookingView(markNoShow(requireBooking(bookingId, key.userId, true).booking, key.userId), key.userId))
  }),
  defineTool({
    name: "get_booking_link",
    title: "Get a booking link",
    description: "The public booking page URL of a type (when it is public and active), else none.",
    scopes: ["bookings:read"],
    access: { mode: "items", items: [{ arg: "typeId", kind: "booking_type" }] },
    write: false,
    inputSchema: z.object({ typeId: ref }),
    handler: ({ typeId }, key) => run(key, () => {
      const view = typeView(requireType(typeId, key.userId).type, key.userId);
      return { url: view.publicPath ? absolute(view.publicPath) : null, public: view.public, status: view.status };
    })
  })
];

export const BOOKING_AGENT_TOOLS = {
  allowed: ["list_booking_types", "get_booking_type", "get_availability", "list_bookings", "get_booking", "get_booking_link", "create_booking"],
  never: ["create_booking_type", "update_booking_type", "delete_booking_type", "reschedule_booking", "cancel_booking", "approve_booking", "decline_booking", "mark_no_show"]
};
