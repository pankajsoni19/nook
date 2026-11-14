import type { ComponentType } from "react";
import type { Editor, Range } from "@tiptap/core";
import { EMBED_KINDS, EMBED_TITLE, EMBED_WORDS, EMBED_WORK_KIND, embedMarkdown, type EmbedKind } from "../../shared/embeds";
import { parseWorkRef } from "../../shared/workRefs";

/**
 * Module embeds and slash items (docs/plan/WORKSPACE_MODULES.md §B.4.4, D835). A leaf (types only),
 * so module files register without importing the editor.
 *
 * An embed is one Markdown line, a link alone in its paragraph whose title is the marker:
 * `[Poll](/forms/team-lunch-4k2m9x0a1b "nook-embed")`. The link text is always the kind's neutral
 * word (QA H1, T513): readers of the note never learn a title they cannot open. A line whose path no
 * registered kind claims (a module that is off, not ready, or not installed) stays an ordinary link.
 */
export const MODULE_EMBED_TITLE = EMBED_TITLE;

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
  /** shared/embeds.ts EMBED_KINDS; its neutral word (EMBED_WORDS) is the link text: "Poll", "Goal". */
  kind: EmbedKind;
  /** Claims an in-app path (`/forms/…`) for this kind; by default any path of the kind's work kind (shared/embeds.ts EMBED_WORK_KIND). */
  match?: (path: string) => boolean;
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

/** One module owns each embed kind and slash label; the same module registering again replaces its own (tests, hot reload). */
const ownedByAnother = (existing: { module?: string } | undefined, def: { module?: string }) => Boolean(existing?.module && def.module && existing.module !== def.module);

export function registerEmbedKind(def: EmbedKindDef) {
  const at = kinds.findIndex((item) => item.kind === def.kind);
  if (ownedByAnother(kinds[at], def)) throw new Error(`Embed kind ${def.kind} is already registered by ${kinds[at]!.module}`);
  if (at >= 0) kinds.splice(at, 1, def);
  else kinds.push(def);
}

export function registerSlashItem(def: SlashItemDef) {
  const at = slashItems.findIndex((item) => item.label === def.label);
  if (ownedByAnother(slashItems[at], def)) throw new Error(`Slash item ${def.label} is already registered by ${slashItems[at]!.module}`);
  if (at >= 0) slashItems.splice(at, 1, def);
  else slashItems.push(def);
}

const claims = (def: EmbedKindDef, path: string) => def.match ? def.match(path) : parseWorkRef(path)?.kind === EMBED_WORK_KIND[def.kind];
const WORD_KINDS = new Map(Object.entries(EMBED_WORDS).map(([kind, word]) => [word, kind as EmbedKind]));

/**
 * The registered kind an embed line names: by its neutral word when it is one ("Poll" and "Form" share
 * the form paths), else (a title typed into the text) the first registered kind that claims the path.
 * Null when no registered kind claims it: the line stays an ordinary link.
 */
export function embedKindForPath(path: string, word?: string): EmbedKindDef | null {
  const named = word !== undefined ? WORD_KINDS.get(word.trim()) : undefined;
  if (named) {
    const def = kinds.find((item) => item.kind === named);
    return def && claims(def, path) ? def : null;
  }
  return kinds.find((item) => claims(item, path)) ?? null;
}
export const embedKind = (kind: string): EmbedKindDef | null => kinds.find((item) => item.kind === kind) ?? null;
export const registeredSlashItems = (): readonly SlashItemDef[] => slashItems;

/** The Markdown line for one embed: the kind's neutral word, never the item's title (shared/embeds.ts). */
export const moduleEmbedMarkdown = (kind: EmbedKind, path: string) => embedMarkdown(kind, path);
export const embedWord = (kind: EmbedKind) => EMBED_WORDS[kind];

/** Tests: drop every registration. */
export function clearModuleEmbedsForTests() {
  kinds.length = 0;
  slashItems.length = 0;
}

export const isEmbedKind = (value: unknown): value is EmbedKind => typeof value === "string" && (EMBED_KINDS as readonly string[]).includes(value);
