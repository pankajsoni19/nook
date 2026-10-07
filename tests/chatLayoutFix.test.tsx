import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "src");
const read = (path: string) => Bun.file(join(root, path)).text();
/** The declarations of one exact selector in a stylesheet (the last rule with it, as the cascade does). */
const rule = (sheet: string, selector: string) => {
  const start = sheet.lastIndexOf(`${selector} {`);
  return start === -1 ? null : sheet.slice(start, sheet.indexOf("}", start));
};
/** The body of the last `@media (…)` block with this exact query. */
const media = (sheet: string, query: string) => {
  const start = sheet.lastIndexOf(`@media (${query}) {`);
  if (start === -1) return "";
  let depth = 0;
  for (let index = sheet.indexOf("{", start); index < sheet.length; index += 1) {
    if (sheet[index] === "{") depth += 1;
    if (sheet[index] === "}" && --depth === 0) return sheet.slice(start, index + 1);
  }
  return "";
};

describe("Chat layout fix", () => {
  test("a new chat's composer ends the pane: the empty state takes the free space, centred", async () => {
    const chat = await read("chat/chat.css");
    const empty = rule(chat, ".chat-app .chat-thread > .chat-empty");
    expect(empty).not.toBeNull();
    expect(empty).toContain("flex: 1 0 auto");
    expect(empty).toContain("align-content: center");
    // The thread itself fills the pane, and the empty state and composer are its children in that order.
    expect(chat).toContain("\n.chat-thread { display: flex; flex-direction: column; flex: 1 1 auto;");
    const app = await read("chat/ChatApp.tsx");
    expect(app).toMatch(/route\.newChat \? <div className="chat-thread">[\s\S]*?<div className="chat-empty">[\s\S]*?\{composer\}/);
    // Short threads keep their rows at their own height instead of stretching to fill.
    expect(rule(chat, ".chat-app .chat-messages")).toContain("align-content: start");
  });

  test("on a computer the pane runs to the window's edge and keeps its gutters as padding", async () => {
    const desktop = media(await read("chat/chat.css"), "min-width: 761px");
    expect(rule(desktop, ".chat-app .chat-layout")).toContain("padding-right: 0");
    const pane = rule(desktop, ".chat-app .chat-layout > .chat-pane");
    expect(pane).not.toBeNull();
    for (const declaration of ["margin-left: 0", "margin-right: 0", "padding-left: var(--chat-gutter-start)", "padding-right: var(--chat-gutter-end)", "--chat-gutter-end: clamp(16px, 4vw, 40px)"]) expect(pane).toContain(declaration);
    // The list stops at its border instead of reaching under the chat pane.
    expect(rule(desktop, ".chat-app .chat-layout > .chat-list-pane")).toContain("margin-right: 0");
    // The header and composer bands span the pane; their content keeps the gutters.
    const bands = rule(desktop, ".chat-app .chat-pane .chat-thread-header, .chat-app .chat-pane .chat-composer");
    for (const declaration of ["margin-left: calc(-1 * var(--chat-gutter-start))", "margin-right: calc(-1 * var(--chat-gutter-end))", "padding-left: var(--chat-gutter-start)", "padding-right: var(--chat-gutter-end)"]) expect(bands).toContain(declaration);
    // Nothing under the composer: the pane drops its bottom padding when it has one.
    expect(rule(desktop, ".chat-app .chat-layout > .chat-pane:has(> .chat-thread > .chat-composer)")).toContain("padding-bottom: 0");
  });

  test("on a phone the open chat fills the page under its header, edge to edge", async () => {
    const phone = media(await read("chat/chat.css"), "max-width: 760px");
    expect(rule(phone, ".chat-app.chat-detail-open")).toContain("flex-direction: column");
    expect(rule(phone, ".chat-app.chat-detail-open > .chat-layout")).toContain("flex: 1 0 auto");
    expect(rule(phone, ".chat-app.chat-detail-open .chat-pane")).toContain("flex: 1 0 auto");
    const bands = rule(phone, ".chat-app .chat-pane .chat-thread-header, .chat-app .chat-pane .chat-composer");
    for (const declaration of ["margin-left: -16px", "margin-right: -16px", "padding-left: 16px", "padding-right: 16px"]) expect(bands).toContain(declaration);
    // The page is the 100dvh scroller the sticky composer pins to.
    expect(await read("appShell.css")).toContain(".app-page:not(.tasks-app):not(.collections-app) { height: 100dvh; overflow-y: auto;");
  });
});
