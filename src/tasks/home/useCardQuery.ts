import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api";
import { taskErrorCode, taskErrorMessage } from "../tasksApi";
import type { LaneMode } from "../../../shared/taskLanes";
import { queryTaskCards, viewCards, type QueriedCard, type QueryLanes, type QueryPage, type QueryRefs, type QueryRequest } from "./homeApi";

/** Where results come from: an ad hoc grammar query, or a saved view run as the viewer. */
export type CardSource =
  | { kind: "query"; request: Omit<QueryRequest, "cursor" | "limit"> }
  | { kind: "view"; viewId: string; tz: string; lanes?: LaneMode };

export const PAGE_SIZE = 50;
/** The board layout (lanes, D643) loads 200 cards a page. */
export const LANES_PAGE_SIZE = 200;

const pageSize = (source: CardSource) => (source.kind === "view" ? source.lanes : source.request.lanes) ? LANES_PAGE_SIZE : PAGE_SIZE;

export type CardQueryState = {
  cards: QueriedCard[];
  nextCursor: string | null;
  total?: number;
  refs?: QueryRefs;
  status: "idle" | "loading" | "ready" | "error";
  loadingMore: boolean;
  error: string | null;
  /** The server's code for a refused query (FILTER_INVALID, RATE_LIMITED, …). */
  errorCode?: string;
  /** With lanes: the lanes of the whole match and their true counts (first page). */
  lanes?: QueryLanes;
};

const idle: CardQueryState = { cards: [], nextCursor: null, status: "idle", loadingMore: false, error: null };

// Results of recently shown queries, so Back from a card returns to the same loaded pages ("Load
// more" included) instead of starting over. Five entries, two minutes each; per tab, never stored.
const CACHE_LIMIT = 5;
const CACHE_MS = 120_000;
const cache = new Map<string, { at: number; state: CardQueryState }>();

export const sourceKey = (source: CardSource | null) => source ? JSON.stringify(source) : "";

function remember(key: string, state: CardQueryState) {
  if (!key || state.status !== "ready") return;
  cache.delete(key);
  cache.set(key, { at: Date.now(), state });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

function cached(key: string) {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_MS) return null;
  return hit.state;
}

/** Test hook. */
export function clearCardQueryCache() {
  cache.clear();
}

function fetchPage(source: CardSource, cursor: string | undefined, signal: AbortSignal, limit = pageSize(source)): Promise<QueryPage> {
  if (source.kind === "view") return viewCards(source.viewId, { cursor, limit, tz: source.tz, ...(source.lanes ? { lanes: source.lanes } : {}) }, signal);
  return queryTaskCards({ ...source.request, limit, ...(cursor ? { cursor } : {}) }, signal);
}

/** The most a refresh asks for at once: the server's page cap with lanes (200) or without (100). */
const refreshCap = (source: CardSource) => (source.kind === "view" ? source.lanes : source.request.lanes) ? LANES_PAGE_SIZE : 100;

const lanesOf = (page: QueryPage) => page.columns && page.laneCounts && page.lanes
  ? { lanes: page.lanes, columns: page.columns, laneCounts: page.laneCounts, ...(page.laneBoards ? { laneBoards: page.laneBoards } : {}), ...(page.lanesFallback ? { lanesFallback: true as const } : {}) }
  : undefined;

function failure(reason: unknown): Pick<CardQueryState, "error" | "errorCode"> {
  const code = taskErrorCode(reason);
  if (reason instanceof ApiError && reason.status === 429) return { error: "Too many searches in a row. Wait a few seconds, then try again.", errorCode: "RATE_LIMITED" };
  return { error: taskErrorMessage(reason, "Could not load the cards"), errorCode: typeof code === "string" ? code : undefined };
}

/**
 * Runs a cross-board query with keyset pages: the first page on every source change, then "Load
 * more" with the signed cursor. `null` runs nothing (a view without a selective filter, Q11).
 */
export function useCardQuery(source: CardSource | null) {
  const key = sourceKey(source);
  const [state, setState] = useState<CardQueryState>(() => (key && cached(key)) || idle);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const keyRef = useRef(key);
  keyRef.current = key;
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const current = sourceRef.current;
    if (!current) {
      setState(idle);
      return;
    }
    const hit = reload === 0 ? cached(key) : null;
    // A remembered result shows at once. With more than one page loaded it stays as it was (so the
    // pages Load more fetched are kept); a single page is refreshed quietly behind it.
    if (hit) {
      setState(hit);
      if (hit.cards.length > pageSize(current)) return;
    }
    const controller = new AbortController();
    if (!hit) setState({ ...idle, status: "loading" });
    fetchPage(current, undefined, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      const lanes = lanesOf(page);
      const next: CardQueryState = { cards: page.cards, nextCursor: page.nextCursor, total: page.total, refs: page.refs, status: "ready", loadingMore: false, error: null, ...(lanes ? { lanes } : {}) };
      remember(key, next);
      setState(next);
    }, (reason) => {
      if (controller.signal.aborted) return;
      setState({ ...idle, status: "error", ...failure(reason) });
    });
    return () => controller.abort();
  }, [key, reload]);

  const loadMore = useCallback(async () => {
    const current = sourceRef.current;
    const startKey = keyRef.current;
    const cursor = stateRef.current.loadingMore ? null : stateRef.current.nextCursor;
    if (!current || !cursor) return;
    stateRef.current = { ...stateRef.current, loadingMore: true };
    setState((previous) => ({ ...previous, loadingMore: true, error: null }));
    try {
      const page = await fetchPage(current, cursor, new AbortController().signal);
      if (keyRef.current !== startKey) return;
      setState((previous) => {
        const seen = new Set(previous.cards.map((card) => card.id));
        const next: CardQueryState = { ...previous, cards: [...previous.cards, ...page.cards.filter((card) => !seen.has(card.id))], nextCursor: page.nextCursor, loadingMore: false };
        remember(startKey, next);
        return next;
      });
    } catch (reason) {
      if (keyRef.current !== startKey) return;
      setState((previous) => ({ ...previous, loadingMore: false, ...failure(reason) }));
    }
  }, []);

  /** Replaces one loaded card (after a move), keeping its place. */
  const patchCard = useCallback((cardId: string, change: Partial<QueriedCard>) => {
    setState((previous) => {
      const next = { ...previous, cards: previous.cards.map((card) => card.id === cardId ? { ...card, ...change } : card) };
      remember(keyRef.current, next);
      return next;
    });
  }, []);

  /** Replaces the whole loaded state (a lane move: the card, the lane counts, and the columns' counts). */
  const update = useCallback((change: (state: CardQueryState) => CardQueryState) => {
    setState((previous) => {
      const next = change(previous);
      remember(keyRef.current, next);
      return next;
    });
  }, []);

  const retry = useCallback(() => setReload((value) => value + 1), []);

  /**
   * Fetches the first page again behind what is on screen (lane VIEWS2, D652): as many cards as are
   * loaded (up to the page cap), so a failed lane move shows the server's truth, including changes
   * that landed meanwhile, without a loading state. A failure keeps the screen and says so.
   */
  const refresh = useCallback(async () => {
    const current = sourceRef.current;
    const startKey = keyRef.current;
    if (!current) return;
    const limit = Math.min(Math.max(stateRef.current.cards.length, pageSize(current)), refreshCap(current));
    try {
      const page = await fetchPage(current, undefined, new AbortController().signal, limit);
      if (keyRef.current !== startKey) return;
      const lanes = lanesOf(page);
      setState((previous) => {
        const next: CardQueryState = { ...previous, cards: page.cards, nextCursor: page.nextCursor, total: page.total, refs: page.refs ?? previous.refs, status: "ready", error: null, ...(lanes ? { lanes } : {}) };
        remember(startKey, next);
        return next;
      });
    } catch (reason) {
      if (keyRef.current !== startKey) return;
      setState((previous) => ({ ...previous, ...failure(reason) }));
    }
  }, []);

  return { ...state, loadMore, patchCard, update, retry, refresh };
}
