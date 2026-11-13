import type { ComponentType } from "react";
import type { Editor, Range } from "@tiptap/core";

/**
 * Module embeds and slash items (docs/plan/WORKSPACE_MODULES.md §B.4.4, D835). A leaf (types only),
 * so module files register without importing the editor.
 *
 * An embed is one Markdown line, a link alone in its paragraph whose title is the marker:
 * `[Poll](/forms/team-lunch-4k2m9x0a1b "nook-embed")`. The link text is always the kind's neutral
 * word (QA H1, T513): readers of the note never learn a title they cannot open. A line whose path no
 * registered kind claims (a module that is off, not ready, or not installed) stays an ordinary link.
 */
export const MODULE_EMBED_TITLE = "nook-embed";

export type EmbedCardProps = {
  /** The in-app path of the embedded item (`/forms/team-lunch-4k2m9x0a1b`). */
  path: string;
  kind: string;
  /** The node is selected in an editable note. */
  selected: boolean;
  /** The note is being edited (cards show no voting controls while editing, only a preview). */
  editable: boolean;
};

export type EmbedKindDef = {
  /** "poll", "form", "goal", "booking_type", "time_poll". */
  kind: string;
  /** The neutral link text: "Poll", "Form", "Goal", "Booking link". */
  word: string;
  /** Claims an in-app path (`/forms/…`) for this kind. */
  match: (path: string) => boolean;
  /** The live card, fetched as the reader (render EmbedCard from src/ui/embeds). */
  component: ComponentType<EmbedCardProps>;
  module?: string;
};

export type SlashItemDef = {
  label: string;
  hint: string;
  keywords: string;
  run: (editor: Editor, range: Range) => void;
  /** Offered only when the editor has this command (a picker the host provides). */
  requires?: string;
  module?: string;
};

const kinds: EmbedKindDef[] = [];
const slashItems: SlashItemDef[] = [];

export function registerEmbedKind(def: EmbedKindDef) {
  const at = kinds.findIndex((item) => item.kind === def.kind);
  if (at >= 0) kinds.splice(at, 1, def);
  else kinds.push(def);
}

export function registerSlashItem(def: SlashItemDef) {
  const at = slashItems.findIndex((item) => item.label === def.label);
  if (at >= 0) slashItems.splice(at, 1, def);
  else slashItems.push(def);
}

/** The kind that claims a path, or null. */
export const embedKindForPath = (path: string): EmbedKindDef | null => kinds.find((kind) => kind.match(path)) ?? null;
export const embedKind = (kind: string): EmbedKindDef | null => kinds.find((item) => item.kind === kind) ?? null;
export const registeredSlashItems = (): readonly SlashItemDef[] => slashItems;

/** The Markdown line for one embed: the kind's neutral word, never the item's title. */
export function moduleEmbedMarkdown(kind: string, path: string) {
  const def = embedKind(kind);
  return `[${def?.word ?? "Item"}](${path} "${MODULE_EMBED_TITLE}")`;
}

/** Tests: drop every registration. */
export function clearModuleEmbedsForTests() {
  kinds.length = 0;
  slashItems.length = 0;
}
