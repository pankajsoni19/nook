import { db } from "../db";
import { avatarUrlFor } from "../avatars";
import { readPolicies } from "../team/policies";
import { readableContainerSql } from "../access/workspaceItems";
import { normalizeEmail } from "../../shared/questions";
import type { PersonSummary } from "../../shared/people";

/**
 * Team member chips by id (D1201): a live person gives their name and avatar; a disabled one keeps
 * their name and is `former`; an id that names nobody (a removed account, an integration) is a
 * former member without a name. Team names are visible to every member, so no access check applies.
 * Emails are left out (they are shown to admins only, D79).
 */
export function userSummaries(userIds: readonly string[]): Map<string, PersonSummary> {
  const result = new Map<string, PersonSummary>();
  const ids = [...new Set(userIds.map((id) => id.toLowerCase()))].slice(0, 500);
  if (!ids.length) return result;
  const rows = db.query("SELECT id, display_name, avatar_id, disabled_at FROM users WHERE kind = 'person' AND id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(ids)) as Array<{ id: string; display_name: string; avatar_id: string | null; disabled_at: string | null }>;
  const found = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = found.get(id);
    result.set(id, row
      ? { kind: "user", id, name: row.display_name, avatarUrl: avatarUrlFor(row.id, row.avatar_id), ...(row.disabled_at ? { former: true } : {}) }
      : { kind: "user", id, name: "Former member", former: true });
  }
  return result;
}

/**
 * Whether `userId` is someone a person field may name now: a live team person, and not a guest while
 * the `share_with_guests` policy is off (the same people the picker offers, GET /api/people/search).
 */
export function isPickablePerson(userId: string) {
  const guests = readPolicies().shareWithGuests ? "" : " AND role <> 'guest'";
  return db.query(`SELECT 1 FROM users WHERE id = ? AND kind = 'person' AND disabled_at IS NULL${guests}`).get(userId.toLowerCase()) !== null;
}

/** A live, pickable team person by email (case-insensitive), for CSV import and MCP values. */
export function pickablePersonByEmail(email: string): string | null {
  const row = db.query("SELECT id FROM users WHERE lower(email) = lower(?) AND kind = 'person' AND disabled_at IS NULL").get(email.trim()) as { id: string } | null;
  return row && isPickablePerson(row.id) ? row.id : null;
}

/** A live, pickable team person whose display name is exactly `name` (case-insensitive) and unique. */
export function pickablePersonByName(name: string): string | null {
  const rows = db.query("SELECT id FROM users WHERE display_name = ? COLLATE NOCASE AND kind = 'person' AND disabled_at IS NULL LIMIT 2").all(name.trim()) as Array<{ id: string }>;
  return rows.length === 1 && isPickablePerson(rows[0]!.id) ? rows[0]!.id : null;
}

/**
 * The contact `viewerId` can read that has this email (normalized) or, failing that, exactly this
 * display name, for CSV import and MCP values. Null when none or more than one readable contact
 * matches (an ambiguous reference names nobody).
 */
export function readableContactIdByReference(reference: string, viewerId: string): string | null {
  const text = reference.trim();
  if (text.includes("@")) {
    const rows = db.query(`SELECT DISTINCT c.id FROM contact_channels ch JOIN contacts c ON c.id = ch.contact_id AND c.deleted_at IS NULL JOIN contact_books b ON b.id = c.book_id
        WHERE ch.kind = 'email' AND ch.value_norm = $email AND ${readableContainerSql("contact_book", "b")} LIMIT 2`)
      .all({ email: normalizeEmail(text), userId: viewerId }) as Array<{ id: string }>;
    return rows.length === 1 ? rows[0]!.id : null;
  }
  const rows = db.query(`SELECT c.id FROM contacts c JOIN contact_books b ON b.id = c.book_id
      WHERE c.deleted_at IS NULL AND c.display_name = $name COLLATE NOCASE AND ${readableContainerSql("contact_book", "b")} LIMIT 2`)
    .all({ name: text, userId: viewerId }) as Array<{ id: string }>;
  return rows.length === 1 ? rows[0]!.id : null;
}
