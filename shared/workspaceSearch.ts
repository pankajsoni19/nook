/**
 * Search across modules (§B.12): `GET /api/search?scope=all&q=` fans out to every scope the caller
 * has (built-in: notes, files, whiteboards, collections, reports; plus each registered module scope)
 * and returns the top results per scope under its header. A module scope's own query is
 * `GET /api/search?scope=<scope>&q=`.
 */
import type { WorkKind } from "./workRefs";

/** One result of a registered module scope. Titles and snippets are plain text with optional highlight ranges. */
export type ModuleSearchResult = {
  kind: WorkKind;
  id: string;
  title: string;
  snippet?: string;
  /** Relative in-app path. */
  href: string;
  updatedAt?: string;
};

export type SearchSection = {
  scope: string;
  label: string;
  /** Built-in scopes keep their own result shapes (as `scope=notes` etc. return them); module scopes use ModuleSearchResult. */
  results: unknown[];
  truncated: boolean;
  error?: string;
};

export type AllSearchResponse = { sections: SearchSection[] };
export const ALL_SEARCH_PER_SCOPE = 5;
