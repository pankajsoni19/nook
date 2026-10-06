import { createHash } from "node:crypto";
import { audit, db, now } from "../db";
import { avatarUrlFor } from "../avatars";
import { recordAccessEvent } from "../access/events";
import { notifyAccess } from "../access/notices";
import { mailAgentShared } from "../mail/triggers";
import { AUDIENCE_ALL_USERS, type Role } from "../team/roles";
import { AgentError } from "./status";
import { publishChatUpdate } from "./chatUpdates";

/**
 * Sharing agents and chats (Wave 43 "AC-D", plan §5, §6.2, D356, D361, T311, T315), through the
 * shared Access sheet's vocabulary and `agent_access` (people and groups, module-local rows).
 *
 * - **Agents:** `view` = may chat with it and sees its name, description, model, and starters,
 *   never its system prompt or its tools configuration; `manage` = may edit it, except deleting it
 *   or changing who owns it. Managers share at `view` only and leave managers and the audience
 *   alone (D273's caps, with `edit` absent from this module).
 * - **Chats:** `view` only: recipients read the live transcript, tool calls and results included,
 *   and may continue in their own copy. Only the owner opens the chat's sheet.
 * - **Audience:** private, selected (people and groups), or everyone signed in at `view`
 *   (`AUDIENCE_ALL_USERS`: never guests or integrations). Group rows count only under `selected`.
 * - **Live and capped:** read fresh on every call; viewers are capped at `view` (a role is a
 *   ceiling, D71); guests never reach the module (AC-O2), whatever a row says; a blocked account
 *   reaches nothing. A binned agent or chat reaches nobody but its owner's Bin (D363).
 *
 * D73: an admin is nobody special here. Without a share they get the same 404 as anyone.
 * A shared agent never lends its owner's access (D359, T311): Nook tools always run through the
 * runner's own linked key (server/agents/tools.ts), whoever owns the agent.
 */

export type ShareKind = "agent" | "chat";
export type ShareLevel = "none" | "view" | "manage" | "owner";
export const SHARE_RANK: Record<ShareLevel, number> = { none: 0, view: 1, manage: 2, owner: 3 };
export const atLeastShare = (level: ShareLevel, needed: ShareLevel) => SHARE_RANK[level] >= SHARE_RANK[needed];

type Shareable = { id: string; owner_id: string; visibility: string; deleted_at: string | null };

const userQuery = db.query("SELECT role, kind FROM users WHERE id = ? AND disabled_at IS NULL");
const rowLevels = db.query(`SELECT a.level FROM agent_access a LEFT JOIN group_members gm ON gm.group_id = a.group_id
  WHERE a.resource_kind = ? AND a.resource_id = ? AND (a.user_id = ? OR gm.user_id = ?)`);

/** The live level of `userId` on an agent or chat row (see the file comment). */
export function shareLevel(kind: ShareKind, item: Shareable, userId: string): ShareLevel {
  if (item.deleted_at !== null) return "none";
  const user = userQuery.get(userId) as { role: Role; kind: string } | null;
  if (!user) return "none";
  if (item.owner_id === userId) return "owner";
  if (user.role === "guest") return "none";
  let best: ShareLevel = "none";
  if (item.visibility === "all_users") {
    if (user.kind === "person") best = "view";
  } else if (item.visibility === "selected") {
    for (const row of rowLevels.all(kind, item.id, userId, userId) as Array<{ level: string }>) {
      const level: ShareLevel = row.level === "manage" ? "manage" : "view";
      if (SHARE_RANK[level] > SHARE_RANK[best]) best = level;
    }
  }
  if (best === "manage" && (kind === "chat" || user.role === "viewer")) best = "view";
  return best;
}

const TABLE: Record<ShareKind, "agents" | "chats"> = { agent: "agents", chat: "chats" };
const NAME: Record<ShareKind, "name" | "title"> = { agent: "name", chat: "title" };

/** The live level on an agent or chat by id ("none" when it is missing or binned). */
export function shareLevelById(kind: ShareKind, id: string, userId: string): ShareLevel {
  const row = db.query(`SELECT id, owner_id, visibility, deleted_at FROM ${TABLE[kind]} WHERE id = ?`).get(id) as Shareable | null;
  return row ? shareLevel(kind, row, userId) : "none";
}

/**
 * SQL for "the caller (`$userId`) can open this agent or chat" on the row aliased `alias`: the owner (not blocked, review L1),
 * everyone signed in for `all_users` (never guests or integrations), or a direct or group row under
 * `selected`; never a binned row, never a guest or blocked account. The same rule as `shareLevel`.
 */
export function shareReadableSql(kind: ShareKind, alias: string) {
  return `(${alias}.deleted_at IS NULL AND ((${alias}.owner_id = $userId AND EXISTS (SELECT 1 FROM users ou WHERE ou.id = $userId AND ou.disabled_at IS NULL)) OR (
    EXISTS (SELECT 1 FROM users ru WHERE ru.id = $userId AND ru.disabled_at IS NULL AND ru.role IN ('admin','member','viewer')) AND (
      (${alias}.visibility = 'all_users' AND ${AUDIENCE_ALL_USERS})
      OR (${alias}.visibility = 'selected' AND EXISTS (SELECT 1 FROM agent_access sx LEFT JOIN group_members sgm ON sgm.group_id = sx.group_id
        WHERE sx.resource_kind = '${kind}' AND sx.resource_id = ${alias}.id AND (sx.user_id = $userId OR sgm.user_id = $userId)))))))`;
}

/** An agent's or chat's name as `viewerId` may see it now, or null (gone, binned, or not shared with them). */
export function sharedTitleFor(kind: ShareKind, id: string, viewerId: string): string | null {
  const row = db.query(`SELECT id, owner_id, visibility, deleted_at, ${NAME[kind]} AS title FROM ${TABLE[kind]} WHERE id = ?`).get(id) as (Shareable & { title: string }) | null;
  return row && shareLevel(kind, row, viewerId) !== "none" ? row.title : null;
}

// ------------------------------------------------------------------------------ the Access sheet

export const SHARE_LEVELS: Record<ShareKind, readonly ("view" | "manage")[]> = { agent: ["view", "manage"], chat: ["view"] };
export const MAX_SHARE_PEOPLE = 100;
export const MAX_SHARE_GROUPS = 20;

type Audience = "private" | "selected" | "all_users";
type SheetState = { id: string; ownerId: string; ownerName: string; title: string; audience: Audience };

function sheetState(kind: ShareKind, id: string): SheetState | null {
  const row = db.query(`SELECT x.id, x.owner_id, x.visibility, x.${NAME[kind]} AS title, u.display_name AS owner_name FROM ${TABLE[kind]} x JOIN users u ON u.id = x.owner_id
    WHERE x.id = ? AND x.deleted_at IS NULL`).get(id) as { id: string; owner_id: string; visibility: Audience; title: string; owner_name: string } | null;
  return row && { id: row.id, ownerId: row.owner_id, ownerName: row.owner_name, title: row.title, audience: row.visibility };
}

type Principal = { id: string; level: "view" | "manage" };

function directRows(kind: ShareKind, id: string): Map<string, "view" | "manage"> {
  const rows = db.query("SELECT user_id, level FROM agent_access WHERE resource_kind = ? AND resource_id = ? AND user_id IS NOT NULL").all(kind, id) as Array<{ user_id: string; level: string }>;
  return new Map(rows.map((row) => [row.user_id, row.level === "manage" ? "manage" : "view"]));
}

function groupRows(kind: ShareKind, id: string) {
  return (db.query(`SELECT g.id, g.name, a.level,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = g.id AND u.role = 'guest') AS guest_count,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id AND gm.added_by = gm.user_id) AS self_added
    FROM agent_access a JOIN user_groups g ON g.id = a.group_id
    WHERE a.resource_kind = ? AND a.resource_id = ? AND a.group_id IS NOT NULL ORDER BY g.name COLLATE NOCASE, g.id`).all(kind, id) as Array<{ id: string; name: string; level: string; member_count: number; guest_count: number; self_added: number }>)
    .map((row) => ({ id: row.id, name: row.name, level: (row.level === "manage" ? "manage" : "view") as "view" | "manage", memberCount: row.member_count, guestCount: row.guest_count, selfAddedCount: row.self_added }));
}

function etagOf(state: SheetState, people: ReadonlyMap<string, string>, groups: ReadonlyArray<{ id: string; level: string }>) {
  const canonical = JSON.stringify({
    audience: state.audience,
    people: [...people].map(([userId, level]) => `${userId}:${level}`).sort(),
    groups: groups.map((group) => `${group.id}:${group.level}`).sort()
  });
  return `"${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}"`;
}

/** Who may open the sheet: the owner; an agent's managers too. Everyone else who can see it gets 403, the rest 404. */
function authorizeSheet(kind: ShareKind, id: string, userId: string) {
  const state = sheetState(kind, id);
  if (!state) throw new AgentError(404, "NOT_FOUND", "Not found");
  const level = shareLevelById(kind, id, userId);
  if (level === "none") throw new AgentError(404, "NOT_FOUND", "Not found");
  if (level !== "owner" && !(kind === "agent" && level === "manage")) throw new AgentError(403, "OWNER_ONLY", kind === "chat" ? "Only the chat's owner shares it" : "Only the owner or a manager can change who has access");
  return { state, yourLevel: level as "owner" | "manage" };
}

/** GET …/access for an agent or chat, in the Access sheet's shape (src/access/accessApi.ts `ItemAccess`). */
export function readShareAccess(kind: ShareKind, id: string, userId: string) {
  const { state, yourLevel } = authorizeSheet(kind, id, userId);
  const direct = directRows(kind, id);
  const groups = groupRows(kind, id);
  const ids = [...direct.keys()];
  const users = ids.length
    ? db.query(`SELECT id, display_name, role, kind, disabled_at, avatar_id FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string; display_name: string; role: Role; kind: "person" | "service"; disabled_at: string | null; avatar_id: string | null }>
    : [];
  const memberOf = new Map<string, string[]>();
  if (ids.length && groups.length) {
    const rows = db.query(`SELECT user_id, group_id FROM group_members WHERE group_id IN (${groups.map(() => "?").join(",")}) AND user_id IN (${ids.map(() => "?").join(",")})`)
      .all(...groups.map((group) => group.id), ...ids) as Array<{ user_id: string; group_id: string }>;
    for (const row of rows) memberOf.set(row.user_id, [...(memberOf.get(row.user_id) ?? []), row.group_id]);
  }
  return {
    etag: etagOf(state, direct, groups),
    kind,
    title: state.title,
    owner: { id: state.ownerId, displayName: state.ownerName },
    audience: state.audience,
    people: users.map((user) => ({ id: user.id, displayName: user.display_name, teamRole: user.role, kind: user.kind, level: direct.get(user.id)!, via: "direct" as const, blocked: user.disabled_at !== null, groupIds: memberOf.get(user.id) ?? [], avatarUrl: avatarUrlFor(user.id, user.avatar_id) }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })),
    groups,
    levels: SHARE_LEVELS[kind].filter((level) => yourLevel === "owner" || level !== "manage"),
    yourLevel,
    youId: userId,
    // Guests never reach Chat (AC-O2): the sheet offers no guest by name; a group's guests simply get nothing.
    shareWithGuests: true,
    guestsExcluded: true,
    inheritable: false
  };
}
export type ShareAccess = ReturnType<typeof readShareAccess>;

export type ShareAccessPut = { audience: "private" | "selected" | "all_users" | "inherit"; audienceLevel?: string; people: Array<{ id: string; level: string }>; groups: Array<{ id: string; level: string }> };

const dedupe = (entries: ReadonlyArray<{ id: string; level: string }>) => {
  const byId = new Map<string, string>();
  for (const entry of entries) byId.set(entry.id.toLowerCase(), entry.level);
  return [...byId].map(([id, level]) => ({ id, level }));
};

/** PUT …/access: validates, replaces the rows in one transaction, and tells newly added people. */
export function writeShareAccess(kind: ShareKind, id: string, actor: { userId: string }, body: ShareAccessPut, ifMatch: string | undefined): ShareAccess {
  if (!ifMatch) throw new AgentError(428, "ETAG_REQUIRED", "Send If-Match with the ETag from GET …/access");
  return db.transaction(() => {
    const current = readShareAccess(kind, id, actor.userId);
    if (ifMatch !== current.etag && ifMatch !== current.etag.slice(1, -1)) {
      throw new AgentError(409, "ACCESS_CHANGED", "Someone else changed who has access. Review the latest and save again.", { access: current });
    }
    const people = dedupe(body.people) as Principal[];
    const groups = dedupe(body.groups) as Principal[];
    validateShare(kind, current, body, people, groups);
    const selected = body.audience === "selected";
    const before = new Set(current.people.map((person) => person.id));
    const beforeGroups = new Set(current.groups.map((group) => group.id));
    const timestamp = now();
    db.query("DELETE FROM agent_access WHERE resource_kind = ? AND resource_id = ?").run(kind, id);
    if (selected) {
      const insert = db.query("INSERT INTO agent_access (resource_kind, resource_id, user_id, group_id, level, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const person of people) insert.run(kind, id, person.id, null, person.level, actor.userId, timestamp);
      for (const group of groups) insert.run(kind, id, null, group.id, group.level, actor.userId, timestamp);
    }
    if (kind === "agent") db.query("UPDATE agents SET visibility = ?, all_users_level = 'view', updated_at = ? WHERE id = ?").run(body.audience, timestamp, id);
    else db.query("UPDATE chats SET visibility = ?, updated_at = ? WHERE id = ?").run(body.audience, timestamp, id);
    // "Shared with you" (§C.11): a bell line for everyone newly reaching it by name or through a new
    // group, and mail for people added by name (the existing share mail; groups are not mailed).
    if (selected) {
      const addedPeople = people.map((person) => person.id).filter((userId) => !before.has(userId));
      const reached = new Set(addedPeople);
      for (const group of groups) {
        if (beforeGroups.has(group.id)) continue;
        for (const row of db.query("SELECT user_id FROM group_members WHERE group_id = ? LIMIT 500").all(group.id) as Array<{ user_id: string }>) reached.add(row.user_id);
      }
      for (const userId of reached) {
        if (userId === current.owner.id || shareLevelById(kind, id, userId) === "none") continue;
        notifyAccess({ userId, kind: kind === "agent" ? "agent_shared" : "chat_shared", actorId: actor.userId, resource: { kind, id } }, timestamp);
      }
      mailAgentShared(actor.userId, kind, id, addedPeople.filter((userId) => userId !== current.owner.id && shareLevelById(kind, id, userId) !== "none"));
    }
    const counts = { kind, audience: body.audience, peopleCount: selected ? people.length : 0, groupCount: selected ? groups.length : 0 };
    const asManager = current.yourLevel === "manage" ? { asManager: true } : {};
    audit(actor.userId, null, "item.access_changed", { ...counts, itemId: id, ...asManager });
    recordAccessEvent({ actorId: actor.userId, via: "web", action: "item.access_changed", resource: { kind, id }, meta: { ...counts, ...asManager } }, timestamp);
    // QA M1: open readers re-check their access at once (someone taken off gets `gone`).
    if (kind === "chat") publishChatUpdate(id, { type: "chat_changed", data: { revision: (db.query("SELECT revision FROM chats WHERE id = ?").get(id) as { revision: number } | null)?.revision ?? 0 } });
    return readShareAccess(kind, id, actor.userId);
  })();
}

function validateShare(kind: ShareKind, current: ShareAccess, body: ShareAccessPut, people: Principal[], groups: Principal[]) {
  const invalid = (message: string, code = "INVALID", details: Record<string, unknown> = {}) => new AgentError(400, code, message, details);
  if (body.audience === "inherit") throw invalid("Agents and chats have no folder to inherit from");
  if (body.audienceLevel !== undefined) throw invalid("Everyone signed in can only view agents and chats", "LEVEL_NOT_OFFERED");
  const offered = SHARE_LEVELS[kind] as readonly string[];
  for (const entry of [...people, ...groups]) if (!offered.includes(entry.level)) throw invalid(`${entry.level} is not offered here`, "LEVEL_NOT_OFFERED");
  if (body.audience !== "selected" && (people.length || groups.length)) throw invalid("People and groups apply only to “People and groups I choose”");
  if (body.audience === "selected" && people.length === 0 && groups.length === 0) throw invalid("Choose at least one person or group");
  if (people.length > MAX_SHARE_PEOPLE || groups.length > MAX_SHARE_GROUPS) throw invalid("Too many people or groups");
  if (people.some((entry) => entry.id === current.owner.id)) throw invalid("The owner cannot be added as a recipient");
  if (people.length) {
    const found = db.query(`SELECT id, role FROM users WHERE id IN (${people.map(() => "?").join(",")})`).all(...people.map((entry) => entry.id)) as Array<{ id: string; role: Role }>;
    const known = new Set(current.people.map((person) => person.id));
    // People already listed may stay even if blocked meanwhile (they reach nothing while blocked); new ones must be active.
    const active = new Set((db.query(`SELECT id FROM users WHERE disabled_at IS NULL AND id IN (${people.map(() => "?").join(",")})`).all(...people.map((entry) => entry.id)) as Array<{ id: string }>).map((row) => row.id));
    if (found.length !== people.length || people.some((entry) => !known.has(entry.id) && !active.has(entry.id))) throw invalid("One or more people were not found");
    const guests = found.filter((row) => row.role === "guest" && !known.has(row.id)).map((row) => row.id);
    if (guests.length) throw invalid("Guests cannot use Chat, so an agent or chat cannot be shared with them by name", "GUEST_NOT_ALLOWED", { guests: { people: guests, groups: [] } });
  }
  if (groups.length) {
    const found = db.query(`SELECT id FROM user_groups WHERE id IN (${groups.map(() => "?").join(",")})`).all(...groups.map((group) => group.id)) as Array<{ id: string }>;
    if (found.length !== groups.length) throw invalid("One or more groups were not found");
  }
  if (current.yourLevel === "manage") {
    const refuse = (message: string) => new AgentError(403, "MANAGER_CAP", message);
    if (body.audience !== current.audience) throw refuse("Only the owner changes who can open this");
    const managers = (entries: ReadonlyArray<{ id: string; level: string }>) => entries.filter((entry) => entry.level === "manage").map((entry) => entry.id).sort().join(",");
    if (managers(people) !== managers(current.people) || managers(groups) !== managers(current.groups)) throw refuse("Only the owner adds, changes, or removes managers");
  }
}

// ------------------------------------------------------------------------------ the member access page (D268)

export type SharedAccessRow = {
  kind: ShareKind; title: string; titleHidden: boolean; owner: { id: string; displayName: string }; id?: string; level: "view" | "manage"; active: boolean;
  sources: Array<{ via: "direct" | "group"; level: "view" | "manage"; group: { id: string; name: string } | null; lowerTo: Array<"view">; handleItem: { kind: ShareKind; id: string; via: "direct" | "group"; groupId: string | null } }>;
};

/**
 * The agents and chats `userId` reaches by name or through a group, for the member access page:
 * titles only when `viewerId` can open the item (D269), otherwise "Agent owned by Carol". At most
 * 200 items (agents and chats are per-person things; the page lists them in one section).
 */
export function memberSharedRows(viewerId: string, userId: string): SharedAccessRow[] {
  const rows = db.query(`SELECT x.via, x.resource_kind, x.resource_id, x.level, x.group_id, x.group_name FROM (
      SELECT 'direct' AS via, a.resource_kind, a.resource_id, a.level, '' AS group_id, NULL AS group_name FROM agent_access a WHERE a.user_id = $userId AND a.resource_kind IN ('agent','chat')
      UNION ALL
      SELECT 'group', a.resource_kind, a.resource_id, a.level, a.group_id, g.name FROM group_members gm JOIN agent_access a ON a.group_id = gm.group_id JOIN user_groups g ON g.id = a.group_id
        WHERE gm.user_id = $userId AND a.resource_kind IN ('agent','chat')) x LIMIT 2000`).all({ userId }) as Array<{ via: "direct" | "group"; resource_kind: ShareKind; resource_id: string; level: string; group_id: string; group_name: string | null }>;
  const byItem = new Map<string, typeof rows>();
  for (const row of rows) byItem.set(`${row.resource_kind}:${row.resource_id}`, [...(byItem.get(`${row.resource_kind}:${row.resource_id}`) ?? []), row]);
  const items: Array<SharedAccessRow & { sort: string }> = [];
  for (const [, grants] of byItem) {
    const first = grants[0]!;
    const kind = first.resource_kind;
    const item = db.query(`SELECT x.id, x.owner_id, x.visibility, x.deleted_at, x.${NAME[kind]} AS title, u.display_name AS owner_name FROM ${TABLE[kind]} x JOIN users u ON u.id = x.owner_id WHERE x.id = ?`)
      .get(first.resource_id) as (Shareable & { title: string; owner_name: string }) | null;
    if (!item) continue;
    const readable = shareLevel(kind, item, viewerId) !== "none";
    const label = kind === "agent" ? "Agent" : "Chat";
    const sources = grants.sort((left, right) => left.via === right.via ? (left.group_name ?? "").localeCompare(right.group_name ?? "") : left.via === "direct" ? -1 : 1).map((grant) => {
      const level: "view" | "manage" = grant.level === "manage" ? "manage" : "view";
      return { via: grant.via, level, group: grant.via === "group" ? { id: grant.group_id, name: grant.group_name ?? "" } : null, lowerTo: grant.via === "direct" && level === "manage" ? ["view" as const] : [], handleItem: { kind, id: item.id, via: grant.via, groupId: grant.via === "group" ? grant.group_id : null } };
    });
    items.push({
      kind, title: readable ? item.title : `${label} owned by ${item.owner_name}`, titleHidden: !readable, owner: { id: item.owner_id, displayName: item.owner_name }, ...(readable ? { id: item.id } : {}),
      level: sources.some((source) => source.level === "manage") ? "manage" : "view", active: shareLevel(kind, item, userId) !== "none", sources, sort: `${item.owner_name.toLocaleLowerCase("en")}\u0000${kind}\u0000${createHash("sha256").update(`${viewerId}:${item.id}`).digest("hex")}`
    });
  }
  return items.sort((left, right) => left.sort < right.sort ? -1 : left.sort > right.sort ? 1 : 0).slice(0, 200).map(({ sort: _sort, ...row }) => row);
}

const ownerOfShared = (kind: ShareKind, id: string) => (db.query(`SELECT owner_id FROM ${TABLE[kind]} WHERE id = ?`).get(id) as { owner_id: string } | null)?.owner_id ?? null;

/** An admin removes one person's direct row on an agent or chat (D268). Returns the item's owner, or null when the row is gone. */
export function removeSharedDirect(kind: ShareKind, id: string, userId: string): { ownerId: string | null; level: string } | null {
  const row = db.query("SELECT level FROM agent_access WHERE resource_kind = ? AND resource_id = ? AND user_id = ?").get(kind, id, userId) as { level: string } | null;
  if (!row) return null;
  db.query("DELETE FROM agent_access WHERE resource_kind = ? AND resource_id = ? AND user_id = ?").run(kind, id, userId);
  return { ownerId: ownerOfShared(kind, id), level: row.level };
}

/** An admin lowers one person's agent row from manage to view (the only reduction short of removing it). */
export function lowerSharedDirect(kind: ShareKind, id: string, userId: string): { ownerId: string | null; from: string } | null {
  const changed = db.query("UPDATE agent_access SET level = 'view' WHERE resource_kind = ? AND resource_id = ? AND user_id = ? AND level = 'manage'").run(kind, id, userId).changes;
  if (!changed) return null;
  return { ownerId: ownerOfShared(kind, id), from: "manage" };
}

/** Direct agent and chat rows Reset access removes, counted with the other direct shares. */
export const sharedDirectCount = (userId: string) =>
  (db.query("SELECT COUNT(*) AS count FROM agent_access WHERE user_id = ? AND resource_kind IN ('agent','chat')").get(userId) as { count: number }).count;

/** Reset access: deletes the person's direct agent and chat rows; returns each owner's count for their notice. */
export function resetSharedDirect(userId: string): Map<string, number> {
  const rows = db.query("SELECT resource_kind, resource_id FROM agent_access WHERE user_id = ? AND resource_kind IN ('agent','chat')").all(userId) as Array<{ resource_kind: ShareKind; resource_id: string }>;
  const perOwner = new Map<string, number>();
  for (const row of rows) {
    const ownerId = ownerOfShared(row.resource_kind, row.resource_id);
    if (ownerId) perOwner.set(ownerId, (perOwner.get(ownerId) ?? 0) + 1);
  }
  db.query("DELETE FROM agent_access WHERE user_id = ? AND resource_kind IN ('agent','chat')").run(userId);
  return perOwner;
}
