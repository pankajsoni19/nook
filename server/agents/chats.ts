import { audit, db, now } from "../db";
import { purgeAfterFrom } from "../bin";
import { AGENT_BOUNDS, type ChatDetail, type ChatMessage, type ChatSummary, type TokenUsage } from "../../shared/agents";
import { usableAgent, type AgentRow } from "./agentsService";
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

export const messageOf = (row: MessageRow): ChatMessage => ({
  id: row.id, parentId: row.parent_id, role: row.role, content: row.content, status: row.status, errorCode: row.error_code, model: row.model,
  usage: parseUsage(row.usage_json), runId: row.run_id, createdAt: row.created_at, finishedAt: row.finished_at
});

const LIVE_RUN = "SELECT 1 FROM agent_runs r WHERE r.chat_id = c.id AND r.status IN ('queued','running','awaiting_confirmation')";

function summaryRows(where: string, params: Record<string, string>): ChatSummary[] {
  // LEFT JOIN: a purged agent leaves agent_id NULL and the chat stays listed (review M2).
  const rows = db.query(`SELECT c.*, a.name AS agent_name, a.icon AS agent_icon, EXISTS (${LIVE_RUN}) AS running FROM chats c LEFT JOIN agents a ON a.id = c.agent_id WHERE ${where}`).all(params) as Array<ChatRow & { agent_name: string | null; agent_icon: string | null; running: number }>;
  return rows.map((row) => ({
    id: row.id, agentId: row.agent_id, agentName: row.agent_name, agentIcon: row.agent_icon, title: row.title, pinned: row.pinned === 1, activeLeafId: row.active_leaf_id,
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, running: row.running === 1
  }));
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
    return summaryRows(`c.owner_id = $userId AND c.deleted_at IS NULL AND c.id IN (${marks}) ORDER BY c.pinned DESC, c.updated_at DESC LIMIT ${limit}`, { userId, ...Object.fromEntries(ids.map((id, index) => [`id${index}`, id])) });
  }
  return summaryRows(`c.owner_id = $userId AND c.deleted_at IS NULL ORDER BY c.pinned DESC, c.updated_at DESC LIMIT ${limit}`, { userId });
}

/** The owner's live chat, or the 404 (missing, binned, and someone else's are the same). */
export function ownedChat(id: string, userId: string): ChatRow {
  const row = db.query("SELECT * FROM chats WHERE id = ? AND deleted_at IS NULL").get(id) as ChatRow | null;
  if (!row || row.owner_id !== userId) throw new AgentError(404, "NOT_FOUND", "Not found");
  return row;
}

export function chatDetail(id: string, userId: string): ChatDetail {
  const chat = summaryRows("c.id = $id AND c.owner_id = $userId AND c.deleted_at IS NULL", { id, userId })[0];
  if (!chat) throw new AgentError(404, "NOT_FOUND", "Not found");
  const rows = db.query("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at, rowid").all(id) as MessageRow[];
  const run = db.query("SELECT id FROM agent_runs WHERE chat_id = ? AND status IN ('queued','running','awaiting_confirmation') ORDER BY queued_at DESC LIMIT 1").get(id) as { id: string } | null;
  return { chat, messages: rows.map(messageOf), activeRunId: run?.id ?? null };
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
    return summaryRows("c.id = $id", { id })[0]!;
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
    return summaryRows("c.id = $id", { id })[0]!;
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

export function finishAssistantMessage(messageId: string, result: { status: ChatMessage["status"]; content: string; errorCode?: string | null; usage: TokenUsage | null; model: string | null }) {
  const cut = boundedAssistantText(result.content);
  db.query("UPDATE chat_messages SET content = ?, status = ?, error_code = ?, usage_json = ?, model = COALESCE(?, model), finished_at = ? WHERE id = ?")
    .run(cut, result.status, result.errorCode ?? null, result.usage ? JSON.stringify(result.usage) : null, result.model, now(), messageId);
}
