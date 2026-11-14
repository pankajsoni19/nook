import { db } from "../db";
import { readableContainerSql } from "../access/workspaceItems";
import { publicPolicyAllows } from "../public";
import { currentSet } from "../questions/service";
import { LOCATION_LABELS, type Assignment, type LocationKind } from "../../shared/bookings";
import { durationsOf, notFound, typeHref, typeLevel, typeRow, userName, type TypeRow } from "./model";
import { ownerActive } from "./availability";

/**
 * "Book time with …" (D1250–D1253): which booking types a member may book with a colleague, in one
 * query for a whole team list, and the one rule every internal booking path uses to open a type.
 *
 * A type is bookable by a viewer when it is live and active and the viewer either reads it (the
 * type's sharing) or could book it on its public page anyway (public, the workspace allows public
 * booking pages, its owner can host and has the booking profile on). A member "offers" a type when
 * they host every booking of it: the owner of a single-host type, each host of a collective one.
 * Round-robin types are left out (the booker cannot choose who they get), and so is anything the
 * viewer owns or hosts (nobody books time with themselves).
 */

export const MAX_BOOKABLE_HOSTS = 500;
export const MAX_TYPES_PER_HOST = 20;

export type BookableType = {
  id: string; shortId: string; title: string; description: string; durations: number[]; color: string;
  locationKind: LocationKind; confirm: "auto" | "manual"; assignment: Assignment; href: string;
};

const bookableView = (type: TypeRow): BookableType => ({
  id: type.id, shortId: type.short_id, title: type.title, description: type.description_md.slice(0, 280), durations: durationsOf(type), color: type.color,
  locationKind: type.location_kind, confirm: type.confirm, assignment: type.assignment, href: typeHref(type)
});

const profileOn = (userId: string) => Boolean(db.query("SELECT 1 FROM booking_profiles WHERE user_id = ? AND enabled = 1").get(userId));

/** Could anyone book this type on its public page right now (the same rule as `/p/book/<handle>/<slug>`)? */
export function publiclyOpen(type: TypeRow): boolean {
  return type.deleted_at === null && type.status === "active" && type.public === 1 && publicPolicyAllows("booking_type") && ownerActive(type.owner_id) && profileOn(type.owner_id);
}

/**
 * The type an internal booking path opens (POST /api/bookings, its slots and form, MCP
 * `create_booking` and `get_availability`): a type the caller reads (active, or any status for its
 * owner; `preview` keeps a hidden type's slots open to its readers, the type editor's preview), or a
 * publicly open one. Anything else is NOT_FOUND, never 403 (T90).
 */
export function requireTypeForBooking(ref: string, userId: string, options: { preview?: boolean } = {}): TypeRow {
  const row = typeRow(ref);
  if (!row || row.deleted_at !== null) throw notFound("Booking type");
  if (typeLevel(row.id, userId) !== "none" && (options.preview || row.status === "active" || row.owner_id === userId)) return row;
  if (publiclyOpen(row)) return row;
  throw notFound("Booking type");
}

type HostTypeRow = TypeRow & { host_id: string };

/**
 * Bookable types by the member who offers them, for one viewer, in one query (no N+1): only
 * members who can host (not blocked; admins and members), at most `MAX_TYPES_PER_HOST` each.
 * `hostIds` narrows to some members; `typeIds` to a key's chosen types (MCP, T203). Viewers,
 * guests, and blocked callers get nothing: they cannot book.
 */
export function bookableByHost(viewerId: string, options: { hostIds?: readonly string[] | null; typeIds?: readonly string[] | null } = {}): Record<string, BookableType[]> {
  const viewer = db.query("SELECT role, disabled_at FROM users WHERE id = ?").get(viewerId) as { role: string; disabled_at: string | null } | null;
  if (!viewer || viewer.disabled_at !== null || !["admin", "member"].includes(viewer.role)) return {};
  if (options.hostIds && options.hostIds.length === 0) return {};
  if (options.typeIds && options.typeIds.length === 0) return {};
  const params: Record<string, string | number> = { userId: viewerId, publicOn: publicPolicyAllows("booking_type") ? 1 : 0 };
  const where = [
    "bt.deleted_at IS NULL", "bt.status = 'active'", "x.host_id <> $userId", "bt.owner_id <> $userId",
    "NOT EXISTS (SELECT 1 FROM booking_type_hosts me WHERE me.type_id = bt.id AND me.user_id = $userId)",
    `(${readableContainerSql("booking_type", "bt")} OR ($publicOn = 1 AND bt.public = 1 AND EXISTS (SELECT 1 FROM booking_profiles p JOIN users ou ON ou.id = p.user_id
      WHERE p.user_id = bt.owner_id AND p.enabled = 1 AND ou.disabled_at IS NULL AND ou.role IN ('admin','member'))))`
  ];
  if (options.hostIds) { where.push("x.host_id IN (SELECT value FROM json_each($hosts))"); params.hosts = JSON.stringify(options.hostIds.slice(0, MAX_BOOKABLE_HOSTS)); }
  if (options.typeIds) { where.push("bt.id IN (SELECT value FROM json_each($typeIds))"); params.typeIds = JSON.stringify(options.typeIds); }
  const rows = db.query(`SELECT bt.*, x.host_id FROM (
      SELECT t.id AS type_id, t.owner_id AS host_id FROM booking_types t WHERE t.assignment = 'single'
      UNION
      SELECT h.type_id, h.user_id FROM booking_type_hosts h JOIN booking_types t ON t.id = h.type_id WHERE t.assignment = 'collective'
    ) x
    JOIN booking_types bt ON bt.id = x.type_id
    JOIN users u ON u.id = x.host_id AND u.disabled_at IS NULL AND u.role IN ('admin','member') AND u.kind = 'person'
    WHERE ${where.join(" AND ")}
    ORDER BY x.host_id, bt.title COLLATE NOCASE, bt.id LIMIT 5000`).all(params) as HostTypeRow[];
  const out: Record<string, BookableType[]> = {};
  for (const row of rows) {
    const list = out[row.host_id] ??= [];
    if (list.length < MAX_TYPES_PER_HOST) list.push(bookableView(row));
  }
  return out;
}

const needsLocation = (type: TypeRow) => type.location_kind === "ask" || (type.location_kind === "phone" && !type.location_value.trim());

/** What the in-app booking sheet shows for one type: the summary, where it happens, and the published intake questions. */
export function bookingForm(userId: string, ref: string) {
  const type = requireTypeForBooking(ref, userId);
  const set = currentSet({ kind: "booking_type", id: type.id });
  const hosts = type.assignment === "single" ? [type.owner_id]
    : (db.query("SELECT user_id FROM booking_type_hosts WHERE type_id = ? ORDER BY priority DESC, user_id").all(type.id) as Array<{ user_id: string }>).map((row) => row.user_id);
  return {
    type: { ...bookableView(type), description: type.description_md, locationLabel: LOCATION_LABELS[type.location_kind],
      location: type.location_kind === "in_person" || type.location_kind === "custom" ? type.location_value : "", needsLocation: needsLocation(type) },
    hosts: hosts.map((id) => ({ id, name: userName(id) })),
    questions: set && set.set.questions.length ? set.set : null
  };
}
