import { db } from "./db";
import { scopeReach, grantsForScopes, selectionHas, unionReach, type ResourceKind, type ScopeReach } from "./keyGrants";
import { hasScope, type McpScope } from "./mcpScopes";
import type { McpKeyContext } from "./mcpToolKit";
import { cardIdForKey } from "./tasks/keys";
import { CARD_KEY_PATTERN } from "../shared/boardKeys";
import { WORKSPACE_CONTAINER_KINDS, type WorkspaceContainerKind } from "../shared/workspaceModules";

/**
 * Where an item sits, for chosen-item keys (access plan D281, §C.10, T203; Wave 34).
 *
 * A tool declares which argument names which kind of item (server/mcpToolKit.ts `ToolAccess`).
 * Before its handler runs, runTool resolves each named item to its **anchors**: the item itself
 * and its container (a card's board, a note's or file's immediate folder, a run's routine). A
 * key limited to chosen items reaches the item when one anchor is among them. Missing items and
 * items outside the grant look the same (NOT_FOUND, T205).
 *
 * List tools cannot be checked item by item, so their handlers narrow their SQL with
 * `keyFilter`, before any LIMIT or page cut, so counts and pages only ever hold granted items.
 */

export type ItemKind =
  | "note" | "folder" | "document" | "whiteboard"
  | "board" | "card" | "column" | "sprint" | "task_view"
  | "collection" | "row"
  | "calendar" | "event"
  | "routine" | "run"
  // Wave 27: a vault (its tools run only for `nkv_` vault keys; server/vault/mcpTools.ts).
  | "vault"
  // Wave 42 (AC-C): an agent (`run_agent`, the REST runs).
  | "agent"
  // Wave 44 (AC-E): a knowledge base (`search_knowledge`).
  | "knowledge_base"
  // Wave 45: an analytics report.
  | "report"
  // Workspace modules (§B.9): containers and their contents, anchored through registerItemKind.
  | WorkspaceItemKind;

/** The workspace modules' item kinds: their containers and what sits in them (each lane registers its lookups). */
export type WorkspaceItemKind = WorkspaceContainerKind | "response" | "time_entry" | "key_result" | "checkin_round" | "contact" | "company" | "deal" | "interaction" | "booking" | "townhall_question";
type BuiltinItemKind = Exclude<ItemKind, WorkspaceItemKind>;

export type Anchor = { kind: ResourceKind; id: string };

type Lookup = { sql: string; anchors: (row: Record<string, string | null>) => Array<Anchor | null> };

const direct = (kind: ResourceKind) => (id: string): Anchor[] => [{ kind, id }];

const LOOKUPS: Record<BuiltinItemKind, Lookup | ((id: string) => Anchor[])> = {
  note: { sql: "SELECT id, folder_id FROM notes WHERE id = ?", anchors: (row) => [{ kind: "note", id: row.id! }, row.folder_id ? { kind: "folder", id: row.folder_id } : null] },
  folder: { sql: "SELECT id FROM folders WHERE id = ?", anchors: (row) => [{ kind: "folder", id: row.id! }] },
  // A whiteboard is a Files document too: Files grants reach it through its id or folder, whiteboard grants through its id.
  document: {
    sql: "SELECT d.id, d.folder_id, w.document_id AS whiteboard FROM documents d LEFT JOIN whiteboards w ON w.document_id = d.id WHERE d.id = ?",
    anchors: (row) => [{ kind: "document", id: row.id! }, row.folder_id ? { kind: "folder", id: row.folder_id } : null, row.whiteboard ? { kind: "whiteboard", id: row.whiteboard } : null]
  },
  whiteboard: { sql: "SELECT document_id AS id FROM whiteboards WHERE document_id = ?", anchors: (row) => [{ kind: "whiteboard", id: row.id! }] },
  board: direct("board"),
  // A card by id, or by key (MYT-12, lane KEYS D713): the key is read as the card it names, on its board now.
  card: (id) => {
    const cardId = CARD_KEY_PATTERN.test(id) ? cardIdForKey(id) : id;
    const row = cardId ? db.query("SELECT board_id FROM cards WHERE id = ?").get(cardId) as { board_id: string } | null : null;
    return row ? [{ kind: "board", id: row.board_id }] : [];
  },
  column: { sql: "SELECT board_id FROM board_columns WHERE id = ?", anchors: (row) => [{ kind: "board", id: row.board_id! }] },
  sprint: { sql: "SELECT board_id FROM board_sprints WHERE id = ?", anchors: (row) => [{ kind: "board", id: row.board_id! }] },
  task_view: direct("task_view"),
  collection: direct("collection"),
  row: { sql: "SELECT collection_id FROM collection_rows WHERE id = ?", anchors: (row) => [{ kind: "collection", id: row.collection_id! }] },
  calendar: direct("calendar"),
  event: { sql: "SELECT calendar_id FROM events WHERE id = ?", anchors: (row) => [{ kind: "calendar", id: row.calendar_id! }] },
  routine: direct("routine"),
  vault: direct("vault"),
  agent: direct("agent"),
  knowledge_base: direct("knowledge_base"),
  report: direct("report"),
  run:{ sql: "SELECT routine_id FROM routine_runs WHERE id = ?", anchors: (row) => [{ kind: "routine", id: row.routine_id! }] }
};

/** The kinds an item of `kind` can be anchored on (static: for hiding tools a key can never use). */
export const ANCHOR_KINDS: Record<ItemKind, readonly ResourceKind[]> = {
  note: ["note", "folder"], folder: ["folder"], document: ["document", "folder", "whiteboard"], whiteboard: ["whiteboard"],
  board: ["board"], card: ["board"], column: ["board"], sprint: ["board"], task_view: ["task_view"],
  collection: ["collection"], row: ["collection"], calendar: ["calendar"], event: ["calendar"], routine: ["routine"], run: ["routine"],
  vault: ["vault"], agent: ["agent"], knowledge_base: ["knowledge_base"], report: ["report"],
  // Workspace containers anchor on themselves; their contents on the container (§B.9). Lanes register
  // the lookups (registerItemKind); these are the static kinds, for hiding tools a key can never use.
  form: ["form"], response: ["form"], time_project: ["time_project"], time_entry: ["time_project"], goal: ["goal"], key_result: ["goal"],
  checkin: ["checkin"], checkin_round: ["checkin"], contact_book: ["contact_book"], contact: ["contact_book"], company: ["contact_book"],
  deal: ["contact_book"], interaction: ["contact_book"], booking_type: ["booking_type"], booking: ["booking_type"],
  townhall_session: ["townhall_session"], townhall_question: ["townhall_session"]
};

/**
 * Registered lookups of the workspace item kinds (§B.1, §B.9): `anchors(id)` returns the item's
 * anchors (itself if it is a container, else its container), or null when it does not exist. A
 * container kind with no registered lookup anchors on itself.
 */
const registeredLookups = new Map<WorkspaceItemKind, (id: string) => Anchor[] | null>();

export function registerItemKind(kind: WorkspaceItemKind, anchors: (id: string) => Anchor[] | null) {
  if (registeredLookups.has(kind)) throw new Error(`Item kind ${kind} is already registered`);
  registeredLookups.set(kind, anchors);
  return () => { if (registeredLookups.get(kind) === anchors) registeredLookups.delete(kind); };
}

/** A lookup by SQL that selects the container id (`SELECT form_id AS anchor FROM responses WHERE id = ?`). */
export const anchorBySql = (kind: WorkspaceContainerKind, sql: string) => (id: string): Anchor[] | null => {
  const row = db.query(sql).get(id) as { anchor: string | null } | null;
  return row ? (row.anchor ? [{ kind, id: row.anchor }] : []) : null;
};

/** The anchors of one item, or null when it does not exist. Ids compare in lower case. */
export function anchorsOf(kind: ItemKind, id: string): Anchor[] | null {
  const lower = id.toLowerCase();
  const registered = registeredLookups.get(kind as WorkspaceItemKind);
  if (registered) return registered(lower);
  if ((WORKSPACE_CONTAINER_KINDS as readonly string[]).includes(kind)) return [{ kind: kind as ResourceKind, id: lower }];
  if (!(kind in LOOKUPS)) return null;
  const lookup = LOOKUPS[kind as BuiltinItemKind];
  if (typeof lookup === "function") return lookup(lower);
  const row = db.query(lookup.sql).get(lower) as Record<string, string | null> | null;
  return row ? lookup.anchors(row).filter((anchor): anchor is Anchor => anchor !== null) : null;
}

/** Whether `reach` covers an item with these anchors. */
export function reachCovers(reach: ScopeReach, anchors: readonly Anchor[] | null) {
  if (reach === null || anchors === null) return false;
  if (reach === "all") return true;
  return anchors.some((anchor) => selectionHas(reach, anchor.kind, anchor.id));
}

/** Whether `reach` could ever cover an item of `kind` (it names a kind the item anchors on). */
export function reachCanCover(reach: ScopeReach, kind: ItemKind) {
  if (reach === null) return false;
  if (reach === "all") return true;
  return ANCHOR_KINDS[kind].some((anchorKind) => (reach.kinds.get(anchorKind)?.size ?? 0) > 0);
}

/**
 * What the key reaches for a scope now: from its effective grants, or its scopes over every item
 * when the context carries none (tests). A signed-in person approving a proposal is not limited.
 */
export function keyReach(key: McpKeyContext, scope: McpScope): ScopeReach {
  if (key.person) return "all";
  if (!key.grants) return hasScope(key.scopes, scope) ? "all" : null;
  return scopeReach(key.grants, scope);
}

/** The union of the reaches of several scopes (a tool allowed by any one of them). */
export const keyReachAny = (key: McpKeyContext, scopes: readonly McpScope[]) => scopes.reduce<ScopeReach>((reach, scope) => unionReach(reach, keyReach(key, scope)), null);

/** A contexts' grants, or "all" grants for its scopes, for callers that need the list. */
export const grantsOfKey = (key: McpKeyContext) => key.grants ?? grantsForScopes(key.scopes);

// ------------------------------------------------------------------ SQL filters for list tools

/** An SQL condition plus its named parameters (merge them into the statement's own). */
export type SqlFilter = { sql: string; params: Record<string, string> };

export const NO_FILTER: SqlFilter = { sql: "1", params: {} };
export const NOTHING: SqlFilter = { sql: "0", params: {} };

let filterCounter = 0;

/**
 * The condition that keeps only rows the reach covers. `columns` maps each kind a row can be
 * anchored on to its SQL column (for notes: `{ note: "n.id", folder: "n.folder_id" }`). "all" is
 * `1`; nothing (or only kinds the row cannot anchor on) is `0`. Parameters are JSON arrays read
 * with json_each, so a long selection is one bound value per kind.
 */
export function reachFilter(reach: ScopeReach, columns: Partial<Record<ResourceKind, string>>): SqlFilter {
  if (reach === "all") return NO_FILTER;
  if (reach === null) return NOTHING;
  const terms: string[] = [];
  const params: Record<string, string> = {};
  for (const [kind, column] of Object.entries(columns) as Array<[ResourceKind, string]>) {
    const ids = reach.kinds.get(kind);
    if (!ids?.size) continue;
    const name = `keyReach${(filterCounter = (filterCounter + 1) % 1_000_000)}`;
    params[name] = JSON.stringify([...ids]);
    terms.push(`${column} IN (SELECT value FROM json_each($${name}))`);
  }
  return terms.length ? { sql: `(${terms.join(" OR ")})`, params } : NOTHING;
}

/** `reachFilter` for a key and scope (a session, or a key over every item, gets `1`). */
export const keyFilter = (key: McpKeyContext | null | undefined, scope: McpScope, columns: Partial<Record<ResourceKind, string>>) =>
  key ? reachFilter(keyReach(key, scope), columns) : NO_FILTER;

/** The ids a key may list of one container kind, or null when it reaches every one (no narrowing needed). */
export function keyContainerIds(key: McpKeyContext, scope: McpScope, kind: ResourceKind): string[] | null {
  const reach = keyReach(key, scope);
  if (reach === "all") return null;
  if (reach === null) return [];
  return [...(reach.kinds.get(kind) ?? [])];
}
