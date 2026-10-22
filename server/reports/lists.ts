import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { AUDIENCE_ALL_USERS } from "../team/roles";
import { REPORT_LIST_ITEMS_MAX, REPORT_LIST_SHARES_MAX, REPORT_LISTS_PER_USER, type ReportListChoice, type ReportListLevel, type ReportListShare, type ReportListSharing, type ReportListSummary, type ReportListVisibility } from "../../shared/reports";
import { readableReport, readableReportSql } from "./access";
import { ReportError } from "./errors";
import { curatedList, listLevelSql, listNotFound, ownedList, readableListSql, type ListRow } from "./listAccess";

/**
 * Report lists (report organization phase 3, migration 068, D550–D559). A list groups reports without
 * moving them, in an order its curators choose; a report sits in many lists. A list never grants access
 * (D487, D550): its items, counts, and pages always go through readableReportSql, so each person sees
 * only the reports they can open, and the count is theirs. Its curators (the owner and people at `edit`)
 * also see how many live reports in it they can't open, never which (D552, T415). Any member creates
 * lists; the owner renames, shares, and deletes one (to their Bin, D553); curators add, remove, and
 * reorder. Every change is audited.
 */

type Via = { keyId?: string };
const viaMeta = (via: Via) => via.keyId ? { via: "mcp", keyId: via.keyId } : {};

/**
 * The live lists `$userId` may see, as ids from the indexes (D556: no scan of every list): their own
 * (report_lists_owner), everyone's (report_lists_audience), and the ones shared with them or a group of
 * theirs (report_list_members_user, report_list_group_shares_group). readableListSql re-checks each.
 */
const CANDIDATES_SQL = `SELECT id FROM report_lists WHERE owner_id = $userId AND deleted_at IS NULL
  UNION SELECT id FROM report_lists WHERE visibility = 'all_users' AND ${AUDIENCE_ALL_USERS} AND deleted_at IS NULL
  UNION SELECT list_id FROM report_list_members WHERE user_id = $userId
  UNION SELECT lg_c.list_id FROM group_members gm_c JOIN report_list_group_shares lg_c ON lg_c.group_id = gm_c.group_id WHERE gm_c.user_id = $userId`;

type SummaryRow = ListRow & { owner_name: string; level: ReportListLevel; count: number; live: number };

/**
 * The list summaries' SQL for the lists `candidates` names: each list's live reports and the ones `$userId`
 * can open (D552), from one GROUP BY over their items (each item is checked once), for `$userId`; `scoped`
 * narrows the readable count to an MCP key's reports (`$ids`).
 */
function summarySql(candidates: string, scoped: boolean) {
  const inKey = scoped ? " AND r.id IN (SELECT value FROM json_each($ids))" : "";
  return `WITH candidates(id) AS (${candidates}),
  counts(list_id, live, readable) AS (SELECT li.list_id, COUNT(*), SUM(CASE WHEN ${readableReportSql("r")}${inKey} THEN 1 ELSE 0 END)
    FROM report_list_items li CROSS JOIN reports r ON r.id = li.report_id WHERE li.list_id IN (SELECT id FROM candidates) AND r.deleted_at IS NULL GROUP BY li.list_id)
  SELECT l.*, u.display_name AS owner_name, ${listLevelSql("l")} AS level, COALESCE(c.readable, 0) AS count, COALESCE(c.live, 0) AS live
  FROM report_lists l CROSS JOIN users u ON u.id = l.owner_id LEFT JOIN counts c ON c.list_id = l.id
  WHERE l.id IN (SELECT id FROM candidates) AND ${readableListSql("l")}`;
}

function summaryOf(row: SummaryRow, scoped: boolean): ReportListSummary {
  const curator = row.level !== "view";
  return {
    id: row.id, name: row.name, ownerId: row.owner_id, ownerName: row.owner_name, level: row.level, visibility: row.visibility,
    count: row.count, hidden: curator && !scoped ? Math.max(0, row.live - row.count) : null, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

/**
 * The Reports nav's Lists: every live list the caller can see (their own first, then by name), each with
 * the count of its reports they can open and, for its curators, how many they can't (D552). `ids` (an MCP
 * key over chosen reports) narrows the counts to those reports and drops the hidden counts.
 */
export function listReportLists(userId: string, options: { ids?: readonly string[] | null } = {}): ReportListSummary[] {
  const ids = options.ids ? JSON.stringify(options.ids) : null;
  const rows = db.query(reportListsSql(Boolean(ids))).all(ids ? { userId, ids } : { userId }) as SummaryRow[];
  return rows.map((row) => summaryOf(row, Boolean(ids)));
}

/** The nav's SQL (tests run it over their own database): binds `$userId`, and `$ids` when `scoped`. */
export function reportListsSql(scoped = false) {
  return `${summarySql(CANDIDATES_SQL, scoped)} ORDER BY l.owner_id = $userId DESC, l.name COLLATE NOCASE, l.id`;
}

/** One list the caller can see, as the nav shows it (404 otherwise). */
export function reportListSummary(userId: string, id: string, options: { ids?: readonly string[] | null } = {}): ReportListSummary {
  const ids = options.ids ? JSON.stringify(options.ids) : null;
  const row = db.query(summarySql("SELECT $id", Boolean(ids))).get(ids ? { userId, id, ids } : { userId, id }) as SummaryRow | null;
  if (!row) throw listNotFound();
  return summaryOf(row, Boolean(ids));
}

function mayCreateLists(userId: string) {
  const row = db.query("SELECT role FROM users WHERE id = ? AND disabled_at IS NULL").get(userId) as { role: string } | null;
  return row?.role === "admin" || row?.role === "member";
}

/** Any member (admins and members; never viewers or guests) creates a list of their own, private at first. */
export function createList(userId: string, name: string, via: Via = {}): ReportListSummary {
  return db.transaction(() => {
    if (!mayCreateLists(userId)) throw new ReportError(403, "ROLE_READ_ONLY", "Your Team role can only view report lists");
    const owned = (db.query("SELECT COUNT(*) AS n FROM report_lists WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { n: number }).n;
    if (owned >= REPORT_LISTS_PER_USER) throw new ReportError(409, "LIMIT_REACHED", `You can have up to ${REPORT_LISTS_PER_USER} report lists`);
    const id = crypto.randomUUID();
    const at = now();
    db.query("INSERT INTO report_lists (id, owner_id, name, visibility, created_at, updated_at) VALUES (?, ?, ?, 'private', ?, ?)").run(id, userId, name, at, at);
    audit(userId, null, "reports.list.create", { id, name, ...viaMeta(via) });
    return reportListSummary(userId, id);
  })();
}

/** The owner renames their list. */
export function renameList(userId: string, id: string, name: string): ReportListSummary {
  const row = ownedList(id, userId);
  if (row.name !== name) {
    db.query("UPDATE report_lists SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), id);
    audit(userId, null, "reports.list.rename", { id, from: row.name, name });
  }
  return reportListSummary(userId, id);
}

/** The owner moves their list to their Bin for 30 days (D553); its items and sharing wait with it. No report changes. */
export function binList(userId: string, id: string) {
  ownedList(id, userId);
  const at = new Date();
  const purgeAfter = purgeAfterFrom(at);
  db.query("UPDATE report_lists SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(at.toISOString(), userId, purgeAfter, at.toISOString(), id);
  audit(userId, null, "reports.list.bin", { id });
  return { ok: true as const, purgeAfter };
}

/** Item positions of a list, in order (all of them: a curator's reorder keeps the ones they can't see where they are). */
const orderOf = (listId: string) => (db.query("SELECT report_id FROM report_list_items WHERE list_id = ? ORDER BY position, report_id").all(listId) as Array<{ report_id: string }>).map((row) => row.report_id);

/** Writes positions 0, 1, 2… for `order`, touching only the rows whose position changed. */
function renumber(listId: string, order: readonly string[]) {
  const current = new Map((db.query("SELECT report_id, position FROM report_list_items WHERE list_id = ?").all(listId) as Array<{ report_id: string; position: number }>).map((row) => [row.report_id, row.position]));
  const update = db.query("UPDATE report_list_items SET position = ? WHERE list_id = ? AND report_id = ?");
  order.forEach((reportId, position) => { if (current.get(reportId) !== position) update.run(position, listId, reportId); });
}

/**
 * A curator adds a report they can open to the end of the list (D550: a report you can't open is the same
 * 404 as a missing one, so a list never carries a title its curator could not see). Adding it again changes nothing.
 */
export function addToList(userId: string, listId: string, reportId: string, via: Via = {}): { added: boolean; list: ReportListSummary } {
  return db.transaction(() => {
    curatedList(listId, userId);
    readableReport(reportId, userId);
    if (db.query("SELECT 1 FROM report_list_items WHERE list_id = ? AND report_id = ?").get(listId, reportId)) return { added: false, list: reportListSummary(userId, listId) };
    const { n, top } = db.query("SELECT COUNT(*) AS n, MAX(position) AS top FROM report_list_items WHERE list_id = ?").get(listId) as { n: number; top: number | null };
    if (n >= REPORT_LIST_ITEMS_MAX) throw new ReportError(409, "LIMIT_REACHED", `A list holds up to ${REPORT_LIST_ITEMS_MAX} reports`);
    const at = now();
    db.query("INSERT INTO report_list_items (list_id, report_id, position, added_by, added_at) VALUES (?, ?, ?, ?, ?)").run(listId, reportId, (top ?? -1) + 1, userId, at);
    db.query("UPDATE report_lists SET updated_at = ? WHERE id = ?").run(at, listId);
    audit(userId, null, "reports.list.add", { id: listId, reportId, ...viaMeta(via) });
    return { added: true, list: reportListSummary(userId, listId) };
  })();
}

/** A curator removes a report from the list (it needs no access to the report: only the list changes). */
export function removeFromList(userId: string, listId: string, reportId: string): { removed: boolean; list: ReportListSummary } {
  return db.transaction(() => {
    curatedList(listId, userId);
    const removed = db.query("DELETE FROM report_list_items WHERE list_id = ? AND report_id = ?").run(listId, reportId).changes > 0;
    if (removed) {
      db.query("UPDATE report_lists SET updated_at = ? WHERE id = ?").run(now(), listId);
      audit(userId, null, "reports.list.remove", { id: listId, reportId });
    }
    return { removed, list: reportListSummary(userId, listId) };
  })();
}

/**
 * A curator moves a report they can open to just before `beforeId` or just after `afterId` (another report
 * of the list they can open; neither: the end). Reports in the list they can't open keep their places
 * relative to each other (D555).
 */
export function moveInList(userId: string, listId: string, reportId: string, place: { beforeId?: string | null; afterId?: string | null }) {
  return db.transaction(() => {
    curatedList(listId, userId);
    const notInList = () => new ReportError(404, "NOT_FOUND", "That report is not in this list");
    readableReport(reportId, userId);
    const anchor = place.beforeId ?? place.afterId ?? null;
    if (anchor) readableReport(anchor, userId);
    const order = orderOf(listId);
    if (!order.includes(reportId)) throw notInList();
    if (anchor === reportId) return { ok: true as const };
    const rest = order.filter((id) => id !== reportId);
    let at = rest.length;
    if (anchor) {
      const index = rest.indexOf(anchor);
      if (index < 0) throw notInList();
      at = place.beforeId ? index : index + 1;
    }
    rest.splice(at, 0, reportId);
    renumber(listId, rest);
    db.query("UPDATE report_lists SET updated_at = ? WHERE id = ?").run(now(), listId);
    audit(userId, null, "reports.list.reorder", { id: listId, reportId });
    return { ok: true as const };
  })();
}

/** The add-to-list picker: the lists the caller curates, and whether the report (one they can open) is in each. */
export function listChoices(userId: string, reportId: string): ReportListChoice[] {
  readableReport(reportId, userId);
  const rows = db.query(`WITH candidates(id) AS (${CANDIDATES_SQL})
    SELECT l.id, l.name, l.owner_id, u.display_name AS owner_name, EXISTS (SELECT 1 FROM report_list_items li WHERE li.list_id = l.id AND li.report_id = $reportId) AS contains
    FROM candidates c CROSS JOIN report_lists l ON l.id = c.id CROSS JOIN users u ON u.id = l.owner_id
    WHERE ${readableListSql("l")} AND ${listLevelSql("l")} <> 'view' ORDER BY l.owner_id = $userId DESC, l.name COLLATE NOCASE, l.id`).all({ userId, reportId }) as Array<{ id: string; name: string; owner_id: string; owner_name: string; contains: number }>;
  return rows.map((row) => ({ id: row.id, name: row.name, contains: row.contains === 1, ownerName: row.owner_name, isOwner: row.owner_id === userId }));
}

/** Who else sees or curates the list (the owner's). */
export function getListSharing(userId: string, listId: string): ReportListSharing {
  const list = ownedList(listId, userId);
  const users = db.query("SELECT m.user_id AS id, u.display_name AS name, m.level FROM report_list_members m JOIN users u ON u.id = m.user_id WHERE m.list_id = ? ORDER BY u.display_name")
    .all(listId) as Array<{ id: string; name: string; level: ReportListShare["level"] }>;
  const groups = db.query("SELECT g.group_id AS id, ug.name, g.level FROM report_list_group_shares g JOIN user_groups ug ON ug.id = g.group_id WHERE g.list_id = ? ORDER BY ug.name")
    .all(listId) as Array<{ id: string; name: string; level: ReportListShare["level"] }>;
  return { visibility: list.visibility, shares: [...groups.map((row) => ({ kind: "group" as const, ...row })), ...users.map((row) => ({ kind: "user" as const, ...row }))] };
}

/**
 * The owner sets who sees the list (D551, the reports' sharing shape): private, chosen people and groups
 * at `view` or `edit`, or everyone on the team at view. Saving replaces the shares. Sharing a list never
 * shares a report in it (D487): each person still sees only the reports they can open.
 */
export function setListSharing(userId: string, listId: string, input: { visibility: ReportListVisibility; shares: Array<{ kind: "user" | "group"; id: string; level: "view" | "edit" }> }): ReportListSharing {
  ownedList(listId, userId);
  const shares = input.visibility === "selected" ? input.shares : [];
  if (shares.length > REPORT_LIST_SHARES_MAX) throw new ReportError(400, "INVALID", `Share with at most ${REPORT_LIST_SHARES_MAX} people and groups`);
  const seen = new Set<string>();
  for (const share of shares) {
    const key = `${share.kind}:${share.id}`;
    if (seen.has(key)) throw new ReportError(400, "INVALID", "A person or group is listed twice");
    seen.add(key);
    if (share.kind === "user") {
      if (share.id === userId) throw new ReportError(400, "INVALID", "You own this list");
      const person = db.query("SELECT role, kind FROM users WHERE id = ? AND disabled_at IS NULL").get(share.id) as { role: string; kind: string } | null;
      if (!person || person.role === "guest" || person.kind !== "person") throw new ReportError(400, "INVALID", "Lists can be shared only with people on the team (not guests or integrations)");
    } else if (!db.query("SELECT 1 FROM user_groups WHERE id = ?").get(share.id)) throw new ReportError(400, "INVALID", "That group no longer exists");
  }
  const at = now();
  db.transaction(() => {
    db.query("UPDATE report_lists SET visibility = ?, updated_at = ? WHERE id = ?").run(input.visibility, at, listId);
    db.query("DELETE FROM report_list_members WHERE list_id = ?").run(listId);
    db.query("DELETE FROM report_list_group_shares WHERE list_id = ?").run(listId);
    for (const share of shares) {
      if (share.kind === "user") db.query("INSERT INTO report_list_members (list_id, user_id, level, added_by, created_at) VALUES (?, ?, ?, ?, ?)").run(listId, share.id, share.level, userId, at);
      else db.query("INSERT INTO report_list_group_shares (list_id, group_id, level, added_by, created_at) VALUES (?, ?, ?, ?, ?)").run(listId, share.id, share.level, userId, at);
    }
  })();
  audit(userId, null, "reports.list.share", { id: listId, visibility: input.visibility, users: shares.filter((share) => share.kind === "user").length, groups: shares.filter((share) => share.kind === "group").length });
  return getListSharing(userId, listId);
}
