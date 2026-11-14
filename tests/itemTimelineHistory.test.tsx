import { describe, expect, test } from "bun:test";
import { installDom, mockApi, render } from "./support/dom";
import { ItemTimeline } from "../src/ui/activity/ItemTimeline";

/**
 * Contacts' record pages show their history once (D988): the comments panel under the record timeline
 * takes `history={false}`, so it shows comments only, with no Activity switch and no history read.
 */
installDom("http://nook.test/contacts/deals/quote-abc");

const comment = { id: "c1", parentId: null, authorId: "u1", authorName: "Olive Owner", authorAvatarUrl: null, body: "Call them Monday", createdAt: "2026-11-14T10:00:00Z", updatedAt: "2026-11-14T10:00:00Z", deleted: false, canEdit: true };
const entry = { id: "a1", kind: "created", actorId: "u1", actorName: "Olive Owner", via: null, payload: { to: { label: "Quote: Bo Buyer" } }, createdAt: "2026-11-14T09:00:00Z" };

describe("ItemTimeline without history (D988)", () => {
  test("comments only: no Activity switch, no history request", async () => {
    try { localStorage.setItem("nook.itemTimeline", JSON.stringify({ showActivity: true, order: "asc" })); } catch { /* ignore */ }
    const api = mockApi({
      "GET /items/deal/d1/comments": () => ({ comments: [comment], nextCursor: null }),
      "GET /items/deal/d1/activity?order=desc": () => ({ entries: [entry], nextCursor: null })
    });
    const view = await render(<ItemTimeline kind="deal" id="d1" canComment history={false} />);
    await view.waitFor(() => view.container.textContent?.includes("Call them Monday"));
    expect(view.container.querySelector('[role="switch"]')).toBeNull();
    expect(view.container.textContent).not.toContain("created this");
    expect(api.calls.some((call) => call.path.startsWith("/items/deal/d1/activity"))).toBe(false);
  });

  test("with history (the default) the switch is there and the history is read", async () => {
    const api = mockApi({
      "GET /items/goal/g1/comments": () => ({ comments: [comment], nextCursor: null }),
      "GET /items/goal/g1/activity?order=desc": () => ({ entries: [entry], nextCursor: null })
    });
    const view = await render(<ItemTimeline kind="goal" id="g1" canComment />);
    await view.waitFor(() => view.container.textContent?.includes("Call them Monday"));
    expect(view.container.querySelector('[role="switch"]')).not.toBeNull();
    expect(api.calls.some((call) => call.path.startsWith("/items/goal/g1/activity"))).toBe(true);
  });
});
