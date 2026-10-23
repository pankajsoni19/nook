// The Tasks home's presentation state in the URL (research 2026-09-26 §9.1 "the URL is the state",
// §9.5, §10). Pure: no DOM access, so the router and tests import it directly.
//
//   /tasks                 Boards (the board list)
//   /tasks/my              My work: `assignee:me` across boards (Q11), by default open cards,
//                          grouped by due bucket (Q16)
//   /tasks/views           the saved views list
//   /tasks/views/new       an unsaved view (the draft lives in the query)
//   /tasks/views/:id       a saved view; a query string is an unsaved change to it
//
// Filters are the one task grammar (shared/taskQuery.ts) as a canonical `q=`; the presentation keys
// are `layout`, `group`, and `sort`. Decoding never throws: bad values fall back to the default.
import { decodeFilterParams, encodeFilterParams, format, parse, type FilterTerm, type TaskQuery } from "../../../shared/taskQuery";
import { isLaneMode, type LaneMode } from "../../../shared/taskLanes";

export const HOME_LAYOUTS = ["list", "table", "board"] as const;
export type HomeLayout = typeof HOME_LAYOUTS[number];
/** `board`, `state`, and `due` group on the server; `assignee` and `tag` group the loaded cards. */
export const HOME_GROUPS = ["none", "board", "state", "due", "assignee", "tag"] as const;
export type HomeGroup = typeof HOME_GROUPS[number];
export const HOME_SORTS = ["due", "updated", "created", "title", "board"] as const;
export type HomeSort = typeof HOME_SORTS[number];

/**
 * `lanes` (lane VIEWS, D640; VIEWS2, D650): the board layout's lanes, merged columns (the default, left out),
 * `state`, or a field (`assignee`, `tag`, `sprint`, `due`, `board`). In the URL as `lanes=<mode>`.
 */
export type HomeQuery = { layout: HomeLayout; group: HomeGroup; sort: HomeSort; filter: TaskQuery; lanes?: LaneMode; /** Lane VIEWS2 (D665): the lanes split into rows by person or board; `swim=` in the URL. */ swim?: HomeSwim };
export type HomeSwim = "assignee" | "board";
const isHomeSwim = (value: unknown): value is HomeSwim => value === "assignee" || value === "board";

/** The lanes a query shows (columns unless it names another mode). */
export const homeLanes = (query: Pick<HomeQuery, "lanes">): LaneMode => isLaneMode(query.lanes) ? query.lanes : "columns";
const lanesFrom = (params: URLSearchParams): Pick<HomeQuery, "lanes" | "swim"> => {
  const value = params.get("lanes");
  const swim = params.get("swim");
  return { ...(isLaneMode(value) && value !== "columns" ? { lanes: value } : {}), ...(isHomeSwim(swim) ? { swim } : {}) };
};

export type TasksHome =
  | { section: "my"; query?: HomeQuery }
  | { section: "views" }
  /** `viewId` "new" is an unsaved view; `query` (when set) overrides the saved one. */
  | { section: "view"; viewId: string; query?: HomeQuery };

export const NEW_VIEW = "new";

const MY_WORK_FILTER_TEXT = "state:todo,doing assignee:me";

function parsed(text: string): TaskQuery {
  const result = parse(text, { lenient: true });
  return result.ok ? result.query : { terms: [] };
}

/** My work's default: open cards assigned to me, grouped by due bucket, soonest first (§10.2, Q16). */
export const myWorkDefault = (): HomeQuery => ({ layout: "list", group: "due", sort: "due", filter: parsed(MY_WORK_FILTER_TEXT) });
/** A new view starts empty: no filter runs until it has a key (Q11). */
export const newViewDefault = (): HomeQuery => ({ layout: "list", group: "none", sort: "due", filter: { terms: [] } });

const oneOf = <T extends string>(list: readonly T[], value: string | null): T | null =>
  value !== null && (list as readonly string[]).includes(value) ? value as T : null;

function readParams(search: string): URLSearchParams | null {
  if (!search || search === "?" || search.length > 4096) return null;
  try {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    return [...params.keys()].length ? params : null;
  } catch {
    return null;
  }
}

/**
 * My work always carries `assignee:me` (Q11): any other positive assignee term is replaced, so the
 * query stays selective whatever a link says. Negated assignee terms are kept.
 */
export function withAssigneeMe(filter: TaskQuery): TaskQuery {
  const terms: FilterTerm[] = filter.terms.filter((term) => term.key !== "assignee" || term.negate);
  return parsed(format({ terms: [...terms, { key: "assignee", negate: false, values: ["me"] }] }));
}

/** My work's query from its search string: the default without one. */
export function parseMyWorkSearch(search: string): HomeQuery {
  const base = myWorkDefault();
  const params = readParams(search);
  if (!params) return base;
  const hasFilter = params.has("q") || ["board", "state", "tag", "flag", "due", "has", "creator", "assignee"].some((key) => params.has(key));
  return {
    layout: oneOf(HOME_LAYOUTS, params.get("layout")) ?? base.layout,
    group: oneOf(HOME_GROUPS, params.get("group")) ?? base.group,
    sort: oneOf(HOME_SORTS, params.get("sort")) ?? base.sort,
    filter: withAssigneeMe(hasFilter ? decodeFilterParams(params) : base.filter),
    ...lanesFrom(params)
  };
}

const readable = (params: URLSearchParams) => {
  // `:` and `,` are legal in a query; keeping them readable makes shared links easier to read.
  const text = params.toString().replace(/%3A/gi, ":").replace(/%2C/gi, ",");
  return text ? `?${text}` : "";
};

/** My work's search string: "" for the default, otherwise only what differs. */
export function formatMyWorkSearch(query: HomeQuery): string {
  const base = myWorkDefault();
  const params = new URLSearchParams();
  if (query.layout !== base.layout && oneOf(HOME_LAYOUTS, query.layout)) params.set("layout", query.layout);
  if (query.group !== base.group && oneOf(HOME_GROUPS, query.group)) params.set("group", query.group);
  if (query.sort !== base.sort && oneOf(HOME_SORTS, query.sort)) params.set("sort", query.sort);
  if (homeLanes(query) !== "columns") params.set("lanes", homeLanes(query));
  if (isHomeSwim(query.swim)) params.set("swim", query.swim);
  const filter = withAssigneeMe(query.filter);
  if (format(filter) !== format(base.filter)) {
    encodeFilterParams(filter, params);
    // "All states" leaves only assignee:me, which still differs from the default.
    if (!params.has("q")) params.set("q", format(filter));
  }
  return readable(params);
}

/** A view page's override from its search string, or undefined when the URL has none (the saved view). */
export function parseViewSearch(search: string): HomeQuery | undefined {
  const params = readParams(search);
  if (!params) return undefined;
  const base = newViewDefault();
  return {
    layout: oneOf(HOME_LAYOUTS, params.get("layout")) ?? base.layout,
    group: oneOf(HOME_GROUPS, params.get("group")) ?? base.group,
    sort: oneOf(HOME_SORTS, params.get("sort")) ?? base.sort,
    filter: decodeFilterParams(params),
    ...lanesFrom(params)
  };
}

/**
 * A view page's override as a search string. It always names the layout, group, and sort, so an
 * override is never the empty string that means "the saved view".
 */
export function formatViewSearch(query: HomeQuery): string {
  const params = new URLSearchParams();
  params.set("layout", oneOf(HOME_LAYOUTS, query.layout) ?? "list");
  params.set("group", oneOf(HOME_GROUPS, query.group) ?? "none");
  params.set("sort", oneOf(HOME_SORTS, query.sort) ?? "due");
  if (homeLanes(query) !== "columns") params.set("lanes", homeLanes(query));
  if (isHomeSwim(query.swim)) params.set("swim", query.swim);
  encodeFilterParams(query.filter, params);
  return readable(params);
}

/** The route's search string for a home section. */
export function formatHomeSearch(home: TasksHome): string {
  if (home.section === "my") return home.query ? formatMyWorkSearch(home.query) : "";
  if (home.section === "view") return home.query ? formatViewSearch(home.query) : "";
  return "";
}

/**
 * Q11: a view runs only with at least one positive key other than text (a board, an assignee, a
 * state…), so an empty or text-only view never scans every readable board.
 */
export function isSelectiveQuery(filter: TaskQuery) {
  return filter.terms.some((term) => !term.negate && term.key !== "text");
}

export type SavedDisplay = { layout: string; group: string; sort: string; lanes?: string; swimlanes?: string | null };

/** A saved view's stored query and display as a home query (unknown values fall back). */
export function viewHomeQuery(view: { query: string; display: SavedDisplay }): HomeQuery {
  const base = newViewDefault();
  return {
    layout: oneOf(HOME_LAYOUTS, view.display.layout) ?? base.layout,
    group: oneOf(HOME_GROUPS, view.display.group) ?? base.group,
    sort: oneOf(HOME_SORTS, view.display.sort) ?? base.sort,
    filter: parsed(view.query),
    ...(isLaneMode(view.display.lanes) && view.display.lanes !== "columns" ? { lanes: view.display.lanes } : {}),
    ...(isHomeSwim(view.display.swimlanes) ? { swim: view.display.swimlanes } : {})
  };
}

/** Whether two home queries show the same thing (the unsaved-changes indicator). */
export function sameHomeQuery(left: HomeQuery, right: HomeQuery) {
  return left.layout === right.layout && left.group === right.group && left.sort === right.sort && homeLanes(left) === homeLanes(right) && (left.swim ?? null) === (right.swim ?? null) && format(left.filter) === format(right.filter);
}

/** The server's group for a home group: assignee and tag group the loaded cards instead. */
export const serverGroup = (group: HomeGroup): "none" | "board" | "state" | "due" => group === "assignee" || group === "tag" ? "none" : group;
