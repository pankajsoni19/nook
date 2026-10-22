import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, CircleCheck, CircleX, Clock3, ExternalLink, ListFilter, LoaderCircle, MoreHorizontal, MousePointerClick, RefreshCw, ScanSearch, Trash2, TriangleAlert } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Markdown, type RenderContext } from "../chat/markdown/render";
import { notify } from "../ui/notify";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { blockKeys, defaultWidth, reportLayout, type ChartBlock, type ReportBlock, type ReportDetail, type ReportResult, type ReportRun, type TableBlock } from "../../shared/reports";
import type { ChartPick } from "./charts";
import { ClickFilterSheet, clickChoices, clickedValue, columnValues, FilterBySheet, isClickable, PickBar, pickedValues, type ClickState } from "./clickFilter";
import { reportCssVariables } from "../../shared/reportTheme";
import type { QueryResultView, ReportResultsView, ScheduleView } from "../../shared/reportsView";
import { buildChartOption, paletteFor, type ChartBuild, type ChartPalette } from "./chartOption";
import type { MeterModel } from "./chartKinds";
import { InspectSheet, type DataBlock } from "./InspectSheet";
import { INSPECT_TABS, type InspectTab } from "./inspectHistory";
import { useLayerOpener } from "../historyDialogs";
import { KpiTile, type ResultLookup } from "./KpiTile";
import { ResultTable } from "./ResultTable";
import { PAGE_METRICS_RUN_MARKER } from "../../shared/reportsMetrics";
import { getParamOptions, previewVersionOf, getParamResults, getResults, getRun, listRuns, refreshReport, runParamSet, RUN_STATUS_TEXT, timeAgo } from "./reportViewApi";
import { ReportParamsBar, ReportParamsContext, type ParamReach } from "./ReportParamsBar";
import { canonicalValues, isDefaultSet, optionParentsOf, reachOf, valuesFromSearch, valuesToSearch, type ParamValues, type ReportParameter } from "../../shared/reportParams";
import { dropUnlinked, parentsKey, parentValuesOf } from "./linkedFilters";
import { codeOf, messageOf } from "./reportsApi";
import { scheduleBadge, ScheduleSheet } from "./ScheduleSheet";
import { CommentOnBlockButton } from "./reportComment";
import { blockLabel, useHeaderRemoval, useReportEditing } from "./reportBlockEdit";
import { useHeaderActions, useRegisterReportCommands } from "./reportCommands";
import "./reportView.css";

/** "Updated 3 min ago", kept current (every 30 s) without re-rendering the report. */
export function UpdatedAgo({ at }: { at: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [at]);
  return <>{`Updated ${timeAgo(at, now)}`}</>;
}

/** A KPI title as words, each kept whole on its line (ellipsized when one alone is wider than the tile). */
export function titleWords(title: string) {
  const words = title.split(/\s+/).filter(Boolean);
  return words.map((word, at) => <span key={at} className="report-title-word">{word}{at < words.length - 1 ? " " : ""}</span>);
}

/** ECharts and its option renderer load only when a report with a chart opens (charts.tsx). */
const EChart = lazy(() => import("./charts"));

const POLL_MS = 1000;

/** Whether the system asks for forced colours (texture fills then stand in for hue). */
const forcedColors = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches;

/**
 * The chart theme from the page's one theme source (review L4, wave 48b): the root's `color-scheme`
 * (what the app's CSS sets, src/styles.css) picks the mode; every colour then comes from that mode's
 * tokens in shared/reportTheme.ts, the same tokens the view's CSS variables are made of.
 */
export function readChartPalette(): ChartPalette {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return paletteFor("dark");
  try {
    return paletteFor(getComputedStyle(document.documentElement).colorScheme, { forcedColors: forcedColors() });
  } catch {
    return paletteFor("dark");
  }
}

/** Re-reads the theme whenever it can have changed: the root's attributes or style, the OS scheme, or forced colours. */
export function useChartPalette(): ChartPalette {
  const [palette, setPalette] = useState<ChartPalette>(() => readChartPalette());
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const update = () => setPalette((current) => {
      const next = readChartPalette();
      return next.mode === current.mode && next.forcedColors === current.forcedColors ? current : next;
    });
    update();
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    observer?.observe(document.documentElement, { attributes: true });
    if (document.body) observer?.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const media = typeof window.matchMedia === "function" ? [window.matchMedia("(prefers-color-scheme: dark)"), window.matchMedia("(forced-colors: active)")] : [];
    media.forEach((query) => query?.addEventListener?.("change", update));
    return () => { observer?.disconnect(); media.forEach((query) => query?.removeEventListener?.("change", update)); };
  }, []);
  return palette;
}

/** The layout class of a block: its width slot (the grid's 12/6/1 columns follow the view's width). */
export const widthClass = (block: ReportBlock) => `report-w-${block.width ?? defaultWidth(block)}`;

const isDataBlock = (block: ReportBlock): block is DataBlock => block.type !== "markdown";

/**
 * When the viewer (re)loads its results and run history: on open, and whenever the report gets a new
 * revision (a generation saved a new spec), so the new spec's first results show with no manual refresh.
 */
export const resultsLoadKey = (report: Pick<ReportDetail, "id" | "revision">) => `${report.id}@${report.revision}`;

type Props = {
  report: ReportDetail;
  canWrite: boolean;
  /** Review L2: a generation is starting or running (ReportGeneration knows before the run row shows here). */
  generating?: boolean;
  /** Tests and server-side rendering: the results to show without a request. */
  initial?: { results: ReportResultsView; schedule?: ScheduleView | null; runs?: ReportRun[] };
  /** Lane J: a past version (Versions → View this version): no toolbar, no inspect or menu, nothing runs; pass `initial`. */
  readOnly?: { emptyText: string };
};

/**
 * The report viewer (plan wave 47): the spec's blocks over their latest results, one column on a phone
 * and two from 768 px; markdown through the chat's sanitized renderer; charts drawn by ECharts from
 * options Nook builds (chartOption.ts). Every chart, KPI, and table has an inspect button ("How was
 * this built") and a menu with "Re-run this query"; the toolbar has "Refresh all" and the schedule.
 * A refresh is a run: the page polls it and reloads the results when it ends.
 */
export function ReportView({ report, canWrite, generating = false, initial, readOnly }: Props) {
  const [view, setView] = useState<ReportResultsView | null>(initial?.results ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState<ReportRun | null>(initial?.results.running ?? null);
  const [schedule, setSchedule] = useState<ScheduleView | null>(initial?.schedule ?? null);
  const [runs, setRuns] = useState<ReportRun[]>(initial?.runs ?? []);
  const [inspect, setInspect] = useState<{ blockId: string; tab: InspectTab } | null>(null);
  // Forward after Back reopens the last Inspect sheet (its first tab), as Changes and Share do.
  const lastInspect = useRef<{ blockId: string; tab: InspectTab } | null>(null);
  if (inspect) lastInspect.current = inspect;
  // D480: Forward after Back went past the report page remounts it; the layer key names the block and tab.
  useLayerOpener("reports.inspect", (arg) => {
    const [blockId, tab] = arg.split(":");
    if (blockId) setInspect({ blockId, tab: INSPECT_TABS.includes(tab as InspectTab) ? tab as InspectTab : "query" });
  });
  const [menuBlock, setMenuBlock] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [externalLink, setExternalLink] = useState<string | null>(null);
  const palette = useChartPalette();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Spec v3 (D489): the report's parameter values come from the URL (ReportParamsContext); the default
  // set reads the stored results, any other set its cached results, running what is missing first.
  const paramsContext = useContext(ReportParamsContext);
  const parameters = report.spec.parameters ?? [];
  const withParams = parameters.length > 0 && !readOnly && !initial && paramsContext !== null;
  const values = useMemo(() => valuesFromSearch(parameters, paramsContext?.search), [parameters, paramsContext?.search]);
  const setKey = withParams && !isDefaultSet(parameters, values) ? canonicalValues(parameters, values) : "";
  const valuesRef = useRef<ParamValues>(values);
  valuesRef.current = values;
  const parametersRef = useRef(parameters);
  parametersRef.current = parameters;
  const pushRef = useRef<(next: ParamValues, options?: { replace?: boolean }) => void>(() => undefined);
  /** The queries a parameter set is still running (their blocks show spinners); null when none. */
  const [pending, setPending] = useState<string[] | null>(null);
  const ticket = useRef(0);

  const loadResults = useCallback(async () => {
    const mine = ++ticket.current;
    const current = () => alive.current && mine === ticket.current;
    try {
      if (!setKey) {
        const next = await getResults(report.id);
        if (!current()) return null;
        setView(next);
        setPending(null);
        setLoadError(null);
        return next;
      }
      const shown = valuesRef.current;
      const first = await getParamResults(report.id, shown);
      if (!current()) return null;
      if (!first.set.missing.length) {
        setView(first);
        setPending(null);
        setLoadError(null);
        return first;
      }
      setPending(first.set.missing);
      // Another run (a refresh, another reader's set) holds the report: wait for it, then run this set.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const ran = await runParamSet(report.id, shown);
          if (!current()) return null;
          setView(ran);
          setPending(null);
          setLoadError(null);
          return ran;
        } catch (reason) {
          if (codeOf(reason).code !== "RUN_IN_PROGRESS" || attempt >= 80) throw reason;
          await new Promise((resolve) => setTimeout(resolve, 1500));
          if (!current()) return null;
        }
      }
    } catch (reason) {
      // D561: a link (or an old URL) whose linked filter holds a value its parents' choices do not: drop it, with a note.
      const refused = codeOf(reason) as { code?: string; paramId?: unknown };
      const params = parametersRef.current;
      if (current() && refused.code === "INVALID" && params.some((param) => param.id === refused.paramId && optionParentsOf(param, params).length > 0)) {
        const { values: cleaned, notes } = await dropUnlinked(report.id, params, null, valuesRef.current);
        if (current() && notes.length) {
          for (const note of notes) notify.info(note);
          pushRef.current(cleaned, { replace: true });
          return null;
        }
      }
      if (current()) {
        setPending(null);
        setLoadError(messageOf(reason, "Could not load the results"));
      }
      return null;
    }
  }, [report.id, setKey]);
  const pushValues = useCallback((next: ParamValues, options?: { replace?: boolean }) => {
    const search = valuesToSearch(parameters, next);
    paramsContext?.onChange(Object.keys(search).length ? search : undefined, options);
  }, [parameters, paramsContext]);
  // D561: a parent's change drops the linked children's picks its new choices do not hold, with a note, before the URL changes.
  const linked = useMemo(() => parameters.some((param) => optionParentsOf(param, parameters).length > 0), [parameters]);
  const changeParams = useCallback((next: ParamValues) => {
    if (!linked) { pushValues(next); return; }
    const before = valuesRef.current;
    void dropUnlinked(report.id, parameters, before, next).then(({ values: cleaned, notes }) => {
      if (!alive.current || valuesRef.current !== before) return;
      for (const note of notes) notify.info(note);
      pushValues(cleaned);
    });
  }, [linked, parameters, pushValues, report.id]);
  pushRef.current = pushValues;
  const loadRuns = useCallback(async () => {
    try {
      const history = await listRuns(report.id);
      if (!alive.current) return;
      setRuns(history.runs);
      setSchedule(history.schedule);
    } catch { /* the toolbar works without the history */ }
  }, [report.id]);

  const loadKey = resultsLoadKey(report);
  useEffect(() => {
    if (initial) return;
    void loadResults().then((next) => { if (next?.running) setRunning(next.running); });
  }, [initial, loadResults, loadKey]);
  useEffect(() => {
    if (initial) return;
    void loadRuns();
  }, [initial, loadRuns, loadKey]);

  // While a run goes: poll it, then reload the results and say how it went.
  useEffect(() => {
    if (!running || running.status !== "running" || initial) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const { run } = await getRun(report.id, running.id);
        if (!alive.current) return;
        if (run.status === "running") {
          // A 409 names only the holder's id: once the server says it is a generation, show it as one.
          if (run.kind !== running.kind) { setRunning(run); return; }
          timer = setTimeout(() => { void tick(); }, POLL_MS);
          return;
        }
        setRunning(null);
        await loadResults();
        void loadRuns();
        // A generation's end is told by ReportGeneration (its progress and toast).
        if (run.kind === "generate") return;
        // L2: Check doc re-reading catalog metrics says how it went itself (the Doc changed banner).
        if (run.queryKeys?.[0] === PAGE_METRICS_RUN_MARKER) return;
        if (run.status === "succeeded") notify.success(run.queryKeys?.length ? "Query re-ran" : "Report refreshed");
        else if (run.status === "partial") notify.warning(`Refreshed with errors: ${run.error ?? "some queries failed"}. Their blocks keep the last good result.`);
        else notify.error(`The refresh ${run.status === "abandoned" ? "stopped" : "failed"}${run.error ? `: ${run.error}` : ""}`);
      } catch {
        if (alive.current) timer = setTimeout(() => { void tick(); }, POLL_MS * 3);
      }
    };
    timer = setTimeout(() => { void tick(); }, POLL_MS);
    return () => { if (timer) clearTimeout(timer); };
  }, [initial, loadResults, loadRuns, report.id, running]);

  async function startRefresh(queryKey?: string) {
    if (running || generating) return;
    try {
      const { run } = await refreshReport(report.id, queryKey);
      setRunning(run);
    } catch (reason) {
      const { code } = codeOf(reason);
      const holder = reason && typeof reason === "object" && "payload" in reason ? (reason as { payload?: { runId?: string } }).payload?.runId : undefined;
      if (code === "RUN_IN_PROGRESS") {
        notify.info("This report is already running; it reloads when the run ends");
        if (holder) setRunning({ id: holder, reportId: report.id, kind: "refresh", trigger: "user", status: "running", agentRunId: null, docSnapshotId: null, queryKeys: null, startedAt: new Date().toISOString(), finishedAt: null, error: null });
      } else notify.error(messageOf(reason, "Could not start the refresh"));
    }
  }

  const results = useMemo(() => new Map((view?.results ?? []).map((item) => [item.queryKey, item])), [view]);
  const queries = useMemo(() => new Map(report.spec.queries.map((query) => [query.key, query])), [report.spec.queries]);
  const blocks = report.spec.blocks;
  const inspected = inspect ? blocks.find((block) => block.id === inspect.blockId) : undefined;
  const menuTarget = menuBlock ? blocks.find((block) => block.id === menuBlock) : undefined;
  const badge = scheduleBadge(schedule);
  const staleCount = [...results.values()].filter((item) => item.stale || (!item.result && item.failed)).length;
  const lastRun = runs.find((run) => run.status !== "running");
  // D489 follow-up: with other filters, "Updated" is when the shown set's results ran (its newest), not the default set's run.
  const shownSet = view && "set" in view ? canonicalValues(parameters, (view as { set: { values: ParamValues } }).set.values) : null;
  const setRanAt = setKey ? (view?.results ?? []).reduce<string | null>((newest, item) => {
    const at = (item.result ?? item.failed)?.createdAt ?? null;
    return at && (!newest || at > newest) ? at : newest;
  }, null) : null;
  const layout = useMemo(() => reportLayout(report.spec), [report.spec]);
  const cssVars = useMemo(() => reportCssVariables(palette.mode) as React.CSSProperties, [palette.mode]);
  const lookup = useCallback<ResultLookup>((key) => results.get(key)?.result ?? null, [results]);
  const markdownContext = useMemo<RenderContext>(() => ({ onExternalLink: setExternalLink, onNookLink: (path) => window.location.assign(path), images: { mode: "public" } }), []);

  // A refresh, a re-run, or a generation (starting or running) holds the report: nothing else starts.
  const busy = Boolean(running) || generating;
  // On the report page, Refresh all and Schedule live in the page header (reportCommands.tsx).
  const inHeader = useHeaderActions();
  useRegisterReportCommands({
    refreshAll: canWrite ? { run: () => { void startRefresh(); }, busy: busy, disabled: busy || !report.spec.queries.length } : null,
    schedule: { open: () => setScheduleOpen(true), badge: badge?.text ?? null }
  }, readOnly ? [] : ["refreshAll", "schedule"]);

  // Lane EDIT (D525): the owner removes a block or a section from its header (never the last block).
  const editing = useReportEditing();
  const removal = useHeaderRemoval(report, editing?.onChanged ?? noChange);
  const canRemove = Boolean(editing?.canEdit) && !readOnly && blocks.length > 1;
  // D534: the owner's Add filter and Remove filter (not on a past version or in tests without a URL).
  const canAddFilter = Boolean(editing?.canEdit && editing.addFilter) && !readOnly && !initial;
  const removeBlock = (block: ReportBlock) => { void removal.remove({ kind: "block", block }); };
  const removeButton = (block: ReportBlock, className = "") => canRemove
    ? <RemoveButton label={blockLabel(block)} disabled={busy} className={className} onClick={() => removeBlock(block)} /> : null;

  // D533: which queries each parameter reaches, the blocks that follow it, and the changed filters a block ignores.
  const queryReach = useMemo(() => reachOf(parameters, report.spec.queries), [parameters, report.spec.queries]);
  const blockReach = useMemo<ParamReach>(() => {
    const data = blocks.filter(isDataBlock);
    return Object.fromEntries(parameters.map((param) => [param.id, { blocks: data.filter((block) => blockKeys(block).some((key) => queryReach[param.id]?.includes(key))).length, total: data.length }]));
  }, [blocks, parameters, queryReach]);
  const changedParams = useMemo(() => withParams ? parameters.filter((param) => !isDefaultSet([param], { [param.id]: values[param.id] ?? param.default })) : [], [parameters, values, withParams]);
  // A chart or table whose click sets the filter is its source: its highlight says what is picked, so it shows no "Not filtered by" for it.
  const notFilteredBy = (block: DataBlock) => changedParams.filter((param) => !blockKeys(block).some((key) => queryReach[param.id]?.includes(key))
    && !(isClickable(block) && block.clickFilter?.param === param.id));

  // D536: click to filter. A click pushes a URL entry (Back undoes it); clicks closer than 300 ms are one (TF4);
  // a value the options do not list is refused here as the server would (TF3).
  const lastClick = useRef(0);
  const optionCache = useRef(new Map<string, Promise<{ options: string[]; truncated: boolean } | null>>());
  const applyClick = useCallback(async (param: ReportParameter, value: string) => {
    const at = Date.now();
    if (at - lastClick.current < 300) return;
    lastClick.current = at;
    const current = valuesRef.current[param.id] ?? param.default;
    const next = clickedValue(param, current, value);
    if (next === null) { notify.warning(`At most 50 values can be picked for ${param.label}`); return; }
    const adding = param.type === "multi_select" ? !(current as string[]).includes(value) : next !== param.default;
    if (adding) {
      // D560: a linked filter's choices are those of its parents' current values.
      const cacheKey = `${param.id}\u0000${parentsKey(param, parameters, valuesRef.current)}`;
      if (!optionCache.current.has(cacheKey)) optionCache.current.set(cacheKey, getParamOptions(report.id, param.id, undefined, parentValuesOf(param, parameters, valuesRef.current)).then(({ options }) => options, () => null));
      const options = await optionCache.current.get(cacheKey);
      if (options && !options.truncated && !options.options.includes(value)) { notify.error(`${value.slice(0, 60) || "(blank)"} is not one of the choices for ${param.label}`); return; }
    }
    changeParams({ ...valuesRef.current, [param.id]: next });
  }, [changeParams, parameters, report.id]);
  const clickFor = (block: DataBlock): ClickState | undefined => {
    if (!withParams || !isClickable(block) || !block.clickFilter) return undefined;
    const param = parameters.find((item) => item.id === block.clickFilter!.param && (item.type === "select" || item.type === "multi_select"));
    if (!param) return undefined;
    return { param, column: block.clickFilter.column, picked: pickedValues(param, values[param.id] ?? param.default), onPick: (value) => { void applyClick(param, value); } };
  };
  const [filterBy, setFilterBy] = useState<string | null>(null);
  const [clickSetup, setClickSetup] = useState<string | null>(null);
  const filterByBlock = filterBy ? blocks.find((block) => block.id === filterBy) : undefined;
  const clickSetupBlock = clickSetup ? blocks.find((block) => block.id === clickSetup) : undefined;

  const card = (block: DataBlock) => <DataBlockCard key={block.id} block={block} view={results.get(block.queryKey)} hasQuery={queries.has(block.queryKey)} palette={palette}
    running={running} loaded={view !== null} lookup={lookup} readOnly={readOnly} pending={Boolean(pending?.some((key) => blockKeys(block).includes(key)))} filtered={withParams} notFilteredBy={notFilteredBy(block)}
    onInspect={() => setInspect({ blockId: block.id, tab: "query" })} onMenu={() => setMenuBlock(block.id)}
    onRemove={canRemove ? () => removeBlock(block) : undefined} removeDisabled={busy} click={clickFor(block)} />;

  if (!blocks.length) return null;
  return <section className={`report-view report-theme-${palette.mode}`} style={cssVars} aria-label="Report">
    {(withParams || (canAddFilter && paramsContext !== null)) && <ReportParamsBar reportId={report.id} parameters={parameters} values={values} busy={Boolean(pending)} onChange={changeParams} timeZone={view?.timeZone}
      reach={blockReach} onAddFilter={canAddFilter ? editing?.addFilter : undefined} onRemoveFilter={canAddFilter && editing?.removeFilter ? (param) => editing.removeFilter!(param.id) : undefined} />}
    {!readOnly && <div className="report-view-toolbar">
      <p className="report-view-status" role="status">
        {busy ? <span className="report-view-running"><LoaderCircle className="spin" aria-hidden="true" />{!running || running.kind === "generate" ? "Generating…" : previewVersionOf(running.queryKeys) !== null ? `Running v${previewVersionOf(running.queryKeys)} on today's data…` : running.queryKeys?.[0] === PAGE_METRICS_RUN_MARKER ? "Re-reading metrics…" : running.queryKeys?.length ? `Re-running ${running.queryKeys.join(", ")}…` : "Refreshing…"}</span>
          : <span><Clock3 aria-hidden="true" />{setKey
            ? shownSet === setKey ? (setRanAt ? <UpdatedAgo at={setRanAt} /> : "Not run yet") : "Loading…"
            : report.lastRunAt ? <UpdatedAgo at={lastRun?.finishedAt ?? report.lastRunAt} /> : "Not refreshed yet"}</span>}
        {staleCount > 0 && <span className="reports-status reports-status-stale">{`${staleCount} stale`}</span>}
        {badge && <span className={`reports-status reports-status-${badge.tone}`}><CalendarClock aria-hidden="true" />{badge.text}</span>}
      </p>
      {!inHeader && <div className="report-view-actions">
        <button type="button" className="secondary-button" onClick={() => setScheduleOpen(true)}><CalendarClock aria-hidden="true" />Schedule</button>
        {canWrite && <button type="button" className="primary-button" onClick={() => { void startRefresh(); }} disabled={busy || !report.spec.queries.length}>
          {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}Refresh all
        </button>}
      </div>}
    </div>}
    {loadError && <p className="form-error" role="alert">{loadError} <button type="button" className="secondary-button" onClick={() => { void loadResults(); }}>Try again</button></p>}
    {layout.narrative.map((block) => <div key={block.id} className="report-narrative">
      {removeButton(block, " report-block-float")}
      {block.title && <h2 className="report-narrative-title">{block.title}</h2>}
      <div className="report-markdown"><Markdown text={block.markdown} context={markdownContext} /></div>
    </div>)}
    {layout.strip.length > 0 && <div className="report-kpi-area" role="group" aria-label="Key figures">
      {/* The one hero figure takes its own row; the other KPIs share the strip evenly (each at least 150 px). */}
      {layout.strip.filter((block) => block.hero).map((block) => card(block))}
      {layout.strip.some((block) => !block.hero) && <div className="report-kpi-strip">{layout.strip.filter((block) => !block.hero).map((block) => card(block))}</div>}
    </div>}
    {layout.sections.map((section, index) => <section key={section.id ?? `_${section.blocks[0]?.id ?? ""}`} className={`report-section${section.id === null && index > 0 ? " report-section-after" : ""}`} aria-label={section.title ?? undefined}>
      {section.title && (canRemove && section.id
        ? <div className="report-section-head">
          <h2 className="report-section-title">{section.title}</h2>
          <RemoveButton label={`the section ${section.title}`} disabled={busy}
            onClick={() => { void removal.remove({ kind: "section", section: { id: section.id!, title: section.title! }, blockIds: section.blocks.map((block) => block.id) }); }} />
        </div>
        : <h2 className="report-section-title">{section.title}</h2>)}
      {section.summary && <p className="report-section-summary">{section.summary}</p>}
      <div className="report-grid">
        {section.blocks.map((block) => block.type === "markdown"
          ? <article key={block.id} className={`report-block report-block-markdown ${widthClass(block)}`}>
            {/* D525: a titled text block gets a header row like a chart's; an untitled one, the trash floated in its text. */}
            {block.title && (canRemove
              ? <header className="report-block-head"><h3 className="report-block-title">{block.title}</h3><span className="report-block-buttons">{removeButton(block)}</span></header>
              : <h3 className="report-block-title">{block.title}</h3>)}
            <div className="report-markdown">{!block.title && removeButton(block, " report-block-float")}<Markdown text={block.markdown} context={markdownContext} /></div>
          </article>
          : card(block))}
      </div>
    </section>)}
    {menuTarget && isDataBlock(menuTarget) && <BlockMenu block={menuTarget} canWrite={canWrite} busy={busy}
      onClose={() => setMenuBlock(null)}
      onRemove={canRemove ? () => { setMenuBlock(null); removeBlock(menuTarget); } : undefined}
      onInspect={(tab) => { setMenuBlock(null); setInspect({ blockId: menuTarget.id, tab }); }}
      onRerun={() => { setMenuBlock(null); void startRefresh(menuTarget.queryKey); }}
      onFilterBy={clickFor(menuTarget) && results.get(menuTarget.queryKey)?.result ? () => { setMenuBlock(null); setFilterBy(menuTarget.id); } : undefined}
      onClickSetup={editing?.canEdit && !readOnly && isClickable(menuTarget) && (menuTarget.clickFilter || clickChoices(report, menuTarget).length) ? () => { setMenuBlock(null); setClickSetup(menuTarget.id); } : undefined} />}
    {filterByBlock && isDataBlock(filterByBlock) && clickFor(filterByBlock) && <FilterBySheet title={filterByBlock.title ?? filterByBlock.queryKey} click={clickFor(filterByBlock)!}
      values={columnValues(results.get(filterByBlock.queryKey)?.result ?? { columns: [], rows: [] }, clickFor(filterByBlock)!.column)} onClose={() => setFilterBy(null)} />}
    {clickSetupBlock && isClickable(clickSetupBlock) && <ClickFilterSheet report={report} block={clickSetupBlock} resultColumns={(results.get(clickSetupBlock.queryKey)?.result?.columns ?? []).map((column) => column.name)}
      onClose={() => setClickSetup(null)} onSaved={() => { setClickSetup(null); editing?.onChanged(); }} />}
    {inspected && isDataBlock(inspected) && <InspectSheet report={report} block={inspected} query={queries.get(inspected.queryKey)} view={results.get(inspected.queryKey)}
      palette={palette} canRerun={canWrite} busy={busy} onRerun={(key) => { void startRefresh(key); }} initialTab={inspect!.tab} layerKey={`reports.inspect:${inspected.id}:${inspect!.tab}`} onClose={() => setInspect(null)} reopen={() => setInspect(lastInspect.current)} />}
    {scheduleOpen && <ScheduleSheet reportId={report.id} schedule={schedule} runs={runs} canWrite={canWrite} reopen={() => setScheduleOpen(true)}
      onSaved={(next) => { setSchedule(next); setScheduleOpen(false); notify.success(next.enabled ? "Schedule saved" : "Schedule off"); }} onClose={() => setScheduleOpen(false)} />}
    {externalLink && <ExternalLinkSheet href={externalLink} onClose={() => setExternalLink(null)} />}
    {removal.confirmElement}
  </section>;
}

const noChange = () => undefined;

/** D525: the trash on a block header or a section title, the same size and colour as Inspect and ⋯. */
function RemoveButton({ label, disabled, className = "", onClick }: { label: string; disabled?: boolean; className?: string; onClick: () => void }) {
  return <button type="button" className={`icon-button report-block-button report-block-remove${className}`} onClick={onClick} disabled={disabled}
    aria-label={`Remove ${label}`} title={disabled ? "The report is running" : "Remove"}><Trash2 /></button>;
}

type CardProps = {
  block: DataBlock;
  view: QueryResultView | undefined;
  hasQuery: boolean;
  palette: ChartPalette;
  running: ReportRun | null;
  loaded: boolean;
  /** Other queries' results (KPI comparisons and sparklines). */
  lookup?: ResultLookup;
  onInspect: () => void;
  onMenu: () => void;
  /** Lane J: a past version's view: no inspect or menu buttons, and this text where a query has no stored result. */
  readOnly?: { emptyText: string };
  /** D489: its query is running for the parameter set on show (the block keeps its last rows, dimmed). */
  pending?: boolean;
  /** D489: the report has parameters (an empty result is "no rows for these filters"). */
  filtered?: boolean;
  /** D525: the owner's Remove (a trash between Inspect and ⋯; a narrow KPI tile keeps it in ⋯ only). */
  onRemove?: () => void;
  removeDisabled?: boolean;
  /** D533: the changed filters this block's queries do not read ("Not filtered by Country"). */
  notFilteredBy?: readonly Pick<ReportParameter, "id" | "label">[];
  /** D536: what a click on this chart or table filters by. */
  click?: ClickState;
};

/** One chart, KPI, or table: its title, stale/error badges, the inspect, remove, and menu buttons, and the body. */
export function DataBlockCard({ block, view, hasQuery, palette, running, loaded, lookup, onInspect, onMenu, readOnly, pending = false, filtered = false, onRemove, removeDisabled = false, notFilteredBy = [], click }: CardProps) {
  const result = view?.result ?? null;
  const failed = view?.failed ?? null;
  const rerunning = pending || Boolean(running && (!running.queryKeys || running.queryKeys.includes(block.queryKey)));
  const title = block.title ?? (block.type === "kpi" ? block.label ?? block.column : block.queryKey);
  return <article className={`report-block report-block-${block.type} ${widthClass(block)}${block.type === "kpi" && block.hero ? " report-block-hero" : ""}${pending ? " report-block-pending" : ""}`} aria-label={title} aria-busy={pending || undefined}>
    <header className="report-block-head">
      {/* A KPI title wraps between words only; a word too long for its line ends in an ellipsis (the tooltip has it all). */}
      <h3 className="report-block-title" title={title}>{block.type === "kpi" ? titleWords(title) : title}</h3>
      <span className="report-block-badges">
        {rerunning && <LoaderCircle className="spin report-block-spinner" aria-label="Running" />}
        {view?.stale && <span className="reports-status reports-status-stale" title={failed ? `The last run failed: ${failed.error ?? ""}` : "The query changed since this result"}>Stale</span>}
        {!result && failed && <span className="reports-status reports-status-error">Error</span>}
      </span>
      {!readOnly && <span className="report-block-buttons">
        <button type="button" className="icon-button report-block-button" onClick={onInspect} aria-label={`How was ${title} built`} title="How was this built"><ScanSearch /></button>
        {onRemove && <RemoveButton label={title} disabled={removeDisabled} onClick={onRemove} />}
        <button type="button" className="icon-button report-block-button" onClick={onMenu} aria-label={`More for ${title}`} aria-haspopup="dialog"><MoreHorizontal /></button>
      </span>}
    </header>
    {notFilteredBy.length > 0 && <p className="report-block-unfiltered">Not filtered by {listLabels(notFilteredBy.map((param) => param.label))}</p>}
    <div className="report-block-body">
      {!hasQuery ? <p className="report-block-problem">This block names a query the report does not have ({block.queryKey}).</p>
        // D489: a chart or table with no rows for the chosen filters says so (not a mapping problem).
        : result && filtered && !result.rows.length && block.type !== "kpi" ? <p className="report-block-empty">No rows for these filters.</p>
        : result ? <BlockBody block={block} result={result} palette={palette} lookup={lookup} click={click} />
          : failed ? <p className="report-block-problem"><TriangleAlert aria-hidden="true" />{failed.error ?? "The query failed"}</p>
            : <p className="report-block-empty">{readOnly ? readOnly.emptyText : loaded ? "No results yet. Refresh the report to run its queries." : "Loading…"}</p>}
    </div>
    {view?.stale && failed && result && <p className="report-block-note">Showing results from {timeAgo(result.createdAt)}; the last run failed.</p>}
  </article>;
}

/** "Country", "Country and Route", "Country, Route, and Plan". */
const listLabels = (labels: readonly string[]) => labels.length <= 1 ? labels.join("") : labels.length === 2 ? `${labels[0]} and ${labels[1]}` : `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;

function BlockBody({ block, result, palette, lookup, click }: { block: DataBlock; result: ReportResult; palette: ChartPalette; lookup?: ResultLookup; click?: ClickState }) {
  if (block.type === "kpi") return <KpiTile block={block} result={result} lookup={lookup} />;
  if (block.type === "table") return <TableBody block={block} result={result} click={click} />;
  return <ChartBody block={block} result={result} palette={palette} click={click} />;
}

/** D536: a tapped value waiting for its Filter by button (a touch never filters by itself). */
function useTapped(click: ClickState | undefined) {
  const [tapped, setTapped] = useState<string | null>(null);
  const take = (value: string, touch: boolean) => {
    if (!click) return;
    if (touch) setTapped(value);
    else { setTapped(null); click.onPick(value); }
  };
  const bar = click && tapped !== null ? <PickBar label={click.param.label} value={tapped} picked={click.picked.includes(tapped)}
    onApply={() => { click.onPick(tapped); setTapped(null); }} onClose={() => setTapped(null)} /> : null;
  return { take, bar };
}

function TableBody({ block, result, click }: { block: TableBlock; result: ReportResult; click?: ClickState }) {
  const { take, bar } = useTapped(click);
  return <>
    <ResultTable columns={result.columns} rows={result.rows} show={block.columns} formats={block.formats} label={block.title ?? block.queryKey}
      pick={click ? { column: click.column, picked: click.picked, onPick: take } : undefined} />
    {bar}
  </>;
}

/** The width of an element, re-read when it resizes (small multiples and heatmaps lay out by their tile's width). */
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number | undefined] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    // Panel columns change at 520 and 800 px; round so a resize does not rebuild the option on every pixel.
    const read = () => setWidth((current) => {
      const next = Math.round(element.clientWidth / 8) * 8;
      return next > 0 && next !== current ? next : current;
    });
    read();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function ChartBody({ block, result, palette, click }: { block: ChartBlock; result: ReportResult; palette: ChartPalette; click?: ClickState }) {
  const [box, width] = useElementWidth<HTMLDivElement>();
  const picked = click?.picked;
  const built = useMemo(() => buildChartOption(block, result, palette, { width, ...(picked?.length ? { picked } : {}) }), [block, result, palette, width, picked]);
  const { take, bar } = useTapped(click);
  // D536: the clicked category (x) or series is the value; "Other" (folded categories) is not one.
  const onPick = click ? (pick: ChartPick) => {
    const value = click.column === block.x ? pick.name : pick.seriesName;
    if (value === null || value === undefined || (value === "Other" && built.foldedCategories > 0)) return;
    take(value, pick.touch);
  } : undefined;
  const label = `${block.title ?? block.queryKey}: ${block.kind.replace("_", " ")} chart of ${block.y.join(", ")}${block.x && block.x !== block.y[0] ? ` by ${block.x}` : ""}`;
  return <div ref={box} className={`report-chart report-chart-${block.kind}`}>
    {!built.option || built.problems.length ? <ul className="report-block-problem">{built.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
      : built.view === "meter" ? <MeterView model={built.option as unknown as MeterModel} label={label} />
        : <ChartCanvas built={built} label={label} mode={palette.mode} onPick={onPick} />}
    {bar}
    {built.cutRows > 0 && <p className="report-block-note">Showing the first {(result.rows.length - built.cutRows).toLocaleString()} rows; the Data tab has them all.</p>}
  </div>;
}

/** The ECharts canvas; a heatmap or calendar wider than its tile scrolls sideways inside the tile, never the page. */
function ChartCanvas({ built, label, mode, onPick }: { built: ChartBuild; label: string; mode: ChartPalette["mode"]; onPick?: (pick: ChartPick) => void }) {
  const canvas = <Suspense fallback={<div className="report-chart-canvas report-chart-loading" role="status" style={{ height: built.height }}>Loading chart…</div>}>
    <EChart option={built.option!} mode={mode} height={built.height} minWidth={built.minWidth} label={label} onPick={onPick} />
  </Suspense>;
  return <>
    {built.minWidth ? <div className="report-chart-scroll" tabIndex={0} role="group" aria-label={`${label} (scrolls sideways)`}>{canvas}</div> : canvas}
    {built.scale && <ScaleLegend steps={built.scale} />}
  </>;
}

/** A stepped colour scale (low → high) under a value-coloured chart: a swatch row and the low and high values. */
export function ScaleLegend({ steps }: { steps: NonNullable<ChartBuild["scale"]> }) {
  const low = steps[0]?.from ?? "";
  const high = steps[steps.length - 1]?.to ?? "";
  return <div className="report-scale" aria-label={`Colour scale from ${low} to ${high}`}>
    <span className="report-scale-end">{low}</span>
    <span className="report-scale-steps" aria-hidden="true">{steps.map((step, at) => <span key={at} style={{ background: step.color }} title={step.label} />)}</span>
    <span className="report-scale-end">{high}</span>
  </div>;
}

const STATUS_ICONS = { check: CircleCheck, alert: TriangleAlert, cross: CircleX } as const;

/** The gauge kind: a meter (value, a same-ramp track, the target's tick) with a status that always shows an icon and a label. */
export function MeterView({ model, label }: { model: MeterModel; label: string }) {
  const Icon = model.status ? STATUS_ICONS[model.status.icon] : null;
  return <div className="report-meter" role="img" aria-label={`${label}: ${model.valueText}, ${model.caption}${model.status ? `, ${model.status.label}` : ""}`}>
    <div className="report-meter-head">
      <span className="report-meter-value">{model.valueText}</span>
      {model.status && Icon && <span className={`report-meter-status report-meter-${model.status.tone}`}><Icon aria-hidden="true" style={{ color: model.status.color }} />{model.status.label}</span>}
    </div>
    <div className="report-meter-track" style={{ background: model.track }}>
      <span className="report-meter-fill" style={{ width: `${(model.ratio * 100).toFixed(2)}%`, background: model.fill }} />
      {model.targetRatio !== null && <span className="report-meter-target" style={{ left: `${(model.targetRatio * 100).toFixed(2)}%` }} />}
    </div>
    <p className="report-meter-caption">{model.caption}</p>
  </div>;
}

export function BlockMenu({ block, canWrite, busy, onClose, onInspect, onRerun, onRemove, onFilterBy, onClickSetup }: { block: DataBlock; canWrite: boolean; busy: boolean; onClose: () => void; onInspect: (tab: InspectTab) => void; onRerun: () => void; /** D525: the owner's Remove (asks first). */ onRemove?: () => void;
  /** D536: the keyboard's click (the block's values as a list), and the owner's "Clicking filters by…". */ onFilterBy?: () => void; onClickSetup?: () => void }) {
  useHistoryDialogGuard(true, onClose);
  const title = block.title ?? block.queryKey;
  return <ModalDialog title={title} eyebrow="Block" onClose={onClose} variant="sheet" className="reports-dialog report-block-menu">
    <div className="report-menu-list" role="menu" aria-label={`Actions for ${title}`}>
      <button type="button" role="menuitem" onClick={() => onInspect("query")}><ScanSearch aria-hidden="true" />How was this built</button>
      <button type="button" role="menuitem" onClick={() => onInspect("data")}><ScanSearch aria-hidden="true" />View data</button>
      {canWrite && <button type="button" role="menuitem" onClick={onRerun} disabled={busy}><RefreshCw aria-hidden="true" />{busy ? "A run is in progress" : "Re-run this query"}</button>}
      {/* Wave 48: a comment on this block opens the Changes panel aimed at it (only for those who may comment). */}
      {onFilterBy && <button type="button" role="menuitem" onClick={onFilterBy}><ListFilter aria-hidden="true" />Filter by…</button>}
      {onClickSetup && <button type="button" role="menuitem" onClick={onClickSetup}><MousePointerClick aria-hidden="true" />Clicking filters by…</button>}
      <CommentOnBlockButton blockId={block.id} className="report-menu-comment" onBefore={onClose} />
      {onRemove && <button type="button" role="menuitem" className="report-menu-danger" onClick={onRemove} disabled={busy}><Trash2 aria-hidden="true" />{busy ? "A run is in progress" : "Remove this block"}</button>}
    </div>
  </ModalDialog>;
}

function ExternalLinkSheet({ href, onClose }: { href: string; onClose: () => void }) {
  useHistoryDialogGuard(true, onClose);
  let host = href;
  try { host = new URL(href).host; } catch { /* shown as is */ }
  return <ModalDialog title={`Open ${host}?`} eyebrow="Link" onClose={onClose} variant="sheet" className="reports-dialog">
    <div className="file-dialog-form">
      <p className="report-link-full"><code>{href}</code></p>
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        <a className="primary-button report-link-open" href={href} target="_blank" rel="noopener noreferrer" onClick={onClose}><ExternalLink aria-hidden="true" />Open</a>
      </footer>
    </div>
  </ModalDialog>;
}
