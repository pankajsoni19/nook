import type { Migration } from "./types";

/**
 * Tool images (chat Markdown and images, D370 as amended, T304): the pictures MCP tools return in a
 * chat (`image` content parts), checked by their bytes (PNG, JPEG, GIF, or WebP; never SVG) and at
 * most 2 MiB each, 4 per call, 12 per run. The tool-call list on the message keeps only their ids,
 * types, and sizes (`ToolCallView.images`).
 *
 * - `chat_image_blobs` holds each picture's bytes once, by SHA-256 (security review M2).
 * - `chat_tool_images` is a reference per chat and message, keyed by the chat so that a chat
 *   continued as a copy gets its own rows (the same image ids, the copy's message ids) pointing at the
 *   same blob; the Bin's purge removes a chat's rows with the chat.
 * - A trigger deletes a blob once its last reference is gone (it fires for cascaded deletes too).
 *
 * Each distinct picture a person's chats reference counts once against their storage quota
 * (server/documents.ts `storedBytes`). Served by `GET /api/chats/:chatId/tool-images/:imageId` to
 * whoever can read the chat (people it is shared with: the active branch only).
 *
 * Needs 039. Transactional and filesystem-free; re-running changes nothing. The Messages plan's
 * migration moves to 045.
 */
export const chatToolImagesMigration: Migration = {
  id: 43,
  name: "chat_tool_images",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_image_blobs (
        sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/gif','image/webp')),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
        bytes BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_tool_images (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES chat_image_blobs(sha256),
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/gif','image/webp')),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, id)
      );
      CREATE INDEX IF NOT EXISTS chat_tool_images_message ON chat_tool_images(message_id);
      CREATE INDEX IF NOT EXISTS chat_tool_images_sha ON chat_tool_images(sha256);
      CREATE TRIGGER IF NOT EXISTS chat_tool_images_release AFTER DELETE ON chat_tool_images
      WHEN NOT EXISTS (SELECT 1 FROM chat_tool_images WHERE sha256 = OLD.sha256)
      BEGIN
        DELETE FROM chat_image_blobs WHERE sha256 = OLD.sha256;
      END;
    `);
  }
};
