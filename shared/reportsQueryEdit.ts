/**
 * Lane EDIT (D525–D531): editing a saved query from Inspect → Query. The owner previews and saves the
 * new SQL (a manual edit, a new version); a person at the comment level previews it and suggests it to
 * the owner (an instruction whose proposal is their SQL, applied or rejected in Changes). Pure: no
 * server or client imports.
 */
import type { QueryOutcome } from "./reports";

export const QUERY_EDIT_LIMITS = {
  /** Previews a person may run in a minute (each runs one guarded SELECT). */
  previewsPerMinute: 20,
  /** Suggestions a person may send in an hour (each re-checks the whole report: every query runs). */
  suggestionsPerHour: 10,
  /** A suggestion's note to the owner, in characters. */
  note: 500
} as const;

/** One block that reads the query, and the columns it maps that the preview's result lacks. */
export type PreviewBlockCheck = { blockId: string; title: string; missing: string[] };

/** POST /api/reports/:id/queries/:key/preview: the new SQL's result, and whether the blocks still fit it. */
export type QueryEditPreview = {
  queryKey: string;
  outcome: QueryOutcome;
  /** The blocks that read this query (their own query, a KPI's compare, or a sparkline). */
  blocks: PreviewBlockCheck[];
  /** Column problems as Save and Suggest would report them (empty: every mapped column is there). */
  problems: string[];
};
