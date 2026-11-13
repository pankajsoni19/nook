import { registerWorkspaceModule } from "../workspaceModules";
import { db } from "../db";
import { registerActivityKinds } from "../../shared/itemActivity";
import { WORK_KIND_ICONS } from "../../shared/workRefs";
import { STATUS_LABELS, STATUS_TONES, formatWhen } from "../../shared/bookings";
import { page as todayPage, sectionScope } from "../today/registry";
import { readableContainerSql } from "../access/workspaceItems";
import { atLeast, bookingAccess, bookingHref, bookingRow, readableBookingSql, typeHref, typeLevel, typeRow, type BookingRow, type TypeRow } from "./model";
import { bookingTools, BOOKING_AGENT_TOOLS } from "./mcpTools";
import { registerBookingRoutes } from "./routes";
import { registerBookingPublicRoutes } from "./publicRoutes";
import { bookingsMailTemplates } from "./mail";
import { bookingsDataset } from "./insights";
import { registerTypeBin } from "./types";
import { completeBooking, expirePending, sendReminder } from "./service";
import { refreshFeed } from "./feeds";
import { profileRow } from "./setup";

/**
 * Bookings: the module entry (docs/plan/WORKSPACE_MODULES.md §D.6). Everything is registered here
 * through the workspace registry; the code lives in server/bookings/. Migrations 106–107
 * (server/migrations/workspace/bookings.ts), decisions D1000–D1039, threats T575–T594.
 */

registerActivityKinds("bookings", {
  booking_status: { shape: "change", coalesce: false },
  booking_rescheduled: { shape: "change", coalesce: false },
  meeting_booked: { shape: "item", coalesce: false },
  type_renamed: { shape: "change", coalesce: true },
  type_updated: { shape: "event", coalesce: true }
});

const typeSummary = (type: TypeRow, viewerId: string) => {
  const level = typeLevel(type.id, viewerId);
  if (level === "none") return null;
  return { kind: "booking_type" as const, id: type.id, shortId: type.short_id, title: type.title, subtitle: type.status === "hidden" ? "Hidden" : undefined, href: typeHref(type), icon: WORK_KIND_ICONS.booking_type };
};

const bookingSummary = (booking: BookingRow, viewerId: string) => {
  if (!bookingAccess(booking, viewerId)) return null;
  const tz = profileRow(viewerId)?.tz ?? "UTC";
  return {
    kind: "booking" as const, id: booking.id, shortId: booking.short_id, title: `${booking.type_title} with ${booking.booker_name}`, subtitle: formatWhen(booking.start_utc, booking.end_utc, tz),
    href: bookingHref(booking), icon: WORK_KIND_ICONS.booking, status: { label: STATUS_LABELS[booking.status], tone: STATUS_TONES[booking.status] }, due: booking.start_utc
  };
};

const reminderHandler = { run: (schedule: { owner: { id: string }; payload: Record<string, unknown> }, fireAt: string) => sendReminder(schedule.owner.id, schedule.payload, Math.max(Date.parse(fireAt), Date.now() - 3_600_000)), skipIfLateMs: 6 * 3_600_000 };

registerWorkspaceModule({
  id: "bookings",
  routes: registerBookingRoutes,
  publicRoutes: registerBookingPublicRoutes,
  mcpTools: bookingTools,
  agentTools: BOOKING_AGENT_TOOLS,
  accessContainer: { kind: "booking_type", table: "booking_types", nameColumn: "title" },
  itemKinds: [
    { kind: "booking_type", anchors: (id) => { const row = typeRow(id); return row ? [{ kind: "booking_type", id: row.id }] : null; } },
    { kind: "booking", anchors: (id) => { const row = bookingRow(id); return row ? (row.type_id ? [{ kind: "booking_type", id: row.type_id }] : []) : null; } }
  ],
  workKinds: [
    {
      kind: "booking_type", itemKind: "booking_type", scopes: { read: "bookings:read", write: "bookings:write" },
      resolve: (ids, viewer) => new Map(ids.map((id) => { const row = typeRow(id); return [id, row && row.deleted_at === null ? typeSummary(row, viewer.userId) : null]; })),
      level: (id, viewer) => typeLevel(id, viewer.userId),
      lookup: (ref) => typeRow(ref.ref)?.id ?? null
    },
    {
      kind: "booking", itemKind: "booking", scopes: { read: "bookings:read", write: "bookings:write" },
      resolve: (ids, viewer) => new Map(ids.map((id) => { const row = bookingRow(id); return [id, row ? bookingSummary(row, viewer.userId) : null]; })),
      level: (id, viewer) => {
        const row = bookingRow(id);
        const access = row ? bookingAccess(row, viewer.userId) : null;
        return access === "host" || access === "manager" ? "edit" : access === "booker" ? "view" : "none";
      },
      lookup: (ref) => bookingRow(ref.ref)?.id ?? null
    }
  ],
  binProviders: [registerTypeBin()],
  datasets: [bookingsDataset],
  mailTemplates: bookingsMailTemplates(),
  scheduleHandlers: {
    "bookings.remind_1": reminderHandler,
    "bookings.remind_2": reminderHandler,
    "bookings.remind_3": reminderHandler,
    "bookings.complete": { run: (schedule) => completeBooking(schedule.owner.id) },
    "bookings.pending_expire": { run: (schedule, fireAt) => expirePending(schedule.owner.id, Date.parse(fireAt)) },
    "bookings.feed_refresh": { run: (schedule) => refreshFeed(schedule.owner.id), skipIfLateMs: 30 * 60_000 }
  },
  searchScopes: [{
    scope: "bookings", label: "Bookings", module: "bookings",
    search: ({ userId, q, limit }) => {
      const needle = q.trim();
      if (!needle) return { results: [], truncated: false };
      const take = Math.min(20, Math.max(1, limit));
      const types = db.query(`SELECT bt.* FROM booking_types bt WHERE ${readableContainerSql("booking_type", "bt")} AND instr(lower(bt.title), lower($q)) > 0 ORDER BY bt.title LIMIT $take`)
        .all({ userId, q: needle, take }) as TypeRow[];
      const match = needle.replace(/["*^:()]/g, " ").split(/\s+/).filter(Boolean).map((word) => `"${word}"*`).join(" ");
      const bookings = match ? db.query(`SELECT b.* FROM bookings_fts f JOIN bookings b ON b.rowid = f.rowid WHERE bookings_fts MATCH $match AND ${readableBookingSql("b")} ORDER BY b.start_utc DESC LIMIT $take`)
        .all({ userId, match, take: take + 1 }) as BookingRow[] : [];
      const results = [
        ...types.map((type) => ({ kind: "booking_type" as const, id: type.id, title: type.title, snippet: "Booking type", href: typeHref(type) })),
        ...bookings.map((booking) => ({ kind: "booking" as const, id: booking.id, title: `${booking.type_title} with ${booking.booker_name}`, snippet: `${STATUS_LABELS[booking.status]} · ${booking.start_utc.slice(0, 10)}`, href: bookingHref(booking) }))
      ];
      return { results: results.slice(0, take), truncated: results.length > take };
    }
  }],
  todayProviders: [{
    name: "bookingsToday",
    provider: {
      href: "/bookings",
      mcpScope: "bookings:read",
      load: (context) => {
        const start = new Date(context.now.getTime() - 3_600_000).toISOString();
        const end = new Date(context.now.getTime() + 2 * 86_400_000).toISOString();
        const filter = sectionScope(context, "bookings:read", { booking_type: "b.type_id" });
        const rows = db.query(`SELECT b.* FROM bookings b WHERE ${readableBookingSql("b")} AND ${filter.sql}
            AND ((b.status = 'pending' AND b.end_utc > $now) OR (b.status = 'confirmed' AND b.end_utc > $start AND b.start_utc < $end))
          ORDER BY b.status = 'pending' DESC, b.start_utc LIMIT 11`).all({ userId: context.userId, now: context.now.toISOString(), start, end, ...filter.params }) as BookingRow[];
        return todayPage(rows.map((row) => ({
          id: row.id, title: `${row.type_title} with ${row.booker_name}`, start: row.start_utc, end: row.end_utc, status: row.status, href: bookingHref(row),
          when: formatWhen(row.start_utc, row.end_utc, context.tz)
        })));
      }
    }
  }],
  digestSections: [{
    id: "bookings.today", label: "Today's bookings", module: "bookings",
    rows: (recipient, context) => {
      const start = new Date(context.nowMs).toISOString();
      const end = new Date(context.nowMs + (context.period === "weekly" ? 7 : 1) * 86_400_000).toISOString();
      const rows = db.query(`SELECT b.* FROM bookings b WHERE ${readableBookingSql("b")} AND b.status IN ('pending','confirmed') AND b.start_utc >= $start AND b.start_utc < $end ORDER BY b.start_utc LIMIT 21`)
        .all({ userId: recipient.id, start, end }) as BookingRow[];
      return { rows: rows.slice(0, 20).map((row) => ({ title: `${row.type_title} with ${row.booker_name}`, meta: formatWhen(row.start_utc, row.end_utc, context.tz), href: bookingHref(row) })), total: rows.length };
    }
  }]
});

export { atLeast };
