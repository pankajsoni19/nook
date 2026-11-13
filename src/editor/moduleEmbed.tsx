import { Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useDisabledModules } from "../modules";
import "../ui/workspace.css";
import type { EmbedKind } from "../../shared/embeds";
import { embedKind, embedKindForPath, embedWord, isEmbedKind, MODULE_EMBED_TITLE, moduleEmbedMarkdown } from "./moduleEmbedRegistry";

/**
 * The generic module embed node (D835, §B.4.4): `[Poll](/forms/<slug>-<shortid> "nook-embed")` alone
 * in its paragraph becomes the live card its kind registered (registerEmbedKind). Like the whiteboard
 * card (D208), the Markdown keeps only the path and the neutral word, so published versions, MCP, and
 * search never carry the item's title (T513), and the card asks the server as the reader.
 */

// An in-app path: letters, digits, dashes, underscores, dots, and slashes; never a scheme or a host.
const PATH = "/[A-Za-z0-9][A-Za-z0-9/_.-]{0,300}";
const lineAt = new RegExp(`^\\[((?:[^\\]\\\\\\n]|\\\\.){0,40})\\]\\((${PATH}) "${MODULE_EMBED_TITLE}"\\)[ \\t]*(?:\\n+|$)`);
const lineAnywhere = new RegExp(`^\\[(?:[^\\]\\\\\\n]|\\\\.){0,40}\\]\\(${PATH} "${MODULE_EMBED_TITLE}"\\)[ \\t]*$`, "m");

/** Parses one embed line a registered kind claims (pure; exported for tests). */
export function parseModuleEmbedLine(src: string): { raw: string; path: string; kind: string } | null {
  const match = lineAt.exec(src);
  if (!match) return null;
  const path = match[2]!;
  if (path.includes("//") || path.includes("/../")) return null;
  const kind = embedKindForPath(path, match[1]!.replace(/\\(.)/g, "$1"));
  return kind ? { raw: match[0], path, kind: kind.kind } : null;
}

function ModuleEmbedView({ node, selected, editor }: NodeViewProps) {
  const disabled = useDisabledModules();
  const def = embedKind(String(node.attrs.kind ?? ""));
  const path = String(node.attrs.path ?? "");
  const off = !def || (def.module !== undefined && disabled.includes(def.module as never));
  const Card = def?.component;
  return <NodeViewWrapper className={`module-embed${selected ? " is-selected" : ""}`} data-module-embed="">
    <div contentEditable={false}>
      {off || !Card
        ? <p className="module-embed-off">{def ? embedWord(def.kind) : "Item"} · this module is turned off. <a href={path}>Open link</a></p>
        : <Card path={path} kind={def.kind} selected={selected} editable={editor.isEditable} />}
    </div>
  </NodeViewWrapper>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    moduleEmbed: {
      /** Inserts a module embed (a poll, a form, a goal) at the selection. */
      insertModuleEmbed: (attrs: { kind: EmbedKind; path: string }) => ReturnType;
    };
  }
}

export const ModuleEmbed = Node.create({
  name: "moduleEmbed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: null, parseHTML: (element) => element.getAttribute("data-kind"), renderHTML: (attrs) => ({ "data-kind": attrs.kind }) },
      path: { default: null, parseHTML: (element) => element.getAttribute("data-path"), renderHTML: (attrs) => ({ "data-path": attrs.path }) }
    };
  },
  parseHTML() {
    return [{ tag: "div[data-module-embed]", getAttrs: (element) => {
      const path = (element as HTMLElement).getAttribute("data-path") ?? "";
      return new RegExp(`^${PATH}$`).test(path) && embedKindForPath(path) ? null : false;
    } }];
  },
  renderHTML({ HTMLAttributes, node }) {
    // Copied HTML carries the neutral word only (T513).
    const kind = String(node.attrs.kind ?? "");
    return ["div", { ...HTMLAttributes, "data-module-embed": "", class: "module-embed" }, isEmbedKind(kind) ? embedWord(kind) : "Item"];
  },
  markdownTokenizer: {
    name: "moduleEmbed",
    level: "block",
    start: (src: string) => src.search(lineAnywhere),
    tokenize: (src: string) => {
      const parsed = parseModuleEmbedLine(src);
      return parsed ? { type: "moduleEmbed", raw: parsed.raw, path: parsed.path, kind: parsed.kind } : undefined;
    }
  },
  parseMarkdown: (token, helpers) => helpers.createNode("moduleEmbed", { path: (token as { path?: string }).path, kind: (token as { kind?: string }).kind }),
  renderMarkdown: (node) => typeof node.attrs?.path === "string" && isEmbedKind(node.attrs?.kind) ? moduleEmbedMarkdown(node.attrs.kind, node.attrs.path) : "",
  addCommands() {
    return {
      insertModuleEmbed: (attrs) => ({ commands }) => commands.insertContent({ type: this.name, attrs })
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ModuleEmbedView);
  }
});
