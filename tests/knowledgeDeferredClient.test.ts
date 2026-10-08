import { describe, expect, test } from "bun:test";
import { previewRange } from "../src/chat/knowledgeApi";
import { deleteGroupMessage, KIND_LABELS } from "../src/team/groupsApi";
import { MODEL_CHANGE_EFFECT, takesDimensions } from "../shared/knowledge";

/** The AC-E deferred items' client pieces (2026-10-08): the preview count, Change embedding model's words, and the group page's kinds. */
describe("knowledge deferred, client", () => {
  test("the preview count line", () => {
    expect(previewRange({ offset: 0, total: 0 }, 0)).toBe("No chunks");
    expect(previewRange({ offset: 0, total: 57 }, 20)).toBe("Chunks 1–20 of 57");
    expect(previewRange({ offset: 0, total: 7 }, 7)).toBe("Chunks 1–7 of 7");
  });

  test("Change embedding model says what it costs, and which models take a size", () => {
    expect(MODEL_CHANGE_EFFECT).toContain("embedded again");
    expect(MODEL_CHANGE_EFFECT).toContain("your token cost");
    expect(MODEL_CHANGE_EFFECT).toContain("keywords only");
    expect(MODEL_CHANGE_EFFECT).toContain("old vectors are deleted");
    expect(takesDimensions("text-embedding-3-large")).toBe(true);
    expect(takesDimensions("nomic-embed-text")).toBe(false);
  });

  test("the group page names agents, chats, and knowledge bases", () => {
    expect(KIND_LABELS.knowledge_base).toBe("Knowledge base");
    expect(KIND_LABELS.agent).toBe("Agent");
    expect(KIND_LABELS.chat).toBe("Chat");
    expect(deleteGroupMessage(2, 1)).toContain("1 item");
  });
});
