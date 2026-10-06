import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { AGENT_BOUNDS, type ChatDetail, type ChatMessage, type ChatSummary, type TokenUsage, type ToolCallView } from "../../shared/agents";
import { usableAgent, type AgentRow } from "./agentsService";
import { shareLevel, shareReadableSql } from "./sharing";
import { AgentError } from "./status";

/**
 * Chats and their message trees (plan §6.1, D360): a chat belongs to its owner and one agent; its
 * messages form a tree by `parent_id`, and `active_leaf_id` names the branch on screen. Editing a
 * user message inserts a sibling; regenerating inserts a sibling assistant turn; nothing is ever
 * deleted by branching. Delete moves the chat to the Bin (D363). Runs are started by runs.ts.
 */

export type ChatRow = {
  id: string; owner_id: string; agent_id: string | null; title: string; pinned: number; active_leaf_id: string | null; always_allow_json: string; visibility: string;
  revision: number; created_at: string; updated_at: string; deleted_at: string | null; deleted_by: string | null; purge_after: string | null; purge_started_at: string | null;
  /** Wave 43 (041): "Copied from <name>'s chat" (Continue as a copy). */
  copied_from_user_id?: string | null; copied_from_name?: string | null;
};
export type MessageRow = {
  id: string; chat_id: string; parent_id: string | null; role: "user" | "assistant" | "tool"; content: string; tool_calls_json: string | null; tool_call_id: string | null;
  tool_name: string | null; server_id: string | null; ok: number | null; duration_ms: number | null; status: ChatMessage["status"]; error_code: string | null;
  model: string | null; usage_json: string | null; run_id: string | null; author_id: string | null; created_at: string; finished_at: string | null;
};

const parseUsage = (json: string | null): TokenUsage | null => {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<TokenUsage>;
    return typeof value.promptTokens === "number" && typeof value.completionTokens === "number" ? { promptTokens: value.promptTokens, completionTokens: value.completionTokens, estimated: value.estimated === true, ...(typeof value.cachedTokens === "number" ? { cachedTokens: value.cachedTokens } : {}) } : null;
  } catch {
    return null;
  }
};

/** The tool calls stored on an assistant row (AC-B): excerpts only, never whole results. */
export function parseToolCalls(json: string | null): ToolCallView[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is ToolCallView => !!item && typeof item === "object" && typeof (item as ToolCallView).id === "string" && typeof (item as ToolCallView).tool === "string") : [];
  } catch {
    return [];
  }
}

export const messageOf = (row: MessageRow): ChatMessage => ({
  id: row.id, parentId: row.parent_id, role: row.role, content: row.content, status: row.status, errorCode: row.error_code, model: row.model,
  usage: parseUsage(row.usage_json), runId: row.run_id, createdAt: row.created_at, finishedAt: row.finished_at, toolCalls: parseToolCalls(row.tool_calls_json)
});

const LIVE_RUN = "SELECT 1 FROM agent_runs r WHERE r.chat_id = c.id AND r.status IN ('queued','running','awaiting_confirmation')";

/** Chats as `viewerId` sees them: their own with the audience, others' (shared with them) read-only with the owner's name. */
function summaryRows(where: string, params: Record<string, string>, viewerId: string): ChatSummary[] {
  // LEFT JOIN: a purged agent leaves agent_id NULL and the chat stays listed (review M2).
  const rows = db.query(`SELECT c.*, a.name AS agent_name, a.icon AS agent_icon, EXISTS (${LIVE_RUN}) AS running, o.display_name AS owner_name
    FROM chats c LEFT JOIN agents a ON a.id = c.agent_id JOIN users o ON o.id = c.owner_id WHERE ${where}`).all(params) as Array<ChatRow & { agent_name: string | null; agent_icon: string | null; running: number; owner_name: string }>;
  return rows.map((row) => {
    const owner = row.owner_id === viewerId;
    return {
      id: row.id, agentId: row.agent_id, agentName: row.agent_name, agentIcon: row.agent_icon, title: row.title, pinned: owner && row.pinned === 1, activeLeafId: row.active_leaf_id,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, running: row.running === 1,
      yourLevel: owner ? "owner" as const : "view" as const, ownerName: row.owner_name, copiedFrom: owner ? row.copied_from_name ?? null : null,
      audience: owner ? (row.visibility === "selected" || row.visibility === "all_users" ? row.visibility : "private") : null
    };
  });
}

/** The owner's live chats, pinned first then newest, optionally filtered by a title or message search. */
export function listChats(userId: string, options: { q?: string; limit?: number } = {}): ChatSummary[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const q = options.q?.trim();
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 8).map((term) => `"${term.replace(/"/g, "")}"*`).filter((term) => term !== '""*').join(" ");
    if (!terms) return [];
    // Owner-scoped inside the FTS stage (review L4): other people's matches never fill the 500 before the owner's.
    const ids = (db.query("SELECT DISTINCT chat_id FROM chat_fts WHERE chat_fts MATCH ? AND owner_id = ? LIMIT 500").all(terms, userId) as Array<{ chat_id: string }>).map((row) => row.chat_id);
    if (ids.length === 0) return [];
    const marks = ids.map((_, index) => `$id${index}`).join(",");
    return summaryRows(`c.owner_id = $userId AND c.deleted_at IS NULL AND c.id IN (${marks}) ORDER BY c.pinned DESC, c.updated_at DESC LIMIT ${limit}`, { userId, ...Object.fromEntries(ids.map((id, index) => [`id${index}`, id])) }, userId);
  }
  return summaryRows(`c.owner_id = $userId AND c.deleted_at IS NULL ORDER BY c.pinned DESC, c.updated_at DESC LIMIT ${limit}`, { userId }, userId);
}

/**
 * Chats others shared with the person (Wave 43, AC-D, D361): live, readable now (by name, through a
 * group, or everyone signed in), newest first; an optional title filter. Read-only for them.
 */
export function listSharedChats(userId: string, options: { q?: string; limit?: number } = {}): ChatSummary[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const q = options.q?.trim().slice(0, 200);
  const filter = q ? " AND c.title LIKE $q ESCAPE '\\'" : "";
  return summaryRows(`c.owner_id <> $userId AND ${shareReadableSql("chat", "c")}${filter} ORDER BY c.updated_at DESC LIMIT ${limit}`,
    { userId, ...(q ? { q: `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%` } : {}) }, userId);
}

/** The owner's live chat; someone it is shared with gets 403 READ_ONLY, everyone else the 404 (missing, binned, or not theirs). */
export function ownedChat(id: string, userId: string): ChatRow {
  const row = db.query("SELECT * FROM chats WHERE id = ? AND deleted_at IS NULL").get(id) as ChatRow | null;
  if (!row) throw new AgentError(404, "NOT_FOUND", "Not found");
  if (row.owner_id !== userId) {
    if (shareLevel("chat", row, userId) === "none") throw new AgentError(404, "NOT_FOUND", "Not found");
    throw new AgentError(403, "READ_ONLY", "This chat is shared with you read-only; continue in your own copy to reply");
  }
  return row;
}

/** A live chat the person may read: their own, or shared with them now (D361); otherwise the 404. */
export function readableChat(id: string, userId: string): ChatRow {
  const row = db.query("SELECT * FROM chats WHERE id = ? AND deleted_at IS NULL").get(id) as ChatRow | null;
  if (!row || shareLevel("chat", row, userId) === "none") throw new AgentError(404, "NOT_FOUND", "Not found");
  return row;
}

export function chatDetail(id: string, userId: string): ChatDetail {
  readableChat(id, userId);
  const chat = summaryRows("c.id = $id AND c.deleted_at IS NULL", { id }, userId)[0];
  if (!chat) throw new AgentError(404, "NOT_FOUND", "Not found");
  const rows = db.query("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at, rowid").all(id) as MessageRow[];
  const run = db.query("SELECT id FROM agent_runs WHERE chat_id = ? AND status IN ('queued','running','awaiting_confirmation') ORDER BY queued_at DESC LIMIT 1").get(id) as { id: string } | null;
  // `pendingConfirmation` is filled by the route from the live run (runs.ts owns it).
  return { chat, messages: rows.map(messageOf), activeRunId: run?.id ?? null, pendingConfirmation: null };
}

export function createChat(userId: string, agentId: string): ChatSummary {
  const agent = usableAgent(agentId, userId);
  return db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM chats WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count;
    if (count >= AGENT_BOUNDS.chatsPerUser) throw new AgentError(409, "LIMIT_REACHED", `You can have up to ${AGENT_BOUNDS.chatsPerUser} chats`);
    const id = crypto.randomUUID();
    const timestamp = now();
    db.query("INSERT INTO chats (id, owner_id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, agent.id, "New chat", timestamp, timestamp);
    db.query("INSERT INTO chat_fts (chat_id, owner_id, title, body) VALUES (?, ?, ?, '')").run(id, userId, "New chat");
    return summaryRows("c.id = $id", { id }, userId)[0]!;
  })();
}

/** The chat's agent, which must still be live to send (binned agents keep their chats readable; purged ones leave them read-only). */
export function chatAgent(chat: ChatRow): AgentRow {
  if (chat.agent_id === null) throw new AgentError(409, "AGENT_GONE", "This chat's agent was deleted; start a new chat with another agent");
  const row = db.query("SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL").get(chat.agent_id) as AgentRow | null;
  if (!row) throw new AgentError(409, "AGENT_GONE", "This chat's agent is in the Bin; restore it to continue");
  return row;
}

export function updateChat(userId: string, id: string, input: { title?: string; pinned?: boolean; activeLeafId?: string | null; expectedRevision: number }): ChatSummary {
  return db.transaction(() => {
    const chat = ownedChat(id, userId);
    if (chat.revision !== input.expectedRevision) throw new AgentError(409, "REVISION_MISMATCH", "This chat changed elsewhere; reload and try again", { revision: chat.revision });
    if (input.activeLeafId !== undefined && input.activeLeafId !== null && !db.query("SELECT 1 FROM chat_messages WHERE id = ? AND chat_id = ?").get(input.activeLeafId, id)) {
      throw new AgentError(404, "NOT_FOUND", "Not found");
    }
    const title = input.title !== undefined ? input.title.trim().slice(0, AGENT_BOUNDS.chatTitle) || chat.title : chat.title;
    db.query("UPDATE chats SET title = ?, pinned = ?, active_leaf_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(title, input.pinned !== undefined ? (input.pinned ? 1 : 0) : chat.pinned, input.activeLeafId !== undefined ? input.activeLeafId : chat.active_leaf_id, now(), id);
    if (input.title !== undefined) db.query("UPDATE chat_fts SET title = ? WHERE chat_id = ?").run(title, id);
    return summaryRows("c.id = $id", { id }, userId)[0]!;
  })();
}

export function deleteChat(userId: string, id: string) {
  ownedChat(id, userId);
  const timestamp = now();
  db.query("UPDATE chats SET deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(timestamp, userId, purgeAfterFrom(new Date(timestamp)), timestamp, id);
  audit(userId, null, "agents.chat.delete", { chatId: id });
  return { ok: true as const };
}

/** A message of this chat, or the 404. */
export function chatMessage(chatId: string, messageId: string): MessageRow {
  const row = db.query("SELECT * FROM chat_messages WHERE id = ? AND chat_id = ?").get(messageId, chatId) as MessageRow | null;
  if (!row) throw new AgentError(404, "NOT_FOUND", "Not found");
  return row;
}

/** The path from the root to `leafId` (inclusive), oldest first. */
export function pathTo(chatId: string, leafId: string | null): MessageRow[] {
  const path: MessageRow[] = [];
  const seen = new Set<string>();
  let cursor = leafId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const row = db.query("SELECT * FROM chat_messages WHERE id = ? AND chat_id = ?").get(cursor, chatId) as MessageRow | null;
    if (!row) break;
    path.push(row);
    cursor = row.parent_id;
  }
  return path.reverse();
}

const titleFrom = (content: string) => {
  const line = content.replace(/\s+/g, " ").trim();
  return (line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line) || "New chat";
};

/**
 * Inserts a user message under `parentId` (null = a root; an edit passes the edited message's own
 * parent, which makes a sibling) and makes it the active leaf. The first message titles the chat.
 */
export function insertUserMessage(chat: ChatRow, userId: string, content: string, parentId: string | null): MessageRow {
  return db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id = ?").get(chat.id) as { count: number }).count;
    if (count >= AGENT_BOUNDS.messagesPerChat) throw new AgentError(409, "LIMIT_REACHED", `A chat holds at most ${AGENT_BOUNDS.messagesPerChat} messages; start a new one`);
    if (parentId !== null) chatMessage(chat.id, parentId);
    const id = crypto.randomUUID();
    const timestamp = now();
    db.query("INSERT INTO chat_messages (id, chat_id, parent_id, role, content, status, author_id, created_at, finished_at) VALUES (?, ?, ?, 'user', ?, 'complete', ?, ?, ?)")
      .run(id, chat.id, parentId, content, userId, timestamp, timestamp);
    const first = count === 0;
    db.query("UPDATE chats SET active_leaf_id = ?, title = CASE WHEN ? THEN ? ELSE title END, revision = revision + 1, updated_at = ? WHERE id = ?").run(id, first ? 1 : 0, titleFrom(content), timestamp, chat.id);
    const fts = db.query("SELECT title FROM chats WHERE id = ?").get(chat.id) as { title: string };
    db.query("INSERT INTO chat_fts (chat_id, owner_id, title, body) VALUES (?, ?, ?, ?)").run(chat.id, chat.owner_id, first ? fts.title : "", content.slice(0, 4096));
    return chatMessage(chat.id, id);
  })();
}

/** Inserts the streaming assistant placeholder under `parentId` and makes it the active leaf. */
export function insertAssistantPlaceholder(chat: ChatRow, parentId: string, runId: string, model: string): MessageRow {
  return db.transaction(() => {
    const id = crypto.randomUUID();
    const timestamp = now();
    db.query("INSERT INTO chat_messages (id, chat_id, parent_id, role, content, status, model, run_id, created_at) VALUES (?, ?, ?, 'assistant', '', 'streaming', ?, ?, ?)")
      .run(id, chat.id, parentId, model, runId, timestamp);
    db.query("UPDATE chats SET active_leaf_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(id, timestamp, chat.id);
    return chatMessage(chat.id, id);
  })();
}

/** Flushes streamed text (plan §2.3: every second or 2 KiB, and once at the end). */
export function flushAssistantText(messageId: string, content: string) {
  db.query("UPDATE chat_messages SET content = ? WHERE id = ? AND status = 'streaming'").run(content.slice(0, AGENT_BOUNDS.assistantMessageChars), messageId);
}

export const TRUNCATION_MARKER = "\n\n[truncated: the reply was longer than allowed]";

/** The stored form of a reply: cut so that text plus marker fit the bound exactly (QA Q4: the old cut overshot the CHECK). */
export function boundedAssistantText(content: string) {
  if (content.length <= AGENT_BOUNDS.assistantMessageChars) return content;
  return `${content.slice(0, AGENT_BOUNDS.assistantMessageChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/** The stored tool-call list, bounded (AC-B): the newest calls are kept when the list would be too long. */
const toolCallsJson = (calls: readonly ToolCallView[]) => {
  let list = [...calls];
  let json = JSON.stringify(list);
  while (json.length > AGENT_BOUNDS.toolCallsJsonChars && list.length > 1) {
    list = list.slice(1);
    json = JSON.stringify(list);
  }
  return list.length ? json : null;
};

/** Flushes the tool calls made so far (after every call), so a reload shows them. */
export function flushToolCalls(messageId: string, calls: readonly ToolCallView[]) {
  db.query("UPDATE chat_messages SET tool_calls_json = ? WHERE id = ? AND status IN ('streaming','awaiting_confirmation')").run(toolCallsJson(calls), messageId);
}

export function finishAssistantMessage(messageId: string, result: { status: ChatMessage["status"]; content: string; errorCode?: string | null; usage: TokenUsage | null; model: string | null; toolCalls?: readonly ToolCallView[] }) {
  const cut = boundedAssistantText(result.content);
  db.query("UPDATE chat_messages SET content = ?, status = ?, error_code = ?, usage_json = ?, model = COALESCE(?, model), tool_calls_json = COALESCE(?, tool_calls_json), finished_at = ? WHERE id = ?")
    .run(cut, result.status, result.errorCode ?? null, result.usage ? JSON.stringify(result.usage) : null, result.model, result.toolCalls ? toolCallsJson(result.toolCalls) : null, now(), messageId);
}

/**
 * Continue as a copy (Wave 43, AC-D, D361): someone who can read a chat and chat with its agent
 * starts their own chat holding a copy of the branch up to `messageId`. The copy is theirs alone
 * (owner, private, its own ids), remembers only the original owner's name ("Copied from <name>'s
 * chat"), and nothing points back at the original, so its owner sees nothing of it. Copied turns keep
 * their text and tool-call excerpts; a turn still streaming is copied as interrupted; no run carries
 * over. When the recipient sends, the agent runs as them: their budget, their slots, and Nook tools
 * through their own linked key (D359, T311), never the original owner's.
 */
export function forkChat(userId: string, chatId: string, messageId: string): ChatSummary {
  const source = readableChat(chatId, userId);
  if (source.agent_id === null) throw new AgentError(409, "AGENT_GONE", "This chat's agent was deleted; start a new chat with another agent");
  const agentRow = db.query("SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL").get(source.agent_id) as AgentRow | null;
  if (!agentRow) throw new AgentError(409, "AGENT_GONE", "This chat's agent is in the Bin; it cannot be continued now");
  // The agent must be shared with the person too (D361): reading a chat is not using its agent.
  if (shareLevel("agent", agentRow, userId) === "none") throw new AgentError(403, "AGENT_NOT_SHARED", "You can read this chat, but its agent is not shared with you, so you cannot continue it");
  chatMessage(chatId, messageId);
  const path = pathTo(chatId, messageId).filter((row) => row.role === "user" || row.role === "assistant");
  if (path.length === 0) throw new AgentError(400, "INVALID", "That message cannot be continued");
  const ownerName = source.owner_id === userId ? null : (db.query("SELECT display_name FROM users WHERE id = ?").get(source.owner_id) as { display_name: string } | null)?.display_name ?? "a former member";
  return db.transaction(() => {
    const count = (db.query("SELECT COUNT(*) AS count FROM chats WHERE owner_id = ? AND deleted_at IS NULL").get(userId) as { count: number }).count;
    if (count >= AGENT_BOUNDS.chatsPerUser) throw new AgentError(409, "LIMIT_REACHED", `You can have up to ${AGENT_BOUNDS.chatsPerUser} chats`);
    const id = crypto.randomUUID();
    const timestamp = now();
    const title = source.title.slice(0, AGENT_BOUNDS.chatTitle);
    db.query("INSERT INTO chats (id, owner_id, agent_id, title, created_at, updated_at, copied_from_user_id, copied_from_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, agentRow.id, title, timestamp, timestamp, ownerName === null ? null : source.owner_id, ownerName === null ? null : ownerName.slice(0, 120));
    db.query("INSERT INTO chat_fts (chat_id, owner_id, title, body) VALUES (?, ?, ?, '')").run(id, userId, title);
    const insert = db.query(`INSERT INTO chat_messages (id, chat_id, parent_id, role, content, tool_calls_json, status, error_code, model, usage_json, run_id, author_id, created_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`);
    const fts = db.query("INSERT INTO chat_fts (chat_id, owner_id, title, body) VALUES (?, ?, '', ?)");
    let parent: string | null = null;
    for (const row of path) {
      const copy = crypto.randomUUID();
      const status = row.status === "streaming" || row.status === "awaiting_confirmation" ? "interrupted" : row.status;
      insert.run(copy, id, parent, row.role, row.content, row.tool_calls_json, status, row.error_code, row.model, row.usage_json, row.role === "user" ? userId : null, row.created_at, row.finished_at ?? timestamp);
      if (row.role === "user") fts.run(id, userId, row.content.slice(0, 4096));
      parent = copy;
    }
    db.query("UPDATE chats SET active_leaf_id = ? WHERE id = ?").run(parent, id);
    audit(userId, null, "agents.chat.fork", { chatId: id, messages: path.length, ...(source.owner_id !== userId ? { shared: true } : {}) });
    return summaryRows("c.id = $id", { id }, userId)[0]!;
  })();
}
