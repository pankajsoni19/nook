import type { Migration } from "./types";

/**
 * Tool images (chat Markdown and images, D370 as amended, T304): the pictures MCP tools return in a
 * chat (`image` content parts), checked by their bytes (PNG, JPEG, GIF, or WebP; never SVG) and at
 * most 2 MiB each, 4 per call, 12 per run. The tool-call list on the message keeps only their ids,
 * types, and sizes (`ToolCallView.images`); the bytes live here, keyed by the chat so that a chat
 * continued as a copy keeps its own rows (the ids stay the same) and the Bin's purge removes them
 * with the chat. Served by `GET /api/chats/:chatId/tool-images/:imageId` to whoever can read the chat.
 *
 * Needs 039. Transactional and filesystem-free; re-running changes nothing. The Messages plan's
 * migration moves to 044.
 */
export const chatToolImagesMigration: Migration = {
  id: 43,
  name: "chat_tool_images",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_tool_images (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/gif','image/webp')),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
        bytes BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, id)
      );
      CREATE INDEX IF NOT EXISTS chat_tool_images_message ON chat_tool_images(message_id);
    `);
  }
};
