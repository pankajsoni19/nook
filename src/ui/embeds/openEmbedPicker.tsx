import { lazy, Suspense, type ComponentProps } from "react";
import type { PickItem } from "./EmbedPicker";

/**
 * Opens the `/` embed picker (src/ui/embeds/EmbedPicker.tsx, D1059) on its own root. The dialog and
 * react-dom/client load on first use, so module files that register slash items stay light and bind
 * nothing before a test's DOM exists (the Forms slash pattern).
 */
const Dialog = lazy(() => import("./EmbedPicker"));
type DialogProps = ComponentProps<typeof Dialog>;

export type { PickItem };

export function openEmbedPicker(props: Omit<DialogProps, "onClose" | "onPick">, onPick: (item: PickItem) => void) {
  void import("react-dom/client").then(({ createRoot }) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const close = () => { root.unmount(); host.remove(); };
    root.render(<Suspense fallback={null}><Dialog {...props} onClose={close} onPick={(item) => { close(); onPick(item); }} /></Suspense>);
  });
}

type EmbedChain = { focus: () => { deleteRange: (range: unknown) => { insertModuleEmbed: (attrs: { kind: string; path: string }) => { run: () => void } } } };

/** Replaces the slash range with a module embed (the editor's `insertModuleEmbed` command, D835). */
export function insertEmbedAt(editor: { chain: () => unknown }, range: unknown, kind: string, path: string) {
  (editor.chain() as EmbedChain).focus().deleteRange(range).insertModuleEmbed({ kind, path }).run();
}
