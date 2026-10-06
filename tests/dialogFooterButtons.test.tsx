import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { GeneratorDialog } from "../src/vault/VaultDialogs";

const root = join(import.meta.dir, "..", "src");
const css = (path: string) => Bun.file(join(root, path)).text();
/** The declarations of one exact selector in a stylesheet. */
const rule = (sheet: string, selector: string) => {
  const start = sheet.indexOf(`${selector} {`);
  return start === -1 ? null : sheet.slice(start, sheet.indexOf("}", start));
};

describe("dialog footer buttons (2026-10-06)", () => {
  test("the generator's Again and Use this sit in the shared dialog footer", () => {
    const html = renderToStaticMarkup(<GeneratorDialog onCancel={() => undefined} onUse={() => undefined} />);
    const footer = html.slice(html.indexOf("<footer"), html.indexOf("</footer>"));
    expect(footer).toStartWith('<footer class="file-dialog-actions">');
    // Again keeps its icon inside the button, beside the label.
    expect(footer).toMatch(/<button type="button" class="secondary-button"><svg[^>]*>.*<\/svg>Again<\/button>/);
    expect(footer).toContain('<button type="button" class="primary-button">Use this</button>');
  });

  test("the shared footer button class keeps an icon and its label on one 44 px line", async () => {
    const files = await css("files/files.css");
    const button = rule(files, ".file-dialog-actions button");
    expect(button).not.toBeNull();
    for (const declaration of ["display: inline-flex", "align-items: center", "gap: 6px", "white-space: nowrap", "min-height: 44px"]) expect(button).toContain(declaration);
    expect(rule(files, ".file-dialog-actions button svg")).toContain("flex: none");
    // The one-off copies the shared rule replaced are gone.
    const vault = await css("vault/vault.css");
    expect(vault).not.toContain(".vault-settings-actions button { display: inline-flex");
    expect(vault).not.toContain(".vault-import .file-dialog-actions button");
  });

  test("a dialog body scrolls under its header and keeps its footer in view", async () => {
    const files = await css("files/files.css");
    expect(rule(files, ".file-dialog > .file-dialog-form")).toContain("overflow-y: auto");
    const footer = rule(files, ".file-dialog > .file-dialog-form > .file-dialog-actions:last-child");
    expect(footer).toContain("position: sticky");
    expect(footer).toContain("bottom: 0");
    // Checkbox labels read as sentences, not as all-caps field labels.
    expect(files).toContain('.file-dialog-form label:has(> input[type="checkbox"]):not(.vault-check) { color: #d6d6d9; font-size: .86rem; font-weight: 500; letter-spacing: normal; text-transform: none; }');
  });

  test("the AI provider and tool server dialogs use the shared scrolling body (their footers stay reachable)", async () => {
    for (const file of ["chat/AiSettings.tsx", "chat/ToolServers.tsx"]) {
      const source = await Bun.file(join(root, file)).text();
      // A form that is the dialog's direct child, ending in the footer: the shared rule scrolls it and pins the footer.
      expect(source).toMatch(/<ModalDialog [^\n]*>\n    <form className="file-dialog-form ai-provider-form"/);
      expect(source).toMatch(/<footer className="file-dialog-actions">[\s\S]*<\/footer>\n    <\/form>\n  <\/ModalDialog>/);
    }
  });

  test("Vault help icons sit inline, and the settings sheet is wide on a computer", async () => {
    expect(rule(await css("files/files.css"), ".file-dialog-hint > svg:first-child")).toContain("display: inline-block");
    const vault = await css("vault/vault.css");
    expect(rule(vault, ".vault-hint-icon")).toContain("display: inline-block");
    expect(vault).toContain(".vault-dialog.vault-settings { width: min(720px, calc(100vw - 32px)); }");
  });

  test("the empty Chat list explains agents and styles Create an agent as a full-width button", async () => {
    const source = await Bun.file(join(root, "chat", "ChatApp.tsx")).text();
    expect(source).toContain("No agents yet. An agent is a system prompt and a model you chat with.");
    expect(source).toContain('className="secondary-button chat-create-agent" onClick={() => onOpenAgents("new")}><Bot />Create an agent</button>');
    expect(source).toContain('status?.hasProvider === false');
    expect(source).toContain('href="/settings/ai"');
    const chat = await css("chat/chat.css");
    const button = rule(chat, ".chat-create-agent");
    for (const declaration of ["width: 100%", "min-height: 44px", "display: inline-flex", "white-space: nowrap"]) expect(button).toContain(declaration);
    expect(rule(chat, ".chat-list-foot")).toContain("flex-wrap: wrap");
  });
});
